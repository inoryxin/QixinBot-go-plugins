import { serve, host } from '../_sdk/qixin.mjs'

const DEFAULT_TEMPLATE = '🛰 {title} · {status}\n{desc}\n🕒 更新于 {time}\n\n{devices}\n\n{url}'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'
let settings = {}

function norm(value) {
  return String(value ?? '').normalize('NFC').replace(/[\uFE0E\uFE0F]/g, '')
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
  return {
    time: String(json?.time ?? ''),
    status: json?.status,
    name: String(json?.info?.name ?? '未知'),
    desc: String(json?.info?.desc ?? ''),
    lastUpdated: String(json?.last_updated ?? ''),
    devices,
  }
}

async function fetchStatus() {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const resp = await fetch(endpointOf(settings.endpoint), {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    })
    const text = await resp.text()
    if (resp.status >= 400) throw new Error(`HTTP ${resp.status}`)
    let json
    try { json = JSON.parse(text) } catch { throw new Error('接口没有返回 JSON（可能被网关拦截）') }
    if (json.success === false) throw new Error(json.message || '状态接口返回失败')
    return normalizeStatus(json)
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('请求超时（8000ms）')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function devicesText(st) {
  if (settings.showDevices === false || settings.showDevices === 'false') return ''
  const lines = st.devices.slice(0, 8).map((d) => `${d.name}${d.app ? ` · ${d.app}` : ''}${d.using ? '' : '（未使用）'}`)
  if (st.devices.length > 8) lines.push(`…还有 ${st.devices.length - 8} 个设备`)
  return lines.join('\n')
}

function render(st) {
  const values = {
    title: settings.title || '祈歆',
    status: st.name,
    desc: st.desc,
    time: st.lastUpdated || st.time,
    devices: devicesText(st),
    url: settings.pageUrl || '',
  }
  return String(settings.template || DEFAULT_TEMPLATE)
    .replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k] ?? '') : m))
    .split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function triggerRegex() {
  const aliases = String(settings.aliases || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  const actions = String(settings.actions || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const name = aliases.length ? `(?:${aliases.map(esc).join('|')})` : '.+?'
  const action = actions.length ? `(?:${actions.map(esc).join('|')})` : '(?:在干嘛|状态)'
  return new RegExp(`^(?:视奸\\s*${name}?\\s*|${name}\\s*[（(]?\\s*${action}\\s*[）)]?\\s*[?？!！]*)$`, 'iu')
}

function chatOf(session) {
  return { account: session.account || '', chat_type: session.chat_type || 'private', chat_id: session.chat_id }
}

serve({
  async initialize({ settings: s }) {
    settings = s || {}
    host.log('info', '祈歆状态插件启动')
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...(values || {}) }
    return { ok: true }
  },

  async handle_message({ session }) {
    const text = norm(session.text).trim()
    if (!text || !triggerRegex().test(text)) return { handled: false }
    try {
      const st = await fetchStatus()
      await host.reply(chatOf(session), render(st))
    } catch (e) {
      host.log('warn', `watch 状态获取失败: ${e.message}`)
      await host.reply(chatOf(session), `状态页连不上：${e.message}`)
    }
    return { handled: true }
  },

  async call_tool({ name }) {
    if (name !== 'get_qixin_status') return { ok: false, error: '未知工具: ' + name }
    const st = await fetchStatus()
    const devices = devicesText(st).replace(/\n/g, '；')
    const text = `${settings.title || '祈歆'}：${st.name}。${st.desc}${st.lastUpdated ? `（更新于 ${st.lastUpdated}）` : ''}${devices ? `\n设备：${devices}` : ''}`
    return { ok: true, data: { text } }
  },
})
