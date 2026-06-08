const express              = require('express')
const https                = require('https')
const { HttpsProxyAgent }  = require('https-proxy-agent')

const TOKEN        = process.env.BOT_TOKEN    || ''
const CHAT_ID      = process.env.CHAT_ID      || ''
const SYNC_KEY     = process.env.SYNC_KEY     || 'changeme'
const MORNING_TIME = process.env.MORNING_TIME || '09:00'
const EVENING_TIME = process.env.EVENING_TIME || '20:00'
const PORT         = process.env.PORT         || 3001

if (!TOKEN || !CHAT_ID) {
  console.error('[flow-bot] BOT_TOKEN и CHAT_ID обязательны')
  process.exit(1)
}

// ── In-memory store (данные синхронизируются из Electron) ────────────────────
let store = {}

// Очередь элементов, добавленных через бот пока приложение было закрыто
let pendingItems = []

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
  await tgSend(reply)
}

// ── Обработка команд ─────────────────────────────────────────────────────────

async function handleCmd(text) {
  const parts = text.trim().split(/\s+/)
  const cmd   = parts[0].toLowerCase().split('@')[0]
  const args  = parts.slice(1).join(' ').trim()

  const HELP = '👋 *Flow — твой личный планировщик*\n\n' +
    '📋 /tasks   — задачи на сегодня\n' +
    '📌 /all     — все незавершённые задачи\n' +
    '🔁 /habits  — привычки сегодня\n' +
    '⏱ /focus   — статистика фокуса\n' +
    '💰 /budget  — бюджет месяца\n' +
    '📊 /summary — сводка дня\n\n' +
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
    else if (!text.startsWith('/')) {
      await applyParsed(await smartParse(text))
    }
    else await tgSend('❓ Неизвестная команда. Напиши /help')
  } catch (e) {
    console.log('[bot:cmd]', e.message)
  }
}

// ── Polling ──────────────────────────────────────────────────────────────────

let offset = 0

async function pollOnce() {
  try {
    const res = await tgApi('getUpdates', { offset, timeout: 0, allowed_updates: ['message'] })
    if (!res.result?.length) return
    for (const upd of res.result) {
      offset = upd.update_id + 1
      const msg = upd.message
      if (!msg?.text) continue
      if (String(msg.chat.id) !== String(CHAT_ID)) continue
      await handleCmd(msg.text)
    }
  } catch {}
}

setInterval(pollOnce, 2000)
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

scheduleDaily(MORNING_TIME, async () => {
  console.log('[flow-bot] утренняя сводка')
  await tgSend(fmtSummary('🌅 *Утренняя сводка*\n\n'))
  setTimeout(() => tgSend(fmtTasks()), 1500)
})

scheduleDaily(EVENING_TIME, async () => {
  console.log('[flow-bot] вечерняя сводка')
  await tgSend(fmtSummary('🌙 *Вечерняя сводка*\n\n'))
})

setInterval(async () => {
  const h = new Date().getHours()
  if (h < 9 || h > 22) return
  const tasks  = store.tasks || []
  const today  = todayKey()
  const overdue = tasks.filter(t => !t.done && t.date && t.date < today)
  if (!overdue.length) return
  const lines = [`⚠️ *Просроченные задачи (${overdue.length}):*`]
  overdue.slice(0, 5).forEach(t => lines.push(`• ${t.text}  _${t.date}_`))
  if (overdue.length > 5) lines.push(`…ещё ${overdue.length - 5}`)
  await tgSend(lines.join('\n'))
}, 2 * 60 * 60 * 1000)

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
  console.log(`[flow-bot] sync: tasks=${(store.tasks||[]).length}`)
  res.json({ ok: true })
})

// Electron забирает очередь накопленных элементов (добавленных пока приложение было закрыто)
app.get('/pending', (req, res) => {
  if (req.headers['x-sync-key'] !== SYNC_KEY) return res.status(401).json({ error: 'Unauthorized' })
  const items = pendingItems.splice(0)
  console.log(`[flow-bot] /pending → отдано ${items.length} элементов`)
  res.json({ items })
})

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }))

app.listen(PORT, () => console.log(`[flow-bot] HTTP на порту ${PORT}`))
