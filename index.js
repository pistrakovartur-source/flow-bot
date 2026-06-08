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

// ── Умный парсинг входящих сообщений ─────────────────────────────────────────

function tagEmoji(tag) {
  const map = { 'Учёба':'📚', 'Работа':'💼', 'Здоровье':'💪', 'Финансы':'💰', 'Личное':'🏠', 'Проект':'🎯' }
  return map[tag] || '📌'
}

function detectCategory(lower) {
  if (/еда|кафе|ресторан|кофе|обед|ужин|завтрак|продукты|пицца|доставк|суши|фастфуд/.test(lower)) return 'Еда'
  if (/такси|метро|автобус|транспорт|бензин|парковк|uber|каршер|электричк/.test(lower)) return 'Транспорт'
  if (/кино|игры|развлечен|подписк|netflix|spotify|стриминг|концерт|театр/.test(lower)) return 'Развлечения'
  if (/врач|аптек|здоровь|лекарств|анализ|клиник|стоматол/.test(lower)) return 'Здоровье'
  if (/одежд|обувь|шопинг/.test(lower)) return 'Одежда'
  if (/зарплат|фриланс|доход|заработ|гонорар|выплат/.test(lower)) return 'Доходы'
  if (/связь|интернет|мобильн/.test(lower)) return 'Связь'
  if (/аренд|квартир|комуналк|жкх/.test(lower)) return 'Жильё'
  return 'Прочее'
}

function detectTaskTag(lower) {
  if (/изучи|выучи|прочитать|разобраться|туториал|лекц|книга|учёба|учиться|пройти курс/.test(lower)) return 'Учёба'
  if (/работ|проект|написать|отправить|подготовить|отчёт|презентаци|митинг|созвон/.test(lower)) return 'Работа'
  if (/зал|тренировк|врач|таблетк|здоровь|диета|бегать|спорт|упражнен|пробежк/.test(lower)) return 'Здоровье'
  if (/купить(?! курс| книг)|оплатить|счёт|финанс|банк/.test(lower)) return 'Финансы'
  return 'Личное'
}

