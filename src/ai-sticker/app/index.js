import { serve, host } from '../_sdk/qixin.mjs'
import crypto from 'node:crypto'

let settings = {}
let visionSupported = false
const INDEX_KEY = 'sticker:index'
const HASH_KEY = 'sticker:hashes'
const MAX_BYTES = 3 * 1024 * 1024

const EMOTIONS = ['开心', '难过', '生气', '害羞', '无语', '惊讶', '安慰', '期待', '困', '晚安', '吃饭', '摸鱼']

function now() { return Math.floor(Date.now() / 1000) }
function uid() { return crypto.randomBytes(6).toString('hex') }
function dataURLToBuf(u) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(u || ''))
  if (!m) throw new Error('不是 data URL')
  return m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]))
}
function imageSize(buf) {
  if (!buf || buf.length < 20) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: 'image/png' }
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), mime: 'image/gif' }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue }
      const marker = buf[i + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), mime: 'image/jpeg' }
      }
      i += 2 + buf.readUInt16BE(i + 2)
    }
    return null
  }
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    const chunk = buf.slice(12, 16).toString('ascii')
    if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), mime: 'image/webp' }
    if (chunk === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, mime: 'image/webp' }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21)
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, mime: 'image/webp' }
    }
  }
  return null
}

function isStickerLike(buf) {
  if (!buf?.length) return false
  const maxKb = Number(settings.steal_max_kb ?? 1024)
  if (maxKb > 0 && buf.length > maxKb * 1024) return false
  const size = imageSize(buf)
  if (!size) return false
  const maxSide = Number(settings.steal_max_side ?? 720)
  const minSide = Number(settings.steal_min_side ?? 80)
  if (size.width < minSide || size.height < minSide) return false
  if (size.width > maxSide || size.height > maxSide) return false
  const ratio = size.width / size.height
  if (ratio < 0.45 || ratio > 2.2) return false
  return true
}

function mimeOf(u) {
  const m = /^data:([^;,]+)/.exec(String(u || '')); return m ? m[1] : 'image/png'
}
function hashOf(u) { return crypto.createHash('sha1').update(String(u)).digest('hex') }

async function loadIndex() {
  const v = await host.storage.get(INDEX_KEY)
  return Array.isArray(v) ? v : []
}
async function saveIndex(list) { await host.storage.set(INDEX_KEY, list) }
async function hashes() {
  const v = await host.storage.get(HASH_KEY)
  return Array.isArray(v) ? v : []
}
async function rememberHash(hash) {
  const list = await hashes()
  if (list.includes(hash)) return
  list.push(hash)
  while (list.length > 5000) list.shift()
  await host.storage.set(HASH_KEY, list)
}

async function putImage(id, dataUrl) {
  if (Buffer.byteLength(dataUrl) > MAX_BYTES * 1.4) throw new Error('图片太大（>3MB）')
  await host.storage.set(`sticker:img:${id}`, dataUrl)
}
async function getImage(id) { return await host.storage.get(`sticker:img:${id}`) }

function remoteBase() { return String(settings.remote_url || '').replace(/\/+$/, '') }
function remoteOn() { return settings.remote_enabled === true || settings.remote_enabled === 'true' || settings.remote_enabled === 1 }

// 远程库（祈歆表情包）是密码登录 + Cookie 会话：
//   POST /api/login {password}  -> Set-Cookie
//   GET  /api/state            -> { images:[{url,emotion,usage,tags,...}] }
//   POST /api/upload           -> {files:[{data,category,tags,emotion,usage}]}
let remoteCookie = ''
const EMO_CODE = { '开心': 'happy', '难过': 'sad', '生气': 'angry', '害羞': 'shy', '无语': 'confused', '惊讶': 'confused', '安慰': 'love', '期待': 'happy', '困': 'tired', '晚安': 'tired', '吃饭': 'happy', '摸鱼': 'tired' }
const CODE_EMO = { happy: '开心', sad: '难过', angry: '生气', shy: '害羞', confused: '无语', tired: '困', love: '害羞' }

async function remoteLogin() {
  const r = await fetch(remoteBase() + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: String(settings.remote_pass || '') }),
  })
  if (!r.ok) throw new Error('远程库登录失败')
  const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []
  const raw = sc.length ? sc.join('; ') : (r.headers.get('set-cookie') || '')
  remoteCookie = raw.split(/,(?=[^;]+?=)/).map((x) => x.split(';')[0]).join('; ')
}

