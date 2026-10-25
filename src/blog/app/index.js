import fs from 'node:fs'
import { serve, host } from '../_sdk/qixin.mjs'

const DEFAULTS = {
  baseUrl: 'https://home.inory.xin:20806',
  username: '',
  password: '',
  category: '',
  uploadToken: 'qixin-blog-upload-2026',
  aiStyle: '自然、简短、像个人博客',
  ownerQQ: '2849446053',
}

let settings = {}

const conf = () => ({ ...DEFAULTS, ...settings })
const escXml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const escHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function xml(v) {
  if (Array.isArray(v)) return `<array><data>${v.map(xml).join('')}</data></array>`
  if (v && typeof v === 'object') return `<struct>${Object.entries(v).map(([k, x]) => `<member><name>${escXml(k)}</name>${xml(x)}</member>`).join('')}</struct>`
  if (typeof v === 'number') return `<int>${Math.round(v)}</int>`
  if (typeof v === 'boolean') return `<boolean>${v ? 1 : 0}</boolean>`
  return `<string>${escXml(v)}</string>`
}

function parseXml(text) {
  const s = String(text ?? '').trim()
  const fault = /<fault>([\s\S]*?)<\/fault>/.exec(s)
  if (fault) {
    const m = /<name>faultString<\/name>\s*<value>\s*<string>([\s\S]*?)<\/string>/.exec(fault[1])
    throw new Error(m ? m[1] : 'XML-RPC fault')
  }
  const str = /<string>([\s\S]*?)<\/string>/.exec(s)
  if (str) return str[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  const int = /<int>(-?\d+)<\/int>/.exec(s)
  if (int) return Number(int[1])
  const bool = /<boolean>(\d)<\/boolean>/.exec(s)
  if (bool) return bool[1] === '1'
  return s
}

async function rpc(method, params) {
  const c = conf()
  const body = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map((p) => `<param>${xml(p)}</param>`).join('')}</params></methodCall>`
  const resp = await fetch(`${c.baseUrl.replace(/\/$/, '')}/index.php/action/xmlrpc`, {
    method: 'POST', headers: { 'Content-Type': 'text/xml' }, body, signal: AbortSignal.timeout(20000),
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`Typecho HTTP ${resp.status}`)
  return parseXml(text)
}

function toHtml(text) {
  return String(text ?? '').split(/\n{2,}/).map((p) => `<p>${escHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n')
}

function readImage(data) {
  const src = String(data?.url || data?.file || '').trim()
  if (!src) return null
  if (src.startsWith('file://')) {
    try { return { src, buffer: fs.readFileSync(new URL(src)) } } catch { return null }
  }
  if (src.startsWith('base64://')) return { src, buffer: Buffer.from(src.slice(9), 'base64') }
  return null
}

async function fetchImage(data) {
  const local = readImage(data)
  if (local) return local
  const src = String(data?.url || data?.file || '').trim()
  if (!/^https?:/i.test(src)) return null
  try {
    const resp = await fetch(src, { signal: AbortSignal.timeout(15000) })
    if (!resp.ok) return null
    return { src, buffer: Buffer.from(await resp.arrayBuffer()) }
  } catch { return null }
}

async function uploadImage(data) {
  const got = await fetchImage(data)
  if (!got?.buffer?.length || got.buffer.length > 8 * 1024 * 1024) return null
  const ext = /\.png/i.test(got.src) ? 'png' : /\.gif/i.test(got.src) ? 'gif' : 'jpg'
  const c = conf()
  try {
    const resp = await fetch(`${c.baseUrl.replace(/\/$/, '')}/upload.php`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: c.uploadToken,
        name: `qq-${Date.now()}.${ext}`,
        type: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
        data: got.buffer.toString('base64'),
      }),
      signal: AbortSignal.timeout(30000),
    })
    if (resp.ok) {
      const j = await resp.json()
      if (j.ok && j.url) return j.url
    }
  } catch (e) {
    host.log('warn', `blog 图片上传失败: ${e.message}`)
  }
  try {
    return await rpc('metaWeblog.newMediaObject', ['1', c.username, c.password, {
      name: `qq-${Date.now()}.${ext}`,
      type: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
      bits: got.buffer.toString('base64'),
    }])
  } catch { return null }
}

