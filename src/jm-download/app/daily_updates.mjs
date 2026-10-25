// 「更新JM」每日采集 + 信息图渲染（QixinBot 版）。
//
// 与旧版 skill 的区别：
//   · 不再自己读宿主配置文件，也不自己猜路径：数据目录、引擎客户端、Python 路径
//     都由 app/index.js 通过 configure() 注入（同一个插件里只有一套配置来源）。
//   · 不再负责"发消息"：本文件只产出清单数据和图片路径，发消息统一走 index.js 的
//     host.reply —— 这样群白名单、权限、失败降级只有一处实现。
//   · 采集由 index.js 的定时器驱动（发行版没有框架级 [[schedule]]）。
//
// 状态文件：<data>/daily_updates.json
//   { date: "2026-10-26", items: [{ id, name, author, category, categorySub, tags, updateAt, seenAt, cover }], lastRun }
//   按 date 键存：过午夜后第一次采集自动重置（"晚上 12 点清空重新积累"）。
//
// 接口来源（旧版实测确认）：
//   · 列表 GET /latest?p=N —— 每页 80 条，按发布时间倒序，含 update_at（unix 秒）
//   · 封面 GET /media/albums/<id>_3x4.jpg —— 与正文同批图片域名
//   · tags 不在列表里，逐本调 /album?id= 补（失败不致命）

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as engine from './engine.js'
import { findPython } from './pdf.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const STATE_KEEP_DAYS = 3
const MAX_ITEMS = 300

let deps = {
  dataRoot: () => '.',
  client: () => engine.createClient({ fetchImpl: globalThis.fetch, timeoutMs: () => 30000 }),
  warn: () => {},
  pythonPath: () => '',
}

/** 由 index.js 注入运行环境。必须在第一次使用前调用。 */
export function configure(next = {}) {
  deps = { ...deps, ...next }
}

const dataRoot = () => String(deps.dataRoot() || '.')
export const stateFile = () => path.join(dataRoot(), 'daily_updates.json')
export const coverDir = () => path.join(dataRoot(), 'daily-covers')

/** 东八区的今天（服务器可能是 UTC）。 */
export function todayKey(now = Date.now()) {
  const d = new Date(now + 8 * 3600000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 今天 0 点（东八区）的 unix 秒。 */
export function todayStartTs(now = Date.now()) {
  return Math.floor(Date.parse(`${todayKey(now)}T00:00:00+08:00`) / 1000)
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    if (s && typeof s === 'object' && Array.isArray(s.items)) return s
  } catch {
    /* 没有/损坏都从空开始 */
  }
  return { date: todayKey(), items: [] }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 1))
}

// ───────────────────────── 采集 ─────────────────────────

async function fetchLatestPage(client, page) {
  const r = await client.jmApi(`/latest?p=${encodeURIComponent(page)}`)
  return Array.isArray(r) ? r : (r?.list ?? r?.content ?? [])
}

/** 下载封面 /media/albums/<id>_3x4.jpg，多域名轮询。失败返回 ''（不致命）。 */
async function fetchCover(client, albumId) {
  const covers = coverDir()
  fs.mkdirSync(covers, { recursive: true })
  const target = path.join(covers, `${albumId}.jpg`)
  try {
    if (fs.existsSync(target) && fs.statSync(target).size > 1024) return target
  } catch {
    /* ignore */
  }
  const ts = Math.floor(Date.now() / 1000)
  for (const domain of engine.IMAGE_DOMAINS) {
    for (const q of [`?v=${ts}`, '']) {
      const res = await client.httpGet(`https://${domain}/media/albums/${albumId}_3x4.jpg${q}`, {
        headers: {
          'user-agent': engine.UA_APP,
          accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          referer: `https://${engine.IMAGE_DOMAINS[0]}/`,
          'accept-language': 'zh-CN,zh;q=0.9',
        },
        retries: 0,
      })
      if (res.ok && res.buffer?.length > 1024) {
        const b = res.buffer
        const looksLikeImage = (b[0] === 0xff && b[1] === 0xd8) || b[0] === 0x89 || (b[0] === 0x52 && b[1] === 0x49)
        if (!looksLikeImage) continue
        fs.writeFileSync(target, b)
        return target
      }
    }
  }
  return ''
}

/** 跨天时清掉昨天的封面（只保留今天的），防止目录无限膨胀。 */
function pruneOldCovers(keepIds) {
  try {
    for (const f of fs.readdirSync(coverDir())) {
      if (!f.endsWith('.jpg')) continue
      if (!keepIds.has(f.slice(0, -4))) fs.rmSync(path.join(coverDir(), f), { force: true })
    }
  } catch {
    /* 目录不存在就算了 */
  }
}

