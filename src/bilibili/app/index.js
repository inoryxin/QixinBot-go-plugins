// B 站订阅
//
// 从 QixinBot 的 bilibili 插件移植（原版 33KB：plugin.js + bilibili-api.js + bilibili-watcher.js）。
// 改动：
//   - 轮询从 setTimeout 换成 [[schedule]] + run_task
//   - 数据从 bilibili.json/state.json 换成 host.storage
//   - 推送从 client.call 换成 host.sendMessage
//   - WebUI 的 HTTP 路由换成能力（bili.qr.* / bili.sub.*），面板用 /api/capabilities/call 调
import crypto from 'node:crypto'
import qrcode from '../deps/vendor/qrcode.js'
import { serve, host, chatOf } from '../_sdk/qixin.mjs'

let settings = {}

// ---------------------------------------------------------------- B 站 API

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// B 站 web bundle 里的固定置换表，用来从 nav.wbi_img 派生 mixin key
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20,
  34, 44, 52,
]

const LOGIN_COOKIE_KEYS = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']

class BilibiliError extends Error {
  constructor(code, message, url) {
    super(`bilibili ${code}: ${message}`)
    this.code = code
    this.url = url
  }
  get retryable() {
    return [-352, -412, -799, -509, -500].includes(this.code)
  }
}

function parseCookieString(cookie) {
  const map = new Map()
  for (const part of String(cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i === -1) continue
    map.set(part.slice(0, i).trim(), part.slice(i + 1).trim())
  }
  return map
}

function cookieFromLoginUrl(url) {
  try {
    const parsed = new URL(url)
    const parts = []
    for (const [name, value] of parsed.searchParams) {
      if (LOGIN_COOKIE_KEYS.includes(name) && value) parts.push(`${name}=${value}`)
    }
    return parts.join('; ')
  } catch {
    return ''
  }
}

function cookieFromSetCookie(headers) {
  const list = typeof headers?.getSetCookie === 'function' ? headers.getSetCookie() : []
  const parts = []
  for (const raw of list) {
    const pair = raw.split(';')[0]
    const i = pair.indexOf('=')
    if (i === -1) continue
    const name = pair.slice(0, i).trim()
    const value = pair.slice(i + 1).trim()
    if (LOGIN_COOKIE_KEYS.includes(name) && value) parts.push(`${name}=${value}`)
  }
  return parts.join('; ')
}

class BilibiliApi {
  constructor(cookie = '') {
    this.cookie = cookie
    this.mixin = undefined
    this.mixinAt = 0
    this.buvid3 = parseCookieString(cookie).get('buvid3')
    this.buvidAttemptedAt = 0
  }

  setCookie(cookie) {
    this.cookie = cookie ?? ''
    this.buvid3 = parseCookieString(this.cookie).get('buvid3')
  }

  get loggedIn() {
    return /SESSDATA=/.test(this.cookie)
  }

  async headers() {
    if (!this.buvid3) await this.ensureBuvid()
    return {
      'User-Agent': UA,
      Referer: 'https://space.bilibili.com/',
      Origin: 'https://space.bilibili.com',
      ...(this.cookie ? { Cookie: this.cookie } : {}),
    }
  }

