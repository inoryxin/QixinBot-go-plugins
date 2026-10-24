// 关键词回复
//
// 规则存在 storage 里，通过能力 kw.list / kw.save / kw.test 管理，
// WebUI 面板在 web/panel.html。
//
// 规则格式：
//   { id, match, pattern, replies: [{type, text|url}], enabled, exactCase }
//   match: exact | contains | prefix | suffix | regex | fuzzy
import { serve, host, chatOf } from '../_sdk/qixin.mjs'

let settings = {}

// 每会话的冷却时间戳 / 每分钟计数
const lastAt = new Map()
const perMinute = new Map()

// ---------------------------------------------------------------- 规则

async function loadRules() {
  const raw = await host.storage.get('rules')
  const list = Array.isArray(raw) ? raw : []
  return list
    .filter((r) => r && r.pattern)
    .map((r, i) => ({
      id: r.id || `r${i}`,
      match: ['exact', 'contains', 'prefix', 'suffix', 'regex', 'fuzzy'].includes(r.match) ? r.match : 'contains',
      pattern: String(r.pattern),
      replies: Array.isArray(r.replies) ? r.replies : [],
      enabled: r.enabled !== false,
      exactCase: Boolean(r.exactCase),
      scope: r.scope === 'private' || r.scope === 'group' ? r.scope : '',
    }))
}

async function saveRules(rules) {
  await host.storage.set('rules', rules)
}

// ---------------------------------------------------------------- 匹配

// Levenshtein：模糊匹配用
function distance(a, b) {
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  let cur = new Array(n + 1)
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[n]
}

function matches(rule, text) {
  const hay = rule.exactCase ? text : text.toLowerCase()
  const pat = rule.exactCase ? rule.pattern : rule.pattern.toLowerCase()

  switch (rule.match) {
    case 'exact':
      return hay === pat
    case 'prefix':
      return hay.startsWith(pat)
    case 'suffix':
      return hay.endsWith(pat)
    case 'regex':
      try {
        return new RegExp(rule.pattern, rule.exactCase ? '' : 'i').test(text)
      } catch {
        return false
      }
    case 'fuzzy': {
      // 允许一个字的手滑；长词允许 2 个
      const limit = pat.length >= 5 ? 2 : 1
      return distance(hay, pat) <= limit
    }
    case 'contains':
    default:
      return hay.includes(pat)
  }
}

// ---------------------------------------------------------------- 回复

const RANDOM = (arr) => arr[Math.floor(Math.random() * arr.length)]

function toSegments(reply) {
  if (!reply) return []
  // 纯字符串
  if (typeof reply === 'string') return [{ type: 'text', data: { text: reply } }]

  // 多段
  if (Array.isArray(reply)) {
    return reply.map(toSegment).filter(Boolean)
  }

  return [toSegment(reply)].filter(Boolean)
}

function toSegment(one) {
  if (!one) return null
  if (typeof one === 'string') return { type: 'text', data: { text: one } }

  const TYPE_ALIAS = {
    text: 'text', 文本: 'text', 文字: 'text',
    image: 'image', 图片: 'image', 图: 'image',
    record: 'record', voice: 'record', 语音: 'record',
    face: 'face', 表情: 'face',
    at: 'at', '@': 'at', 艾特: 'at',
  }
  const raw = String(one.type || 'text')
  const type = TYPE_ALIAS[raw.toLowerCase()] || TYPE_ALIAS[raw] || 'text'
  if (type === 'text') return { type: 'text', data: { text: String(one.text ?? one.content ?? '') } }
  if (type === 'image') return { type: 'image', data: { file: String(one.url ?? one.file ?? one.content ?? '') } }
  if (type === 'record' || type === 'voice') {
    return { type: 'record', data: { file: String(one.url ?? one.file ?? one.content ?? '') } }
  }
  if (type === 'face') return { type: 'face', data: { id: String(one.id ?? one.content ?? '') } }
  if (type === 'at') return { type: 'at', data: { qq: String(one.qq ?? one.content ?? '') } }
  return null
}