async function remoteJSON(path, opts = {}, retry = true) {
  if (!remoteBase()) throw new Error('未配置远程地址')
  const headers = { ...(opts.headers || {}) }
  if (remoteCookie) headers.cookie = remoteCookie
  const resp = await fetch(remoteBase() + path, { ...opts, headers, signal: AbortSignal.timeout(10000) })
  let body = null
  try { body = await resp.json() } catch { body = null }
  if (resp.status === 401 && retry) {
    await remoteLogin()
    return remoteJSON(path, opts, false)
  }
  return { status: resp.status, body }
}

async function remotePick(emotion, context) {
  const r = await remoteJSON('/api/state')
  if (r.status >= 300 || !r.body) throw new Error('远程库读取失败')
  const imgs = Array.isArray(r.body.images) ? r.body.images : []
  let pool = []
  if (emotion) {
    const code = EMO_CODE[emotion]
    if (code) pool = imgs.filter((i) => i.emotion === code)
  }
  // 情绪没匹配上才退到场景，最后才全库随机
  if (!pool.length && context) pool = imgs.filter((i) => (i.usage || []).includes(context))
  if (!pool.length) pool = imgs
  // 优先小图：远程原图可能好几 MB，聊天里没必要
  const small = pool.filter((i) => Number(i.size) > 0 && Number(i.size) <= 512 * 1024)
  if (small.length) pool = small
  if (!pool.length) throw new Error('远程库没有匹配的表情')
  const img = pool[Math.floor(Math.random() * pool.length)]
  const url = remoteBase() + img.url
  // 远程库在内网，WebUI/协议端不一定能直接访问；取回来转成 data URL 最稳
  let dataUrl = url
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer())
      if (buf.length <= 5 * 1024 * 1024) {
        const ct = resp.headers.get('content-type') || 'image/png'
        dataUrl = `data:${ct};base64,${buf.toString('base64')}`
      }
    }
  } catch (e) {
    host.log('debug', `远程图下载失败: ${e.message}`)
  }
  return {
    ok: true,
    remote: true,
    sticker: {
      id: img.id,
      emotion: CODE_EMO[img.emotion] || emotion,
      contexts: Array.isArray(img.usage) ? img.usage.slice(0, 2) : [],
      data_url: dataUrl,
    },
  }
}

async function remoteAdd({ dataUrl, emotion, contexts }) {
  const ext = /^data:image\/(\w+)/.exec(dataUrl)
  const name = `ai-${Date.now()}.${ext ? ext[1] : 'png'}`
  const r = await remoteJSON('/api/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      files: [{
        name,
        data: dataUrl,
        category: 'AI',
        tags: [emotion, ...(contexts || [])].filter(Boolean).slice(0, 8),
        emotion: EMO_CODE[emotion] || 'happy',
        usage: contexts || [],
      }],
    }),
  })
  if (r.status >= 300) throw new Error(`远程上传失败 HTTP ${r.status}`)
  const ok = (r.body?.added?.length || 0) + (r.body?.skipped?.length || 0) > 0
  if (!ok) throw new Error('远程库没有接受这张图')
  return true
}

// 远程优先，失败回退本地（串行化，避免并发学习同一张图重复入库）
let addChain = Promise.resolve()
function addSticker(args) {
  const run = addChain.then(() => addStickerInner(args))
  addChain = run.catch(() => {})
  return run
}
async function addStickerInner({ dataUrl, emotion, contexts, source }) {
  emotion = String(emotion || '开心').trim() || '开心'
  contexts = (contexts || []).map((x) => String(x).trim()).filter(Boolean)
  const hash = hashOf(dataUrl)
  const list = await loadIndex()
  // 本地按索引去重；全局 hash 只在远程模式下用于避免重复上传
  if (list.some((s) => s.hash === hash) || (remoteOn() && (await hashes()).includes(hash))) {
    return { ok: true, duplicate: true }
  }

  if (remoteOn() && remoteBase()) {
    try {
      await remoteAdd({ dataUrl, emotion, contexts })
      await rememberHash(hash)
      return { ok: true, remote: true }
    } catch (e) {
      host.log('warn', `远程库不可用，回退本地: ${e.message}`)
    }
  }

  const id = uid()
  await putImage(id, dataUrl)
  list.push({ id, hash, emotion, contexts, source: source || 'local', added_at: now() })
  await saveIndex(list)
  return { ok: true, id, local: true }
}

