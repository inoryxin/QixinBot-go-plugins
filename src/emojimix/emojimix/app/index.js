import { serve, host } from '../_sdk/qixin.mjs'

const DATES = ['20201001','20210218','20210521','20210831','20211115','20220110','20220203','20220406','20220506']
const API = 'https://www.gstatic.com/android/keyboard/emojikitchen/'
const CACHE = new Map()

function codeOf(char) {
  const s = String(char ?? '').trim()
  if (!/\p{Extended_Pictographic}/u.test(s)) return ''
  return [...s].map((c) => c.codePointAt(0).toString(16)).join('-')
}

function u(code) {
  return code.split('-').map((part) => 'u' + part).join('-')
}

async function mix(one, two) {
  const a = codeOf(one)
  const b = codeOf(two)
  if (!a) return { error: `不支持这个 emoji：${one}` }
  if (!b) return { error: `不支持这个 emoji：${two}` }
  const key = [a, b].sort().join('|')
  if (CACHE.has(key)) return { ...CACHE.get(key) }

  const pairs = [[a, b], [b, a]]
  for (const date of DATES) {
    for (const [x, y] of pairs) {
      const url = `${API}${date}/${u(x)}/${u(x)}_${u(y)}.png`
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(12000) })
        if (!resp.ok) continue
        const buffer = Buffer.from(await resp.arrayBuffer())
        if (buffer.length < 100) continue
        if (CACHE.size > 200) CACHE.clear()
        const hit = { buffer, url }
        CACHE.set(key, hit)
        return hit
      } catch {}
    }
  }
  return { error: `没有 ${one}+${two} 这个组合` }
}

function emojisOf(text) {
  return String(text || '').match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu) || []
}

function chatOf(session) {
  return { account: session.account || '', chat_type: session.chat_type || 'private', chat_id: session.chat_id }
}

serve({
  async initialize() {
    host.log('info', 'emoji 合成插件启动')
    return { api_version: '1.0' }
  },

  async handle_message({ session }) {
    const list = emojisOf(session.text)
    if (list.length < 2) return { handled: false }
    const r = await mix(list[0], list[1])
    if (r.error) {
      // 没有这个组合就安静跳过，不回复
      return { handled: true }
    }
    await host.reply(chatOf(session), [
      { type: 'image', data: { file: `base64://${r.buffer.toString('base64')}` } },
    ])
    return { handled: true }
  },

  async call_tool({ name, args }) {
    if (name !== 'mix_emoji') return { ok: false, error: '未知工具' }
    const r = await mix(args?.emoji1, args?.emoji2)
    if (r.error) return { ok: false, error: r.error }
    return { ok: true, data: { image: r.buffer.toString('base64'), text: '合成好了' } }
  },
})
