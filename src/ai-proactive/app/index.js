// 主动发言：群里冷场太久时，她会自己开个话头。
//
// 为什么独立插件：它要读"所有群的最后消息时间"，和对话逻辑无关；
// 塞进 ai-chat 会把"回消息"和"找机会说话"两件事搅在一起。
//
// 判断顺序（任何一条不过就不说）：
//   1. 开关打开、当前不在免打扰时段、这个群在允许名单里
//   2. 距最后一条消息 ≥ min_silence_min
//   3. 距上次主动发言 ≥ group_cooldown_min，且今天没超过 max_per_day
//   4. 掷骰子：chance_pct

import { serve, host } from '../_sdk/qixin.mjs'

let settings = {}
let chatReady = null

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function db(op, sql, params = []) {
  const r = await host.capability('db.sqlite', { op, sql, params })
  if (!r?.ok) throw new Error(r?.error || 'db.sqlite 调用失败')
  return r.data
}

function allowList() {
  return String(settings.allow_groups || '')
    .split(/[,，\s]+/)
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
}

function inQuietHours() {
  const start = Number(settings.quiet_start ?? 0)
  const end = Number(settings.quiet_end ?? 8)
  const h = new Date().getHours()
  if (start === end) return false
  // 跨零点：比如 23 点到 8 点
  if (start > end) return h >= start || h < end
  return h >= start && h < end
}

// 每个群的状态：上次主动时间 + 今天发了几次
async function stateOf(chatID) {
  const raw = await host.storage.get(`pc:${chatID}`)
  const s = raw && typeof raw === 'object' ? raw : {}
  if (s.day !== today()) return { last: s.last || 0, day: today(), count: 0 }
  return { last: s.last || 0, day: s.day, count: s.count || 0 }
}

async function saveState(chatID, st) {
  await host.storage.set(`pc:${chatID}`, st)
}

// 冷场的群：按最后一条消息排序
async function silentGroups(minSilenceMin) {
  const cutoff = nowSec() - Math.max(1, minSilenceMin) * 60
  const r = await db(
    'all',
    `SELECT chat_type, chat_id, MAX(ts) AS last, COUNT(*) AS n
     FROM ai_message
     WHERE chat_type = 'group'
     GROUP BY chat_type, chat_id
     HAVING last < ?
     ORDER BY last ASC
     LIMIT 20`,
    [cutoff],
  )
  return r.rows || []
}

// 让 ai-chat 生成并发送一条（带人设、生活状态、群语气）
async function speak(chatID, reason) {
  const prompt =
    `现在群里已经安静了一会儿。你是群里的一员，主动说一句自然的话开个话头：` +
    `可以聊你此刻在做什么、随口问一句、或者接着之前的话题。` +
    `不要提"我注意到群里很安静"这种机器味的话，一两句就够。` +
    (reason ? `（背景：${reason}）` : '')

  const r = await host.capability('ai.chat', {
    chat_type: 'group',
    chat_id: chatID,
    user_id: 0,
    nickname: '（群里安静了一会儿）',
    text: '（没人说话）',
    prompt,
  })
  if (!r?.ok) {
    chatReady = null
    return { ok: false, error: r?.error || '生成失败' }
  }
  chatReady = true
  return { ok: true, text: r.data?.text || '' }
}

async function trySpeak(chatID, reason, force = false) {
  const minSilence = Number(settings.min_silence_min) || 45
  const cooldown = (Number(settings.group_cooldown_min) || 120) * 60
  const maxPerDay = Number(settings.max_per_day) || 3

  const st = await stateOf(chatID)
  if (!force) {
    if (st.count >= maxPerDay) return { ok: false, error: '今天已经说够了' }
    if (nowSec() - (st.last || 0) < cooldown) return { ok: false, error: '还在冷却' }
    const chance = Number(settings.chance_pct) || 0
    if (Math.random() * 100 >= chance) return { ok: false, error: '这次没抽到' }
  }

  const r = await speak(chatID, reason)
  if (!r.ok) return r

  await saveState(chatID, { last: nowSec(), day: today(), count: (st.count || 0) + 1 })
  host.log('info', `主动发言 sent chat=${chatID} count=${(st.count || 0) + 1}`)
  return r
}