async function pickSticker({ emotion, context, chat_type, chat_id, source }) {
  emotion = String(emotion || '').trim()
  context = String(context || '').trim()

  // AI 聊天调用时，概率由本插件决定（和 ai-voice 的 chat_pct 一个模式）
  if (source === 'chat') {
    const on = settings.chat_enabled === true || settings.chat_enabled === 'true' || settings.chat_enabled === 1 || settings.chat_enabled === undefined
    if (!on) return { ok: false, skipped: 'disabled', pct: 0 }
    const pct = Math.max(0, Math.min(100, Number(settings.chat_pct ?? 25)))
    if (pct <= 0 || Math.random() * 100 >= pct) {
      return { ok: false, skipped: 'probability', pct }
    }
  }

  if (remoteOn() && remoteBase() && settings.remote_takeover !== false) {
    try {
      return await remotePick(emotion, context)
    } catch (e) {
      host.log('debug', `远程取表情失败，回退本地: ${e.message}`)
    }
  }

  const list = await loadIndex()
  let pool = list
  if (emotion) {
    const match = list.filter((s) => s.emotion === emotion || (s.contexts || []).includes(context))
    if (match.length) pool = match
  }
  if (!pool.length) return { ok: false, error: '没有可用的表情包' }
  const st = pool[Math.floor(Math.random() * pool.length)]
  const dataUrl = await getImage(st.id)
  if (!dataUrl) return { ok: false, error: '表情文件丢失' }
  return { ok: true, sticker: { ...st, data_url: dataUrl } }
}

// 用视觉模型判断图片是不是表情包并打标签
async function classifyImage(dataUrl) {
  const prompt = '判断这张图是不是聊天里用来发的表情包/梗图。截图、聊天记录截图、网页、文档、文字长图、照片、商品图、视频封面、人物自拍、UI 界面都不是表情包。只有卡通/二次元/动物/夸张表情、带配字、透明背景或明显梗图才算。只输出 JSON：{"is_sticker":true/false,"emotion":"开心|难过|生气|害羞|无语|惊讶|安慰|期待|困|晚安|吃饭|摸鱼 之一","contexts":["打招呼","安慰","夸赞","吐槽","晚安","吃饭","摸鱼","撒娇"] 中最多两个}。不确定就 is_sticker=false。'
  const r = await host.capability('llm.chat', {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
    temperature: 0,
  })
  if (!r || r.ok === false) {
    host.log('debug', `表情识别失败: ${r?.error || '无返回'}`)
    return null
  }
  // 能力返回统一是 {ok,data:{text}}；兼容旧字段 r.text
  let text = typeof r.data?.text === 'string' ? r.data.text : (typeof r.text === 'string' ? r.text : '')
  host.log('debug', `表情识别原始: ${text.slice(0, 160)}`)
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    const j = JSON.parse(m[0])
    if (!j.is_sticker) return false
    const emotion = EMOTIONS.includes(j.emotion) ? j.emotion : '开心'
    const contexts = Array.isArray(j.contexts) ? j.contexts.slice(0, 2).map(String) : []
    return { emotion, contexts }
  } catch { return null }
}

async function imageDataURL(seg) {
  const d = seg.data || {}
  let src = d.url || d.file || ''
  if (!src) return null
  if (src.startsWith('base64://')) return 'data:image/png;base64,' + src.slice(9)
  if (src.startsWith('data:')) return src
  if (!/^https?:\/\//.test(src)) return null
  const resp = await fetch(src, { signal: AbortSignal.timeout(8000) })
  if (!resp.ok) return null
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length > MAX_BYTES) return null
  const ct = resp.headers.get('content-type') || 'image/jpeg'
  return `data:${ct};base64,${buf.toString('base64')}`
}