async function publishDraft(draft, publish = true) {
  const c = conf()
  const html = []
  const images = []
  for (const block of draft.blocks || []) {
    if (block.type === 'text') html.push(toHtml(block.text))
    if (block.type === 'image') {
      let url = await uploadImage(block.data).catch(() => null)
      if (!url) {
        const got = await fetchImage(block.data)
        if (got?.buffer?.length && got.buffer.length <= 8 * 1024 * 1024) {
          const mime = /\.png/i.test(got.src) ? 'image/png' : /\.gif/i.test(got.src) ? 'image/gif' : 'image/jpeg'
          url = `data:${mime};base64,${got.buffer.toString('base64')}`
        }
      }
      if (url) {
        if (!String(url).startsWith('data:')) images.push(url)
        html.push(`<p><img src="${escHtml(url)}" alt=""></p>`)
      }
    }
  }
  const id = await rpc('metaWeblog.newPost', ['1', c.username, c.password, {
    title: String(draft.title || '无标题').slice(0, 120),
    description: html.join('\n'),
    mt_keywords: (draft.tags || []).join(','),
    categories: c.category ? [c.category] : [],
  }, publish])
  return { id, title: draft.title, link: `${c.baseUrl.replace(/\/$/, '')}/index.php/archives/${id}/`, images }
}

function chatOf(session) {
  return { account: session.account, chat_type: session.chat_type, chat_id: session.chat_id }
}

function keyOf(session) {
  return `${session.chat_type || 'private'}:${session.chat_id || session.user_id}`
}

async function drafts() {
  try { return (await host.storage.get('drafts')) || {} } catch { return {} }
}

async function getDraft(session) {
  return (await drafts())[keyOf(session)] || null
}

async function saveDraft(session, draft) {
  const all = await drafts()
  if (draft) all[keyOf(session)] = draft
  else delete all[keyOf(session)]
  await host.storage.set('drafts', all)
}

function segmentsOf(session) {
  return session.segments || []
}

function append(draft, session) {
  const segments = segmentsOf(session)
  const texts = segments.filter((s) => s?.type === 'text').map((s) => String(s.data?.text || '')).filter(Boolean)
  const images = segments.filter((s) => s?.type === 'image')
  if (!draft.title && texts.length) draft.title = texts.shift().trim().slice(0, 120)
  for (const t of texts) if (t.trim()) draft.blocks.push({ type: 'text', text: t.trim() })
  for (const s of images) draft.blocks.push({ type: 'image', data: s.data || {} })
}