const app = {
  async initialize({ settings: s }) {
    settings = s || {}
    // 软依赖：不在启动时探测 ai.chat，避免 ai-chat 还没就绪时
    // 把 chatReady 永久缓存成 false；真正发言时按需调用，失败只跳过。
    chatReady = null
    host.log('info', `主动发言已加载（${settings.enabled ? '启用' : '关闭'}），AI 聊天按需检测`)
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...values }
    return { ok: true }
  },

  async run_task({ task }) {
    if (task !== 'tick') return {}
    if (!settings.enabled) return { skipped: '未启用' }
    // 不缓存“没装”：每次 tick 由 trySpeak 按需调用 ai.chat，失败只跳过这一轮

    if (inQuietHours()) return { skipped: '免打扰时段' }

    const minSilence = Number(settings.min_silence_min) || 45
    const allow = allowList()
    let groups = await silentGroups(minSilence)
    if (allow.length) groups = groups.filter((g) => allow.includes(Number(g.chat_id)))

    const spoken = []
    for (const g of groups) {
      const chatID = Number(g.chat_id)
      try {
        const r = await trySpeak(chatID)
        if (r.ok) spoken.push(chatID)
      } catch (e) {
        host.log('warn', `主动发言失败 chat=${chatID}: ${e.message}`)
      }
    }
    return { candidates: groups.length, spoken }
  },

  async handle_message({ session }) {
    const text = (session.text || '').trim()
    if (!/^主动(\s|$)/.test(text)) return { handled: false }
    const reply = (m) => host.reply(chatOf(session), m)

    if (!session.chat_type || session.chat_type !== 'group') {
      await reply('主动发言只在群里用')
      return { handled: true }
    }

    const sub = text.replace(/^主动\s*/, '').trim()
    if (sub === '现在') {
      const r = await trySpeak(session.chat_id, '管理员手动触发', true)
      if (!r.ok) await reply(`没发出去：${r.error}`)
      return { handled: true }
    }

    const st = await stateOf(session.chat_id)
    const lines = [
      `主动发言：${settings.enabled ? '开' : '关'}`,
      `AI 聊天插件：${chatReady === true ? '✅ 已就绪' : '⏳ 按需检测'}`,
      `冷场阈值：${settings.min_silence_min || 45} 分钟`,
      `概率：${settings.chance_pct || 30}% / 每次检查`,
      `免打扰：${settings.quiet_start ?? 0}:00 - ${settings.quiet_end ?? 8}:00`,
      `本群冷却：${settings.group_cooldown_min || 120} 分钟，每天最多 ${settings.max_per_day || 3} 次`,
      `本群今天已发：${st.count || 0} 次`,
    ]
    await reply(lines.join('\n'))
    return { handled: true }
  },
}
serve(app)

function chatOf(session) {
  return {
    account: session.account || '',
    chat_type: session.chat_type || 'group',
    chat_id: session.chat_id || 0,
  }
}

// ---- 插件自管定时（发行版）----
// 开发线（QIXIN_EXPERIMENTAL=1）由框架的 [[schedule]] 接管，这里不重复启动。
const __SELF_TIMER = !process.env.QIXIN_EXPERIMENTAL
function __runTask(task) {
  if (!__SELF_TIMER) return
  Promise.resolve(app.run_task({ task })).catch((e) => {
    host.log('warn', `定时 ${task} 执行失败: ${e && e.message ? e.message : e}`)
  })
}
__SELF_TIMER && setInterval(() => __runTask('tick'), 10 * 60 * 1000)
if (__SELF_TIMER) host.log('info', '发行版自管定时已启动')
