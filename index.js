const express              = require('express')
const https                = require('https')
const { HttpsProxyAgent }  = require('https-proxy-agent')
const fs                   = require('fs')
const path                 = require('path')

const TOKEN        = process.env.BOT_TOKEN    || ''
const CHAT_ID      = process.env.CHAT_ID      || ''
const SYNC_KEY     = process.env.SYNC_KEY     || 'changeme'
const ALICE_TOKEN  = process.env.ALICE_TOKEN  || ''   // секрет в URL /alice/:token
const MORNING_TIME = process.env.MORNING_TIME || '09:00'
const EVENING_TIME = process.env.EVENING_TIME || '20:00'
const PORT         = process.env.PORT         || 3001

if (!TOKEN || !CHAT_ID) {
  console.error('[flow-bot] BOT_TOKEN и CHAT_ID обязательны')
  process.exit(1)
}

// ── Персистентная очередь pendingItems (переживает рестарты) ─────────────────
const PENDING_FILE = path.join('/tmp', 'flow_pending.json')

function loadPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')) } catch { return [] }
}
function savePending(items) {
  try { fs.writeFileSync(PENDING_FILE, JSON.stringify(items), 'utf8') } catch {}
}

let pendingItems = loadPending()
console.log(`[flow-bot] загружено pending: ${pendingItems.length}`)

// ── Telegram API (прямое https, без прокси — Render в облаке) ─────────────────
function tgApi(method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params)
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${TOKEN}/${method}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout:  15000,
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())) }
        catch (e) { reject(e) }
      })
    })
    req.on('error',   reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('tgApi timeout')) })
    req.write(body)
    req.end()
  })
}