function preview(draft) {
  const text = (draft.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  return `标题：${draft.title || '（未命名）'}\n\n${text.slice(0, 800)}${text.length > 800 ? '…' : ''}\n\n回复：/blog 发送、/blog 发送同步、/blog 取消`
}

async function generate(topic) {
  const c = conf()
  const prompt = `你是博客作者。只输出 JSON：{"title":"标题","content":"正文","tags":["标签"]}。不要代码块，不要解释。\n风格：${c.aiStyle}\n主题：${topic || '最近的生活'}`
  const r = await host.capability('ai.chat', { text: prompt })
  if (!r?.ok) throw new Error(r?.error || 'AI 生成失败')
  const raw = String(r.data?.text || '').replace(/```[a-zA-Z]*\n?/g, '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('AI 没有返回文章 JSON')
  const data = JSON.parse(raw.slice(start, end + 1))
  return { title: String(data.title || '无标题'), blocks: [{ type: 'text', text: String(data.content || '') }], tags: Array.isArray(data.tags) ? data.tags : [] }
}

async function syncQzone(draft, result) {
  const body = (draft.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  const content = [draft.title, body].filter(Boolean).join('\n').slice(0, 1000)
  const params = { content, ugc_right: 1 }
  const images = (result.images || []).filter((u) => u && !String(u).startsWith('data:'))
  if (images.length) params.images = images.slice(0, 9)
  await host.callOnebot('send_qzone_msg', params)
}

serve({
  async initialize({ settings: s }) {
    settings = s || {}
    host.log('info', '博客插件启动')
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...(values || {}) }
    return { ok: true }
  },

  async handle_message({ session }) {
    if (settings.enabled === false || settings.enabled === 'false') return { handled: false }
    const owner = String(settings.ownerQQ || '').trim()
    if (owner && String(session.user_id) !== owner) return { handled: false }

    const text = String(session.text || '').trim()
    const cmd = /^\/?(?:blog|博客)\s*([\s\S]*)$/i.exec(text)
    const draft = await getDraft(session)

    try {
      if (cmd) {
        const action = cmd[1].trim()
        if (!action || action === '新建' || action === '开始') {
          await saveDraft(session, { title: '', blocks: [], tags: [] })
          await host.reply(chatOf(session), '开始写博客。下一条消息是标题，之后可以连续发文字和图片；完成后 /blog 发送')
          return { handled: true }
        }
        if (action === '取消') {
          await saveDraft(session, null)
          await host.reply(chatOf(session), '已取消当前博客草稿')
          return { handled: true }
        }
        if (action === '发送' || action === '发送同步') {
          if (!draft) {
            await host.reply(chatOf(session), '当前没有草稿，先发 /blog 开始')
            return { handled: true }
          }
          const result = await publishDraft(draft, true)
          await saveDraft(session, null)
          if (action === '发送同步') {
            try {
              await syncQzone(draft, result)
              await host.reply(chatOf(session), `博客已发布，并同步到 QQ 空间：${result.link}`)
            } catch (e) {
              await host.reply(chatOf(session), `博客已发布，但空间同步失败：${e.message}\n${result.link}`)
            }
          } else {
            await host.reply(chatOf(session), `博客已发布：${result.link}`)
          }
          return { handled: true }
        }
        if (action === '测试') {
          await rpc('metaWeblog.getRecentPosts', ['1', conf().username, conf().password, 1])
          await host.reply(chatOf(session), 'Typecho 连接正常')
          return { handled: true }
        }
        if (/^(写|生成|总结)(?:\s+|$)/.test(action)) {
          const article = await generate(action.replace(/^(写|生成|总结)(?:\s+|$)/, '').trim())
          await saveDraft(session, article)
          await host.reply(chatOf(session), `AI 草稿（未发布）：\n\n${preview(article)}`)
          return { handled: true }
        }
        if (action.includes('|')) {
          const [title, ...body] = action.split('|')
          const next = { title: title.trim(), blocks: [{ type: 'text', text: body.join('|').trim() }], tags: [] }
          await saveDraft(session, next)
          await host.reply(chatOf(session), `草稿（未发布）：\n\n${preview(next)}`)
          return { handled: true }
        }
        await host.reply(chatOf(session), '用法：/blog 开始，/blog 写 主题，/blog 发送，/blog 发送同步，/blog 取消，/blog 测试')
        return { handled: true }
      }

      if (!draft) return { handled: false }
      append(draft, session)
      await saveDraft(session, draft)
      if (!draft.title) await host.reply(chatOf(session), '已记录。继续发标题、文字或图片；完成后 /blog 发送')
      return { handled: true }
    } catch (e) {
      host.log('error', `blog: ${e.message}`)
      await host.reply(chatOf(session), `博客操作失败：${e.message}`)
      return { handled: true }
    }
  },

  async call_tool({ name, args }) {
    if (name !== 'publish_blog') return { ok: false, error: `未知工具 ${name}` }
    try {
      const result = await publishDraft({
        title: args?.title,
        blocks: [{ type: 'text', text: args?.content }],
        tags: [],
      }, true)
      return { ok: true, data: { text: `博客已发布：${result.link}` } }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  },
})
