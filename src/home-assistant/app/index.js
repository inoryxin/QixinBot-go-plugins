// 智能家居（Home Assistant）
//
// 从 QixinBot 的 home-assistant 插件移植。原版拆成 plugin.js + src/home-assistant.js，
// 这里合并成一个文件，HTTP 层保留 node:https（HA 是自签名证书，fetch 关不掉校验）。
import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import { serve, host, chatOf } from '../_sdk/qixin.mjs'

let settings = {}

function options() {
  let aliases = {}
  try {
    const parsed = JSON.parse(settings.aliasesJson || '{}')
    if (parsed && typeof parsed === 'object') aliases = parsed
  } catch {
    // 配错了就当没有别名
  }
  return {
    baseUrl: settings.baseUrl || 'https://10.0.0.123:8123',
    token: settings.token || '',
    timeoutMs: Number(settings.timeoutMs) || 8000,
    domains: String(settings.domains || 'light,switch,fan,climate,cover')
      .split(/[|｜,，\s]+/)
      .map((x) => x.trim())
      .filter(Boolean),
    aliases,
  }
}

// ---------------------------------------------------------------- HA 客户端

const DEFAULT_TIMEOUT_MS = 8000

function requestJson(url, { method = 'GET', token, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const client = target.protocol === 'http:' ? http : https
    const payload = body === undefined ? undefined : JSON.stringify(body)

    const request = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        method,
        // HA 常挂在自签名 HTTPS 上，验证书会连不上
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (response.statusCode >= 400) {
            reject(new Error(`HA HTTP ${response.statusCode}: ${text.slice(0, 200)}`))
            return
          }
          try {
            resolve(text ? JSON.parse(text) : {})
          } catch {
            reject(new Error('HA 返回的不是 JSON'))
          }
        })
      },
    )

    request.on('timeout', () => request.destroy(new Error('HA 请求超时')))
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

function client() {
  const o = options()
  const baseUrl = String(o.baseUrl).replace(/\/+$/, '')
  return {
    states: () => requestJson(`${baseUrl}/api/states`, { token: o.token, timeoutMs: o.timeoutMs }),
    callService: (domain, service, data = {}) =>
      requestJson(`${baseUrl}/api/services/${domain}/${service}`, {
        method: 'POST',
        token: o.token,
        body: data,
        timeoutMs: o.timeoutMs,
      }),
  }
}

async function loadStates() {
  if (!options().token) throw new Error('还没配置 Home Assistant 长期令牌')
  return client().states()
}

// ---------------------------------------------------------------- 实体匹配

function candidateEntities(states, domains) {
  const allowed = new Set(domains)
  return (states ?? []).filter((state) => allowed.has(String(state.entity_id).split('.')[0]))
}

// 别名优先，其次精确 friendly_name，最后子串匹配
function resolveEntity(name, states, opts) {
  const wanted = String(name ?? '').trim()
  if (!wanted) return { matches: [] }

  for (const [alias, entityId] of Object.entries(opts.aliases ?? {})) {
    if (wanted === alias || wanted.includes(alias)) {
      const found = (states ?? []).find((state) => state.entity_id === entityId)
      if (found) return { matches: [found], aliasUsed: alias }
    }
  }

  const direct = (states ?? []).find((state) => state.entity_id === wanted)
  if (direct) return { matches: [direct] }

  const domains = opts.domains?.length ? opts.domains : ['light', 'switch', 'fan', 'climate', 'cover']
  const pool = candidateEntities(states, domains)
  const nameOf = (state) => String(state.attributes?.friendly_name ?? '')

  const exact = pool.filter((state) => nameOf(state) === wanted)
  if (exact.length) return { matches: exact }

  return {
    matches: pool.filter(
      (state) => nameOf(state).includes(wanted) || state.entity_id.includes(wanted.toLowerCase()),
    ),
  }
}