async function tgSend(text) {
  if (!text) return
  // Пробуем с Markdown, при ошибке парсинга — шлём plain text
  try {
    const res = await tgApi('sendMessage', { chat_id: CHAT_ID, text, parse_mode: 'Markdown' })
    if (!res.ok) throw new Error(res.description || 'sendMessage failed')
  } catch (e) {
    console.log('[tg:send markdown failed]', e.message, '— retrying plain')
    try {
      await tgApi('sendMessage', { chat_id: CHAT_ID, text: text.replace(/[*_`]/g, '') })
    } catch (e2) {
      console.log('[tg:send plain failed]', e2.message)
    }
  }
}

// ── Персистентный store (переживает рестарты / редеплои) ─────────────────────
const STORE_FILE = path.join('/tmp', 'flow_store.json')

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
    console.log(`[flow-bot] store загружен: tasks=${(raw.tasks||[]).length}, notes=${(raw.notes||[]).length}, events=${(raw.calendar_events||[]).length}`)
    return raw
  } catch { return {} }
}
function saveStore() {
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(store), 'utf8') }
  catch (e) { console.log('[store:save]', e.message) }
}

let store = loadStore()

// Очередь элементов объявлена выше (loadPending)

// ══════════════════════════════════════════════════════════════════════════════
// УМНЫЙ ПАРСЕР (bot-server) — без \b для кириллицы
// ══════════════════════════════════════════════════════════════════════════════

function tagEmoji(tag) {
  const map = { 'Учёба':'📚','Работа':'💼','Здоровье':'💪','Финансы':'💰','Личное':'🏠','Проект':'🎯' }
  return map[tag] || '📌'
}

function budgetCategory(lower) {
  if (/еда|кафе|ресторан|кофе|обед|ужин|завтрак|продукт|пицца|доставк|суши|фастфуд|хлеб|молок|пельмен|шаурм|бургер|роллы/.test(lower)) return 'Еда'
  if (/такси|метро|автобус|транспорт|бензин|парковк|uber|каршер|электричк|самокат|проезд|маршрутк/.test(lower)) return 'Транспорт'
  if (/кино|игры|развлечен|подписк|netflix|spotify|стриминг|концерт|театр|кальян|боулинг/.test(lower)) return 'Развлечения'
  if (/врач|аптек|здоровь|лекарств|анализ|клиник|стоматол|больниц|таблетк|процедур/.test(lower)) return 'Здоровье'
  if (/одежд|обувь|шопинг|штаны|куртка|пальто|футболк|носк|джинс/.test(lower)) return 'Одежда'
  if (/зарплат|фриланс|доход|заработ|гонорар|выплат|аванс|премия|перевод/.test(lower)) return 'Доходы'
  if (/связь|интернет|мобильн|телефон|оператор/.test(lower)) return 'Связь'
  if (/аренд|квартир|комуналк|жкх|электричеств/.test(lower)) return 'Жильё'
  if (/кредит|ипотек|долг|займ/.test(lower)) return 'Кредиты'
  if (/курс|книг|образован|обучени/.test(lower)) return 'Образование'
  return 'Прочее'
}

function taskTag(lower) {
  if (/изучи|выучи|прочитать|разобраться|туториал|лекц|учёба|учиться|пройти курс|книга по/.test(lower)) return 'Учёба'
  if (/работ|проект|написать|отправить|подготовить|отчёт|презентаци|митинг|созвон|деплой|код/.test(lower)) return 'Работа'
  if (/зал|тренировк|врач|таблетк|здоровь|диета|бегать|спорт|упражнен|пробежк|питани|калори/.test(lower)) return 'Здоровье'
  if (/купить(?! курс| книг| урок)|оплатить|счёт|финанс|банк/.test(lower)) return 'Финансы'
  return 'Личное'
}

function pad2(n) { return String(n).padStart(2,'0') }

function parseDate(text) {
  const lower = text.toLowerCase()
  const now   = new Date()
  const fmt   = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`
  const shift = days => { const d=new Date(now); d.setDate(d.getDate()+days); return d }

  if (/сегодня/.test(lower))     return fmt(now)
  if (/послезавтра/.test(lower)) return fmt(shift(2))
  if (/завтра/.test(lower))      return fmt(shift(1))

  let m
  m = lower.match(/через\s+(\d+)\s+дн[еёяий]/)
  if (m) return fmt(shift(+m[1]))
  m = lower.match(/через\s+(\d+)\s+недел[иью]/)
  if (m) return fmt(shift(+m[1]*7))
  m = lower.match(/через\s+(\d+)\s+месяц[ае]?/)
  if (m) { const d=new Date(now); d.setMonth(d.getMonth()+parseInt(m[1])); return fmt(d) }
  if (/через\s+неделю/.test(lower))  return fmt(shift(7))
  if (/через\s+месяц/.test(lower))   { const d=new Date(now); d.setMonth(d.getMonth()+1); return fmt(d) }
  if (/следующ[уюий]+\s+недел|на\s+следующей\s+неделе/.test(lower)) return fmt(shift(7))

  const isNext = /следующ[уюий]/.test(lower)
  const dowMap = [['воскресень',0],['понедельник',1],['вторник',2],['среду',3],['среда',3],['четверг',4],['пятниц',5],['суббот',6]]
  for (const [name,dow] of dowMap) {
    if (lower.includes(name)) {
      let diff = (dow - now.getDay() + 7) % 7 || 7
      if (isNext) diff += 7
      return fmt(shift(diff))
    }
  }

  const numDate = text.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/)
  if (numDate) {
    const dy=parseInt(numDate[1]), mo=parseInt(numDate[2])-1
    let yr = numDate[3] ? parseInt(numDate[3]) : now.getFullYear()
    if (yr<100) yr+=2000
    if (mo>=0&&mo<=11&&dy>=1&&dy<=31) {
      const d=new Date(yr,mo,dy)
      if (d<now&&!numDate[3]) d.setFullYear(d.getFullYear()+1)
      return fmt(d)
    }
  }

  const months = [['январ',0],['феврал',1],['март',2],['апрел',3],['мая',4],['май',4],['июн',5],['июл',6],['август',7],['сентябр',8],['октябр',9],['ноябр',10],['декабр',11]]
  const ruDate = lower.match(/(\d{1,2})(?:-?го)?\s+([а-яё]+)(?:\s+(\d{4}))?/)
  if (ruDate) {
    const me = months.find(([k]) => ruDate[2].startsWith(k))
    if (me) {
      const yr = ruDate[3] ? parseInt(ruDate[3]) : now.getFullYear()
      const d  = new Date(yr, me[1], parseInt(ruDate[1]))
      if (d<now&&!ruDate[3]) d.setFullYear(d.getFullYear()+1)
      return fmt(d)
    }
  }
  return null
}

function parseTime(text) {
  const lower = text.toLowerCase()
  if (/полдень/.test(lower))  return '12:00'
  if (/полночь/.test(lower))  return '00:00'
  const m1 = text.match(/\b(\d{1,2}):(\d{2})\b/)
  if (m1) { const h=+m1[1],mn=+m1[2]; if(h<=23&&mn<=59) return `${pad2(h)}:${pad2(mn)}` }
  const m2 = lower.match(/в\s+(\d{1,2})(?:\s+(?:час[ао]в?|ч))?\s*(утра|дня|вечера|ночи)?(?=\s|$)/)
  if (m2) {
    let h=parseInt(m2[1]); const p=m2[2]||''
    if (p==='вечера'&&h<12)          h+=12
    else if (p==='ночи'&&h>=6&&h<12) h+=12
    else if (p==='дня'&&h<12&&h>=1)  h+=12
    if (h<=23) return `${pad2(h)}:00`
  }
  if (/утром/.test(lower)   && !/(?:вчера|сегодня)\s+утром/.test(lower))   return '09:00'
  if (/днём|днем/.test(lower))                                               return '13:00'
  if (/вечером/.test(lower) && !/(?:вчера|сегодня)\s+вечером/.test(lower)) return '19:00'
  if (/ночью/.test(lower))                                                   return '22:00'
  return null
}

function isBudget(t, lower) {
  if (/\d+\s*₽/.test(t)) return true
  if (/\d+\s*руб/.test(lower)) return true
  if (/руб\w*\s*\d+/.test(lower)) return true
  if (/(?:потратил[а]?|стоит|стоил[а]?|обошлось|заплатил[а]?|оплатил[а]?)\s+\d/.test(lower)) return true
  return false
}

function isCalendar(t, lower) {
  const hasTime = parseTime(t) !== null
  const hasDate = parseDate(t) !== null
  const hasEvt  = /запись|записался|записалась|встреча|встречу|встретиться|созвон|созвониться|звонок|митинг|собрание|мероприятие|событие|визит|приём|прием|конференция|вечеринк|концерт|спектакль|экзамен|зачёт|зачет|защита|дедлайн|поездка|рейс|вылет|прилёт|прилет|день рожден|праздник|юбилей|свидание|интервью|собеседование|напомни/i.test(lower)
  if (hasEvt && (hasDate || hasTime)) return true
  if (hasTime && hasDate)             return true
  return false
}

function isDiary(t, lower) {
  if (/^(?:сегодня|вчера)\s+я\s/i.test(t)) return true
  if (/^(?:сегодня|вчера)\s+я$/i.test(t))  return true
  if (/^сегодня\s+(?:был[аи]?|ходил[а]?|гулял[а]?|посетил[а]?|поел[а]?|провел[а]?|занимался|занималась)/i.test(t)) return true
  if (/(?:^|\s)я\s+(?:погулял|погуляла|сходил|сходила|посетил|посетила|побывал|побывала|провел|провела|встретил|встретила|поговорил|поговорила|поел|поела|выспался|выспалась|отдохнул|отдохнула|поработал|поработала|почитал|почитала|посмотрел|посмотрела|написал|написала|сделал|сделала|поиграл|поиграла|потренировался|потренировалась|пробежал|пробежала|поплавал|поплавала|съездил|съездила|побегал|побегала)/i.test(lower)) return true
  if (/настроение сегодня|чувствую себя|чувствовал|был[а]?\s+продуктивн|хороший день|плохой день|сложный день|тяжёлый день|тяжелый день|неплохой день|день прошёл|день прошел|было здорово|было классно|было грустно|было скучно|скучал|грустил|радовался|радовалась|нервничал/.test(lower)) return true
  return false
}

function isNote(t) {
  return /^(?:идея|заметка|мысль|запиши|записать|нужно запомнить|важно|заметь)[:\s]/i.test(t)
}

function calTitle(t) {
  return t
    .replace(/\b\d{1,2}:\d{2}\b/g,'')
    .replace(/в\s+\d{1,2}\s*(?:час[ао]в?|ч)?\s*(?:утра|дня|вечера|ночи)?/gi,'')
    .replace(/полдень|полночь/gi,'')
    .replace(/\d{1,2}(?:-?го)?\s+(?:январ[яе]?|феврал[яе]?|март[ае]?|апрел[яе]?|мая?|июн[яе]?|июл[яе]?|август[ае]?|сентябр[яе]?|октябр[яе]?|ноябр[яе]?|декабр[яе]?)(?:\s+\d{4})?/gi,'')
    .replace(/\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b/g,'')
    .replace(/сегодня|завтра|послезавтра|через\s+\S+(?:\s+\S+)?/gi,'')
    .replace(/(?:в\s+)?(?:следующ[уюий]+\s+)?(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)/gi,'')
    .replace(/утром|вечером|днём|днем|ночью/gi,'')
    .replace(/\s+/g,' ').trim() || t.trim()
}

// ── LLM-классификатор (Groq, бесплатный) ─────────────────────────────────────
// Понимает свободный текст без ключевых слов. При отсутствии ключа/ошибке
// падаем обратно на классификацию по правилам (smartParseRules).

const GROQ_API_KEY = process.env.GROQ_API_KEY || ''
const GROQ_MODEL   = process.env.GROQ_MODEL   || 'llama-3.1-8b-instant'
const CLASSIFY_TYPES = ['task', 'budget', 'calendar', 'diary', 'note']

// Groq стоит за Cloudflare, который блокирует TLS-отпечаток Node.js (и https,
// и встроенный fetch получают 403 Forbidden), а curl проходит без проблем —
// поэтому запрос делаем через дочерний процесс curl (без участия shell, тело
// передаётся через stdin — инъекция исключена).
const { spawn: _spawn } = require('child_process')

function groqRequest(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const p = _spawn('curl', [
      '-s', '-X', 'POST', 'https://api.groq.com/openai/v1/chat/completions',
      '-H', 'Content-Type: application/json',
      '-H', `Authorization: Bearer ${GROQ_API_KEY}`,
      '--max-time', '20',
      '--data-binary', '@-',
    ])
    let out = '', err = ''
    p.stdout.on('data', c => out += c)
    p.stderr.on('data', c => err += c)
    p.on('error', reject)
    p.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim() || `curl exit ${code}`))
      try { resolve(JSON.parse(out)) } catch (e) { reject(e) }
    })
    p.stdin.write(data)
    p.stdin.end()
  })
}

function classifyPrompt(text) {
  return `Ты — классификатор сообщений для личного планировщика «Flow». Определи категорию сообщения пользователя (на русском языке) и извлеки данные. Отвечай СТРОГО одним JSON-объектом, без markdown и пояснений.

Категории и формат ответа:
• task — дело/действие, которое нужно сделать:
  {"type":"task","text":"переформулированный текст задачи кратко","tag":"Учёба|Работа|Здоровье|Финансы|Личное|Проект","priority":"low|medium|high"}
• budget — трата или поступление денег (в сообщении есть конкретная сумма):
  {"type":"budget","amount":число,"isIncome":true|false,"category":"Еда|Транспорт|Развлечения|Здоровье|Одежда|Доходы|Связь|Жильё|Кредиты|Образование|Прочее","note":"краткое описание операции"}
• calendar — запланированное событие/встреча/визит/звонок на конкретную дату или время:
  {"type":"calendar","title":"короткое название события без даты и времени"}
• diary — личная запись о прожитом дне, впечатления, эмоции, рефлексия о себе:
  {"type":"diary"}
• note — идея, мысль, что-то на заметку для памяти (не дело и не дневник):
  {"type":"note","title":"короткий заголовок","tag":"Идея|Работа|Учёба|Личное"}

Правила выбора при неоднозначности:
- Названа конкретная сумма денег ("150 рублей", "потратил 500", "получил зарплату") → budget.
- Упомянута встреча/визит/созвон/мероприятие с датой или временем → calendar.
- Рассказ о прошедшем/проживаемом дне, своих действиях или чувствах в прошедшем времени → diary.
- Короткая мысль/идея «на подумать» → note.
- Во всех остальных случаях, если это что-то, что нужно сделать → task.

Сообщение пользователя:
"${text}"

Ответ — только JSON одной строкой, без пояснений и markdown.`
}

