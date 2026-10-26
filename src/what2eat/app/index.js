// 今天吃什么
//
// 从 QixinBot 的 what2eat 移植。原版用 setInterval + 正则匹配自然语言，
// 这里改成声明式命令（吃什么/喝什么/加菜/删菜/我的菜），定时提醒走 [[schedule]]。
import { serve, host, chatOf } from '../_sdk/qixin.mjs'
import { FOOD, DRINKS } from './data.js'

let settings = {}

const pick = (list) => list[Math.floor(Math.random() * list.length)]

// 原版正则：从句式上就限定死了，不会误伤「我要吃饭了」这种
const MATCH = /^(?:(?:(今天|中午|午饭|晚上|晚饭|夜宵|早餐|早饭))?(吃|喝)(?:什么|啥|点啥)[呀啊哦呢\s？?！!。]*|(加菜|删菜|我的菜)(?:[：:\s]+([\s\S]*))?)$/

// ---------------------------------------------------------------- 数据

function parseList(value) {
  return String(value ?? '')
    .split(/[|｜,，\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

async function customFoods() {
  const raw = await host.storage.get('custom')
  return Array.isArray(raw) ? raw : []
}

async function saveCustom(list) {
  await host.storage.set('custom', [...new Set(list)])
}

async function allFood() {
  return [...new Set([...FOOD, ...(await customFoods())])]
}

// ---------------------------------------------------------------- 推荐

function mealOf(word) {
  const w = String(word || '')
  if (w.includes('早')) return '早饭'
  if (w.includes('午')) return '午饭'
  if (w.includes('晚')) return '晚饭'
  if (w.includes('夜宵')) return '夜宵'
  const hour = new Date().getHours()
  if (hour < 10) return '早饭'
  if (hour < 15) return '午饭'
  if (hour < 21) return '晚饭'
  return '夜宵'
}

async function eatSuggestion(meal) {
  const food = pick(await allFood())
  return pick([
    `${meal}吃点「${food}」怎么样？`,
    `要不${meal}就「${food}」吧，别纠结啦。`,
    `我看「${food}」挺合适的，${meal}就它？`,
    `${meal}吃「${food}」吧，热乎的。`,
  ])
}

function drinkSuggestion() {
  const brand = pick(Object.keys(DRINKS))
  return `喝「${brand} · ${pick(DRINKS[brand])}」？`
}

// ---------------------------------------------------------------- 权限

function parseIds(value) {
  return String(value ?? '')
    .split(/[|｜,，\s]+/)
    .map((x) => x.trim())
    .filter((x) => /^\d+$/.test(x))
    .map(Number)
}

function canEditCustom(session) {
  const uid = Number(session.user_id) || 0
  // 没配 ownerQQ 时退化成"谁都别改"，避免陌生人乱加菜
  const owners = parseIds(settings.ownerQQ || process.env.QIXIN_OWNER)
  if (!owners.length) return false
  if (owners.includes(uid)) return true
  return parseIds(settings.allowCustomUsers).includes(uid)
}

// ---------------------------------------------------------------- 提醒

function todayKey() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ''))
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

async function remind() {
  if (settings.remindEnabled === false) return

  const now = new Date()
  const current = now.getHours() * 60 + now.getMinutes()
  const state = (await host.storage.get('remindState')) || {}
  const day = todayKey()

  const targets = []
  for (const id of parseIds(settings.ownerQQ || process.env.QIXIN_OWNER)) {
    targets.push({ chat_type: 'private', chat_id: id })
  }
  for (const id of parseIds(settings.remindGroups)) {
    targets.push({ chat_type: 'group', chat_id: id })
  }
  if (!targets.length) return

  for (const [key, time, text] of [
    ['lunch', settings.lunchTime || '11:30', '中午啦，该吃饭了，别饿着。'],
    ['dinner', settings.dinnerTime || '17:30', '晚饭时间到，别忙忘了吃饭。'],
  ]) {
    const target = minutesOf(time)
    if (target === null) continue
    // 到点后 60 分钟内只提醒一次
    if (current < target || current > target + 60) continue
    if (state[key] === day) continue

    const message = `${text}要不要吃「${pick(await allFood())}」？`
    let sent = false
    for (const t of targets) {
      try {
        await host.sendMessage(t, [{ type: 'text', data: { text: message } }])
        sent = true
      } catch (err) {
        host.log('warn', `提醒 ${t.chat_type}:${t.chat_id} 失败: ${err.message}`)
      }
    }
    if (sent) {
      state[key] = day
      await host.storage.set('remindState', state)
      host.log('info', `已发送${key === 'lunch' ? '午饭' : '晚饭'}提醒`)
    }
  }
}

// ---------------------------------------------------------------- 服务

const app = {
  async initialize({ settings: initial }) {
    settings = initial || {}
    host.log('info', '今天吃什么启动')
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...values }
    return { ok: true }
  },

  async handle_message({ session }) {
    const text = (session.text || '').trim()
    if (!text) return { handled: false }

    // 原版正则：吃/喝 + 什么/啥/点啥，允许"今天/中午/晚上"前缀和语气词尾巴
    const m = MATCH.exec(text)
    if (!m) return { handled: false }

    // 第一组：吃/喝
    if (m[2]) {
      if (m[2] === '喝') {
        await host.reply(chatOf(session), drinkSuggestion())
      } else {
        await host.reply(chatOf(session), await eatSuggestion(mealOf(m[1] || '')))
      }
      return { handled: true }
    }

    // 第二组：加菜 / 删菜 / 我的菜
    {
      const action = m[3]
      const value = (m[4] || '').trim()

      if (action === '我的菜') {
        const custom = await customFoods()
        await host.reply(
          chatOf(session),
          custom.length ? `自定义菜谱（${custom.length}）：\n${custom.join('、')}` : '还没有自定义的菜，发「加菜 麻辣烫」试试',
        )
        return { handled: true }
      }

      if (!canEditCustom(session)) {
        await host.reply(chatOf(session), '只有主人能改菜谱哦')
        return { handled: true }
      }

      if (!value) {
        await host.reply(chatOf(session), `用法：${action} 菜名`)
        return { handled: true }
      }
      if (value.length > 30) {
        await host.reply(chatOf(session), '菜名太长了（最多 30 字）')
        return { handled: true }
      }

      const custom = await customFoods()
      if (action === '加菜') {
        if ((await allFood()).includes(value)) {
          await host.reply(chatOf(session), `「${value}」已经在菜单里了`)
          return { handled: true }
        }
        await saveCustom([...custom, value])
        await host.reply(chatOf(session), `已把「${value}」加进菜谱，现在有 ${custom.length + 1} 道自定义菜`)
        return { handled: true }
      }

      if (!custom.includes(value)) {
        await host.reply(chatOf(session), `自定义菜里没有「${value}」`)
        return { handled: true }
      }
      await saveCustom(custom.filter((x) => x !== value))
      await host.reply(chatOf(session), `已删掉「${value}」`)
      return { handled: true }
    }

    return { handled: false }
  },

  async call_tool({ name, args }) {
    if (name === 'what_to_eat') {
      const meal = String(args?.meal ?? '').trim()
      const text = meal === '喝' || meal === '饮料' ? drinkSuggestion() : await eatSuggestion(meal || mealOf(''))
      return { ok: true, data: { text } }
    }

    if (name === 'w2e.custom.list') {
      const custom = await customFoods()
      return { ok: true, data: { custom, total: (await allFood()).length } }
    }

    if (name === 'w2e.custom.add') {
      const value = String(args?.name ?? '').trim()
      if (!value) return { ok: false, error: '需要 name' }
      if (value.length > 30) return { ok: false, error: '菜名最多 30 字' }
      const custom = await customFoods()
      if ((await allFood()).includes(value)) return { ok: false, error: `「${value}」已经在菜单里了` }
      await saveCustom([...custom, value])
      return { ok: true, data: { count: custom.length + 1 } }
    }

    if (name === 'w2e.custom.remove') {
      const value = String(args?.name ?? '').trim()
      const custom = await customFoods()
      if (!custom.includes(value)) return { ok: false, error: `自定义菜里没有「${value}」` }
      await saveCustom(custom.filter((x) => x !== value))
      return { ok: true, data: { count: custom.length - 1 } }
    }

    return { ok: false, error: `未知工具 ${name}` }
  },

  async run_task({ task }) {
    if (task !== 'remind') return { ok: true }
    try {
      await remind()
    } catch (err) {
      host.log('debug', `提醒检查失败: ${err.message}`)
    }
    return { ok: true }
  },
}
serve(app)

// ---- 插件自管定时（发行版）----
// 开发线（QIXIN_EXPERIMENTAL=1）由框架的 [[schedule]] 接管，这里不重复启动。
const __SELF_TIMER = !process.env.QIXIN_EXPERIMENTAL
function __runTask(task) {
  if (!__SELF_TIMER) return
  Promise.resolve(app.run_task({ task })).catch((e) => {
    host.log('warn', `定时 ${task} 执行失败: ${e && e.message ? e.message : e}`)
  })
}
__SELF_TIMER && setInterval(() => __runTask('remind'), 30 * 1000)
if (__SELF_TIMER) host.log('info', '发行版自管定时已启动')