  async ensureBuvid() {
    const now = Date.now()
    if (this.buvidAttemptedAt && now - this.buvidAttemptedAt < 5 * 60 * 1000) return
    this.buvidAttemptedAt = now
    try {
      const resp = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      })
      const json = JSON.parse(await resp.text())
      const buvid3 = json?.data?.b_3
      if (!buvid3) return
      this.buvid3 = buvid3
      this.cookie = this.cookie ? `${this.cookie.replace(/;\s*$/, '')}; buvid3=${buvid3}` : `buvid3=${buvid3}`
    } catch (err) {
      host.log('warn', `bilibili: 拿不到 buvid3: ${err.message}`)
    }
  }

  async request(url) {
    const resp = await fetch(url, { headers: await this.headers() })
    const text = await resp.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new BilibiliError(-412, '反爬页面而不是 JSON（需要登录 Cookie）', url)
    }
    if (json.code !== 0) throw new BilibiliError(json.code, json.message ?? 'unknown', url)
    return json
  }

  async mixinKey() {
    if (this.mixin && Date.now() - this.mixinAt < 30 * 60 * 1000) return this.mixin
    const json = await this.request('https://api.bilibili.com/x/web-interface/nav')
    const img = json?.data?.wbi_img?.img_url
    const sub = json?.data?.wbi_img?.sub_url
    if (!img || !sub) throw new BilibiliError(-1, 'nav 没给 wbi_img')
    const base = (u) => u.split('/').pop().split('.')[0]
    const raw = base(img) + base(sub)
    this.mixin = MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32)
    this.mixinAt = Date.now()
    return this.mixin
  }

  async signedUrl(base, params) {
    const mixin = await this.mixinKey()
    const all = { ...params, wts: Math.floor(Date.now() / 1000) }
    const query = Object.keys(all)
      .sort()
      .map((n) => {
        const v = String(all[n]).replace(/[!'()*]/g, '')
        return `${encodeURIComponent(n)}=${encodeURIComponent(v)}`
      })
      .join('&')
    const wRid = crypto.createHash('md5').update(query + mixin).digest('hex')
    return `${base}?${query}&w_rid=${wRid}`
  }

  async qrLoginStart() {
    const json = await this.request('https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header')
    const data = json.data ?? {}
    if (!data.url || !data.qrcode_key) throw new BilibiliError(-1, 'qrcode/generate 没给 url')
    return { url: data.url, key: data.qrcode_key }
  }

  async qrLoginPoll(key) {
    if (!key) throw new BilibiliError(-1, '缺少 qrcode key')
    const url =
      'https://passport.bilibili.com/x/passport-login/web/qrcode/poll' +
      `?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`
    const resp = await fetch(url, { headers: await this.headers() })
    let json
    try {
      json = JSON.parse(await resp.text())
    } catch {
      throw new BilibiliError(-412, '轮询时返回反爬页面', url)
    }
    const data = json.data ?? {}
    const code = Number(data.code ?? -1)
    if (code === 86101) return { state: 'waiting' }
    if (code === 86090) return { state: 'scanned' }
    if (code === 86038) return { state: 'expired', message: '二维码已过期，请刷新' }
    if (code !== 0) return { state: 'error', message: data.message || `未知状态 ${code}` }
    const cookie = cookieFromSetCookie(resp.headers) || cookieFromLoginUrl(data.url ?? '')
    if (!cookie) return { state: 'error', message: '登录成功但没解析到 SESSDATA' }
    return { state: 'confirmed', cookie, message: '登录成功' }
  }

  async nav() {
    const json = await this.request('https://api.bilibili.com/x/web-interface/nav')
    const data = json.data ?? {}
    return { isLogin: Boolean(data.isLogin), uname: data.uname ?? '', mid: data.mid ?? 0, vip: data.vipStatus === 1 }
  }

  async liveInfo(uid) {
    const json = await this.request(`https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=${uid}`)
    const data = json.data ?? {}
    return {
      liveStatus: Number(data.liveStatus ?? 0),
      roomId: Number(data.roomid ?? 0),
      title: data.title ?? '',
      cover: data.cover ?? '',
      link: data.link || (data.roomid ? `https://live.bilibili.com/${data.roomid}` : ''),
      online: Number(data.online ?? 0),
    }
  }

  async dynamicsRaw(uid) {
    const url = await this.signedUrl('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space', {
      host_mid: uid,
      offset: '',
      timezone_offset: -480,
      features: 'itemOpusStyle',
      platform: 'web',
    })
    const json = await this.request(url)
    return json.data?.items ?? []
  }

  async dynamics(uid) {
    const items = await this.dynamicsRaw(uid)
    return items.map(normalizeDynamic).filter(Boolean)
  }
}

function absoluteUrl(url) {
  if (!url) return ''
  if (url.startsWith('//')) return `https:${url}`
  return url
}

function normalizeDynamic(item) {
  const modules = item?.modules ?? {}
  const author = modules.module_author ?? {}
  const dynamic = modules.module_dynamic ?? {}
  const major = dynamic.major ?? {}
  const createdAt = Number(author.pub_ts ?? 0) * 1000
  const id = String(item.id_str ?? '')
  if (!id) return undefined

  const base = { id, createdAt, author: author.name ?? '', url: `https://t.bilibili.com/${id}`, cover: '', images: [], title: '', text: '' }

  if (major.archive) {
    return {
      ...base,
      kind: 'video',
      title: major.archive.title ?? '',
      text: major.archive.desc ?? '',
      cover: major.archive.cover ?? '',
      url: `https://www.bilibili.com/video/${major.archive.bvid ?? ''}`,
    }
  }
  if (major.article) {
    return {
      ...base,
      kind: 'article',
      title: major.article.title ?? '',
      text: major.article.desc ?? '',
      cover: absoluteUrl(major.article.covers?.[0]),
      url: absoluteUrl(major.article.jump_url) || base.url,
    }
  }

  const opus = major.opus ?? {}
  const summary = opus.summary?.text ?? dynamic.desc?.text ?? ''
  const title = opus.title ?? ''
  const pics = (opus.pics ?? []).map((p) => absoluteUrl(p.url)).filter(Boolean)

  if (pics.length) {
    return { ...base, kind: 'draw', title, text: summary, images: pics.slice(0, 4), url: absoluteUrl(opus.jump_url) || base.url }
  }
  return {
    ...base,
    kind: 'text',
    title,
    text: summary,
    url: absoluteUrl(opus.jump_url) || base.url,
    forward: item.type === 'DYNAMIC_TYPE_FORWARD',
  }
}

// ---------------------------------------------------------------- 消息段

function truncate(text, limit = 200) {
  const v = String(text ?? '').replace(/\s+/g, ' ').trim()
  return v.length > limit ? `${v.slice(0, limit)}…` : v
}

const textSeg = (text) => ({ type: 'text', data: { text: String(text) } })
const imageSeg = (url) => ({ type: 'image', data: { file: String(url) } })

function displayName(sub) {
  return sub.name?.trim() || `UID ${sub.uid}`
}

function liveStartSegments(sub, info) {
  const segs = []
  if (sub.atAll) segs.push({ type: 'at', data: { qq: 'all' } }, textSeg(' '))
  const lines = [`🔴 ${displayName(sub)} 开播了！`, info.title ? `标题：${info.title}` : '', info.link || ''].filter(Boolean)
  segs.push(textSeg(lines.join('\n')))
  if (info.cover) segs.push(imageSeg(info.cover))
  return segs
}

function liveEndSegments(sub, info) {
  const lines = [`⚫ ${displayName(sub)} 下播了`, info.title ? `本场：${info.title}` : '', info.link ?? ''].filter(Boolean)
  return [textSeg(lines.join('\n'))]
}

function postSegments(sub, post) {
  const who = displayName(sub)
  let head
  if (post.kind === 'video') head = `🎬 ${who} 发布了新视频`
  else if (post.kind === 'article') head = `📄 ${who} 发布了新专栏`
  else if (post.forward) head = `🔁 ${who} 转发了一条动态`
  else head = `📝 ${who} 发布了新动态`

  const lines = [head]
  if (post.title) {
    lines.push(post.kind === 'video' || post.kind === 'article' ? `《${truncate(post.title, 80)}》` : truncate(post.title, 120))
  }
  if (post.text) lines.push(truncate(post.text, 400))
  if (post.url) lines.push(post.url)

  const segs = [textSeg(lines.join('\n'))]
  const images = post.images?.length ? post.images : post.cover ? [post.cover] : []
  for (const img of images.slice(0, 4)) segs.push(imageSeg(img))
  return segs
}

// ---------------------------------------------------------------- 配置 / 状态

const MIN_REQUEST_GAP_MS = 1200
const MIN_LIVE_SECONDS = 30
const MIN_DYNAMIC_SECONDS = 60
const BACKOFF_START_MS = 60 * 1000
const BACKOFF_MAX_MS = 15 * 60 * 1000
const MAX_POSTS_PER_CYCLE = 5

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let api = new BilibiliApi('')
let state = { uids: {} }
let nextLiveAt = 0
let nextDynamicAt = 0
let pauseUntil = 0
let backoffMs = BACKOFF_START_MS
let nextRequestAt = 0

// 订阅列表存在 storage 里（设置项放不下数组）
async function loadConfig() {
  const subs = (await host.storage.get('subscriptions')) || []
  // 扫码登录写 storage，设置页填的写 settings —— 前者优先
  const cookie = (await host.storage.get('cookie')) || settings.cookie || ''
  api.setCookie(cookie)
  return {
    cookie,
    intervals: {
      liveSeconds: Math.max(MIN_LIVE_SECONDS, Number(settings.liveSeconds) || 60),
      dynamicSeconds: Math.max(MIN_DYNAMIC_SECONDS, Number(settings.dynamicSeconds) || 180),
    },
    subscriptions: (Array.isArray(subs) ? subs : [])
      .filter((s) => s && s.uid)
      .map((s) => ({
        uid: String(s.uid),
        name: s.name ?? '',
        groups: (Array.isArray(s.groups) ? s.groups : []).map(String),
        live: s.live !== false,
        video: s.video !== false,
        post: s.post !== false,
        atAll: Boolean(s.atAll),
      })),
  }
}

async function loadState() {
  const raw = await host.storage.get('state')
  state = raw && typeof raw === 'object' ? raw : { uids: {} }
  if (!state.uids || typeof state.uids !== 'object') state = { uids: {} }
}

async function saveState() {
  try {
    await host.storage.set('state', state)
  } catch (err) {
    host.log('warn', `bilibili: 状态保存失败: ${err.message}`)
  }
}

function uidState(uid) {
  if (!state.uids[uid]) state.uids[uid] = { liveStatus: null, lastPostAt: 0, lastPostId: '' }
  return state.uids[uid]
}

// ---------------------------------------------------------------- 轮询

async function guard(task) {
  if (Date.now() < pauseUntil) return undefined
  const wait = nextRequestAt ? nextRequestAt - Date.now() : 0
  if (wait > 0) await sleep(wait)
  nextRequestAt = Date.now() + MIN_REQUEST_GAP_MS
  try {
    const result = await task()
    backoffMs = BACKOFF_START_MS
    return result
  } catch (err) {
    if (err instanceof BilibiliError && err.retryable) {
      pauseUntil = Date.now() + backoffMs
      host.log('warn', `bilibili: 风控 ${err.code}，退避 ${Math.round(backoffMs / 1000)}s`)
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS)
    } else {
      host.log('warn', `bilibili: 请求失败: ${err.message}`)
    }
    return undefined
  }
}