async function classifyLLM(text) {
  if (!GROQ_API_KEY) return null
  try {
    const res = await groqRequest({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: classifyPrompt(text) }],
      temperature: 0,
      max_tokens: 250,
      response_format: { type: 'json_object' },
    })
    const content = res?.choices?.[0]?.message?.content
    if (!content) return null
    const parsed = JSON.parse(content)
    if (!CLASSIFY_TYPES.includes(parsed.type)) return null
    return parsed
  } catch (e) {
    console.log('[llm:classify]', e.message)
    return null
  }
}

// ── Основная функция: сначала LLM, при неудаче — классификация по правилам ──

async function smartParse(text) {
  const t     = text.trim()
  const lower = t.toLowerCase()
  const today = todayKey()
  const now   = new Date()
  const llm   = await classifyLLM(t)

  if (llm?.type === 'calendar') {
    const date  = parseDate(t) || today
    const time  = parseTime(t) || ''
    const title = (llm.title || calTitle(t)).trim() || t
    return {
      type: 'calendar',
      data: { id:`tg_${Date.now()}`, title, date, time, endTime:'', color:'#5b8dee', allDay:!time, desc:'', location:'', repeat:'none', repeatEnd:'' },
      reply: `📅 *Событие добавлено*\n«${title}»\n📆 ${date}${time?' в '+time:''}`,
    }
  }
  if (llm?.type === 'budget') {
    const numMatch = t.match(/\d[\d\s,.]*/)
    const amount   = typeof llm.amount === 'number' && llm.amount > 0
      ? llm.amount
      : (numMatch ? parseFloat(numMatch[0].replace(/\s/g,'').replace(',','.')) : 0)
    const isIncome = !!llm.isIncome
    const category = llm.category || budgetCategory(lower)
    const note     = llm.note || t
    return {
      type: 'budget',
      data: { id:`tg_${Date.now()}`, type:isIncome?'income':'expense', amount, category, note, date:today, month:today.slice(0,7), created:now.toISOString() },
      reply: `💰 *${isIncome?'Доход':'Расход'} ${amount.toLocaleString('ru')} ₽*\nКатегория: ${category}${note&&note!==t?'\nЗаметка: '+note:''}`,
    }
  }
  if (llm?.type === 'diary') {
    return {
      type: 'diary',
      data: { id:`tg_${Date.now()}`, date:today, body:t, mood:null, created:now.toISOString(), updated:now.toISOString() },
      reply: `📖 *Запись в дневник*\n«${t.slice(0,100)}${t.length>100?'…':''}»`,
    }
  }
  if (llm?.type === 'note') {
    const title = (llm.title || t.split('\n')[0]).slice(0, 60) || 'Без заголовка'
    const tag   = llm.tag || 'Личное'
    return {
      type: 'note',
      data: { id:`tg_${Date.now()}`, title, body:t, color:'#1e2433', tag, pinned:false, created:now.toISOString(), updated:now.toISOString() },
      reply: `📝 *Заметка сохранена*\n«${title}»`,
    }
  }
  if (llm?.type === 'task') {
    // Защита от ошибки LLM: если в тексте есть явные признаки события (ключевое слово + дата/время)
    // — перекрываем task → calendar, чтобы встречи/записи не попадали в задачи
    if (isCalendar(t, lower)) {
      const date  = parseDate(t) || today
      const time  = parseTime(t) || ''
      const title = (llm.text || calTitle(t)).trim() || t
      return {
        type: 'calendar',
        data: { id:`tg_${Date.now()}`, title, date, time, endTime:'', color:'#5b8dee', allDay:!time, desc:'', location:'', repeat:'none', repeatEnd:'' },
        reply: `📅 *Событие добавлено*\n«${title}»\n📆 ${date}${time?' в '+time:''}`,
      }
    }
    const cleanText = llm.text || t
    const tag       = llm.tag || taskTag(lower)
    const priority  = llm.priority || (/срочно|важно|критично|asap|горит|немедленно/.test(lower) ? 'high' : 'medium')
    const taskDate  = parseDate(t) || today
    return {
      type: 'task',
      data: { id:`tg_${Date.now()}`, text:cleanText, tag, priority, date:taskDate, done:false, created:now.toISOString(), subtasks:[] },
      reply: `${tagEmoji(tag)} *Задача [${tag}]* добавлена:\n«${cleanText}»`,
    }
  }

  // LLM недоступен или вернул некорректный результат — классификация по правилам
  return smartParseRules(t, lower, today, now)
}

// ── Классификация по правилам (фолбэк, если LLM недоступен) ──────────────────

function smartParseRules(t, lower, today, now) {
  if (isCalendar(t, lower)) {
    const date  = parseDate(t) || today
    const time  = parseTime(t) || ''
    const title = calTitle(t)
    return {
      type: 'calendar',
      data: { id:`tg_${Date.now()}`, title, date, time, endTime:'', color:'#5b8dee', allDay:!time, desc:'', location:'', repeat:'none', repeatEnd:'' },
      reply: `📅 *Событие добавлено*\n«${title}»\n📆 ${date}${time?' в '+time:''}`,
    }
  }

  if (isBudget(t, lower)) {
    const mM = t.match(/(\d[\d\s,.]*)\s*₽/)
            || lower.match(/(\d[\d\s,.]*)\s*руб/)
            || lower.match(/(?:потратил[а]?|стоит|заплатил[а]?|оплатил[а]?)\s+(\d[\d\s,.]*)/)
    const amount   = mM ? parseFloat(mM[1].replace(/\s/g,'').replace(',','.')) : 0
    const isIncome = /получил[а]?|зарплат|доход|заработал[а]?|выплат|пришло|перевод|аванс|премия|гонорар/.test(lower)
    const note     = t.replace(/\d[\d\s,.]*\s*(?:₽|руб[а-яё]*)/gi,'').replace(/^\s*[-—:,]\s*/,'').trim() || t
    const category = budgetCategory(lower)
    return {
      type: 'budget',
      data: { id:`tg_${Date.now()}`, type:isIncome?'income':'expense', amount, category, note, date:today, month:today.slice(0,7), created:now.toISOString() },
      reply: `💰 *${isIncome?'Доход':'Расход'} ${amount.toLocaleString('ru')} ₽*\nКатегория: ${category}${note&&note!==t?'\nЗаметка: '+note:''}`,
    }
  }

  if (isDiary(t, lower)) {
    return {
      type: 'diary',
      data: { id:`tg_${Date.now()}`, date:today, body:t, mood:null, created:now.toISOString(), updated:now.toISOString() },
      reply: `📖 *Запись в дневник*\n«${t.slice(0,100)}${t.length>100?'…':''}»`,
    }
  }

  if (isNote(t)) {
    const body  = t.replace(/^(?:идея|заметка|мысль|запиши|записать|нужно запомнить|важно|заметь)[:\s]*/i,'').trim()
    const title = body.split('\n')[0].slice(0,60) || 'Без заголовка'
    const tag   = /идея/i.test(t)?'Идея':/работ/.test(lower)?'Работа':/учёб|учи/.test(lower)?'Учёба':'Личное'
    return {
      type: 'note',
      data: { id:`tg_${Date.now()}`, title, body, color:'#1e2433', tag, pinned:false, created:now.toISOString(), updated:now.toISOString() },
      reply: `📝 *Заметка сохранена*\n«${title}»`,
    }
  }

  const tag      = taskTag(lower)
  const priority = /срочно|важно|критично|asap|горит|немедленно/.test(lower) ? 'high' : 'medium'
  const taskDate = parseDate(t) || today
  const cleanText = t
    .replace(/^(?:нужно|надо|необходимо|не забыть|хочу|планирую)\s+/i,'')
    .replace(/^(?:изучить?|прочитать?|посмотреть?|сделать?|добавить?|напомнить?|купить?|написать?|отправить?|позвонить?)\s+/i,'')
    .replace(/\s+(?:срочно|важно|сегодня)$/i,'').trim() || t
  return {
    type: 'task',
    data: { id:`tg_${Date.now()}`, text:cleanText, tag, priority, date:taskDate, done:false, created:now.toISOString(), subtasks:[] },
    reply: `${tagEmoji(tag)} *Задача [${tag}]* добавлена:\n«${cleanText}»`,
  }
}