serve({
  async initialize({ settings: s }) {
    settings = s || {}
    try {
      const info = await host.capability('llm.info', {})
      visionSupported = info?.data?.vision === true
    } catch {}
    host.log('info', `表情包插件启动，本地 ${(await loadIndex()).length} 张，远程 ${remoteOn() ? '开' : '关'}`)
    return { api_version: '1.0' }
  },

  async get_settings() { return { values: settings } },

  async set_settings({ values }) {
    settings = { ...settings, ...(values || {}) }
    return { ok: true }
  },

  async handle_message({ session }) {
    const t = String(session.text || '').trim()
    if (!/^表情包(状态)?$/.test(t)) return { handled: false }
    const list = await loadIndex()
    await host.reply({ account: session.account, chat_type: session.chat_type, chat_id: session.chat_id },
      `表情包本地 ${list.length} 张${remoteOn() ? '，远程库已启用' : '，远程库未启用'}`)
    return { handled: true }
  },

  async http({ method, path, query, body, content_type }) {
    const u = new URL('http://x' + (path || '/') + (query ? '?' + query : ''))
    const p = u.pathname
    const auth = () => true
    if (!auth()) return { status: 403, body: Buffer.from('forbidden').toString('base64') }
    const send = (status, ct, obj) => ({ status, content_type: ct, body: Buffer.from(obj).toString('base64') })
    const json = (obj, status = 200) => send(status, 'application/json; charset=utf-8', JSON.stringify(obj))

    try {
      if (method === 'GET' && p === '/list') {
        const list = await loadIndex()
        return json({ ok: true, stickers: list.map((s) => ({ ...s, has_image: true })), remote: remoteOn() })
      }
      if (method === 'GET' && p === '/image') {
        const id = u.searchParams.get('id') || ''
        const dataUrl = await getImage(id)
        if (!dataUrl) return send(404, 'text/plain', 'not found')
        const buf = dataURLToBuf(dataUrl)
        return { status: 200, content_type: mimeOf(dataUrl), body: buf.toString('base64') }
      }
      if (method === 'POST' && p === '/upload') {
        const req = JSON.parse(Buffer.from(body || '', 'base64').toString('utf8') || '{}')
        if (!req.data_url) return json({ ok: false, error: '缺少图片' }, 400)
        const r = await addSticker({ dataUrl: req.data_url, emotion: req.emotion, contexts: req.contexts, source: 'admin' })
        return json(r)
      }
      if (method === 'POST' && p === '/tag') {
        const req = JSON.parse(Buffer.from(body || '', 'base64').toString('utf8') || '{}')
        const list = await loadIndex()
        const st = list.find((s) => s.id === req.id)
        if (!st) return json({ ok: false, error: '不存在' }, 404)
        if (req.emotion) st.emotion = String(req.emotion)
        if (Array.isArray(req.contexts)) st.contexts = req.contexts.map(String)
        await saveIndex(list)
        return json({ ok: true })
      }
      if (method === 'POST' && p === '/delete') {
        const req = JSON.parse(Buffer.from(body || '', 'base64').toString('utf8') || '{}')
        const list = await loadIndex()
        const i = list.findIndex((s) => s.id === req.id)
        if (i < 0) return json({ ok: false, error: '不存在' }, 404)
        list.splice(i, 1)
        await saveIndex(list)
        await host.storage.delete(`sticker:img:${req.id}`)
        return json({ ok: true })
      }
      if (method === 'GET' && p === '/stats') {
        const list = await loadIndex()
        const by = {}
        for (const s of list) by[s.emotion] = (by[s.emotion] || 0) + 1
        return json({ ok: true, total: list.length, by_emotion: by, remote: remoteOn(), remote_url: remoteBase() })
      }
      if (method === 'POST' && p === '/remote/test') {
        try {
          const r = await remoteJSON('/api/state')
          const n = Array.isArray(r.body?.images) ? r.body.images.length : 0
          return json({ ok: r.status < 300, status: r.status, count: n })
        } catch (e) {
          return json({ ok: false, error: e.message })
        }
      }
      return json({ ok: false, error: '未知接口' }, 404)
    } catch (e) {
      return json({ ok: false, error: e.message }, 500)
    }
  },

  async call_tool({ name, args }) {
    if (name === 'sticker.pick') return await pickSticker(args || {})
    if (name === 'sticker.learn') {
      const dataUrl = args?.data_url
      if (!dataUrl) return { ok: false, error: '缺少 data_url' }
      if (settings.steal_enabled === false || settings.steal_enabled === 'false') {
        return { ok: true, learned: false, skipped: 'disabled' }
      }
      const buf = dataURLToBuf(dataUrl)
      // 有视觉模型时以识图结果为准：截图、网页、聊天记录、照片都不是表情包。
      // 尺寸过滤只在没有视觉模型时兜底。
      let tags = null
      if (visionSupported) {
        tags = await classifyImage(dataUrl)
        if (tags === false) return { ok: true, learned: false, skipped: 'not-sticker' }
        if (!tags) return { ok: true, learned: false, skipped: 'classify-failed' }
      } else {
        if (!isStickerLike(buf)) return { ok: true, learned: false, skipped: 'not-sticker' }
        tags = { emotion: '待分类', contexts: ['待分类'] }
      }
      const r = await addSticker({ dataUrl, emotion: tags.emotion, contexts: tags.contexts, source: args?.source || 'water' })
      if (r.ok && !r.duplicate) host.log('info', `静默收藏表情包 ${tags.emotion}`)
      return { ok: true, learned: !r.duplicate, remote: !!r.remote }
    }
    if (name === 'sticker.add') return await addSticker({
      dataUrl: args?.data_url, emotion: args?.emotion, contexts: args?.contexts, source: args?.source,
    })
    return { ok: false, error: '未知能力' }
  },
})