async function push(sub, segments) {
  for (const group of sub.groups) {
    try {
      // 不传 account，宿主用唯一那个
      await host.sendMessage({ chat_type: 'group', chat_id: Number(group) }, segments)
    } catch (err) {
      host.log('error', `bilibili: 推送到群 ${group} 失败: ${err.message}`)
    }
  }
}

async function checkLive(sub, config) {
  const st = uidState(sub.uid)
  const info = await guard(() => api.liveInfo(sub.uid))
  if (!info) return

  const previous = st.liveStatus
  if (previous === null) {
    st.liveStatus = info.liveStatus
    host.log('debug', `bilibili: ${sub.uid} 直播基线 = ${info.liveStatus}`)
    return
  }
  if (info.liveStatus === 1 && previous !== 1) {
    st.liveStatus = 1
    host.log('info', `bilibili: ${sub.uid} 开播: ${info.title}`)
    await push(sub, liveStartSegments(sub, info))
    return
  }
  if (info.liveStatus === 0 && previous === 1) {
    st.liveStatus = 0
    host.log('info', `bilibili: ${sub.uid} 下播`)
    await push(sub, liveEndSegments(sub, info))
    return
  }
  st.liveStatus = info.liveStatus
}

// 命中屏蔽词就跳过（标题 + 正文）
async function blocked(post) {
  const kws = (await host.storage.get('blockKeywords')) || []
  if (!Array.isArray(kws) || !kws.length) return null
  const hay = `${post.title || ''} ${post.text || ''}`.toLowerCase()
  for (const kw of kws) {
    const k = String(kw).trim().toLowerCase()
    if (k && hay.includes(k)) return k
  }
  return null
}