// ── Применить результат парсинга к store + pendingItems ──────────────────────

async function applyParsed(parsed) {
  const { type, data, reply } = parsed
  if (type === 'task') {
    if (!store.tasks) store.tasks = []
    store.tasks.push(data)
  } else if (type === 'note') {
    if (!store.notes) store.notes = []
    store.notes.push(data)
  } else if (type === 'budget') {
    if (!store.budget_txns) store.budget_txns = []
    store.budget_txns.push(data)
  } else if (type === 'calendar') {
    if (!store.calendar_events) store.calendar_events = []
    store.calendar_events.push(data)
  } else if (type === 'diary') {
    if (!store.diary_entries) store.diary_entries = []
    const ex = store.diary_entries.find(e => e.date === data.date)
    if (ex) { ex.body += '\n\n' + data.body; ex.updated = data.updated }
    else store.diary_entries.push(data)
  }
  pendingItems.push({ type, data })
  savePending(pendingItems)
  saveStore()
  await tgSend(reply)
}

// ── Утилиты ──────────────────────────────────────────────────────────────────

function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`
}

// ── Форматтеры (читают из in-memory store) ────────────────────────────────────

function fmtTasks() {
  const tasks   = store.tasks || []
  const today   = todayKey()
  const overdue = tasks.filter(t => !t.done && t.date && t.date < today)
  const todayT  = tasks.filter(t => !t.done && t.date === today)
  const noDate  = tasks.filter(t => !t.done && !t.date)

  if (!overdue.length && !todayT.length && !noDate.length)
    return '✅ Все задачи выполнены!'

  const lines = ['📋 *Задачи*']
  if (overdue.length) {
    lines.push(`\n🔴 *Просрочено (${overdue.length}):*`)
    overdue.slice(0, 5).forEach(t => lines.push(`  • ${t.text}  _${t.date}_`))
    if (overdue.length > 5) lines.push(`  …ещё ${overdue.length - 5}`)
  }
  if (todayT.length) {
    lines.push(`\n📅 *Сегодня (${todayT.length}):*`)
    todayT.slice(0, 8).forEach(t => lines.push(`  • ${t.text}`))
    if (todayT.length > 8) lines.push(`  …ещё ${todayT.length - 8}`)
  }
  if (noDate.length) {
    lines.push(`\n📌 *Без даты (${noDate.length}):*`)
    noDate.slice(0, 5).forEach(t => lines.push(`  • ${t.text}`))
    if (noDate.length > 5) lines.push(`  …ещё ${noDate.length - 5}`)
  }
  return lines.join('\n')
}

function fmtHabits() {
  const habits = store.habits_v2 || []
  const today  = todayKey()
  if (!habits.length) return '🔁 *Привычки*\n\nНет активных привычек.'
  let done = 0
  const rows = habits.map(h => {
    const ok = (h.log || []).includes(today)
    if (ok) done++
    return `${ok ? '✅' : '⬜'} ${h.icon || ''} ${h.name}`.trim()
  })
  return ['🔁 *Привычки сегодня*', ...rows, `\n${done}/${habits.length} выполнено`].join('\n')
}

function fmtFocus() {
  const stats   = store.focus_stats   || {}
  const history = store.focus_history || {}
  const d       = history[todayKey()] || { sessions: 0, minutes: 0 }
  const totalH  = Math.round((stats.totalMinutes || 0) / 60 * 10) / 10
  return [
    '⏱ *Фокус*',
    `📅 Сегодня: ${d.sessions} сессий, ${d.minutes} мин`,
    `📊 Всего:   ${stats.sessions || 0} сессий, ${totalH} ч`,
  ].join('\n')
}

function fmtBudget() {
  const txns  = store.budget_txns || []
  const month = new Date().toISOString().slice(0, 7)
  const mt    = txns.filter(t => t.month === month)
  const income  = mt.filter(t => t.type === 'income') .reduce((s, t) => s + (t.amount || 0), 0)
  const expense = mt.filter(t => t.type === 'expense').reduce((s, t) => s + (t.amount || 0), 0)
  const balance = income - expense
  return [
    `💰 *Бюджет ${month}*`,
    `📈 Доходы:  ${income.toLocaleString('ru')} ₽`,
    `📉 Расходы: ${expense.toLocaleString('ru')} ₽`,
    `${balance >= 0 ? '✅' : '⚠️'} Баланс:   ${balance.toLocaleString('ru')} ₽`,
  ].join('\n')
}

function fmtSummary(prefix = '') {
  const profile  = store.profile    || {}
  const tasks    = store.tasks      || []
  const habits   = store.habits_v2  || []
  const today    = todayKey()
  const name     = profile.name || 'Дмитрий'
  const h        = new Date().getHours()
  const greeting = h < 12 ? 'Доброе утро' : h < 17 ? 'Добрый день' : 'Добрый вечер'

  const overdue   = tasks.filter(t => !t.done && t.date && t.date < today).length
  const todayLeft = tasks.filter(t => !t.done && t.date === today).length
  const doneToday = tasks.filter(t => t.done && (t.updated || t.created || '').slice(0, 10) === today).length
  const habDone   = habits.filter(h => (h.log || []).includes(today)).length

  const lines = [`${prefix}👋 ${greeting}, ${name}!`]
  if (overdue   > 0) lines.push(`🔴 Просрочено: ${overdue} задач`)
  if (todayLeft > 0) lines.push(`📅 На сегодня: ${todayLeft} задач`)
  if (doneToday > 0) lines.push(`✅ Выполнено:  ${doneToday} задач`)
  lines.push(`🔁 Привычки: ${habDone}/${habits.length}`)
  return lines.join('\n')
}

// ── Умное часовое напоминание ─────────────────────────────────────────────────

function buildHourlyReminder() {
  const today  = todayKey()
  const now    = new Date()
  const hour   = now.getHours()
  const minute = now.getMinutes()
  const nowMin = hour * 60 + minute

  const tasks  = store.tasks      || []
  const events = store.calendar_events || []
  const habits = store.habits_v2  || []

  // Задачи
  const overdue   = tasks.filter(t => !t.done && t.date && t.date < today)
  const todayLeft = tasks.filter(t => !t.done && t.date === today)

  // Ближайшие события сегодня (в течение следующих 2 ч)
  const upcoming = events.filter(e => {
    if (e.date !== today || !e.time) return false
    const [h, m] = e.time.split(':').map(Number)
    const evMin  = h * 60 + m
    return evMin > nowMin && evMin <= nowMin + 120
  })
  // Все события сегодня (без timed — allDay)
  const todayEvents = events.filter(e => e.date === today && !e.allDay && e.time)

  // Привычки не выполнены
  const habitsLeft = habits.filter(h => !(h.log || []).includes(today))

  // Не шлём если совсем нечего
  if (!overdue.length && !todayLeft.length && !upcoming.length && !habitsLeft.length) return null

  const lines = []

  // Заголовок по времени суток
  if (hour < 12)      lines.push('☀️ *Напоминание (утро)*')
  else if (hour < 17) lines.push('🕐 *Напоминание (день)*')
  else                lines.push('🌆 *Напоминание (вечер)*')

  // Ближайшие события — самое важное
  if (upcoming.length) {
    lines.push('')
    lines.push('⚡ *Скоро:*')
    upcoming.forEach(e => {
      const mins = Math.round((e.time.split(':').map(Number).reduce((h,m)=>h*60+m,0)) - nowMin)
      const label = mins <= 5 ? 'прямо сейчас' : `через ${mins} мин`
      lines.push(`  📅 ${e.title} — ${e.time} (${label})`)
    })
  }

  // Просроченные
  if (overdue.length) {
    lines.push('')
    lines.push(`🔴 *Просрочено (${overdue.length}):*`)
    overdue.slice(0, 4).forEach(t => lines.push(`  • ${t.text}  _(${t.date})_`))
    if (overdue.length > 4) lines.push(`  …ещё ${overdue.length - 4}`)
  }

  // Задачи на сегодня
  if (todayLeft.length) {
    lines.push('')
    lines.push(`📋 *На сегодня (${todayLeft.length}):*`)
    todayLeft.slice(0, 6).forEach(t => {
      const prio = t.priority === 'high' ? ' 🔥' : ''
      lines.push(`  • ${t.text}${prio}`)
    })
    if (todayLeft.length > 6) lines.push(`  …ещё ${todayLeft.length - 6}`)
  }

  // Привычки (только после 17:00)
  if (habitsLeft.length && hour >= 17) {
    lines.push('')
    lines.push(`🔁 *Привычки не выполнены (${habitsLeft.length}):*`)
    habitsLeft.slice(0, 4).forEach(h => lines.push(`  ⬜ ${h.icon || ''} ${h.name}`.trim()))
  }

  return lines.join('\n')
}

// ── Итоги дня (23:00) ─────────────────────────────────────────────────────────

function fmtEndOfDay() {
  const today  = todayKey()
  const tasks  = store.tasks        || []
  const habits = store.habits_v2    || []
  const txns   = store.budget_txns  || []
  const diary  = store.diary_entries|| []
  const events = store.calendar_events || []
  const profile = store.profile || {}
  const name   = profile.name || ''

  const doneToday   = tasks.filter(t => t.done && (t.updated||t.created||'').slice(0,10) === today)
  const remaining   = tasks.filter(t => !t.done && t.date && t.date <= today)
  const habDone     = habits.filter(h => (h.log||[]).includes(today))
  const todayEvents = events.filter(e => e.date === today)
  const todayTxns   = txns.filter(t => t.date === today)
  const todayDiary  = diary.find(d => d.date === today)
  const todayExp    = todayTxns.filter(t=>t.type==='expense').reduce((s,t)=>s+(t.amount||0),0)
  const todayInc    = todayTxns.filter(t=>t.type==='income' ).reduce((s,t)=>s+(t.amount||0),0)

  const lines = ['🌙 *Итоги дня*', `📅 ${today}`, '']

  // Выполненные задачи
  if (doneToday.length) {
    lines.push(`✅ *Выполнено задач: ${doneToday.length}*`)
    doneToday.slice(0,6).forEach(t => lines.push(`  ✓ ${t.text}`))
    if (doneToday.length > 6) lines.push(`  …ещё ${doneToday.length-6}`)
    lines.push('')
  } else {
    lines.push('📋 Задач не выполнено сегодня')
    lines.push('')
  }

  // Незавершённые / просроченные
  if (remaining.length) {
    lines.push(`⏳ *Осталось незакрытым: ${remaining.length}*`)
    remaining.slice(0,4).forEach(t => {
      const overdue = t.date < today ? ` _(просрочено ${t.date})_` : ''
      lines.push(`  • ${t.text}${overdue}`)
    })
    if (remaining.length > 4) lines.push(`  …ещё ${remaining.length-4}`)
    lines.push('')
  }

  // События дня
  if (todayEvents.length) {
    lines.push(`📅 *События дня:*`)
    todayEvents.forEach(e => lines.push(`  • ${e.title}${e.time?' в '+e.time:''}`))
    lines.push('')
  }

  // Привычки
  if (habits.length) {
    const pct = Math.round(habDone.length / habits.length * 100)
    const bar = '█'.repeat(Math.round(pct/10)) + '░'.repeat(10-Math.round(pct/10))
    lines.push(`🔁 *Привычки: ${habDone.length}/${habits.length}* (${pct}%)`)
    lines.push(`  ${bar}`)
    habits.forEach(h => {
      const ok = (h.log||[]).includes(today)
      lines.push(`  ${ok?'✅':'❌'} ${h.icon||''} ${h.name}`.trim())
    })
    lines.push('')
  }

  // Бюджет за день
  if (todayTxns.length) {
    const parts = []
    if (todayInc) parts.push(`+${todayInc.toLocaleString('ru')} ₽ доход`)
    if (todayExp) parts.push(`-${todayExp.toLocaleString('ru')} ₽ расход`)
    lines.push(`💰 *Бюджет за день:* ${parts.join(', ')}`)
    todayTxns.slice(0,4).forEach(t => {
      const sign = t.type==='income'?'↑':'↓'
      lines.push(`  ${sign} ${(t.amount||0).toLocaleString('ru')} ₽ — ${t.category}`)
    })
    lines.push('')
  }

  // Запись в дневник
  if (todayDiary) {
    const snippet = todayDiary.body.slice(0,160)
    lines.push('📔 *Из дневника:*')
    lines.push(`_"${snippet}${todayDiary.body.length>160?'…':''}"_`)
    lines.push('')
  }

  // Итоговое сообщение
  const phrases = [
    'Ты молодец — ещё один день позади!',
    'Хороший день. Отдыхай — завтра новые дела.',
    'Спокойной ночи! Завтра продолжим.',
    'День завершён. Заряжайся энергией на завтра! 💪',
  ]
  const closing = phrases[new Date().getDate() % phrases.length]
  lines.push(name ? `👋 ${closing} ${name}` : `👋 ${closing}`)

  return lines.join('\n')
}

// ── Извлечение URL из сообщения Telegram ─────────────────────────────────────

function extractUrls(msg) {
  const urls = []
  // Используем text из msg (уже может быть с инлайн-ссылками от inlineTextLinks)
  const text = msg.text || msg.caption || ''
  const entities = msg.entities || msg.caption_entities || []

  for (const e of entities) {
    if (e.type === 'url') {
      // Сырой URL прямо в тексте
      urls.push(text.slice(e.offset, e.offset + e.length))
    } else if (e.type === 'text_link' && e.url) {
      // Скрытая ссылка за текстом — берём URL из entity
      urls.push(e.url)
    } else if (e.type === 'bold' || e.type === 'italic') {
      // Иногда Telegram присылает mention-ссылки через другие типы — игнорируем
    }
  }

  // Regex-поиск по тексту — ловит URL которые не попали в entities
  // (некоторые клиенты не шлют entities для plain-text ссылок)
  const rx = /https?:\/\/[^\s\]\)>«»"',]+/g
  let m
  while ((m = rx.exec(text)) !== null) {
    const clean = m[0].replace(/[.,;:!?)]+$/, '')
    if (!urls.includes(clean)) urls.push(clean)
  }

  return [...new Set(urls)]
}

// ── Загрузка страницы по URL и очистка HTML ───────────────────────────────────

function fetchUrl(url) {
  return new Promise(resolve => {
    const lib = url.startsWith('https') ? https : require('http')
    const doReq = (u, redirects = 0) => {
      if (redirects > 5) return resolve('')
      try {
        lib.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; flow-bot/1.0)' }, timeout: 10000 }, res => {
          if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
            return doReq(res.headers.location, redirects + 1)
          }
          let raw = ''
          res.setEncoding('utf8')
          res.on('data', c => { if (raw.length < 200000) raw += c })
          res.on('end', () => {
            // Удаляем script/style целиком
            let text = raw
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
            // br/p/div/li → переносы
            text = text.replace(/<br\s*\/?>/gi, '\n')
              .replace(/<\/?(p|div|li|h[1-6]|tr|blockquote)[^>]*>/gi, '\n')
            // Убираем остальные теги
            text = text.replace(/<[^>]+>/g, '')
            // Декодируем HTML entities
            text = text.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
              .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
              .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n))
            // Схлопываем пробелы
            text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
            resolve(text.slice(0, 8000))
          })
        }).on('error', () => resolve('')).on('timeout', function() { this.destroy(); resolve('') })
      } catch { resolve('') }
    }
    doReq(url)
  })
}

// ── Анализ поста: Groq + DuckDuckGo ──────────────────────────────────────────

function ddgSearch(query) {
  return new Promise(resolve => {
    const q = encodeURIComponent(query)
    const req = https.request({
      hostname: 'api.duckduckgo.com',
      path: `/?q=${q}&format=json&no_html=1&skip_disambig=1`,
      method: 'GET',
      headers: { 'User-Agent': 'flow-bot/1.0' },
      timeout: 8000,
    }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try {
          const d = JSON.parse(data)
          const results = []
          if (d.AbstractText) results.push(d.AbstractText)
          if (d.RelatedTopics?.length) {
            d.RelatedTopics.slice(0, 3).forEach(t => {
              if (t.Text) results.push(t.Text)
            })
          }
          resolve(results.join('\n\n'))
        } catch { resolve('') }
      })
    })
    req.on('error', () => resolve(''))
    req.on('timeout', () => { req.destroy(); resolve('') })
    req.end()
  })
}

async function analyzePost(text) {
  // 0. Извлекаем источники URL из всего собранного контента
  const _urlRx = /https?:\/\/[^\s\)\]\>"'<]+/g
  const sourceUrls = [...new Set(
    [...text.matchAll(_urlRx)]
      .map(m => m[0].replace(/[.,;:!?)>]+$/, ''))
      .filter(u => u.length > 12 && !u.includes('api.duckduckgo'))
  )].slice(0, 5)

  // 1. Groq: анализируем пост
  let analysis = null
  try {
    const res = await groqRequest({
      model: GROQ_MODEL,
      messages: [{
        role: 'user',
        content: `Проанализируй следующий текст/пост. Ответь СТРОГО JSON:
{
  "title": "краткий заголовок (до 60 символов)",
  "summary": "краткое изложение в 2-3 предложениях",
  "keyPoints": ["ключевой тезис 1", "ключевой тезис 2", "ключевой тезис 3"],
  "topic": "главная тема для поиска в интернете (2-4 слова на русском)",
  "tag": "Идея|Работа|Учёба|Личное"
}