function parseRuDate(text) {
  const lower = text.toLowerCase()
  const now   = new Date()
  const pad   = n => String(n).padStart(2, '0')
  const fmt   = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`
  if (/\bсегодня\b/.test(lower)) return fmt(now)
  const tom = new Date(now); tom.setDate(tom.getDate()+1)
  if (/\bзавтра\b/.test(lower)) return fmt(tom)
  const dtom = new Date(now); dtom.setDate(dtom.getDate()+2)
  if (/\bпослезавтра\b/.test(lower)) return fmt(dtom)
  const dows = [['воскресен',0],['понедельник',1],['вторник',2],['среду',3],['среда',3],['четверг',4],['пятниц',5],['суббот',6]]
  for (const [name, dow] of dows) {
    if (lower.includes(name)) {
      const d = new Date(now); d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7 || 7)); return fmt(d)
    }
  }
  const months = [['январ',0],['феврал',1],['март',2],['апрел',3],['мая',4],['май',4],['июн',5],['июл',6],['август',7],['сентябр',8],['октябр',9],['ноябр',10],['декабр',11]]
  const dm = lower.match(/(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?/)
  if (dm) {
    const me = months.find(([k]) => dm[2].startsWith(k))
    if (me) {
      const year = dm[3] ? parseInt(dm[3]) : now.getFullYear()
      const d = new Date(year, me[1], parseInt(dm[1]))
      if (d < now && !dm[3]) d.setFullYear(d.getFullYear()+1)
      return fmt(d)
    }
  }
  return null
}

function parseRuTime(text) {
  const m = text.match(/\b(\d{1,2}):(\d{2})\b/)
  if (m) return `${m[1].padStart(2,'0')}:${m[2]}`
  const m2 = text.match(/в\s+(\d{1,2})\s*(?:утра|часов?|дня|вечера|ночи)/i)
  if (m2) {
    let h = parseInt(m2[1])
    if (/вечера|ночи/.test(text) && h < 12) h += 12
    else if (/дня/.test(text) && h < 12 && h >= 1) h += 12
    return `${String(h).padStart(2,'0')}:00`
  }
  return null
}

function isCalendar(t, lower) {
  const hasTime     = /\b\d{1,2}:\d{2}\b/.test(t) || /в\s+\d{1,2}\s*(?:утра|часов?|дня|вечера|ночи)/i.test(t)
  const hasDate     = /\b(завтра|послезавтра|сегодня|понедельник|вторник|среду?|четверг|пятниц[уа]|суббот[уа]|воскресенье|\d{1,2}\s+[а-яё]{3,})/i.test(lower)
  const hasEventWrd = /\b(запись|встреча|встречу|встретиться|созвон|звонок|митинг|собрание|мероприятие|событие|визит|приём|прием|конференция|вечеринк|концерт|спектакль|экзамен|защита|дедлайн|поездка|рейс|вылет|прилёт|прилет|день\s*рожден)\b/i.test(lower)
  return hasEventWrd && (hasDate || hasTime) || (hasTime && hasDate)
}

function isDiary(t, lower) {
  if (/^(?:сегодня|вчера)\s+я\b/i.test(t)) return true
  if (/^сегодня\s+(?:был[аи]?|ходил[а]?|гулял[а]?|посетил[а]?|поел[а]?|провел[а]?)/i.test(t)) return true
  if (/\bя\s+(?:погулял|погуляла|сходил|сходила|посетил|посетила|побывал|побывала|провел|провела|встретил|встретила|поговорил|поговорила|поел|поела|выспался|выспалась|отдохнул|отдохнула|поработал|поработала|почитал|почитала|посмотрел|посмотрела|написал|написала)\b/i.test(lower)) return true
  if (/\b(?:настроение сегодня|чувствую себя|был[а]? продуктивн|хороший день|плохой день|устал[а]?$|неплохой день|день прошёл|день прошел)\b/i.test(lower)) return true
  return false
}

function cleanCalendarTitle(t) {
  return t
    .replace(/\b\d{1,2}:\d{2}\b/g, '')
    .replace(/\b\d{1,2}\s+[а-яёА-ЯЁ]{3,}(?:\s+\d{4})?\b/g, '')
    .replace(/\b(?:сегодня|завтра|послезавтра)\b/gi, '')
    .replace(/\bв\s+(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)\b/gi, '')
    .replace(/\s+/g, ' ').trim() || t.trim()
}

function smartParse(text) {
  const t     = text.trim()
  const lower = t.toLowerCase()
  const today = todayKey()
  const now   = new Date()

  // ── 1. Календарь ──────────────────────────────────────────────────────────
  if (isCalendar(t, lower)) {
    const date  = parseRuDate(t) || today
    const time  = parseRuTime(t) || ''
    const title = cleanCalendarTitle(t)
    return {
      type: 'calendar',
      data: { id:`tg_${Date.now()}`, title, date, time, endTime:'', color:'#5b8dee', allDay:!time, desc:'', location:'', repeat:'none', repeatEnd:'' },
      reply: `📅 *Событие добавлено*\n«${title}»\n📆 ${date}${time?' в '+time:''}`,
    }
  }

  // ── 2. Бюджет ─────────────────────────────────────────────────────────────
  const moneyMatch = t.match(/(\d[\d\s,.]*)\s*(?:₽|р(?:уб(?:лей|ля|\.)?)?(?:\b|$))/i)
  if (moneyMatch) {
    const amount   = parseFloat(moneyMatch[1].replace(/\s/g,'').replace(',','.'))
    const isIncome = /получил|зарплат|доход|заработал|выплат|пришло|перевод/i.test(lower)
    const note     = t.replace(moneyMatch[0],'').replace(/^\s*[-—:,]\s*/,'').trim() || t
    const category = detectCategory(lower)
    return {
      type: 'budget',
      data: { id:`tg_${Date.now()}`, type:isIncome?'income':'expense', amount, category, note, date:today, month:today.slice(0,7), created:now.toISOString() },
      reply: `💰 *${isIncome?'Доход':'Расход'} ${amount.toLocaleString('ru')} ₽*\nКатегория: ${category}\nЗаметка: ${note}`,
    }
  }

  // ── 3. Дневник ────────────────────────────────────────────────────────────
  if (isDiary(t, lower)) {
    return {
      type: 'diary',
      data: { id:`tg_${Date.now()}`, date:today, body:t, mood:null, created:now.toISOString(), updated:now.toISOString() },
      reply: `📖 *Запись в дневник*\n«${t.slice(0,80)}${t.length>80?'…':''}»`,
    }
  }

  // ── 4. Заметка ────────────────────────────────────────────────────────────
  if (/^(?:идея|заметка|мысль|запиши?|записать)[:\s]/i.test(t)) {
    const body  = t.replace(/^(?:идея|заметка|мысль|запиши?|записать)[:\s]*/i,'').trim()
    const title = body.split('\n')[0].slice(0,60) || 'Без заголовка'
    const tag   = /идея/i.test(t)?'Идея':/работ/i.test(lower)?'Работа':/учёб|учи/i.test(lower)?'Учёба':'Личное'
    return {
      type: 'note',
      data: { id:`tg_${Date.now()}`, title, body, color:'#1e2433', tag, pinned:false, created:now.toISOString(), updated:now.toISOString() },
      reply: `📝 *Заметка сохранена*\n«${title}»`,
    }
  }

  // ── 5. Задача ─────────────────────────────────────────────────────────────
  const tag      = detectTaskTag(lower)
  const priority = /срочно|важно|критично|asap/i.test(lower) ? 'high' : 'medium'
  const cleanText = t.replace(/^(?:изучить?|прочитать?|посмотреть?|сделать?|добавить?|напомнить?|купить?)\s+/i,'').replace(/\s+(?:срочно|важно)$/i,'').trim() || t
  return {
    type: 'task',
    data: { id:`tg_${Date.now()}`, text:cleanText, tag, priority, date:today, done:false, created:now.toISOString(), subtasks:[] },
    reply: `${tagEmoji(tag)} *Задача [${tag}]* добавлена:\n«${cleanText}»`,
  }
}

// ── Утилиты ──────────────────────────────────────────────────────────────────
const todayKey = () => new Date().toISOString().slice(0, 10)
const monthKey = () => new Date().toISOString().slice(0, 7)

// ── Telegram API: прокси только если задан PROXY_URL (локально), на облаке без прокси ──
const tgAgent = process.env.PROXY_URL ? new HttpsProxyAgent(process.env.PROXY_URL) : undefined

function tgApi(method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params)
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${TOKEN}/${method}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      ...(tgAgent ? { agent: tgAgent } : {}),
      timeout:  12000,
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())) }
        catch (e) { reject(e) }
      })
    })
    req.on('error',   reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(body)
    req.end()
  })
}

async function tgSend(text) {
  try {
    await tgApi('sendMessage', { chat_id: CHAT_ID, text, parse_mode: 'Markdown' })
  } catch (e) {
    console.log('[tg:send]', e.message)
  }
}

// ── Форматтеры ───────────────────────────────────────────────────────────────

function fmtTasks() {
  const tasks   = store.tasks || []
  const today   = todayKey()
  const overdue = tasks.filter(t => !t.done && t.date && t.date < today)
  const todayT  = tasks.filter(t => !t.done && t.date === today)
  const noDate  = tasks.filter(t => !t.done && !t.date)
  if (!overdue.length && !todayT.length && !noDate.length) return '✅ Все задачи выполнены!'
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
  return ['⏱ *Фокус*',
    `📅 Сегодня: ${d.sessions} сессий, ${d.minutes} мин`,
    `📊 Всего:   ${stats.sessions || 0} сессий, ${totalH} ч`,
  ].join('\n')
}

function fmtBudget() {
  const txns    = store.budget_txns || []
  const month   = monthKey()
  const mt      = txns.filter(t => t.month === month)
  const income  = mt.filter(t => t.type === 'income') .reduce((s, t) => s + (t.amount || 0), 0)
  const expense = mt.filter(t => t.type === 'expense').reduce((s, t) => s + (t.amount || 0), 0)
  const balance = income - expense
  return [`💰 *Бюджет ${month}*`,
    `📈 Доходы:  ${income.toLocaleString('ru')} ₽`,
    `📉 Расходы: ${expense.toLocaleString('ru')} ₽`,
    `${balance >= 0 ? '✅' : '⚠️'} Баланс:   ${balance.toLocaleString('ru')} ₽`,
  ].join('\n')
}

function fmtSummary(prefix = '') {
  const profile  = store.profile   || {}
  const tasks    = store.tasks     || []
  const habits   = store.habits_v2 || []
  const today    = todayKey()
  const name     = profile.name || 'Дима'
  const h        = new Date().getHours()
  const greeting = h < 12 ? 'Доброе утро' : h < 17 ? 'Добрый день' : 'Добрый вечер'
  const overdue   = tasks.filter(t => !t.done && t.date && t.date < today).length
  const todayLeft = tasks.filter(t => !t.done && t.date === today).length
  const doneToday = tasks.filter(t =>  t.done && (t.updated || t.created || '').slice(0,10) === today).length
  const habDone   = habits.filter(h => (h.log || []).includes(today)).length
  const lines = [`${prefix}👋 ${greeting}, ${name}!`]
  if (overdue   > 0) lines.push(`🔴 Просрочено: ${overdue} задач`)
  if (todayLeft > 0) lines.push(`📅 На сегодня: ${todayLeft} задач`)
  if (doneToday > 0) lines.push(`✅ Выполнено:  ${doneToday} задач`)
  lines.push(`🔁 Привычки: ${habDone}/${habits.length}`)
  return lines.join('\n')
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
    '✨ *Умный ввод* — просто напиши текстом:\n' +
    '• `изучить React` → задача [Учёба]\n' +
    '• `кофе 150₽` → расход в бюджет\n' +
    '• `получил 5000₽` → доход в бюджет\n' +
    '• `идея: название` → заметка\n' +
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
      await applyParsed(smartParse(input))
    }
    else if (!text.startsWith('/')) {
      await applyParsed(smartParse(text))
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