/** 按 albumId 从站点拉封面，缓存到 daily-covers（本地书架卡片兜底用）。 */
export async function fetchSiteCover(albumId) {
  try {
    return await fetchCover(deps.client(), String(albumId))
  } catch {
    return ''
  }
}

/** 归档：把过期日期的状态压到 days 字段里，只保留最近 3 天。 */
function archiveOld(state) {
  try {
    const arch = fs.existsSync(stateFile()) ? JSON.parse(fs.readFileSync(stateFile(), 'utf8')) : {}
    const days = arch.days && typeof arch.days === 'object' ? arch.days : {}
    if (arch.date && Array.isArray(arch.items) && arch.date !== state.date) {
      days[arch.date] = { count: arch.items.length, at: arch.lastRun ?? '' }
    }
    while (Object.keys(days).length > STATE_KEEP_DAYS) {
      delete days[Object.keys(days).sort()[0]]
    }
    state.days = days
  } catch {
    /* 归档失败不影响主流程 */
  }
}

/**
 * 采集一轮（由定时器每 30 分钟调用）。
 * @returns {Promise<{added:number,total:number}>}
 */
export async function collect({ pages = 3 } = {}) {
  const client = deps.client()
  const state = loadState()
  const today = todayKey()

  if (state.date !== today) {
    archiveOld(state)
    pruneOldCovers(new Set())
    state.date = today
    state.items = []
  }

  const known = new Set(state.items.map((x) => String(x.id)))
  const startTs = todayStartTs()
  const todayItems = []
  let newestUpdateAt = 0

  for (let page = 1; page <= pages; page += 1) {
    const list = await fetchLatestPage(client, page)
    if (!list.length) break
    let allStale = true
    for (const raw of list) {
      const upd = Number(raw?.update_at) || 0
      if (upd >= startTs) allStale = false
      if (upd >= startTs && upd > newestUpdateAt) newestUpdateAt = upd
      const id = String(raw?.id ?? '').trim()
      if (!id || upd < startTs || known.has(id)) continue
      todayItems.push({
        id,
        name: String(raw.name ?? '').trim(),
        author: String(raw.author ?? '').trim(),
        category: String(raw.category?.title ?? '').trim(),
        categorySub: String(raw.category_sub?.title ?? '').trim(),
        updateAt: upd,
      })
      known.add(id)
    }
    if (allStale) break
  }

  let added = 0
  for (const item of todayItems) {
    if (state.items.length >= MAX_ITEMS) break
    let tags = []
    try {
      const detail = await client.albumInfo(item.id)
      tags = (detail.tags ?? []).slice(0, 8)
      if (!item.name) item.name = detail.name ?? ''
      if (!item.author) item.author = (detail.authors ?? [])[0] ?? ''
    } catch {
      /* 详情偶发失败就先记列表信息，tags 留空 */
    }
    item.tags = tags
    item.cover = await fetchCover(client, item.id)
    item.seenAt = new Date().toISOString()
    state.items.push(item)
    added += 1
  }

  state.lastRun = new Date().toISOString()
  state.newestUpdateAt = Math.max(state.newestUpdateAt || 0, newestUpdateAt)
  saveState(state)
  if (added) deps.warn(`更新采集：新增 ${added}，当日累计 ${state.items.length}`)
  return { added, total: state.items.length }
}

// ───────────────────────── 排版 ─────────────────────────

/** 去掉「[xxx漢化組](C108)」这类前缀/标签块，让标题干净可读。 */
export function cleanTitle(name) {
  let s = String(name ?? '')
  s = s
    .replace(/^\s*(?:\[[^\]]*\]|\([^)]*\)|【[^】]*】)+\s*/g, '')
    .replace(/\s*\[[^\]]*?(?:漢化|汉化|翻譯|翻译|漢化組|字幕|掃圖|嵌字|個人|汉化组)[^\]]*?\]\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return s || String(name ?? '').trim()
}