Текст:
"""
${text.slice(0, 3000)}
"""`,
      }],
      temperature: 0.3,
      max_tokens: 600,
      response_format: { type: 'json_object' },
    })
    const content = res?.choices?.[0]?.message?.content
    if (content) analysis = JSON.parse(content)
  } catch (e) {
    console.log('[analyze:groq]', e.message)
  }

  if (!analysis) {
    // фолбэк без LLM
    const title = text.split(/[.!?\n]/)[0].slice(0, 60) || 'Пост'
    analysis = { title, summary: text.slice(0, 200), keyPoints: [], topic: title, tag: 'Личное' }
  }

  // 2. DuckDuckGo: ищем по теме
  let webInfo = ''
  if (analysis.topic) {
    webInfo = await ddgSearch(analysis.topic)
  }

  // 3. Собираем заметку
  const lines = [`# ${analysis.title}`, '', '## 📝 Краткое содержание', analysis.summary, '']
  if (analysis.keyPoints?.length) {
    lines.push('## 🔑 Ключевые тезисы')
    analysis.keyPoints.forEach(p => lines.push(`- ${p}`))
    lines.push('')
  }
  if (webInfo) {
    lines.push('## 🌐 Из интернета')
    lines.push(webInfo.slice(0, 800))
    lines.push('')
  }
  // Секция источников — чистый список URL (всегда есть если пост содержал ссылки)
  if (sourceUrls.length) {
    lines.push('## 🔗 Источники')
    sourceUrls.forEach(u => lines.push(u))
    lines.push('')
  }
  lines.push('---')
  // Оригинальный текст (только первые 300 символов — не обрезаем URL выше)
  const origSnippet = (msg => msg.length > 300 ? msg.slice(0, 300) + '…' : msg)(
    text.split('\n---\n')[0].trim()  // берём только первую часть до [Контент из ...]
  )
  if (origSnippet) lines.push(`*Источник (оригинал):*\n${origSnippet}`)

  const body = lines.join('\n')
  const now  = new Date()
  const data = {
    id: `tg_${Date.now()}`,
    title: analysis.title,
    body,
    color: 'default',
    tag: analysis.tag || 'Личное',
    pinned: false,
    created: now.toISOString(),
    updated: now.toISOString(),
    sources: sourceUrls,   // явный массив URL — используется в Notes screen
  }

  return {
    type: 'note',
    data,
    reply: `📝 Заметка сохранена: «${analysis.title}»\n\nКраткое содержание:\n${analysis.summary}\n\n${analysis.keyPoints?.length ? 'Тезисы:\n' + analysis.keyPoints.map(p=>`• ${p}`).join('\n') : ''}`,
  }
}