function displayName(state) {
  return String(state?.attributes?.friendly_name ?? state?.entity_id ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isOn(state) {
  return state?.state === 'on' || state?.state === 'open' || state?.state === 'playing'
}

// 温度/湿度传感器（过滤掉电量这类也带 % 的）
function environment(states) {
  const sensors = (states ?? []).filter((state) => {
    if (String(state.entity_id).split('.')[0] !== 'sensor') return false
    if (state.state === 'unavailable' || state.state === 'unknown') return false
    const unit = String(state.attributes?.unit_of_measurement ?? '')
    return unit === '°C' || unit === '%'
  })

  const rows = sensors
    .map((state) => ({
      name: displayName(state)
        .replace(/\s+/g, ' ')
        .replace(/温度$/, '')
        .trim(),
      value: state.state,
      unit: String(state.attributes?.unit_of_measurement ?? ''),
    }))
    .filter((row) => !/电量|battery/i.test(row.name))

  return rows.filter((row) => row.unit === '°C' || /湿度/.test(row.name))
}

function summary(states) {
  const o = options()
  const all = states ?? []
  const lines = []

  const aliasEntries = Object.entries(o.aliases)
    .map(([alias, entityId]) => ({ alias, entity: all.find((s) => s.entity_id === entityId) }))
    .filter((e) => e.entity)

  if (aliasEntries.length) {
    lines.push(
      '设备：' +
        aliasEntries
          .map(({ alias, entity }) => {
            const s = entity.state === 'unavailable' ? '离线' : isOn(entity) ? '开' : entity.state === 'off' ? '关' : entity.state
            return `${alias}（${s}）`
          })
          .join('、'),
    )
  }

  const env = environment(all)
  if (env.length) {
    lines.push('温湿度：' + env.map((r) => `${r.name} ${r.value}${r.unit}`).join('；'))
  }

  return lines.join('\n') || '没有可用的设备'
}

// ---------------------------------------------------------------- 控制

const SERVICES = {
  on: { light: 'turn_on', switch: 'turn_on', fan: 'turn_on', climate: 'turn_on', cover: 'open_cover' },
  off: { light: 'turn_off', switch: 'turn_off', fan: 'turn_off', climate: 'turn_off', cover: 'close_cover' },
  toggle: { light: 'toggle', switch: 'toggle', fan: 'toggle', climate: 'toggle' },
}

const ACTION_ALIASES = {
  on: 'on', open: 'on', 开: 'on', 打开: 'on', turn_on: 'on',
  off: 'off', close: 'off', 关: 'off', 关闭: 'off', 关掉: 'off', turn_off: 'off',
  toggle: 'toggle', 切换: 'toggle', 按一下: 'toggle',
}

function normalizeAction(value) {
  return ACTION_ALIASES[String(value ?? '').trim().toLowerCase()] ?? ''
}

function domainOf(entityId) {
  return String(entityId).split('.')[0]
}

async function control(entity, action) {
  const normalized = normalizeAction(action)
  if (!normalized) throw new Error(`不支持的动作：${action}`)

  const domain = domainOf(entity.entity_id)
  const service = SERVICES[normalized]?.[domain]
  if (!service) throw new Error(`不支持对 ${domain} 执行 ${normalized}`)

  await client().callService(domain, service, { entity_id: entity.entity_id })
  const verb = normalized === 'on' ? '打开' : normalized === 'off' ? '关闭' : '切换'
  return `${verb}了「${displayName(entity)}」`
}

async function controlByName(name, action) {
  const states = await loadStates()
  const { matches } = resolveEntity(name, states, options())
  if (!matches.length) return `没找到叫「${name}」的设备`
  if (matches.length > 1) return `「${name}」对应多个设备：${matches.map(displayName).join('、')}，说清楚一点`
  return control(matches[0], action)
}

async function environmentText() {
  const rows = environment(await loadStates())
  if (!rows.length) return '没读到温湿度'
  return rows.map((r) => `${r.name} ${r.value}${r.unit}`).join('；')
}

async function listText() {
  const states = await loadStates()
  const o = options()
  const lines = []

  for (const [alias, entityId] of Object.entries(o.aliases ?? {})) {
    const entity = states.find((s) => s.entity_id === entityId)
    if (!entity) continue
    const s = entity.state === 'unavailable' ? '离线' : isOn(entity) ? '开' : entity.state === 'off' ? '关' : entity.state
    lines.push(`${alias}：${s}`)
  }

  const env = environment(states)
  if (env.length) lines.push('温湿度：' + env.map((r) => `${r.name} ${r.value}${r.unit}`).join('；'))
  return lines.join('\n') || summary(states)
}

// ---------------------------------------------------------------- 命令解析

// 只认命令前缀。自然语言（「把灯关了」）不归这里，交给 AI 决定调不调工具。
const PREFIX_RE = /^(?:home|ha|家电|智能家居)\s*(.*)$/i

async function runCommand(session, text) {
  try {
    if (!text || text === '状态') {
      await host.reply(chatOf(session), summary(await loadStates()))
      return
    }
    if (/^(温湿度|温度|湿度)$/.test(text)) {
      await host.reply(chatOf(session), await environmentText())
      return
    }
    if (/^(列表|设备)$/.test(text)) {
      await host.reply(chatOf(session), await listText())
      return
    }

    let action = null
    if (/^(开|打开)\s*(.+)$/.test(text)) action = 'on'
    else if (/^(关|关闭|关掉)\s*(.+)$/.test(text)) action = 'off'
    else if (/^(切换|按一下)\s*(.+)$/.test(text)) action = 'toggle'

    const name = action ? text.replace(/^(开|打开|关|关闭|关掉|切换|按一下)\s*/, '').trim() : ''
    if (!action || !name) {
      await host.reply(chatOf(session), '用法：home / home 开 灯 / home 关 电脑 / home 温湿度 / home 列表')
      return
    }

    await host.reply(chatOf(session), await controlByName(name, action))
  } catch (error) {
    host.log('error', `home-assistant: ${error.message}`)
    await host.reply(chatOf(session), `智能家居没连上：${error.message}`)
  }
}

// ---------------------------------------------------------------- 服务

serve({
  async initialize({ settings: initial }) {
    settings = initial || {}
    host.log('info', `智能家居启动 ${settings.baseUrl || '未配置'}`)
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...values }
    return { ok: true }
  },

  async handle_message({ session }) {
    const text = (session.text || '').trim()
    if (!text) return { handled: false }

    // home 系列
    const prefixed = PREFIX_RE.exec(text)
    if (prefixed) {
      await runCommand(session, prefixed[1].trim())
      return { handled: true }
    }

    // 不匹配 home 前缀就是别人的事（自然语言交给 AI）
    return { handled: false }
  },

  async call_tool({ name, args }) {
    switch (name) {
      case 'home_control': {
        const device = String(args?.name ?? '')
        const action = normalizeAction(args?.action) || 'toggle'
        try {
          return { ok: true, data: { text: await controlByName(device, action) } }
        } catch (error) {
          return { ok: false, error: error.message }
        }
      }
      case 'home_environment':
        try {
          return { ok: true, data: { text: await environmentText() } }
        } catch (error) {
          return { ok: false, error: error.message }
        }
      case 'home_list':
        try {
          return { ok: true, data: { text: await listText() } }
        } catch (error) {
          return { ok: false, error: error.message }
        }
      default:
        return { ok: false, error: `未知工具 ${name}` }
    }
  },
})