const hhmm = (ts) => {
  const d = new Date(Number(ts) * 1000 + 8 * 3600000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/**
 * 读状态并产出「已处理」的清单条目（繁→简、日文标题翻译、排序）。
 * @returns {Promise<{date:string, until:string, items:Array<{id,title,kind,tags,cover,updateAt}>}>}
 */
export async function loadDigestItems({ simplify, translate } = {}) {
  const state = loadState()
  const today = todayKey()
  const simp = (s) => (typeof simplify === 'function' ? simplify(s) : String(s ?? ''))

  if (state.date !== today || !state.items.length) return { date: today, until: '', items: [] }

  const items = [...state.items].sort((a, b) => Number(b.updateAt || 0) - Number(a.updateAt || 0))

  if (typeof translate === 'function') {
    await translate(items.slice(0, 40).map((it) => {
      const zh = simp(String(it.name || '').trim())
      return { key: it.id, title: zh, apply: (t) => { if (t) it._name = t } }
    }))
  }

  return {
    date: today,
    until: hhmm(state.newestUpdateAt || Math.floor(Date.now() / 1000)),
    items: items.map((it) => {
      const catParts = [it.category, it.categorySub].map((c) => simp(String(c ?? '').trim())).filter(Boolean)
      const kind = catParts[0] === catParts[1] ? catParts[0] : catParts.join('/')
      return {
        id: String(it.id),
        title: cleanTitle(simp(String(it._name || it.name || `JM${it.id}`))),
        kind,
        tags: (it.tags ?? []).map((t) => simp(t)).filter(Boolean).slice(0, 5),
        cover: it.cover && fs.existsSync(it.cover) ? it.cover : '',
        updateAt: it.updateAt,
      }
    }),
  }
}

/** 文字版清单（Pillow 不可用时的降级路径）。 */
export async function buildDigestFromState({ simplify, translate, limit = 40 } = {}) {
  const { until, items: all } = await loadDigestItems({ simplify, translate })
  if (!all.length) {
    return { text: '今天还没有采集到禁漫更新（每 30 分钟自动抓一次，先等等再看）。', count: 0 }
  }
  let budget = 3200
  const lines = []
  const shown = all.slice(0, limit)
  for (let i = 0; i < shown.length; i += 1) {
    const it = shown[i]
    const short = it.title.length > 42 ? `${it.title.slice(0, 42)}…` : it.title
    const bits = [it.kind, it.tags.join('/')].filter(Boolean)
    let line = `${i + 1}. JM${it.id}「${short}」`
    if (bits.length) line += ` — ${bits.join(' · ')}`
    line += `（${hhmm(it.updateAt)} 更新）`
    if (budget - line.length < 0) {
      lines.push(`…（还有 ${all.length - i} 本没列全，稍后再发「更新JM」看增量）`)
      break
    }
    budget -= line.length
    lines.push(line)
  }
  return {
    text: `📥 今日禁漫更新 ${all.length} 本（截至 ${until}）：\n${lines.join('\n')}\n想下载哪本，直接发编号（如 jm${all[0].id}）即可。`,
    count: all.length,
  }
}

// ───────────────────────── 图片版（默认） ─────────────────────────

let cachedPython = null

function resolvePythonExe() {
  if (cachedPython) return cachedPython
  try {
    const found = findPython(String(deps.pythonPath() || '').trim())
    cachedPython = found.ok ? { exe: found.exe } : { exe: 'python', error: found.error }
  } catch (error) {
    cachedPython = { exe: 'python', error: String(error?.message ?? error) }
  }
  return cachedPython
}

/** 重置 Python 探测缓存（设置里改了解释器路径时用）。 */
export function resetPythonCache() {
  cachedPython = null
}

/** 起 Python 跑 daily_image.py：JSON 从 stdin 喂，成功返回图片路径。 */
async function spawnPythonRender(extraArgs, payload, target) {
  const resolved = resolvePythonExe()
  const py = resolved.exe
  const script = path.join(HERE, 'daily_image.py')
  const { spawn } = await import('node:child_process')
  fs.mkdirSync(path.dirname(target), { recursive: true })

  return new Promise((resolve, reject) => {
    const child = spawn(py, [script, ...extraArgs, target], {
      stdio: ['pipe', 'ignore', 'pipe'],
      // 必须显式要求 UTF-8：Windows 上 Python 默认按本地代码页解 stdin，
      // 中文标题/简介会变成乱码（数字和 ASCII 不受影响，所以只表现为中文全坏）。
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true,
    })
    let errOut = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, 60000)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.stderr.on('data', (b) => { errOut += b.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && fs.existsSync(target) && fs.statSync(target).size > 1024) {
        resolve(target)
      } else {
        reject(new Error(`daily_image.py 退出码 ${code}（解释器 ${py}）${errOut ? `：${errOut.trim().slice(0, 200)}` : ''}`))
      }
    })
    child.stdin.end(JSON.stringify(payload), 'utf8')
  })
}

/** 清单信息图（封面网格）。失败抛错，调用方降级到文字版。 */
export async function renderDigestImage({ payload, outPath } = {}) {
  const target = outPath || path.join(dataRoot(), 'daily-digest.jpg')
  return spawnPythonRender([], payload, target)
}

/** 单本简介信息卡（下载完成时发）。 */
export async function renderAlbumImage({ payload, outPath } = {}) {
  const target = outPath || path.join(dataRoot(), 'album-card.jpg')
  return spawnPythonRender(['--album'], payload, target)
}