// ── Определение — «пост» или нет ──────────────────────────────────────────────
// Пост: пересланное сообщение, сообщение с URL, длинный текст (>200 символов)

function isPost(msg) {
  // Пересланное сообщение (старый и новый API)
  if (msg.forward_from || msg.forward_from_chat || msg.forward_date || msg.forward_origin) return true
  // Есть ссылки (явные или скрытые text_link)
  if (extractUrls(msg).length > 0) return true
  // Есть скрытые ссылки через entities (text_link)
  const entities = msg.entities || msg.caption_entities || []
  if (entities.some(e => e.type === 'text_link')) return true
  // Длинный текст
  const text = msg.text || msg.caption || ''
  if (text.length > 200) return true
  return false
}

// ── Инлайнит скрытые ссылки (text_link entities) в текст ─────────────────────
// "Читать статью" → "Читать статью (https://...)"
// Обрабатывает в обратном порядке, чтобы смещения не съезжали после вставки

function inlineTextLinks(text, entities) {
  if (!entities || !entities.length) return text
  const links = entities
    .filter(e => e.type === 'text_link' && e.url)
    .sort((a, b) => b.offset - a.offset) // обратный порядок
  for (const e of links) {
    const insertPos = e.offset + e.length
    text = text.slice(0, insertPos) + ` (${e.url})` + text.slice(insertPos)
  }
  return text
}

// Собирает весь контент сообщения (текст + содержимое ссылок) в одну строку

async function collectPostContent(msg) {
  const rawText  = msg.text || msg.caption || ''
  const entities = msg.entities || msg.caption_entities || []

  // Инлайним скрытые ссылки прямо в текст, чтобы они были видны при анализе
  const text = inlineTextLinks(rawText, entities)

  const urls  = extractUrls({ ...msg, text }) // передаём обновлённый текст
  const parts = []

  if (text) parts.push(text)

  // Откуда переслано — поддержка и старого (forward_from_chat) и нового (forward_origin) API
  const fwdTitle =
    msg.forward_origin?.chat?.title ||          // новый API: channel
    msg.forward_origin?.sender_user?.first_name || // новый API: user
    msg.forward_from_chat?.title ||              // старый API
    msg.forward_from?.first_name ||
    msg.forward_sender_name ||
    null

  if (fwdTitle) {
    parts.unshift(`[Источник: ${fwdTitle}]`)
  }

  // Содержимое каждой ссылки (до 3 штук)
  const fetched = []
  for (const url of urls.slice(0, 3)) {
    console.log('[post] загружаю:', url)
    const content = await fetchUrl(url)
    if (content && content.length > 100) {
      fetched.push(`[Контент из ${url}]\n${content.slice(0, 4000)}`)
    } else {
      console.log('[post] не удалось загрузить или пустая страница:', url)
      // Добавляем URL в текст явно, чтобы он точно попал в заметку
      fetched.push(`[Ссылка: ${url}]`)
    }
  }
  if (fetched.length) parts.push('\n---\n' + fetched.join('\n\n---\n'))

  return parts.join('\n\n').trim()
}

// ── Обработка команд ─────────────────────────────────────────────────────────

