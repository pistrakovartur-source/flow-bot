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

function smartParse(text) {
  const t     = text.trim()
  const lower = t.toLowerCase()
  const today = todayKey()

  // Бюджет: есть сумма + валюта
  const moneyMatch = t.match(/(\d[\d\s,.]*)\s*(?:₽|р(?:уб(?:лей|ля|\.)?)?(?:\b|$))/i)
  if (moneyMatch) {
    const amount   = parseFloat(moneyMatch[1].replace(/[\s]/g, '').replace(',', '.'))
    const isIncome = /получил|зарплат|доход|заработал|выплат|пришло|перевод/i.test(lower)
    const note     = t.replace(moneyMatch[0], '').replace(/^\s*[-—:,]\s*/, '').trim() || t
    const category = detectCategory(lower)
    return {
      type: 'budget',
      data: {
        id: `tg_${Date.now()}`, type: isIncome ? 'income' : 'expense',
        amount, category, note, date: today, month: today.slice(0, 7),
        created: new Date().toISOString(),
      },
      reply: `💰 *${isIncome ? 'Доход' : 'Расход'} ${amount.toLocaleString('ru')} ₽* добавлен\nКатегория: ${category}\nЗаметка: ${note}`,
    }
  }

  // Заметка: начинается с ключевого слова
  if (/^(?:идея|заметка|мысль|запиши?|записать)[:\s]/i.test(t)) {
    const body  = t.replace(/^(?:идея|заметка|мысль|запиши?|записать)[:\s]*/i, '').trim()
    const title = body.split('\n')[0].slice(0, 60) || 'Без заголовка'
    const tag   = /идея/i.test(t) ? 'Идея' : /работ/i.test(lower) ? 'Работа' : /учёб|учи/i.test(lower) ? 'Учёба' : 'Личное'
    return {
      type: 'note',
      data: {
        id: `tg_${Date.now()}`, title, body, color: '#1e2433',
        tag, pinned: false,
        created: new Date().toISOString(), updated: new Date().toISOString(),
      },
      reply: `📝 *Заметка сохранена*\n«${title}»`,
    }
  }

  // Задача: всё остальное
  const tag      = detectTaskTag(lower)
  const priority = /срочно|важно|критично|asap/i.test(lower) ? 'high' : 'medium'
  const cleanText = t
    .replace(/^(?:изучить?|прочитать?|посмотреть?|сделать?|добавить?|напомнить?|купить?)\s+/i, '')
    .replace(/\s+(?:срочно|важно)$/i, '')
    .trim() || t
  return {
    type: 'task',
    data: {
      id: `tg_${Date.now()}`, text: cleanText, tag, priority,
      date: today, done: false, created: new Date().toISOString(), subtasks: [],
    },
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
      // /add работает как умный парсинг с аргументом
      const input = args || ''
      if (!input) { await tgSend('❌ Укажи текст: /add Купить хлеб'); return }
      const parsed = smartParse(input)
      if (parsed.type === 'task') {
        if (!store.tasks) store.tasks = []
        store.tasks.push(parsed.data)
      } else if (parsed.type === 'note') {
        if (!store.notes) store.notes = []
        store.notes.push(parsed.data)
      } else if (parsed.type === 'budget') {
        if (!store.budget_txns) store.budget_txns = []
        store.budget_txns.push(parsed.data)
      }
      pendingItems.push({ type: parsed.type, data: parsed.data })
      await tgSend(parsed.reply)
    }
    else if (!text.startsWith('/')) {
      // Свободный текст → умный парсинг
      const parsed = smartParse(text)
      if (parsed.type === 'task') {
        if (!store.tasks) store.tasks = []
        store.tasks.push(parsed.data)
      } else if (parsed.type === 'note') {
        if (!store.notes) store.notes = []
        store.notes.push(parsed.data)
      } else if (parsed.type === 'budget') {
        if (!store.budget_txns) store.budget_txns = []
        store.budget_txns.push(parsed.data)
      }
      pendingItems.push({ type: parsed.type, data: parsed.data })
      await tgSend(parsed.reply)
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
      if (item.type === 'task')   incoming.tasks      = [...(incoming.tasks      || []), item.data]
      if (item.type === 'note')   incoming.notes      = [...(incoming.notes      || []), item.data]
      if (item.type === 'budget') incoming.budget_txns = [...(incoming.budget_txns || []), item.data]
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
