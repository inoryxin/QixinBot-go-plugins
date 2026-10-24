// 关键词触发
//
// 从 QixinBot 的 trigger 插件移植。原版谁都能触发，能直接改家里的状态，
// 这里加了鉴权：
//   1. 插件级白/黑名单（allowUsers / denyUsers / allowGroups）
//   2. 规则级 allowUsers（覆盖插件级，用来单独收紧某条危险规则）
//   3. 请求级 headers（Bearer / Basic 等，规则里配）
//
// 规则存在 storage 里，不写到仓库（URL 里常有 secret）。
import { serve, host, chatOf } from '../_sdk/qixin.mjs'

let settings = {}

const DEFAULT_TIMEOUT_MS = 8000
const BODY_PREVIEW = 200
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// ---------------------------------------------------------------- 工具

// 列表解析：| 为主，逗号/空格兼容
function parseIds(value) {
  return String(value ?? '')
    .split(/[|｜,，\s]+/)
    .map((x) => x.trim())
    .filter((x) => /^\d+$/.test(x))
    .map(Number)
}

// 全角转半角 + 去空白，避免"活　着"匹配不上
function normalizeForMatch(text) {
  let s = String(text ?? '')
  s = s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  s = s.replace(/\u3000/g, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

function buildMatcher(keyword, match, caseSensitive) {
  const kw = String(keyword ?? '')
  const mode = match || 'exact'
  if (mode === 'regex') {
    const re = new RegExp(kw, caseSensitive ? '' : 'i')
    return (text) => re.test(text)
  }
  if (mode === 'contains') {
    return (text) => (caseSensitive ? text : text.toLowerCase()).includes(caseSensitive ? kw : kw.toLowerCase())
  }
  if (mode === 'prefix') {
    return (text) => (caseSensitive ? text : text.toLowerCase()).startsWith(caseSensitive ? kw : kw.toLowerCase())
  }
  if (mode === 'suffix') {
    return (text) => (caseSensitive ? text : text.toLowerCase()).endsWith(caseSensitive ? kw : kw.toLowerCase())
  }
  // exact
  return (text) => (caseSensitive ? text : text.toLowerCase()) === (caseSensitive ? kw : kw.toLowerCase())
}

// ---------------------------------------------------------------- 规则

async function loadRules() {
  const raw = await host.storage.get('rules')
  if (!Array.isArray(raw)) return []
  return raw.filter((r) => r && r.keyword && r.url)
}

// ---------------------------------------------------------------- 鉴权

function senderAllowed(rule, session) {
  const uid = Number(session.user_id) || 0

  // 1. 全局黑名单，最高优先级
  if (parseIds(settings.denyUsers).includes(uid)) return { ok: false, why: '黑名单' }

  // 2. 规则级白名单（配了就只认这些）
  const ruleAllow = parseIds(rule.allowUsers)
  if (ruleAllow.length) {
    return ruleAllow.includes(uid) ? { ok: true } : { ok: false, why: '规则白名单' }
  }

  // 3. 插件级白名单
  const groupAllow = parseIds(settings.allowGroups)
  if (session.chat_type === 'group' && groupAllow.length && !groupAllow.includes(Number(session.chat_id))) {
    return { ok: false, why: '群不在白名单' }
  }

  const userAllow = parseIds(settings.allowUsers)
  if (userAllow.length && !userAllow.includes(uid)) return { ok: false, why: '用户不在白名单' }

  return { ok: true }
}

// ---------------------------------------------------------------- 请求

async function performRequest(rule, timeoutMs) {
  const method = String(rule.method || 'GET').toUpperCase()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const headers = { 'User-Agent': UA, ...(rule.headers || {}) }
  const init = { method, headers, signal: controller.signal }

  if (method !== 'GET' && method !== 'HEAD' && rule.body !== undefined) {
    if (typeof rule.body === 'string') {
      init.body = rule.body
    } else {
      init.body = JSON.stringify(rule.body)
      if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json'
    }
  }

  try {
    const response = await fetch(rule.url, init)
    const text = await response.text().catch(() => '')
    return { ok: response.status < 400, status: response.status, body: text }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`请求超时（${timeoutMs}ms）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function renderReply(template, result = {}) {
  return String(template ?? '')
    .replace(/\{httpStatus\}/g, result.status === undefined ? '' : String(result.status))
    .replace(/\{body\}/g, String(result.body ?? '').slice(0, BODY_PREVIEW))
    .replace(/\{error\}/g, String(result.error ?? ''))
}

// 日志里把 query string 抹掉，URL 常带 secret
function redact(url) {
  return String(url).replace(/\?.*$/, '?…')
}

// ---------------------------------------------------------------- 服务

serve({
  async initialize({ settings: initial }) {
    settings = initial || {}
    host.log('info', '关键词触发启动')
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...values }
    return { ok: true }
  },

  async handle_message({ session }) {
    if (settings.enabled === false) return { handled: false }

    const text = normalizeForMatch(session.text)
    if (!text) return { handled: false }

    const rules = await loadRules()
    if (!rules.length) return { handled: false }

    const rule = rules.find((r) => {
      if (r.enabled === false) return false
      return buildMatcher(r.keyword, r.match, r.caseSensitive === true)(text)
    })
    if (!rule) return { handled: false }

    // 鉴权
    const allowed = senderAllowed(rule, session)
    if (!allowed.ok) {
      host.log('info', `规则「${rule.keyword}」被拒绝（${allowed.why}）uid=${session.user_id}`)
      return { handled: true }
    }

    const timeoutMs = Number(rule.timeoutMs) || Number(settings.timeoutMs) || DEFAULT_TIMEOUT_MS
    try {
      const result = await performRequest(rule, timeoutMs)
      const fallback = result.ok ? settings.defaultReply || '已执行（HTTP {httpStatus}）' : settings.defaultFailureReply || '请求失败（HTTP {httpStatus}）'
      const template = result.ok ? rule.reply || fallback : rule.failureReply || fallback
      await host.reply(chatOf(session), [{ type: 'text', data: { text: renderReply(template, result) } }])
      host.log('info', `trigger: "${rule.keyword}" -> ${String(rule.method || 'GET').toUpperCase()} ${redact(rule.url)} => ${result.status}`)
    } catch (err) {
      host.log('error', `trigger: "${rule.keyword}" 失败: ${err.message}`)
      await host.reply(chatOf(session), [
        { type: 'text', data: { text: renderReply(rule.errorReply || settings.defaultErrorReply || '请求出错：{error}', { error: err.message }) } },
      ])
    }
    return { handled: true }
  },

  async call_tool({ name, args }) {
    switch (name) {
      case 'list_triggers': {
        const rules = await loadRules()
        if (!rules.length) return { ok: true, data: { text: '还没有配置关键词触发规则' } }
        return {
          ok: true,
          data: {
            text: rules.map((r) => `- ${r.keyword}${r.description ? `：${r.description}` : ''}`).join('\n'),
          },
        }
      }

      case 'trigger.list': {
        // 返回完整 URL：管理员要编辑，脱敏了就没法保存回去。
        // 这个接口要登录才能调，日志里仍然脱敏。
        const rules = await loadRules()
        return { ok: true, data: { rules } }
      }

      case 'trigger.save': {
        const list = args?.rules
        if (!Array.isArray(list)) return { ok: false, error: '需要 rules 数组' }
        const clean = []
        for (const [i, r] of list.entries()) {
          const keyword = String(r?.keyword ?? '').trim()
          const url = String(r?.url ?? '').trim()
          if (!keyword || !url) continue
          if (!/^https?:\/\//i.test(url)) {
            return { ok: false, error: `第 ${i + 1} 条 URL 必须以 http:// 或 https:// 开头` }
          }
          if (r.match === 'regex') {
            try {
              new RegExp(keyword)
            } catch (e) {
              return { ok: false, error: `第 ${i + 1} 条正则不合法：${e.message}` }
            }
          }
          clean.push({
            keyword,
            url,
            method: String(r.method || 'GET').toUpperCase(),
            match: String(r.match || 'exact'),
            caseSensitive: Boolean(r.caseSensitive),
            headers: r.headers && typeof r.headers === 'object' ? r.headers : {},
            body: r.body,
            reply: r.reply ?? '',
            failureReply: r.failureReply ?? '',
            errorReply: r.errorReply ?? '',
            description: r.description ?? '',
            allowUsers: r.allowUsers ?? '',
            enabled: r.enabled !== false,
          })
        }
        await host.storage.set('rules', clean)
        host.log('info', `触发规则已保存（${clean.length} 条）`)
        return { ok: true, data: { count: clean.length } }
      }

      case 'trigger.test': {
        const rule = args?.rule
        if (!rule?.url) return { ok: false, error: '需要 rule.url' }
        if (!/^https?:\/\//i.test(String(rule.url))) return { ok: false, error: 'URL 必须以 http:// 或 https:// 开头' }
        const timeoutMs = Number(rule.timeoutMs) || Number(settings.timeoutMs) || DEFAULT_TIMEOUT_MS
        try {
          const result = await performRequest(rule, timeoutMs)
          return { ok: true, data: { ok: result.ok, status: result.status, body: result.body.slice(0, 500) } }
        } catch (err) {
          return { ok: false, error: err.message }
        }
      }

      default:
        return { ok: false, error: `未知工具 ${name}` }
    }
  },
})