async function checkDynamics(sub) {
  const st = uidState(sub.uid)
  const posts = await guard(() => api.dynamics(sub.uid))
  if (!posts || !posts.length) return

  const newest = posts.reduce((l, r) => (r.createdAt > l.createdAt ? r : l), posts[0])

  if (!st.lastPostAt) {
    st.lastPostAt = newest.createdAt
    st.lastPostId = newest.id
    if (!sub.name && newest.author) await rememberName(sub, newest.author)
    host.log('debug', `bilibili: ${sub.uid} 动态基线 ${new Date(newest.createdAt).toISOString()}`)
    return
  }

  const freshAll = posts
    .filter((p) => p.createdAt > st.lastPostAt && p.id !== st.lastPostId)
    .sort((l, r) => l.createdAt - r.createdAt)
  if (!freshAll.length) return

  // 只推开启的类型，但水位线要走完所有新动态，避免以后开启时补推一堆历史
  const allowed = (p) => (p.kind === 'video' ? sub.video : sub.post)
  const fresh = freshAll.filter(allowed).slice(-MAX_POSTS_PER_CYCLE)

  if (!sub.name && freshAll[0].author) await rememberName(sub, freshAll[0].author)

  for (const post of fresh) {
    const hit = await blocked(post)
    if (hit) {
      host.log('info', `bilibili: ${sub.uid} 动态 ${post.id} 命中屏蔽词「${hit}」，跳过`)
      continue
    }
    host.log('info', `bilibili: ${sub.uid} 新 ${post.kind} ${post.id}`)
    await push(sub, postSegments(sub, post))
    await saveState()
  }

  st.lastPostAt = Math.max(st.lastPostAt, ...freshAll.map((p) => p.createdAt))
  st.lastPostId = freshAll[freshAll.length - 1].id
  await saveState()
}