async function handleCmd(msg) {
  const text  = msg.text || msg.caption || ''
  const parts = text.trim().split(/\s+/)
  const cmd   = parts[0]?.toLowerCase().split('@')[0] || ''
  const args  = parts.slice(1).join(' ').trim()

  const HELP = '👋 *Flow — твой личный планировщик*\n\n' +
    '📋 /tasks   — задачи на сегодня\n' +
    '📌 /all     — все незавершённые задачи\n' +
    '🔁 /habits  — привычки сегодня\n' +
    '⏱ /focus   — статистика фокуса\n' +
    '💰 /budget  — бюджет месяца\n' +
    '📊 /summary — сводка дня\n' +
    '🔍 /analyze — анализ поста/статьи → заметка с тезисами\n\n' +
    '✨ *Умный ввод* — просто напиши текстом своими словами,\n' +
    'бот сам поймёт, куда это записать:\n' +
    '• `изучить React` → задача [Учёба]\n' +
    '• `кофе 150₽` → расход в бюджет\n' +
    '• `получил 5000₽` → доход в бюджет\n' +
    '• `встреча с врачом завтра в 15:00` → событие\n' +
    '• `сегодня погулял в парке, было классно` → дневник\n' +
    '• `идея для подарка маме` → заметка\n' +
    '• `купить молоко` → задача [Личное]'

  try {
    if      (cmd === '/start' || cmd === '/help') await tgSend(HELP)
    else if (cmd === '/tasks')   await tgSend(fmtTasks())
    else if (cmd === '/habits')  await tgSend(fmtHabits())
    else if (cmd === '/focus')   await tgSend(fmtFocus())
    else if (cmd === '/budget')  await tgSend(fmtBudget())
    else if (cmd === '/summary') await tgSend(fmtSummary())
    else if (cmd === '/all') {
      const tasks   = store.tasks || []
      const pending = tasks.filter(t => !t.done)
      if (!pending.length) { await tgSend('✅ Нет незавершённых задач!'); return }
      const today = todayKey()
      const lines = [`📋 *Все задачи (${pending.length}):*`]
      pending.slice(0, 20).forEach(t => {
        const tag = t.date ? (t.date < today ? `  🔴_${t.date}_` : `  _${t.date}_`) : ''
        lines.push(`• ${t.text}${tag}`)
      })
      if (pending.length > 20) lines.push(`…ещё ${pending.length - 20}`)
      await tgSend(lines.join('\n'))
    }
    else if (cmd === '/add') {
      const input = args || ''
      if (!input) { await tgSend('❌ Укажи текст: /add Купить хлеб'); return }
      await applyParsed(await smartParse(input))
    }
    else if (cmd === '/analyze') {
      const input = args || ''
      if (!input) { await tgSend('❌ Пришли текст после команды: /analyze <текст поста>'); return }
      await tgSend('🔍 Анализирую, ищу в интернете…')
      const content = await collectPostContent({ text: input })
      await applyParsed(await analyzePost(content))
    }
    else if (!text.startsWith('/')) {
      if (isPost(msg)) {
        const urls = extractUrls(msg)
        const hint = urls.length ? '🔗 Нашёл ссылки — загружаю контент…' : '🔍 Анализирую пост…'
        await tgSend(hint)
        const content = await collectPostContent(msg)
        await applyParsed(await analyzePost(content))
      } else {
        await applyParsed(await smartParse(text))
      }
    }
    else await tgSend('❓ Неизвестная команда. Напиши /help')
  } catch (e) {
    console.log('[bot:cmd]', e.message, e.stack)
    try { await tgApi('sendMessage', { chat_id: CHAT_ID, text: `⚠️ Ошибка обработки: ${e.message}` }) } catch {}
  }
}

// ── Polling ──────────────────────────────────────────────────────────────────

let offset = 0

async function pollLoop() {
  try {
    const res = await tgApi('getUpdates', { offset, timeout: 0, allowed_updates: ['message'] })
    if (res.result?.length) {
      for (const upd of res.result) {
        offset = upd.update_id + 1
        const msg = upd.message
        if (!msg) continue
        if (String(msg.chat.id) !== String(CHAT_ID)) continue
        // Принимаем: текстовые сообщения, подписи к медиа, пересланные
        if (!msg.text && !msg.caption) continue
        await handleCmd(msg)
      }
    }
  } catch {}
  // Следующий poll только после завершения текущего — исключает дублирование
  setTimeout(pollLoop, 1000)
}

pollLoop()
console.log('[flow-bot] polling запущен')

// ── Запланированные уведомления ───────────────────────────────────────────────

function scheduleDaily(hhmm, callback) {
  const [h, m] = hhmm.split(':').map(Number)
  const now  = new Date()
  const next = new Date(now)
  next.setHours(h, m, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  const delayMin = Math.round((next - now) / 60000)
  console.log(`[flow-bot] ${hhmm} → через ${delayMin} мин`)
  setTimeout(() => { callback(); setInterval(callback, 86400000) }, next - now)
}

// ── Утренняя сводка ───────────────────────────────────────────────────────────
scheduleDaily(MORNING_TIME, async () => {
  console.log('[flow-bot] утренняя сводка')
  await tgSend(fmtSummary('🌅 *Утренняя сводка*\n\n'))
  await new Promise(r => setTimeout(r, 1500))
  await tgSend(fmtTasks())
})

// ── Вечерняя сводка ───────────────────────────────────────────────────────────
scheduleDaily(EVENING_TIME, async () => {
  console.log('[flow-bot] вечерняя сводка')
  await tgSend(fmtSummary('🌇 *Вечерняя сводка*\n\n'))
})

// ── Итоги дня в 23:00 ────────────────────────────────────────────────────────
scheduleDaily('23:00', async () => {
  console.log('[flow-bot] итоги дня')
  await tgSend(fmtEndOfDay())
})

// ── Умный часовой напоминатель (только если есть что сказать) ─────────────────
// Запускается каждый час ровно в начале часа, работает с 09 до 22
;(function scheduleHourly() {
  const now  = new Date()
  const next = new Date(now)
  // Следующий :00 (начало следующего часа) + небольшой сдвиг 2 мин чтобы не конфликтовать с scheduleDaily
  next.setMinutes(2, 0, 0)
  next.setHours(next.getHours() + 1)
  const delay = next - now
  console.log(`[flow-bot] часовой напоминатель → через ${Math.round(delay/60000)} мин`)

  setTimeout(async function tick() {
    const h = new Date().getHours()
    // Работаем только с 9 до 22 включительно
    if (h >= 9 && h <= 22) {
      try {
        const msg = buildHourlyReminder()
        if (msg) {
          console.log('[flow-bot] часовое напоминание отправлено')
          await tgSend(msg)
        } else {
          console.log('[flow-bot] часовое напоминание пропущено — нечего сообщать')
        }
      } catch (e) {
        console.log('[flow-bot] hourly error:', e.message)
      }
    }
    // Следующий запуск ровно через час
    setTimeout(tick, 60 * 60 * 1000)
  }, delay)
})()

// ── HTTP сервер — синхронизация из Electron ───────────────────────────────────

const app = express()
app.use(express.json({ limit: '10mb' }))

app.post('/sync', (req, res) => {
  if (req.headers['x-sync-key'] !== SYNC_KEY) return res.status(401).json({ error: 'Unauthorized' })
  const incoming = req.body

  // Мёрджим элементы из очереди которые Electron ещё не забрал через /pending
  if (pendingItems.length) {
    const pending = pendingItems.splice(0)
    for (const item of pending) {
      if (item.type === 'task')     incoming.tasks           = [...(incoming.tasks           || []), item.data]
      if (item.type === 'note')     incoming.notes           = [...(incoming.notes           || []), item.data]
      if (item.type === 'budget')   incoming.budget_txns     = [...(incoming.budget_txns     || []), item.data]
      if (item.type === 'calendar') incoming.calendar_events = [...(incoming.calendar_events || []), item.data]
      if (item.type === 'diary') {
        const entries = incoming.diary_entries || []
        const ex = entries.find(e => e.date === item.data.date)
        if (ex) { ex.body += '\n\n' + item.data.body; ex.updated = item.data.updated }
        else entries.push(item.data)
        incoming.diary_entries = entries
      }
    }
    console.log(`[flow-bot] merged ${pending.length} pending items`)
  }

  store = { ...store, ...incoming }
  saveStore()
  console.log(`[flow-bot] sync: tasks=${(store.tasks||[]).length}`)
  res.json({ ok: true })
})

// Electron забирает очередь накопленных элементов (добавленных пока приложение было закрыто)
app.get('/pending', (req, res) => {
  if (req.headers['x-sync-key'] !== SYNC_KEY) return res.status(401).json({ error: 'Unauthorized' })
  const items = pendingItems.splice(0)
  savePending(pendingItems)
  console.log(`[flow-bot] /pending → отдано ${items.length} элементов`)
  res.json({ items })
})

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }))