// ---------------------------------------------------------------- 限流

function rateLimited(session) {
  const now = Date.now()
  const key = session.chat_type + ':' + session.chat_id

  const cd = Math.max(0, Number(settings.cooldownSeconds) || 0) * 1000
  if (cd > 0 && lastAt.has(key) && now - lastAt.get(key) < cd) return true

  const cap = Number(settings.maxPerMinute) || 0
  if (cap > 0) {
    const bucket = perMinute.get(key) || { at: 0, n: 0 }
    if (now - bucket.at > 60000) {
      bucket.at = now
      bucket.n = 0
    }
    if (bucket.n >= cap) return true
    bucket.n += 1
    perMinute.set(key, bucket)
  }
  return false
}

// ---------------------------------------------------------------- 服务

serve({
  async initialize({ settings: initial }) {
    settings = initial || {}
    host.log('info', '关键词回复启动')
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...values }
    return { ok: true }
  },

  async handle_message({ session }) {
    if (settings.enabled === false) return { handled: false }

    const text = (session.text || '').trim()
    if (!text) return { handled: false }
    // 带前缀的消息一般是指令，别插嘴
    if (settings.skipCommands !== false && session.has_prefix) return { handled: false }

    const rules = await loadRules()
    if (!rules.length) return { handled: false }

    for (const rule of rules) {
      if (!rule.enabled) continue
      if (rule.scope && rule.scope !== session.chat_type) continue
      if (!matches(rule, text)) continue
      if (!rule.replies.length) continue
      if (rateLimited(session)) continue

      const reply = RANDOM(rule.replies)
      const segs = toSegments(reply)
      if (!segs.length) continue

      lastAt.set(session.chat_type + ':' + session.chat_id, Date.now())
      host.log('info', `命中规则 ${rule.id}（${rule.match}:${rule.pattern}）`)

      const replyTo = settings.replyToKeyword !== false ? session.message_id : 0
      try {
        await host.reply(chatOf(session), segs, replyTo)
      } catch (err) {
        host.log('error', `回复失败: ${err.message}`)
        return { handled: false }
      }
      return { handled: true }
    }

    return { handled: false }
  },

  async call_tool({ name, args }) {
    switch (name) {
      case 'kw.list': {
        const rules = await loadRules()
        return { ok: true, data: { rules } }
      }

      case 'kw.save': {
        const list = args?.rules
        if (!Array.isArray(list)) return { ok: false, error: '需要 rules 数组' }
        const clean = []
        const seen = new Set()
        for (const [i, r] of list.entries()) {
          const pattern = String(r?.pattern ?? '').trim()
          if (!pattern) continue
          const id = String(r?.id ?? `r${i}`)
          if (seen.has(id)) return { ok: false, error: `规则 id 重复：${id}` }
          seen.add(id)
          if (r.match === 'regex') {
            try {
              new RegExp(pattern)
            } catch (e) {
              return { ok: false, error: `第 ${i + 1} 条正则不合法：${e.message}` }
            }
          }
          clean.push({
            id,
            match: String(r.match ?? 'contains'),
            pattern,
            replies: Array.isArray(r.replies) ? r.replies : [],
            enabled: r.enabled !== false,
            exactCase: Boolean(r.exactCase),
            scope: r.scope === 'private' || r.scope === 'group' ? r.scope : '',
          })
        }
        await saveRules(clean)
        host.log('info', `关键词规则已保存（${clean.length} 条）`)
        return { ok: true, data: { count: clean.length } }
      }

      case 'kw.test': {
        const text = String(args?.text ?? '')
        if (!text) return { ok: false, error: '需要 text' }
        const rules = await loadRules()
        const hits = rules.filter((r) => r.enabled && (!r.scope || r.scope === (args?.chat_type || 'group')) && matches(r, text))
        return { ok: true, data: { hits: hits.map((r) => ({ id: r.id, match: r.match, pattern: r.pattern })) } }
      }

      default:
        return { ok: false, error: `未知工具 ${name}` }
    }
  },
})
