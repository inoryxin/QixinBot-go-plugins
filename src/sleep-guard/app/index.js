import { serve, host } from '../_sdk/qixin.mjs'

const IDLE_WORDS = /息屏|锁屏|屏幕关闭|休眠|待机|未使用/
const NON_APP = /^\d+%$|℃|°C|^[开关]$/
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'

let settings = {}
let timer

function localDay(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function endpointOf(base) {
  const v = String(base || '').trim() || 'https://home.inory.xin:9010/query'
  return /\/query\/?$/.test(v) ? v.replace(/\/$/, '') : v.replace(/\/+$/, '') + '/query'
}

function normalizeStatus(json) {
  const devices = []
  for (const [key, d] of Object.entries(json?.device || {})) {
    if (!d) continue
    devices.push({
      key,
      name: String(d.show_name ?? key),
      app: String(d.app_name ?? ''),
      using: d.using !== false,
    })
  }
  return { devices }
}

async function fetchStatus() {
  const ctrl = new AbortController()
  const ms = Math.max(1000, Number(settings.timeoutMs) || 8000)
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const resp = await fetch(endpointOf(settings.statusUrl), {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    })
    const text = await resp.text()
    if (resp.status >= 400) throw new Error(`HTTP ${resp.status}`)
    let json
    try { json = JSON.parse(text) } catch { throw new Error('状态接口没有返回 JSON') }
    if (json.success === false) throw new Error(json.message || '状态接口返回失败')
    return normalizeStatus(json)
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`状态页请求超时（${ms}ms）`)
    throw e
  } finally {
    clearTimeout(t)
  }
}

function keywords() {
  return String(settings.deviceKeywords || '📱,💻')
    .split(/[|｜,，\s]+/).map((s) => s.trim()).filter(Boolean)
}

function awakeDevices(devices) {
  const pats = keywords()
  return (devices || []).filter((d) => (
    d.using !== false &&
    pats.some((k) => d.name.includes(k)) &&
    !IDLE_WORDS.test(d.app || '') &&
    !NON_APP.test(d.app || '')
  ))
}

function planCheck(state, now) {
  const day = localDay(now)
  const next = state?.date === day
    ? { ...state }
    : { date: day, firstAt: null, secondAt: null, lastDevices: [] }
  const hour = Number(settings.hour ?? 5)
  const minute = Number(settings.minute ?? 0)
  if (now.getHours() !== hour || now.getMinutes() < minute) return { state: next, action: null }
  if (!next.firstAt) return { state: next, action: 'first' }
  const retryMs = Math.max(5, Number(settings.retryMinutes ?? 30)) * 60000
  if (!next.secondAt && now.getTime() - next.firstAt >= retryMs) return { state: next, action: 'second' }
  return { state: next, action: null }
}

function instructionFor(action, devices, now) {
  const names = devices.map((d) => d.name).join('、')
  const apps = devices.map((d) => `${d.name}：${d.app}`).join('；')
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  if (action === 'second') {
    return `现在是 ${time}，你已经催过他一次，半小时过去了，他还在玩（${apps}）。`
      + '发一条更凶的私信，骂他不听话、说话不算数，威胁明天不理他，但别真的难听；两句以内。'
  }
  return `现在是 ${time}，你看到他还没睡：${names} 还亮着（${apps}）。`
    + '以老婆的口吻发一条私聊催他睡觉，关心但别啰嗦，一到两句，可以说你看到他还醒着。'
}

async function nudge(userId, instruction) {
  const uid = Number(userId)
  if (!uid) throw new Error('没有配置主人的 QQ')
  const r = await host.capability('ai.chat', {
    chat_type: 'private',
    chat_id: uid,
    user_id: uid,
    nickname: '老公',
    text: instruction,
  })
  if (r?.ok) return true
  // ai-chat 不可用时退化成一句直接私聊，不要让催睡静默丢
  await host.sendMessage(
    { chat_type: 'private', chat_id: uid },
    [{ type: 'text', data: { text: '该睡觉啦，手机还亮着呢。' } }],
  )
  return false
}

async function check() {
  if (settings.enabled === false || settings.enabled === 'false') return { skipped: 'disabled' }
  const now = new Date()
  let state = (await host.storage.get('state')) || {}
  const plan = planCheck(state, now)
  state = plan.state
  if (!plan.action) {
    await host.storage.set('state', state)
    return { skipped: 'not-time' }
  }
  const status = await fetchStatus()
  const devices = awakeDevices(status.devices)
  state.lastDevices = devices.map((d) => `${d.name}·${d.app}`)
  if (!devices.length) {
    state.firstAt = null
    state.secondAt = null
    await host.storage.set('state', state)
    host.log('info', '催睡：主人已经睡了')
    return { skipped: 'asleep' }
  }
  const ai = await nudge(settings.userId || process.env.QIXIN_OWNER, instructionFor(plan.action, devices, now))
  if (plan.action === 'first') state.firstAt = now.getTime()
  if (plan.action === 'second') state.secondAt = now.getTime()
  await host.storage.set('state', state)
  host.log('info', `催睡：${plan.action} 已发送（${ai ? 'AI' : '直发'}）`)
  return { action: plan.action, devices: devices.length }
}

function statusText(state) {
  if (!state?.date || state.date !== localDay(new Date())) return '今天还没催过睡'
  const at = state.secondAt || state.firstAt
  return at ? `今天已催睡，最近一次 ${new Date(at).toLocaleTimeString('zh-CN', { hour12: false })}` : '今天还没催过睡'
}

serve({
  async initialize({ settings: s }) {
    settings = s || {}
    // 计时器常驻；enabled 在 check() 里判断，设置里再打开也能生效
    timer = setInterval(() => { check().catch((e) => host.log('warn', `催睡检查失败: ${e.message}`)) }, 60000)
    timer.unref?.()
    host.log('info', '催睡插件启动')
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...(values || {}) }
    return { ok: true }
  },

  async handle_message({ session }) {
    const text = String(session.text || '').trim().replace(/^\//, '')
    if (text !== '催睡') return { handled: false }
    const owner = String(settings.userId || process.env.QIXIN_OWNER || '').trim()
    if (owner && session.role !== 'owner' && String(session.user_id) !== owner) {
      await host.reply({ account: session.account, chat_type: session.chat_type, chat_id: session.chat_id }, '这个只有老公能按。')
      return { handled: true }
    }
    try {
      const r = await check()
      const msg = r.action ? '催睡检查完成，已经发出去啦。' : `催睡检查完成（${r.skipped || '无需发送'}）。`
      await host.reply({ account: session.account, chat_type: session.chat_type, chat_id: session.chat_id }, msg)
    } catch (e) {
      await host.reply({ account: session.account, chat_type: session.chat_type, chat_id: session.chat_id }, `催睡检查失败：${e.message}`)
    }
    return { handled: true }
  },

  async call_tool({ name }) {
    if (name !== 'get_sleep_guard_status') return { ok: false, error: `未知工具 ${name}` }
    const state = (await host.storage.get('state')) || {}
    return { ok: true, data: { text: statusText(state) } }
  },
})