async function rememberName(sub, name) {
  try {
    const subs = (await host.storage.get('subscriptions')) || []
    const target = subs.find((s) => String(s.uid) === sub.uid)
    if (!target || target.name) return
    target.name = name
    await host.storage.set('subscriptions', subs)
    sub.name = name
    host.log('info', `bilibili: 学到 ${sub.uid} 的名字: ${name}`)
  } catch (err) {
    host.log('warn', `bilibili: 存名字失败: ${err.message}`)
  }
}

async function tick({ force = false } = {}) {
  const config = await loadConfig()
  await loadState()
  if (!config.subscriptions.length) return

  const now = Date.now()
  const doLive = force || now >= nextLiveAt
  const doDynamic = force || now >= nextDynamicAt
  if (!doLive && !doDynamic) return

  for (const sub of config.subscriptions) {
    if (doLive && sub.live) await checkLive(sub, config)
    if (doDynamic && (sub.video || sub.post)) await checkDynamics(sub)
  }

  await saveState()
  if (doLive) nextLiveAt = Date.now() + config.intervals.liveSeconds * 1000
  if (doDynamic) nextDynamicAt = Date.now() + config.intervals.dynamicSeconds * 1000
}

// ---------------------------------------------------------------- 服务

serve({
  async initialize({ settings: initial }) {
    settings = initial || {}
    api = new BilibiliApi(settings.cookie || '')
    host.log('info', `B站订阅启动 cookie=${settings.cookie ? '已配置' : '未配置'}`)
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...values }
    api.setCookie(settings.cookie || '')
    return { ok: true }
  },

  async handle_message({ session }) {
    const text = (session.text || '').trim()
    const m = /^(?:bili|b站)\s*(status|check|list|preview)?(?:\s+(\d+))?$/i.exec(text)
    if (!m) return { handled: false }

    const action = (m[1] ?? 'status').toLowerCase()
    try {
      if (action === 'preview') {
        const config = await loadConfig()
        const uid = m[2] ?? config.subscriptions[0]?.uid
        if (!uid) {
          await host.reply(chatOf(session), '没有订阅，先在插件设置里加一个 UP')
          return { handled: true }
        }
        const sub = config.subscriptions.find((s) => s.uid === uid) ?? { uid, name: '', groups: [] }
        const posts = await api.dynamics(uid)
        const latest = posts.sort((l, r) => r.createdAt - l.createdAt)[0]
        if (!latest) {
          await host.reply(chatOf(session), `没取到 ${uid} 的动态（检查 Cookie 是否有效）`)
          return { handled: true }
        }
        for (const seg of postSegments(sub, latest)) {
          await host.reply(chatOf(session), [seg])
        }
        return { handled: true }
      }

      if (action === 'check') {
        await tick({ force: true })
        await host.reply(chatOf(session), '已立即检查一次，结果见日志')
        return { handled: true }
      }

      const config = await loadConfig()
      const subs = config.subscriptions
      if (!subs.length) {
        await host.reply(chatOf(session), '还没有订阅任何 UP 主')
        return { handled: true }
      }

      const lines = [
        `订阅中：${subs.length} 个 UP 主`,
        `轮询：直播 ${config.intervals.liveSeconds}s / 动态 ${config.intervals.dynamicSeconds}s`,
        `Cookie：${config.cookie ? '已配置' : '未配置（动态接口会被风控拦截）'}`,
        '',
        ...subs.map((sub) => {
          const flags = [sub.live ? '直播' : '', sub.video ? '视频' : '', sub.post ? '图文' : '', sub.atAll ? '@全体' : '']
            .filter(Boolean)
            .join('/')
          return `· ${sub.name || sub.uid}（${sub.uid}）→ 群 ${sub.groups.join(', ') || '未设置'} [${flags || '全部关闭'}]`
        }),
      ]
      await host.reply(chatOf(session), lines.join('\n'))
    } catch (err) {
      host.log('error', `bilibili: ${err.message}`)
      await host.reply(chatOf(session), `B站订阅出错：${err.message}`)
    }
    return { handled: true }
  },

  async call_tool({ name, args }) {
    if (name === 'check_bilibili_live') {
      const config = await loadConfig()
      if (!config.subscriptions.length) return { ok: true, data: { text: '还没有订阅任何 B 站 UP 主' } }
      const lines = []
      for (const sub of config.subscriptions) {
        const who = sub.name || sub.uid
        try {
          const info = await api.liveInfo(sub.uid)
          if (Number(info.liveStatus) === 1) {
            lines.push(`${who} 正在直播：${info.title || '（无标题）'}${info.link ? ` ${info.link}` : ''}`)
          } else {
            lines.push(`${who} 没在直播`)
          }
        } catch (err) {
          lines.push(`${who} 查询失败：${err.message}`)
        }
      }
      return { ok: true, data: { text: lines.join('\n') } }
    }

    // ---- 订阅管理 / 二维码登录 ----
    if (name === 'bili.sub.list') {
      const config = await loadConfig()
      return { ok: true, data: { subscriptions: config.subscriptions, hasCookie: Boolean(config.cookie) } }
    }

    if (name === 'bili.sub.save') {
      const list = args?.subscriptions
      if (!Array.isArray(list)) return { ok: false, error: '需要 subscriptions 数组' }
      const seen = new Set()
      const cleaned = list.map((sub, index) => {
        const uid = String(sub?.uid ?? '').trim()
        if (!/^\d+$/.test(uid)) throw new Error(`第 ${index + 1} 条 uid 必须是数字`)
        if (seen.has(uid)) throw new Error(`重复订阅：${uid}`)
        seen.add(uid)
        return {
          uid,
          name: String(sub.name ?? '').slice(0, 40),
          groups: String(sub.groupsRaw ?? (sub.groups ?? []).join('|'))
            .split(/[|｜,，\s]+/)
            .map((x) => x.trim())
            .filter((g) => /^\d+$/.test(g)),
          live: sub.live !== false,
          video: sub.video !== false,
          post: sub.post !== false,
          atAll: Boolean(sub.atAll),
        }
      })
      await host.storage.set('subscriptions', cleaned)
      return { ok: true, data: { count: cleaned.length } }
    }

    if (name === 'bili.qr.start') {
      const { url, key } = await api.qrLoginStart()
      // 本地生成 SVG 内联成 data URL，不依赖外部二维码服务
      const qr = qrcode(0, 'M')
      qr.addData(url)
      qr.make()
      const svg = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true })
      const qrImage = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
      return { ok: true, data: { key, url, qrImage } }
    }

    if (name === 'bili.qr.poll') {
      const key = String(args?.key ?? '')
      if (!key) return { ok: false, error: '需要 key' }
      const result = await api.qrLoginPoll(key)
      if (result.state === 'confirmed') {
        settings.cookie = result.cookie
        api.setCookie(result.cookie)
        await host.storage.set('cookie', result.cookie)
        host.log('info', 'bilibili: 扫码登录成功，Cookie 已保存')
        return { ok: true, data: { state: 'confirmed', message: result.message } }
      }
      return { ok: true, data: { state: result.state, message: result.message || null } }
    }

    if (name === 'bili.block.get') {
      const kws = (await host.storage.get('blockKeywords')) || []
      return { ok: true, data: { keywords: kws } }
    }

    if (name === 'bili.block.save') {
      const kws = args?.keywords
      if (!Array.isArray(kws)) return { ok: false, error: '需要 keywords 数组' }
      const clean = kws.map((x) => String(x).trim()).filter(Boolean).slice(0, 50)
      await host.storage.set('blockKeywords', clean)
      host.log('info', `bilibili: 屏蔽词已更新（${clean.length} 个）`)
      return { ok: true, data: { count: clean.length } }
    }

    if (name === 'bili.nav') {
      try {
        return { ok: true, data: await api.nav() }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    }

    return { ok: false, error: `未知工具 ${name}` }
  },

  async run_task({ task }) {
    if (task !== 'poll') return { ok: true }
    try {
      await tick()
    } catch (err) {
      host.log('debug', `bilibili: 轮询失败: ${err.message}`)
    }
    return { ok: true }
  },
})