// ══════════════════════════════════════════════════════════════════════════════
// ЯНДЕКС АЛИСА — голосовой ввод через Яндекс Станцию / приложение
// ══════════════════════════════════════════════════════════════════════════════

// Убирает Markdown-символы для голосового произношения
function aliceText(s) {
  return (s || '')
    .replace(/[*_`#]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ', ')
    .replace(/•\s*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// Голосовые форматтеры — разговорный стиль без Markdown
function aliceTasks() {
  const today   = todayKey()
  const tasks   = store.tasks || []
  const overdue = tasks.filter(t => !t.done && t.date && t.date < today)
  const todayT  = tasks.filter(t => !t.done && t.date === today)
  const noDate  = tasks.filter(t => !t.done && !t.date)

  if (!overdue.length && !todayT.length && !noDate.length)
    return 'Все задачи выполнены, отличная работа!'

  const parts = []
  if (overdue.length) {
    parts.push(`Просрочено ${overdue.length}: ${overdue.slice(0,3).map(t=>t.text).join(', ')}${overdue.length>3?` и ещё ${overdue.length-3}`:''}`)
  }
  if (todayT.length) {
    parts.push(`На сегодня ${todayT.length}: ${todayT.slice(0,4).map(t=>t.text).join(', ')}${todayT.length>4?` и ещё ${todayT.length-4}`:''}`)
  }
  if (noDate.length && !todayT.length) {
    parts.push(`Без даты ${noDate.length}: ${noDate.slice(0,3).map(t=>t.text).join(', ')}`)
  }
  return parts.join('. ')
}

function aliceCalendar() {
  const today  = todayKey()
  const events = store.calendar_events || []
  const now    = new Date()
  const todayE = events.filter(e => e.date === today)
  const upcomingE = events
    .filter(e => e.date > today)
    .sort((a,b) => a.date.localeCompare(b.date))
    .slice(0, 3)

  if (!todayE.length && !upcomingE.length) return 'На сегодня и в ближайшие дни событий нет.'

  const parts = []
  if (todayE.length) {
    const list = todayE.map(e => e.title + (e.time ? ` в ${e.time}` : '')).join(', ')
    parts.push(`Сегодня ${todayE.length > 1 ? todayE.length + ' события' : 'одно событие'}: ${list}`)
  }
  if (upcomingE.length) {
    const list = upcomingE.map(e => `${e.title} ${e.date}${e.time?' в '+e.time:''}`).join(', ')
    parts.push(`Ближайшие: ${list}`)
  }
  return parts.join('. ')
}

function aliceHabits() {
  const habits = store.habits_v2 || []
  const today  = todayKey()
  if (!habits.length) return 'Привычек пока не добавлено.'
  const done   = habits.filter(h => (h.log||[]).includes(today))
  const left   = habits.filter(h => !(h.log||[]).includes(today))
  const parts  = [`Привычки на сегодня: выполнено ${done.length} из ${habits.length}`]
  if (left.length) parts.push(`Ещё не выполнено: ${left.map(h=>h.name).join(', ')}`)
  return parts.join('. ')
}

function aliceBudget() {
  const txns   = store.budget_txns || []
  const month  = new Date().toISOString().slice(0, 7)
  const mt     = txns.filter(t => t.month === month)
  const income  = mt.filter(t => t.type==='income') .reduce((s,t)=>s+(t.amount||0),0)
  const expense = mt.filter(t => t.type==='expense').reduce((s,t)=>s+(t.amount||0),0)
  const bal     = income - expense
  const parts   = [`Бюджет за ${month.replace('-','й год, ')}-й месяц`]
  if (income)  parts.push(`доходы ${income.toLocaleString('ru')} рублей`)
  if (expense) parts.push(`расходы ${expense.toLocaleString('ru')} рублей`)
  parts.push(`баланс ${bal >= 0 ? 'плюс' : 'минус'} ${Math.abs(bal).toLocaleString('ru')} рублей`)
  return parts.join(', ')
}

function aliceSummary() {
  const today    = todayKey()
  const tasks    = store.tasks     || []
  const habits   = store.habits_v2 || []
  const profile  = store.profile   || {}
  const name     = profile.name ? `, ${profile.name}` : ''
  const overdue  = tasks.filter(t => !t.done && t.date && t.date < today).length
  const todayL   = tasks.filter(t => !t.done && t.date === today).length
  const doneT    = tasks.filter(t => t.done && (t.updated||t.created||'').slice(0,10)===today).length
  const habDone  = habits.filter(h => (h.log||[]).includes(today)).length
  const parts    = [`Привет${name}!`]
  if (doneT)   parts.push(`Выполнено задач сегодня: ${doneT}`)
  if (todayL)  parts.push(`Осталось на сегодня: ${todayL}`)
  if (overdue) parts.push(`Просрочено: ${overdue}`)
  parts.push(`Привычки: ${habDone} из ${habits.length}`)
  return parts.join('. ')
}

// Роутер: читающие запросы или smartParse для записи
async function routeAlice(utterance) {
  const u = (utterance || '').toLowerCase().trim()

  // Читающие команды
  if (/^(задач[иа]?|что (на )?сегодня|план|дела|список)/.test(u))    return aliceTasks()
  if (/^(событи[яе]|календар|расписани|встреч)/.test(u))              return aliceCalendar()
  if (/^(привычк|привычки)/.test(u))                                   return aliceHabits()
  if (/^(бюджет|расход|трат|деньг|финанс)/.test(u))                   return aliceBudget()
  if (/^(сводк|итог|как дела|что сделал|резюм|обзор)/.test(u))        return aliceSummary()

  // Запись через smartParse (тот же pipeline что и Telegram)
  try {
    const parsed = await smartParse(utterance)
    // Применяем к store + pendingItems, но БЕЗ отправки в Telegram
    const { type, data } = parsed
    if (type === 'task') {
      if (!store.tasks) store.tasks = []
      store.tasks.push(data)
    } else if (type === 'note') {
      if (!store.notes) store.notes = []
      store.notes.push(data)
    } else if (type === 'budget') {
      if (!store.budget_txns) store.budget_txns = []
      store.budget_txns.push(data)
    } else if (type === 'calendar') {
      if (!store.calendar_events) store.calendar_events = []
      store.calendar_events.push(data)
    } else if (type === 'diary') {
      if (!store.diary_entries) store.diary_entries = []
      const ex = store.diary_entries.find(e => e.date === data.date)
      if (ex) { ex.body += '\n\n' + data.body; ex.updated = data.updated }
      else store.diary_entries.push(data)
    }
    pendingItems.push({ type, data })
    savePending(pendingItems)
    saveStore()
    return aliceText(parsed.reply)
  } catch (e) {
    console.log('[alice:route]', e.message)
    return 'Не удалось обработать команду, попробуй ещё раз.'
  }
}

// Endpoint для навыка Яндекс Диалогов
// URL: POST /alice/:token  — токен защищает от посторонних запросов
app.post('/alice/:token', async (req, res) => {
  // Проверяем секретный токен в URL
  if (!ALICE_TOKEN || req.params.token !== ALICE_TOKEN) {
    console.log('[alice] неверный токен')
    return res.status(403).json({
      version: '1.0',
      response: { text: 'Нет доступа.', end_session: true },
    })
  }

  const body      = req.body || {}
  const utterance = (body.request?.original_utterance || '').trim()
  const isNew     = body.session?.new === true

  console.log(`[alice] utterance="${utterance}" new=${isNew}`)

  let text
  try {
    if (isNew && !utterance) {
      // Алиса только запустила навык, пользователь ещё ничего не сказал
      text = 'Flow включён. Говори команду — добавлю задачу, событие, расход или прочитаю план на сегодня.'
    } else {
      text = await routeAlice(utterance)
    }
  } catch (e) {
    console.log('[alice] error:', e.message)
    text = 'Произошла ошибка. Попробуй позже.'
  }

  res.json({
    version: '1.0',
    response: {
      text,
      tts:         text,
      end_session: true,   // завершаем сессию после каждого ответа
    },
  })
})

app.listen(PORT, () => console.log(`[flow-bot] HTTP на порту ${PORT}`))
