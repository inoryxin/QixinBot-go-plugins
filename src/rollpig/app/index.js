import { serve, host } from '../_sdk/qixin.mjs'

const API = 'https://pighub.top/api/images?sort=2'
const ORIGIN = 'https://pighub.top'
const CACHE_TTL = 60 * 60 * 1000
const ANALYSIS = [
  '你性格温和，嘴硬心软，被人需要的时候最可靠。',
  '你看起来懒懒散散，其实心里什么都明白。',
  '你有点小倔强，认定的事十头猪都拉不回来。',
  '你最近运气不错，适合吃点好的犒劳自己。',
  '你擅长假装没事，其实很需要有人抱一下。',
  '你嘴上嫌弃，身体很诚实，典型口是心非。',
  '你是个慢热的人，熟了以后话多到停不下来。',
  '你最近有点累，记得早点睡，别硬撑。',
  '你心里藏着一个没说出口的人。',
  '你今天适合被夸，不适合讲道理。',
]
let settings = {}

function hash(text) {
  let value = 2166136261
  for (const char of String(text)) {
    value ^= char.codePointAt(0)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}
function pick(seed, list) {
  let x = (seed ^ 0x9e3779b9) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
  x ^= x >>> 16
  return list[(x >>> 0) % list.length]
}
function today() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
function imageUrl(pig) {
  const raw = pig.thumbnail || pig.image_url || ''
  if (/^https?:\/\//i.test(raw)) return raw
  if (raw.startsWith('/')) return encodeURI(ORIGIN + raw)
  return `${ORIGIN}/images/${encodeURIComponent(raw.split('/').pop())}`
}

async function loadPigs() {
  const cached = await host.storage.get('rollpig:cache')
  if (cached?.at && Date.now() - cached.at < CACHE_TTL && Array.isArray(cached.pigs) && cached.pigs.length) {
    return cached.pigs
  }
  const resp = await fetch(API, { headers: { 'User-Agent': 'qixinbot rollpig' }, signal: AbortSignal.timeout(20000) })
  if (!resp.ok) throw new Error(`PigHub HTTP ${resp.status}`)
  const payload = await resp.json()
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.images) ? payload.images : []
  const pigs = list.map((it) => ({
    id: it.id,
    title: String(it.title || it.filename || '无名小猪').replace(/\.(jpe?g|png|webp|gif)$/i, ''),
    filename: it.filename || '',
    thumbnail: it.thumbnail || it.image_url || '',
  })).filter((it) => it.thumbnail)
  if (!pigs.length) throw new Error('PigHub 返回空列表')
  await host.storage.set('rollpig:cache', { at: Date.now(), pigs })
  return pigs
}

function chatOf(session) {
  return { account: session.account || '', chat_type: session.chat_type || 'private', chat_id: session.chat_id }
}
async function sendPig(session, pig, label, analysis) {
  await host.reply(chatOf(session), [
    { type: 'text', data: { text: `${label}：${pig.title}\n${analysis}` } },
    { type: 'image', data: { file: imageUrl(pig) } },
  ])
}
function targetUser(session) {
  const at = (session.segments || []).find((s) => s.type === 'at')
  const qq = String(at?.data?.qq || '')
  return /^\d+$/.test(qq) ? qq : String(session.user_id || '')
}

serve({
  async initialize({ settings: s }) {
    settings = s || {}
    host.log('info', '抽小猪插件启动')
    return { api_version: '1.0' }
  },
  async set_settings({ values }) { settings = { ...settings, ...(values || {}) }; return { ok: true } },

  async handle_message({ session }) {
    const text = String(session.text || '').trim()
    const m = /^(今日小猪|今天小猪|随机小猪|找猪)(?:\s+([\s\S]*))?$/.exec(text)
    if (!m) return { handled: false }
    const command = m[1]
    const rest = String(m[2] || '').trim()
    try {
      const pigs = await loadPigs()
      if (command === '今日小猪' || command === '今天小猪') {
        const qq = targetUser(session)
        const pig = pick(hash(`${today()}:${qq}`), pigs)
        const analysis = pick(hash(`${today()}:${qq}:analysis`), ANALYSIS)
        await sendPig(session, pig, '今日小猪', analysis)
        return { handled: true }
      }
      if (command === '随机小猪') {
        const count = Math.max(1, Math.min(10, Number(rest) || 1))
        const shuffled = [...pigs].sort(() => Math.random() - 0.5).slice(0, count)
        for (const pig of shuffled) await sendPig(session, pig, '随机小猪', ANALYSIS[Math.floor(Math.random() * ANALYSIS.length)])
        return { handled: true }
      }
      if (command === '找猪') {
        if (!rest) { await host.reply(chatOf(session), '用法：找猪 <关键词>，或 找猪 -i <ID>'); return { handled: true } }
        const idMatch = /^-i\s+(\d+)$/.exec(rest)
        const hits = idMatch
          ? pigs.filter((p) => String(p.id) === idMatch[1])
          : pigs.filter((p) => `${p.title} ${p.filename}`.toLowerCase().includes(rest.toLowerCase()))
        if (!hits.length) { await host.reply(chatOf(session), `没找到「${rest}」相关的小猪`); return { handled: true } }
        const lines = [`找到 ${hits.length} 只：`]
        for (const pig of hits.slice(0, 10)) lines.push(`[${pig.id}] ${pig.title}`)
        await host.reply(chatOf(session), lines.join('\n'))
        await sendPig(session, hits[0], '找猪', `关键词：${rest}`)
        return { handled: true }
      }
    } catch (e) {
      host.log('warn', `rollpig: ${e.message}`)
      await host.reply(chatOf(session), `抽小猪失败：${e.message}`)
      return { handled: true }
    }
    return { handled: false }
  },

  async call_tool({ name }) {
    if (name !== 'roll_pig') return { ok: false, error: '未知工具' }
    const pigs = await loadPigs()
    const pig = pigs[Math.floor(Math.random() * pigs.length)]
    return { ok: true, data: { text: `抽到小猪：${pig.title}\n${imageUrl(pig)}` } }
  },
})
