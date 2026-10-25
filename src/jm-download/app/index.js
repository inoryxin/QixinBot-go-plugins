// 禁漫漫画下载（QixinBot 版）—— 异步队列 + PDF + 上传。
//
// 移植自 QQ Agent 技能 jm-download v2.5.1（原实现依赖 skill.json 的钩子把
// 固定指令改写成「让模型调工具」）。QixinBot 没有那套钩子，所以这里把指令
// **直接处理**：消息进来就判断、立刻回执、后台排队，不再绕模型一圈 ——
// 更快、更省 token，也不会出现"模型把暂停指令当聊天"的问题。
//
// 一次请求的完整链路（全部异步，不阻塞消息处理）：
//   群友发 jm123456
//     └─ handle_message 识别 ID → 入队 → 秒回「已排队」
//          └─ 后台 worker：① engine 下载原图（纯 Node）
//                          ② 现查 scramble_id
//                          ③ pdf.js → Python+Pillow 还原竖切、合成 PDF（可降级）
//                          ④ zip.js 打包（可选密码）
//                          ⑤ upload.js 上传到提出请求的会话
//                          ⑥ 简介信息卡 + 文字汇报
//
// 数据都在插件自己的 data/ 下（升级不丢）：任务记录、队列、群白名单、
// 下载目录、日语翻译缓存、每日采集状态。框架只负责发消息和 OneBot 直通。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { serve, host, chatOf } from '../_sdk/qixin.mjs'
import * as engine from './engine.js'
import * as pdfBridge from './pdf.js'
import { uploadFile, groupQuota, deleteGroupFile, humanSize } from './upload.js'
import { createZip, buildZipName } from './zip.js'
import {
  configure as configureDaily,
  collect as collectDaily,
  loadDigestItems,
  buildDigestFromState,
  renderDigestImage,
  resetPythonCache,
  cleanTitle,
  fetchSiteCover,
} from './daily_updates.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')
// 数据目录优先用框架注入的 QIXIN_DATA_DIR（运行时路径，绝对路径）；
// 直接 `node app/selftest.mjs` 或本地调试没有这个变量时，退回运行区的 data/。
// initialize 里的 data_dir 也是同一个路径，两处都认。
const ENV_DATA_DIR = String(process.env.QIXIN_DATA_DIR || '').trim()
let DATA_DIR = ENV_DATA_DIR && path.isAbsolute(ENV_DATA_DIR)
  ? ENV_DATA_DIR
  : path.resolve(PLUGIN_DIR, 'data')

// ───────────────────────── 模块级状态 ─────────────────────────

let settings = {}
const activeTasks = new Map() // albumId -> task
const taskQueue = [] // 待处理 albumId（有序）
let queueBusy = false
const activeByChat = new Map() // chatKey -> albumId
const firstSubmitters = new Map() // `${chatKey}:${albumId}` -> { id, name, at }
const uploadedGroupFiles = new Map() // `${chatKey}:${fileId}` -> { name, at }

let taskHistory = []
let historyLoaded = false
let jpCache = null
let jpCacheLoaded = false
let workerCache = { at: 0, result: null }
let timers = []

// ───────────────────────── 配置 ─────────────────────────

function num(v, dflt, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/**
 * 布尔设置。
 * 框架保存表单时，`type = "bool"` 会原样存成 "on"/"off" 字符串（只有
 * "boolean" 才转真布尔），所以这里必须把两种都认 —— 少认一种的表现是
 * "设置页明明关了，插件还在跑"。
 */
function boolv(v, dflt = false) {
  if (v === undefined || v === null || v === '') return dflt
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  const s = String(v).trim().toLowerCase()
  if (['on', 'true', '1', 'yes'].includes(s)) return true
  if (['off', 'false', '0', 'no'].includes(s)) return false
  return dflt
}

function cfg() {
  const c = settings || {}
  return {
    enabled: boolv(c.enabled, true),
    downloadDir: String(c.downloadDir ?? '').trim(),
    domains: String(c.domains ?? '').trim(),
    maxPages: num(c.maxPages, 500, 1, 5000),
    multiChapter: boolv(c.multiChapter, true),
    concurrency: num(c.concurrency, 4, 1, 8),
    timeoutSeconds: num(c.timeoutSeconds, 30, 5, 300),
    restore: boolv(c.restore, true),
    outputFormat: String(c.outputFormat || 'pdf').toLowerCase() === 'images' ? 'images' : 'pdf',
    deleteImagesAfterPdf: boolv(c.deleteImagesAfterPdf, false),
    pdfQuality: num(c.pdfQuality, 85, 30, 95),
    pdfMaxDim: num(c.pdfMaxDim, 0, 0, 6000),
    uploadMode: ['off', 'request', 'group', 'private'].includes(String(c.uploadMode))
      ? String(c.uploadMode)
      : 'request',
    rejectOversize: boolv(c.rejectOversize, false),
    maxUploadMB: num(c.maxUploadMB, 600, 1, 4096),
    checkQuota: boolv(c.checkQuota, true),
    zipEnabled: boolv(c.zipEnabled, true),
    zipPasswordEnabled: boolv(c.zipPasswordEnabled, false),
    zipPassword: String(c.zipPassword ?? '').trim(),
    zipPasswordInName: boolv(c.zipPasswordInName, true),
    allowIds: String(c.allowIds ?? '').trim(),
    keepHours: num(c.keepHours, 12, 0, 24 * 365),
    localReuseDays: num(c.localReuseDays, 30, 0, 3650),
    keepDays: num(c.keepDays, 7, 0, 365),
    groupFileKeepDays: num(c.groupFileKeepDays, 0, 0, 365),
    translateTitles: boolv(c.translateTitles, true),
    translateModel: String(c.translateModel ?? '').trim(),
    proxy: String(c.proxy ?? '').trim(),
  }
}

/** 下载根目录：优先配置，其次插件 data/。 */
function downloadRoot() {
  const custom = cfg().downloadDir
  return custom ? path.resolve(custom) : DATA_DIR
}

const log = (message, fields) => host.log('info', message, fields)
const debug = (message, fields) => host.log('debug', message, fields)
const warn = (message, fields) => host.log('warn', message, fields)

// ───────────────────────── 繁→简 / 日语标题翻译 ─────────────────────────

// 只带一张内置小表（不打包 opencc）：常用繁体基本够用，生僻字保持原样。
const TRAD_TO_SIMP = new Map(Object.entries({
  麗: '丽', 組: '组', 藝: '艺', 體: '体', 語: '语', 譯: '译', 畫: '画', 圖: '图', 書: '书', 學: '学',
  術: '术', 與: '与', 為: '为', 這: '这', 個: '个', 們: '们', 來: '来', 發: '发', 後: '后', 過: '过',
  點: '点', 時: '时', 間: '间', 長: '长', 開: '开', 關: '关', 門: '门', 風: '风', 雲: '云', 電: '电',
  腦: '脑', 愛: '爱', 夢: '梦', 壞: '坏', 專: '专', 傳: '传', 說: '说', 從: '从', 將: '将', 對: '对',
  於: '于', 無: '无', 萬: '万', 號: '号', 臺: '台', 裏: '里', 貓: '猫', 鳥: '鸟', 龍: '龙', 劍: '剑',
  戰: '战', 勝: '胜', 敗: '败', 強: '强', 經: '经', 濟: '济', 線: '线', 網: '网', 區: '区', 頁: '页',
  會: '会', 讓: '让', 實: '实', 現: '现', 應: '应', 該: '该', 種: '种', 樣: '样', 頭: '头', 見: '见',
  聽: '听', 讀: '读', 寫: '写', 舊: '旧', 簡: '简', 單: '单', 處: '处', 係: '系', 還: '还', 沒: '没',
  帶: '带', 絕: '绝', 極: '极', 視: '视', 覺: '觉', 氣: '气', 陰: '阴', 陽: '阳', 獸: '兽', 兒: '儿',
  兩: '两', 內: '内', 劃: '划', 劉: '刘', 廣: '广', 東: '东', 滿: '满', 給: '给', 華: '华', 麥: '麦',
  黃: '黄', 聖: '圣', 騎: '骑', 機: '机', 貝: '贝', 類: '类', 館: '馆', 醫: '医', 藥: '药', 練: '练',
  緩: '缓', 難: '难', 雜: '杂', 親: '亲', 遠: '远', 違: '违', 導: '导', 響: '响', 繪: '绘', 訂: '订',
  閱: '阅', 價: '价', 錢: '钱', 貴: '贵', 賣: '卖', 買: '买', 顯: '显', 標: '标', 題: '题', 記: '记',
  錄: '录', 總: '总', 結: '结', 預: '预', 備: '备', 運: '运', 動: '动', 際: '际', 稱: '称', 則: '则',
  復: '复', 製: '制', 續: '续', 斷: '断', 業: '业', 創: '创', 漢: '汉', 測: '测', 試: '试',
  潛: '潜', 繼: '继', 統: '统', 紀: '纪', 場: '场', 麼: '么', 幾: '几', 認: '认',
  識: '识', 講: '讲', 許: '许', 詩: '诗', 詞: '词', 調: '调', 變: '变',
}))

function toSimplified(value) {
  const text = String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return [...text].map((ch) => TRAD_TO_SIMP.get(ch) || ch).join('')
}

const KANA_RE = /[\u3040-\u309f\u30a0-\u30ff]/
const hasKana = (s) => KANA_RE.test(String(s || ''))

const JP_CACHE_FILE = () => path.join(DATA_DIR, 'jp-cache.json')

async function loadJpCache() {
  if (jpCacheLoaded) return jpCache
  try {
    jpCache = JSON.parse(await fsp.readFile(JP_CACHE_FILE(), 'utf8'))
  } catch {
    jpCache = {}
  }
  jpCacheLoaded = true
  return jpCache
}

async function saveJpCache() {
  try {
    await fsp.mkdir(path.dirname(JP_CACHE_FILE()), { recursive: true })
    await fsp.writeFile(JP_CACHE_FILE(), JSON.stringify(jpCache, null, 2), 'utf8')
  } catch (error) {
    warn(`日语翻译缓存写入失败：${error?.message ?? error}`)
  }
}

/** 调 llm.chat 能力批量翻译日文标题。返回 { 原文: 译文 }，失败返回 {}。 */
async function translateTitles(texts) {
  const c = cfg()
  if (!c.translateTitles) return {}
  const list = [...new Set(texts.filter((t) => t && hasKana(toSimplified(t))))]
  if (!list.length) return {}

  const prompt = [
    '把下面每条日文漫画标题翻译成简体中文。规则：',
    '1. 只翻译日文部分，已有的中文/英文/罗马音原样保留',
    '2. 方括号 [] 里通常是作者、社团、汉化组名 —— 原样保留，不要翻译',
    '3. 圆括号 () 里的作品名用中文常用译名',
    '4. 逐行输出，格式严格为「序号|译文」，不要编号以外的任何解释',
    '',
    ...list.map((t, i) => `${i + 1}. ${t}`),
  ].join('\n')

  const out = {}
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let r = null
    try {
      r = await host.capability('llm.chat', {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        ...(c.translateModel ? { model: c.translateModel } : {}),
      })
    } catch (error) {
      warn(`日语翻译调用失败（第 ${attempt} 次）：${error?.message ?? error}`)
    }
    const text = r?.ok ? String(r.data?.text || '') : ''
    if (!text.trim()) {
      if (attempt === 1) continue
      warn(`日语翻译不可用（llm.chat：${r?.error || '没有返回内容'}），本次保持原文`)
      return out
    }
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(\d+)\s*[|｜]\s*(.+?)\s*$/)
      if (!m) continue
      const idx = Number(m[1]) - 1
      if (idx >= 0 && idx < list.length) out[list[idx]] = m[2].trim()
    }
    if (Object.keys(out).length) log(`日语标题翻译完成：${Object.keys(out).length}/${list.length}`)
    return out
  }
  return out
}

/** 给一批标题补译文（带磁盘缓存）。失败不抛错 —— 翻译只是锦上添花。 */
async function ensureTranslatedTitles(items) {
  try {
    const cache = await loadJpCache()
    const need = []
    for (const it of items) {
      const t = String(it.title || '').trim()
      if (!t || !hasKana(t)) continue
      if (cache[t]) {
        it.apply(cache[t])
        continue
      }
      need.push(t)
    }
    if (!need.length) return
    const fresh = await translateTitles(need.slice(0, 12))
    let changed = false
    for (const [src, dst] of Object.entries(fresh)) {
      if (dst && dst !== src) {
        cache[src] = dst
        changed = true
      }
    }
    if (changed) await saveJpCache()
    for (const it of items) {
      const t = String(it.title || '').trim()
      if (cache[t]) it.apply(cache[t])
    }
  } catch (error) {
    warn(`标题翻译流程出错（忽略）：${error?.message ?? error}`)
  }
}

// ───────────────────────── 发消息 ─────────────────────────

function chatKeyOf(session) {
  return `${session.chat_type}:${session.chat_id}`
}

function chatOfKey(chatKey, account = '') {
  const [kind, id] = String(chatKey || '').split(':')
  if (!kind || !id) return null
  return { account, chat_type: kind, chat_id: Number(id) }
}

async function sendText(chat, text) {
  if (!chat || !text) return false
  try {
    await host.reply(chat, [{ type: 'text', data: { text: String(text) } }])
    return true
  } catch (error) {
    warn(`发消息失败（不影响任务）：${error?.message ?? error}`)
    return false
  }
}

/**
 * 发一张图 + 说明文字。
 * 先按本地路径发（框架会读成 base64）；路径不在框架 data/ 下时会被拒，
 * 这时自己读文件转 base64 重试 —— 用户把「下载目录」配到 D:\ 也能出卡。
 */
/**
 * 发「文字 + 图片」。
 *
 * ⚠️ 不能走 host.reply 的本地路径：框架会把文件读成 base64 再发，
 *    SnowLuma 对 base64 图片会回 retcode=100（QQ 无回执），实测发不出去；
 *    用 `file:///` 绝对路径（协议端自己读文件 + 上传）就正常。
 */
async function sendImageWithText(chat, text, imagePath) {
  if (!chat) return false
  const segments = []
  if (text) segments.push({ type: 'text', data: { text: String(text) } })
  const abs = path.resolve(imagePath).replace(/\\/g, '/')
  segments.push({ type: 'image', data: { file: /^[A-Za-z]:/.test(abs) ? `file:///${abs}` : `file://${abs}` } })
  try {
    if (chat.chat_type === 'group') {
      await host.callOnebot('send_group_msg', { group_id: chat.chat_id, message: segments })
    } else {
      await host.callOnebot('send_private_msg', { user_id: chat.chat_id, message: segments })
    }
    return true
  } catch (error) {
    warn(`发图失败（改用纯文字）：${error?.message ?? error}`)
  }
  // 图实在发不出去也不能把文字吞掉
  return sendText(chat, text)
}

// ───────────────────────── 群白名单 / 权限 ─────────────────────────

const GROUPS_FILE = () => path.join(DATA_DIR, 'enabled-groups.json')

function loadGroupState() {
  try {
    const s = JSON.parse(fs.readFileSync(GROUPS_FILE(), 'utf8'))
    if (s && typeof s === 'object' && s.groups && typeof s.groups === 'object') return s
  } catch {
    /* 没有文件 = 默认全开 */
  }
  return { groups: {} }
}

function saveGroupState(state) {
  try {
    fs.mkdirSync(path.dirname(GROUPS_FILE()), { recursive: true })
    fs.writeFileSync(GROUPS_FILE(), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2))
  } catch (error) {
    warn(`群白名单写入失败：${error?.message ?? error}`)
  }
}

function isChatAllowed(chatKey) {
  const st = loadGroupState()
  const ids = Object.keys(st.groups || {}).filter(Boolean)
  if (!ids.length) return true
  const key = String(chatKey || '')
  if (key.startsWith('private:')) return true
  const gid = key.startsWith('group:') ? key.slice('group:'.length) : key
  return Boolean(st.groups[gid])
}

function gateText(chatKey) {
  if (isChatAllowed(chatKey)) return ''
  return '本群还没有开启 JM 漫画功能。让群主/管理员在群里 @我 说「开启JM」即可开通；'
    + '机主也可以说「JM所有群开放」恢复全部群可用。'
}

function allowList() {
  return new Set(
    String(cfg().allowIds || '').split(/[\s,;，、]+/).map((s) => s.trim()).filter(Boolean),
  )
}

/** 下载/控制类操作的权限：管理员、群主、白名单 QQ。 */
function checkTrigger(session) {
  const allow = allowList()
  if (!allow.size) return { ok: true }
  if (session.role === 'owner' || session.role === 'admin') return { ok: true }
  if (allow.has(String(session.user_id))) return { ok: true }
  return {
    ok: false,
    reason: '这个功能只对管理员或白名单 QQ 开放。要放开请让机主把 '
      + `${session.user_id} 加进「允许触发的 QQ」。`,
  }
}

function isManager(session) {
  if (session.role === 'owner' || session.role === 'admin') return true
  return allowList().has(String(session.user_id))
}

// ───────────────────────── 任务记录 / 队列持久化 ─────────────────────────

const TASKS_FILE = () => path.join(DATA_DIR, 'tasks.json')
const QUEUE_FILE = () => path.join(DATA_DIR, 'queue.json')
const UPLOADED_FILE = () => path.join(DATA_DIR, 'uploaded-files.json')

async function loadHistory() {
  if (historyLoaded) return
  historyLoaded = true
  try {
    const parsed = JSON.parse(await fsp.readFile(TASKS_FILE(), 'utf8'))
    if (Array.isArray(parsed)) taskHistory = parsed.slice(0, 50)
  } catch {
    taskHistory = []
  }
}

async function saveHistory() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true })
    await fsp.writeFile(TASKS_FILE(), JSON.stringify(taskHistory.slice(0, 50), null, 2), 'utf8')
  } catch (error) {
    warn(`任务记录写入失败（不影响下载）：${error?.message ?? error}`)
  }
}

function pushHistory(entry) {
  taskHistory.unshift({ ...entry, at: new Date().toISOString() })
  taskHistory = taskHistory.slice(0, 50)
  void saveHistory()
}

function loadUploadedGroupFiles() {
  try {
    const items = JSON.parse(fs.readFileSync(UPLOADED_FILE(), 'utf8'))
    for (const it of Array.isArray(items) ? items : []) {
      if (it?.chatKey && it?.fileId) uploadedGroupFiles.set(`${it.chatKey}:${it.fileId}`, it)
    }
  } catch {
    /* 没有记录 = 没什么可清 */
  }
}

function saveUploadedGroupFiles() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(UPLOADED_FILE(), JSON.stringify([...uploadedGroupFiles.values()], null, 2))
  } catch {
    /* 清理记录丢失只影响到期删除，不影响下载 */
  }
}

function saveQueue() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const items = taskQueue.map((id) => {
      const t = activeTasks.get(id) || {}
      return {
        albumId: id,
        chatKey: t.chatKey || '',
        kind: t.kind || '',
        who: t.who || '',
        whoName: t.whoName || '',
        addedAt: t.addedAt || Date.now(),
      }
    })
    fs.writeFileSync(QUEUE_FILE(), JSON.stringify(items, null, 1), 'utf8')
  } catch (error) {
    warn(`队列落盘失败（不影响运行）：${error?.message ?? error}`)
  }
}

function loadQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE())) return 0
    const items = JSON.parse(fs.readFileSync(QUEUE_FILE(), 'utf8'))
    let n = 0
    for (const it of Array.isArray(items) ? items : []) {
      const albumId = String(it?.albumId || '').trim()
      if (!/^\d{2,9}$/.test(albumId) || activeTasks.has(albumId)) continue
      activeTasks.set(albumId, {
        albumId,
        chatKey: String(it.chatKey || ''),
        kind: String(it.kind || ''),
        who: String(it.who || ''),
        whoName: String(it.whoName || ''),
        control: { paused: false, deleted: false, child: null },
        stage: 'queued',
        startedAt: Date.now(),
        addedAt: Number(it.addedAt) || Date.now(),
        chat: chatOfKey(it.chatKey || ''),
      })
      taskQueue.push(albumId)
      n += 1
    }
    if (n) log(`队列恢复：接回 ${n} 本没跑完的（${taskQueue.map((i) => `JM${i}`).join('、')}）`)
    return n
  } catch (error) {
    warn(`队列恢复失败：${error?.message ?? error}`)
    return 0
  }
}

/** 单个 worker：取队首跑，跑完接着下一个。 */
async function pump() {
  if (queueBusy) return
  const nextId = taskQueue[0]
  if (!nextId) {
    saveQueue()
    return
  }
  queueBusy = true
  const task = activeTasks.get(nextId)
  try {
    if (!task || task.control?.deleted) {
      if (taskQueue[0] === nextId) taskQueue.shift()
      activeTasks.delete(nextId)
      return
    }
    task.stage = 'running'
    task.startedAt = Date.now()
    log(`开始处理队列任务 JM${nextId}（队列里还剩 ${taskQueue.length - 1} 本）`)
    // 注意：这里**不**把队首移出队列 —— 进程中途被杀时 queue.json 里还留着它，
    // 重启后能接着跑。跑完（或删除）才出队。
    saveQueue()
    await runJob(task)
  } catch (error) {
    if (!task?.control?.deleted) warn(`排队任务异常（已记录）JM${nextId}：${error?.stack ?? error}`)
  } finally {
    if (taskQueue[0] === nextId) taskQueue.shift()
    activeTasks.delete(nextId)
    if (task?.chatKey && activeByChat.get(task.chatKey) === nextId) activeByChat.delete(task.chatKey)
    queueBusy = false
    saveQueue()
    void cleanupGroupFiles()
    if (taskQueue.length) void pump()
  }
}

// ───────────────────────── 暂停 / 删除 ─────────────────────────

function isPaused(task) {
  return task?.control?.paused === true
}

async function waitIfPaused(task) {
  if (!task?.control) return
  while (task.control.paused && !task.control.deleted) await new Promise((r) => setTimeout(r, 800))
  if (task.control.deleted) throw new Error('任务已被删除，停止处理')
}

function ensureAlive(task) {
  if (task?.control?.deleted) throw new Error('任务已被删除，停止处理')
}

async function albumDirOf(albumId) {
  const base = path.join(downloadRoot(), `jm-${albumId}`)
  try {
    const subs = (await fsp.readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory())
    if (subs.length === 1) return path.join(base, subs[0].name)
    if (!fs.existsSync(base)) return ''
    return base
  } catch {
    return ''
  }
}

async function removeLocalAlbum(albumId) {
  const base = path.join(downloadRoot(), `jm-${albumId}`)
  if (!fs.existsSync(base)) return { ok: true, removed: 0, freed: 0 }
  const before = await dirSize(base).catch(() => ({ bytes: 0, files: 0 }))
  await fsp.rm(base, { recursive: true, force: true })
  return { ok: true, removed: before.files, freed: before.bytes }
}

const onebot = {
  call: async (action, params) => {
    const r = await host.callOnebot(action, params)
    return r?.data ?? r
  },
}

/** 删除这个本子之前上传到群里的文件（按文件名前缀匹配）。 */
async function removeGroupFiles(albumId, chatKey) {
  const results = []
  const groups = [...uploadedGroupFiles.entries()].filter(([, item]) => {
    const key = String(item?.chatKey || '')
    return (!chatKey || key === String(chatKey)) && String(item?.name || '').startsWith(`JM${albumId}`)
  })
  for (const [key, item] of groups) {
    uploadedGroupFiles.delete(key)
    const [, groupId] = String(item.chatKey).split(':')
    const r = await deleteGroupFile(onebot, groupId, item.fileId)
    results.push({ name: item.name, ok: r.ok, error: r.error })
  }
  if (groups.length) saveUploadedGroupFiles()
  return results
}

function rememberGroupFile(chatKey, fileId, name) {
  if (!String(chatKey).startsWith('group:') || !fileId) return
  uploadedGroupFiles.set(`${chatKey}:${fileId}`, { chatKey, fileId, name, at: Date.now() })
  saveUploadedGroupFiles()
}

/** 执行一条控制指令，返回要发到会话里的文本。 */
async function performControl({ action, albumId, chatKey }) {
  const task = activeTasks.get(albumId)
  if (action === 'pause') {
    if (!task) return `JM${albumId} 当前没有正在处理的任务，不用暂停。`
    if (task.control?.paused) return `JM${albumId} 本来就处于暂停状态。`
    if (!task.control) task.control = { paused: false, deleted: false, child: null }
    task.control.paused = true
    task.control.pausedAt = Date.now()
    log(`JM${albumId} 已暂停`)
    return `⏸ JM${albumId} 已暂停下载。发「继续下载 JM${albumId}」就能接着跑。`
  }
  if (action === 'resume') {
    if (!task) return `JM${albumId} 当前没有正在处理的任务。`
    if (!task.control?.paused) return `JM${albumId} 没有暂停，正在正常处理。`
    task.control.paused = false
    log(`JM${albumId} 已继续`)
    return `▶️ JM${albumId} 已继续下载，接着刚才的进度跑。`
  }
  // delete
  const wasActive = Boolean(task)
  if (task) {
    if (!task.control) task.control = { paused: false, deleted: false, child: null }
    task.control.paused = false
    task.control.deleted = true
    const qi = taskQueue.indexOf(task.albumId)
    if (qi >= 0) taskQueue.splice(qi, 1)
    saveQueue()
    try {
      task.control.child?.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
  const dir = await albumDirOf(albumId)
  let local = { ok: false, removed: 0, freed: 0 }
  if (dir) {
    try {
      local = await removeLocalAlbum(albumId)
    } catch (error) {
      warn(`删除本地目录失败 JM${albumId}：${error?.message ?? error}`)
    }
  }
  let groupResults = []
  try {
    groupResults = await removeGroupFiles(albumId, chatKey)
  } catch (error) {
    warn(`删除群文件失败 JM${albumId}：${error?.message ?? error}`)
  }
  taskHistory = taskHistory
    .filter((h) => String(h.id) !== String(albumId))
    .concat(taskHistory.filter((h) => String(h.id) === String(albumId)).map((h) => ({ ...h, ok: false, stage: 'deleted', error: '群指令删除' })))
    .slice(0, 50)
  void saveHistory()
  log(`JM${albumId} 已删除：本地 ${local.removed} 个文件，群文件 ${groupResults.length} 个（active=${wasActive}）`)
  const parts = [
    `🗑 JM${albumId} 已删除`,
    local.removed ? '本地文件已清理' : '',
    groupResults.length ? `群文件已删 ${groupResults.filter((r) => r.ok).length}/${groupResults.length} 个` : '',
  ].filter(Boolean)
  return `${parts.join('，')}。`
}

// ───────────────────────── 本地成品复用 ─────────────────────────

/** 在 keepHours 内复用已有 PDF。 */
async function findCachedPdf(albumId, keepHours) {
  const hours = Number(keepHours)
  if (!Number.isFinite(hours) || hours <= 0) return null
  const base = path.join(downloadRoot(), `jm-${albumId}`)
  const cutoff = Date.now() - hours * 3600000
  const found = []
  const walk = async (dir) => {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.pdf') {
        try {
          const st = await fsp.stat(full)
          if (st.size > 1024 && st.mtimeMs >= cutoff) {
            found.push({ path: full, dir: path.dirname(full), mtimeMs: st.mtimeMs, bytes: st.size })
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(base)
  if (!found.length) return null
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const hit = found[0]
  let meta = {}
  try {
    meta = JSON.parse(await fsp.readFile(path.join(hit.dir, 'metadata.json'), 'utf8'))
  } catch {
    /* ignore */
  }
  return { ...hit, meta }
}

/** 本地成品复用：不限文件类型（PDF 或原图目录都算），N 天内下过就直接发。 */
async function findLocalArtifact(albumId, reuseDays) {
  const days = Number(reuseDays)
  if (!Number.isFinite(days) || days <= 0) return null
  const base = path.join(downloadRoot(), `jm-${albumId}`)
  if (!fs.existsSync(base)) return null
  const cutoff = Date.now() - days * 86400000

  const pdfs = []
  const images = []
  const walk = async (dir) => {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      let st
      try {
        st = await fsp.stat(full)
      } catch {
        continue
      }
      if (st.mtimeMs < cutoff) continue
      if (ext === '.pdf' && st.size > 1024) pdfs.push({ path: full, dir: path.dirname(full), mtimeMs: st.mtimeMs, bytes: st.size })
      else if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext) && st.size > 1024) {
        images.push({ path: full, mtimeMs: st.mtimeMs, bytes: st.size })
      }
    }
  }
  await walk(base)

  let meta = {}
  for (const cand of [path.join(base, 'metadata.json'), path.join(await albumDirOf(albumId), 'metadata.json')]) {
    try {
      meta = JSON.parse(await fsp.readFile(cand, 'utf8'))
      break
    } catch {
      /* 继续找 */
    }
  }

  if (pdfs.length) {
    pdfs.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const hit = pdfs[0]
    return { kind: 'pdf', path: hit.path, dir: hit.dir, bytes: hit.bytes, meta }
  }
  if (images.length) {
    images.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
    const dir = path.dirname(images[0].path)
    const bytes = images.reduce((a, b) => a + b.bytes, 0)
    return { kind: 'images', path: dir, dir, bytes, meta, files: images.map((x) => x.path) }
  }
  return null
}

// ───────────────────────── Python 能力探测 ─────────────────────────

function detectWorker(force = false) {
  const c = cfg()
  if (!force && workerCache.result && Date.now() - workerCache.at < 60000) return workerCache.result
  const result = c.restore || c.outputFormat === 'pdf'
    ? pdfBridge.detect()
    : { ok: false, error: '未启用还原/PDF' }
  workerCache = { at: Date.now(), result }
  if (result?.note) log(result.note)
  return result
}

function resetWorkerCache() {
  workerCache = { at: 0, result: null }
}

// ───────────────────────── 引擎客户端 ─────────────────────────

function client() {
  return engine.createClient({
    fetchImpl: globalThis.fetch.bind(globalThis),
    timeoutMs: () => cfg().timeoutSeconds * 1000,
    domains: cfg().domains,
    warn,
    proxy: cfg().proxy,
  })
}

// ───────────────────────── 下载整本 ─────────────────────────

async function downloadAlbum({ albumId, onProgress, control, onAlbum }) {
  const c = cfg()
  const task = { control }
  const api0 = client()
  const album = await api0.albumInfo(albumId)
  // 拿到本子信息就先发第一条消息（封面+名字），再开始下载
  try {
    if (typeof onAlbum === 'function') await onAlbum(album)
  } catch (error) {
    warn(`首条消息发送失败（继续下载）：${error?.message ?? error}`)
  }

  const chapters = album.series.length
    ? (c.multiChapter ? album.series : album.series.slice(0, 1))
    : [{ id: album.id, name: album.name, sort: 1 }]

  const albumDir = path.join(
    downloadRoot(),
    `jm-${album.id}`,
    engine.sanitizeSegment(`${album.id}-${album.name}`, `JM${album.id}`),
  )
  await fsp.mkdir(albumDir, { recursive: true })

  const totals = { total: 0, ok: 0, fail: 0, pages: 0 }
  const failed = []
  const chapterResults = []

  for (let i = 0; i < chapters.length; i += 1) {
    const chapter = chapters[i]
    let photo
    try {
      photo = await api0.photoInfo(chapter.id)
    } catch (error) {
      failed.push({ chapter: chapter.id, error: `章节信息读取失败：${error?.message ?? error}` })
      onProgress?.({ stage: 'download', chapter: i + 1, chapters: chapters.length, ...totals })
      continue
    }
    if (!photo.images.length) {
      failed.push({ chapter: chapter.id, error: '这一章没有图片（可能已被删除）' })
      onProgress?.({ stage: 'download', chapter: i + 1, chapters: chapters.length, ...totals })
      continue
    }

    let names = photo.images.map((n, idx) => engine.imageFileName(n, idx + 1))
    let skipped = 0
    if (names.length > c.maxPages) {
      skipped = names.length - c.maxPages
      names = names.slice(0, c.maxPages)
    }

    const chapterDir = chapters.length > 1
      ? path.join(
          albumDir,
          engine.sanitizeSegment(
            `${String(chapter.sort || i + 1).padStart(3, '0')}-${chapter.name || photo.name || ''}`,
            `ch-${chapter.id}`,
          ),
        )
      : albumDir
    await fsp.mkdir(chapterDir, { recursive: true })

    const pages = []
    let cursor = 0
    const worker = async () => {
      for (;;) {
        const idx = cursor
        cursor += 1
        if (idx >= names.length) return
        await waitIfPaused(task)
        const target = path.join(chapterDir, names[idx])
        totals.total += 1
        try {
          if (fs.existsSync(target) && (await fsp.stat(target)).size > 1024) {
            totals.ok += 1 // 之前下过（同一 ID 重发时补下）
          } else {
            const buf = await api0.fetchImage(photo.id || chapter.id, names[idx])
            await fsp.writeFile(target, buf)
            totals.ok += 1
          }
          pages[idx] = target
        } catch (error) {
          totals.fail += 1
          failed.push({ chapter: chapter.id, error: `${names[idx]}：${error?.message ?? error}` })
        }
        totals.pages += 1
        if (totals.pages % 5 === 0) {
          onProgress?.({ stage: 'download', chapter: i + 1, chapters: chapters.length, ...totals })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(c.concurrency, names.length)) }, worker))
    onProgress?.({ stage: 'download', chapter: i + 1, chapters: chapters.length, ...totals })

    chapterResults.push({
      id: photo.id || chapter.id,
      name: chapter.name || photo.name || `第${i + 1}话`,
      sort: chapter.sort || i + 1,
      skipped,
      pages: pages.filter(Boolean),
    })
  }

  // scramble_id 每次现查（写死会把本来正常的图弄花）
  let scrambleId = 0
  if (c.restore && chapterResults.length) {
    scrambleId = await api0.fetchScrambleId(chapterResults[0].id)
  }

  return { album, albumDir, chapters: chapterResults, totals, failed, scrambleId }
}

// ───────────────────────── 主任务 ─────────────────────────

async function runJob(job) {
  const c = cfg()
  const { albumId, chatKey } = job
  const chat = job.chat || chatOfKey(chatKey)
  const say = (text) => sendText(chat, text)

  /**
   * 第 1 条消息：漫画名字 + 封面。
   * 封面优先用 worker 生成的「已还原」封面（cover.jpg）；
   * 没有就用站点官方封面；再退回本地第一页（可能是竖切打乱的，仅兜底）。
   */
  const sendTitleWithCover = async (name, id) => {
    const title = toSimplified(name) || `JM${id}`
    const dir = await albumDirOf(id)
    const restoredCover = dir ? path.join(dir, 'cover.jpg') : ''
    let cover = restoredCover && fs.existsSync(restoredCover) ? restoredCover : ''
    if (!cover) {
      try {
        cover = (await fetchSiteCover(String(id))) || ''
      } catch {
        cover = ''
      }
    }
    if (!cover && dir) {
      try {
        cover = firstPageImage(dir)
      } catch {
        cover = ''
      }
    }
    const text = `「${title}」JM${id}`
    if (cover) await sendImageWithText(chat, text, cover)
    else await say(text)
  }

  await waitIfPaused(job)
  await loadHistory()
  await fsp.mkdir(DATA_DIR, { recursive: true })

  const record = { id: albumId, chatKey, who: job.who, ok: false, stage: 'download', startedAt: Date.now() }

  try {
    // ① 复用
    const cachedPdf = c.outputFormat === 'pdf' ? await findCachedPdf(albumId, c.keepHours) : null
    const localArt = cachedPdf ? null : await findLocalArtifact(albumId, c.localReuseDays)
    const reused = cachedPdf || localArt

    const dl = reused
      ? {
          cachedPdf: cachedPdf || undefined,
          localArtifact: localArt || undefined,
          album: {
            id: albumId,
            name: reused.meta?.name || `JM${albumId}`,
            description: reused.meta?.description || '',
            authors: reused.meta?.authors || [],
            tags: reused.meta?.tags || [],
          },
          albumDir: reused.dir,
          chapters: Array.from(
            { length: Math.max(1, Number(reused.meta?.chapters) || 1) },
            (_, i) => ({ name: `第${i + 1}话`, pages: [] }),
          ),
          totals: {
            total: Number(reused.meta?.pages) || 0,
            ok: Number(reused.meta?.pagesOk || reused.meta?.pages) || 0,
            fail: 0,
          },
          failed: [],
          scrambleId: 0,
        }
      : await downloadAlbum({
          albumId,
          control: job.control,
          // 第 1 条：封面+名字；第 2 条：少女祈祷中...
          onAlbum: async (album) => {
            await sendTitleWithCover(album.name, album.id)
            await say('少女祈祷中...')
          },
        })

    if (reused) {
      await sendTitleWithCover(dl.album.name, dl.album.id)
      await say('少女祈祷中...')
    }
    record.title = toSimplified(dl.album.name)
    record.description = toSimplified(dl.album.description || '')
    record.pages = dl.totals.total
    record.pagesOk = dl.totals.ok
    record.dir = dl.albumDir
    if (!dl.totals.ok) {
      throw new Error(`一张图都没下下来（失败 ${dl.totals.fail} 张）。多半是站点限速或网络问题，稍后重发同一个 ID 会接着补下。`)
    }

    // ② 日语标题翻译（必须在生成 PDF 文件名之前）
    const baseName = toSimplified(dl.album.name)
    let jpName = ''
    if (c.translateTitles !== false) {
      await ensureTranslatedTitles([{ title: baseName, apply: (t) => { jpName = toSimplified(String(t || '').trim()) } }])
      if (jpName && jpName !== baseName) {
        log(`标题翻译：${baseName} -> ${jpName}`)
        dl.album.name = jpName
      }
    }

    let deliverPath = ''
    let deliverName = ''
    let deliverParts = []
    let pdfInfo = null
    const wantPdf = c.outputFormat === 'pdf'
    const worker = wantPdf ? detectWorker() : { ok: false, error: '输出格式设为「原始图片」' }

    const uploadLimitBytes = c.maxUploadMB * 1024 * 1024
    const destNow = resolveUploadTarget(c, chatKey, job.kind)
    const needUpload = Boolean(destNow) && c.uploadMode !== 'off'
    const mustReflow = (bytesVal) => needUpload && !c.rejectOversize && Number(bytesVal) > uploadLimitBytes
    const imagesAvailable = () => {
      const pages = dl.chapters.flatMap((ch) => ch.pages || [])
      if (!pages.length) return false
      let checked = 0
      for (const p of pages) {
        checked += 1
        if (checked > 50) break
        try {
          if (!fs.existsSync(p)) return false
        } catch {
          return false
        }
      }
      return true
    }
    const reflowInsteadOfCache = (bytesVal, label) => {
      if (!mustReflow(bytesVal) || !imagesAvailable() || !worker.ok) return false
      record.cacheHit = false
      warn(`${label} ${humanSize(Number(bytesVal))} 超过单文件上限 ${c.maxUploadMB} MB，改按页重新分卷`)
      return true
    }

    if (wantPdf && dl.cachedPdf && !reflowInsteadOfCache(dl.cachedPdf.bytes, '缓存成品')) {
      record.stage = 'pdf'
      const info = dl.cachedPdf
      pdfInfo = {
        ok: true,
        output: info.path,
        bytes: info.bytes,
        pages: Number(info.meta?.pages) || dl.totals.total,
        pagesOk: Number(info.meta?.pagesOk || info.meta?.pages) || dl.totals.ok,
        restored: Number(info.meta?.pdf?.restored) || 0,
      }
      deliverPath = info.path
      deliverName = path.basename(info.path)
      record.cacheHit = true
      record.pdf = { bytes: pdfInfo.bytes, pages: pdfInfo.pages, pagesOk: pdfInfo.pagesOk, restored: pdfInfo.restored, cached: true }
    } else if (wantPdf && dl.localArtifact && dl.localArtifact.kind === 'pdf' && !reflowInsteadOfCache(dl.localArtifact.bytes, '本地成品')) {
      record.stage = 'pdf'
      const info = dl.localArtifact
      pdfInfo = {
        ok: true,
        output: info.path,
        bytes: info.bytes,
        pages: Number(info.meta?.pages) || dl.totals.total,
        pagesOk: Number(info.meta?.pagesOk || info.meta?.pages) || dl.totals.ok,
        restored: Number(info.meta?.pdf?.restored) || 0,
      }
      deliverPath = info.path
      deliverName = path.basename(info.path)
      record.cacheHit = true
      record.pdf = { bytes: pdfInfo.bytes, pages: pdfInfo.pages, pagesOk: pdfInfo.pagesOk, restored: pdfInfo.restored, cached: true }
    } else if (wantPdf && worker.ok) {
      record.stage = 'pdf'
      const pdfName = `${engine.sanitizeSegment(`JM${dl.album.id}-${dl.album.name}`, `JM${dl.album.id}`)}.pdf`
      const outPath = path.join(dl.albumDir, pdfName)

      // 分几卷必须在**合成时**决定（按字节切出来的 PDF 打不开）
      let wantParts = 1
      if (destNow && c.uploadMode !== 'off') {
        let srcBytes = 0
        for (const ch of dl.chapters) {
          for (const p of ch.pages || []) {
            try {
              srcBytes += fs.statSync(p).size
            } catch {
              /* 个别缺文件不影响估算 */
            }
          }
        }
        if (srcBytes > 0) wantParts = Math.max(1, Math.min(30, Math.ceil((srcBytes * 3.0) / uploadLimitBytes)))
      }

      const task = {
        album_id: dl.album.id,
        control: job.control,
        title: dl.album.name,
        scramble_id: dl.scrambleId,
        descramble: c.restore,
        output: outPath,
        quality: c.pdfQuality,
        max_dim: c.pdfMaxDim,
        parts: wantParts,
        cover_output: path.join(dl.albumDir, 'cover.jpg'),
        chapters: dl.chapters.map((ch) => ({ name: ch.name, pages: ch.pages, aid: ch.id })),
      }
      const res = await pdfBridge.runTask({
        python: worker.python,
        task,
        timeoutMs: Math.max(180000, dl.totals.total * 4000),
        onProgress: (p) => {
          // 群里只保留 4 条固定消息，过程进度写日志
          if (p.stage === 'descramble' && p.done % 50 === 0) debug(`还原进度 ${p.done}/${p.total}`)
          else if (p.stage === 'pdf') debug(`PDF 分卷 ${p.done}/${p.total}`)
        },
      })
      if (res.ok) {
        pdfInfo = res
        deliverPath = res.output
        deliverName = path.basename(res.output)
        if (Array.isArray(res.outputs) && res.outputs.length > 1) deliverParts = res.outputs.map((o) => o.output)
        record.pdf = { bytes: res.bytes, pages: res.pages, pagesOk: res.pagesOk, restored: res.restored, parts: deliverParts.length || 1 }
      } else if (task?.control?.deleted) {
        throw new Error('任务已被删除，停止处理')
      } else {
        warn(`PDF 生成失败（已降级为原样图片）：${res.error}`)
        record.pdfError = res.error
      }
    } else if (wantPdf) {
      record.pdfError = worker.error
      warn(`PDF 不可用（降级为原样图片）：${worker.error}`)
    }

    // ②.6 ZIP
    const zipPassword = c.zipPasswordEnabled && c.zipPassword ? c.zipPassword : ''
    if (c.zipEnabled && wantPdf && deliverPath) {
      record.stage = 'zip'
      const sources = deliverParts.length > 1 ? deliverParts.slice() : [deliverPath]
      const entries = sources.map((p) => ({
        filePath: p,
        entryName: path.basename(p) || `JM${dl.album.id}.pdf`,
      }))
      const zipName = buildZipName(dl.album.id, { password: zipPassword, includePassword: c.zipPasswordInName })
      const zipPath = path.join(dl.albumDir, zipName)
      const zipExistsFresh = () => {
        try {
          if (!fs.existsSync(zipPath)) return false
          const zt = fs.statSync(zipPath).mtimeMs
          return sources.every((p) => {
            try {
              return fs.statSync(p).mtimeMs <= zt
            } catch {
              return false
            }
          })
        } catch {
          return false
        }
      }
      if (!zipExistsFresh()) {
        const zr = await createZip({ outPath: zipPath, entries, password: zipPassword })
        if (!zr.ok) throw new Error(`压缩包生成失败：${zr.error}`)
        log(`JM${dl.album.id} 已打包：${zipName}（${humanSize(zr.bytes)}，加密=${zr.encrypted ? '是' : '否'}，${zr.entries} 个文件）`)
      } else {
        log(`JM${dl.album.id} 复用已有压缩包：${zipName}`)
      }
      const zipBytes = fs.statSync(zipPath).size
      record.zip = { name: zipName, password: zipPassword, encrypted: Boolean(zipPassword), bytes: zipBytes, entries: entries.length }
      deliverPath = zipPath
      deliverName = zipName
      deliverParts = []
    }

    // ②.5 metadata.json（书架与信息卡都靠它）
    try {
      const meta = {
        id: dl.album.id,
        name: toSimplified(dl.album.name),
        description: toSimplified(dl.album.description || '').slice(0, 500),
        authors: (dl.album.authors || []).map(toSimplified),
        tags: (dl.album.tags || []).map(toSimplified),
        firstSubmitter: (() => {
          const s = firstSubmitters.get(`${chatKey}:${albumId}`) || (job.whoName ? { id: job.who || '', name: job.whoName } : null)
          if (!s || !(s.name || s.id)) return null
          return { id: s.id || '', name: s.name || '', at: s.at || Date.now() }
        })(),
        chapters: dl.chapters.length,
        pages: dl.totals.total,
        pagesOk: dl.totals.ok,
        downloadedAt: new Date().toISOString(),
        dir: dl.albumDir,
        ...(jpName && jpName !== baseName ? { nameOriginal: baseName } : {}),
        pdf: pdfInfo ? { bytes: pdfInfo.bytes, pages: pdfInfo.pages, pagesOk: pdfInfo.pagesOk, restored: pdfInfo.restored } : null,
        zip: record.zip ? { name: record.zip.name, encrypted: record.zip.encrypted, bytes: record.zip.bytes } : null,
        pdfError: record.pdfError || '',
        deletedImages: false,
        note: '图片为站点原始文件；较新的本子带站点防爬的竖切打乱，会按站点返回的 scramble_id 还原。',
      }
      await fsp.writeFile(path.join(dl.albumDir, 'metadata.json'), JSON.stringify(meta, null, 2), 'utf8')
    } catch (error) {
      warn(`metadata.json 写入失败（不影响下载）：${error?.message ?? error}`)
    }

    if (!deliverPath) record.stage = 'images'
    ensureAlive(job)

    // ③ 第 3 条：下载完成 / 正在上传（页数 · 大小 · 密码）；第 4 条是文件本身
    const dest = resolveUploadTarget(c, chatKey, job.kind)
    const pageCount = pdfInfo ? pdfInfo.pages : dl.totals.ok
    const willUpload = c.uploadMode !== 'off' && Boolean(dest) && Boolean(deliverPath)
    if (deliverPath) {
      const finalBytes = fs.statSync(deliverPath).size
      const pwdNote = record.zip?.encrypted ? `，解压密码：${record.zip.password}` : ''
      await say(willUpload
        ? `下载完成，正在上传：${pageCount} 页 · ${humanSize(finalBytes)}${pwdNote}`
        : `下载完成：${pageCount} 页 · ${humanSize(finalBytes)}${pwdNote}（已保存到本地）`)
    } else {
      await say(`下载完成：${dl.totals.ok} 张（未生成 PDF${record.pdfError ? `：${record.pdfError}` : ''}，已保存到本地）`)
    }

    let uploadNote = ''
    let deliveryConfirmed = false
    if (c.uploadMode === 'off' || !dest) {
      deliveryConfirmed = Boolean(deliverPath) || c.uploadMode === 'off'
    } else if (!deliverPath) {
      deliveryConfirmed = false
    } else {
      record.stage = 'upload'
      const size = fs.statSync(deliverPath).size
      const limit = c.maxUploadMB * 1024 * 1024
      if (deliverParts.length > 1) {
        let sent = 0
        for (const part of deliverParts) {
          const r = await uploadFile({
            onebot, chatKey: dest, filePath: part, name: path.basename(part), checkQuota: c.checkQuota,
          })
          if (r.ok) {
            sent += 1
            deliveryConfirmed = true
            rememberGroupFile(dest, r.fileId, path.basename(part))
          } else {
            uploadNote = `⚠️ 第 ${sent + 1}/${deliverParts.length} 卷上传失败：${r.error}`
            break
          }
        }
      } else if (size > limit && !record.zip) {
        if (c.rejectOversize) {
          uploadNote = `⚠️ 文件 ${humanSize(size)} 超过单文件上限 ${c.maxUploadMB} MB，没有上传（可调大上限或允许分卷）`
        } else {
          const parts = splitForUpload(deliverPath, limit)
          uploadNote = `⚠️ 单文件 ${humanSize(size)} 超过 ${c.maxUploadMB} MB，已按字节切成 ${parts.length} 卷 —— `
            + '必须合并后才能打开。建议调大「单文件上限」，或重新下载（会改按页分卷）。'
          let sent = 0
          for (const part of parts) {
            const r = await uploadFile({
              onebot, chatKey: dest, filePath: part, name: path.basename(part), checkQuota: c.checkQuota,
            })
            if (r.ok) {
              sent += 1
              deliveryConfirmed = true
              rememberGroupFile(dest, r.fileId, path.basename(part))
            } else {
              uploadNote += `\n第 ${sent + 1} 卷上传失败：${r.error}`
              break
            }
          }
        }
      } else {
        // 压缩包超限也走这里：**不按字节切** —— 切开的 zip 解不开
        const zipTooBig = Boolean(record.zip) && size > limit
        const r = await uploadFile({
          onebot, chatKey: dest, filePath: deliverPath, name: deliverName || path.basename(deliverPath), checkQuota: c.checkQuota,
        })
        if (r.ok) {
          deliveryConfirmed = true
          rememberGroupFile(dest, r.fileId, deliverName || path.basename(deliverPath))
          // 上传成功但列表暂时查不到 file_id 时，upload.js 会给 note —— 只记日志，
          // 不再多发一条「协议端已返回成功…」打扰群里
          if (r.note) debug(`上传备注：${r.note}`)
          if (zipTooBig) {
            uploadNote = `⚠️ 压缩包 ${humanSize(size)} 超过单文件上限 ${c.maxUploadMB} MB，已按整包上传（没有切分）。${uploadNote ? `\n${uploadNote}` : ''}`
          }
        } else {
          uploadNote = zipTooBig
            ? `⚠️ 压缩包 ${humanSize(size)} 超过单文件上限 ${c.maxUploadMB} MB，上传失败：${r.error}\n压缩包已留在本地：${deliverPath}`
            : `⚠️ 文件上传失败（原图与成品已保留）：${r.error}`
        }
      }
    }
    if (uploadNote) await say(uploadNote)

    // ④ 按需删除原图（上传之后）
    const wantCleanup = c.deleteImagesAfterPdf && c.outputFormat === 'pdf' && Boolean(pdfInfo) && deliveryConfirmed
    let cleanup = null
    if (wantCleanup) {
      cleanup = await deleteImages(dl.albumDir)
      record.deletedImages = cleanup.files
      record.freedBytes = cleanup.freed
      log(`已删除原图 ${cleanup.files} 个（释放 ${humanSize(cleanup.freed)}），只保留 PDF：${dl.albumDir}`)
      try {
        const metaPath = path.join(dl.albumDir, 'metadata.json')
        const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'))
        meta.deletedImages = true
        meta.deletedAt = new Date().toISOString()
        meta.freedBytes = cleanup.freed
        await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8')
      } catch (error) {
        warn(`metadata 更新删除标记失败（不影响结果）：${error?.message ?? error}`)
      }
    } else if (c.deleteImagesAfterPdf && !pdfInfo) {
      warn('设置了「合成 PDF 后删除原图」，但本次 PDF 未生成 → 已保留原图，未做删除')
    }

    // ⑤ 收尾：文件已经在第 4 条消息里发出，这里只在有缺页时补一句
    if (dl.totals.fail > 0) {
      await say(`有 ${dl.totals.fail} 张没下下来，重发同一个 ID 会接着补下。`)
    }

    if (cleanup) log(`已删除原图 ${cleanup.files} 个（释放 ${humanSize(cleanup.freed)}），只保留 PDF：${dl.albumDir}`)
    if (pdfInfo) log(`JM${dl.album.id} 完成：${pdfInfo.pages} 页/${humanSize(pdfInfo.bytes)}，目录 ${dl.albumDir}`)

    record.stage = 'done'
    record.ok = true
    record.finishedAt = Date.now()
    pushHistory(record)
    return record
  } catch (error) {
    if (job?.control?.deleted) {
      record.stage = 'deleted'
      record.error = '群指令删除'
      record.finishedAt = Date.now()
      pushHistory(record)
      log(`JM${albumId} 已按群指令删除（不作为失败处理）`)
      return record
    }
    record.stage = 'failed'
    record.error = humanize(error?.message ?? String(error))
    record.finishedAt = Date.now()
    pushHistory(record)
    await say(`❌ JM${albumId} 处理失败：${record.error}`)
    warn(`JM${albumId} 任务失败：${error?.stack ?? error}`)
    return record
  }
}

/** 上传目标：按设置决定传到哪个会话。 */
function resolveUploadTarget(c, chatKey, kind) {
  if (c.uploadMode === 'off') return ''
  if (c.uploadMode === 'request') return chatKey
  if (c.uploadMode === 'group') return String(kind) === 'group' ? chatKey : ''
  if (c.uploadMode === 'private') return String(kind) === 'private' ? chatKey : ''
  return chatKey
}

/**
 * 删除某一本的原始图片，只保留 PDF 与 metadata.json（"省空间"模式）。
 * 三道保险：PDF 必须已成功、路径必须在 albumDir 内、只删图片后缀。
 */
async function deleteImages(albumDir) {
  const result = { freed: 0, files: 0, dirs: 0 }
  if (!albumDir || !fs.existsSync(albumDir)) return result
  const rootResolved = path.resolve(albumDir)
  const isImage = (name) => engine.isImageFileName(name)
  const isPart = (name) => /\.part\d+of\d+\.[a-z0-9]+$/i.test(name)

  const walk = async (dir, depth = 0) => {
    let entries = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const target = path.join(dir, e.name)
      const rel = path.relative(rootResolved, path.resolve(target))
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        warn(`跳过可疑路径（不在本子目录内）：${target}`)
        continue
      }
      if (e.isDirectory()) {
        await walk(target, depth + 1)
        continue
      }
      if (!isImage(e.name) || isPart(e.name)) continue
      if (/\.pdf$/i.test(e.name) || e.name.toLowerCase() === 'metadata.json') {
        warn(`跳过受保护文件：${e.name}`)
        continue
      }
      try {
        const size = (await fsp.stat(target)).size
        await fsp.unlink(target)
        result.freed += size
        result.files += 1
      } catch (error) {
        warn(`删除原图失败（已跳过）：${e.name} — ${error?.message ?? error}`)
      }
    }
    if (depth > 0) {
      try {
        if ((await fsp.readdir(dir)).length === 0) {
          await fsp.rmdir(dir)
          result.dirs += 1
        }
      } catch {
        /* 非空或已被删 */
      }
    }
  }
  await walk(rootResolved)
  return result
}

/** 按字节分卷（仅 PDF 超限时的应急路径）。 */
function splitForUpload(filePath, maxBytes) {
  const size = fs.statSync(filePath).size
  const parts = Math.max(2, Math.ceil(size / maxBytes))
  const chunk = Math.ceil(size / parts)
  const ext = (filePath.match(/\.[a-zA-Z0-9]{1,6}$/) || [''])[0]
  const stem = ext ? filePath.slice(0, -ext.length) : filePath
  const out = []
  const fd = fs.openSync(filePath, 'r')
  try {
    for (let i = 0; i < parts; i += 1) {
      const start = i * chunk
      const len = Math.min(chunk, size - start)
      if (len <= 0) break
      const target = `${stem}.part${i + 1}of${parts}${ext}`
      const buf = Buffer.allocUnsafe(len)
      fs.readSync(fd, buf, 0, len, start)
      fs.writeFileSync(target, buf)
      out.push(target)
    }
  } finally {
    fs.closeSync(fd)
  }
  return out
}

function humanize(msg) {
  const s = String(msg)
  if (/所有禁漫域名都连不上/.test(s)) return s
  if (/album_missing|本子.*不存在|章节.*不存在/.test(s)) return `这本子不存在或已被删除（原文：${s}）`
  if (/Restricted Access|ip地区|HTTP 403/.test(s)) return `站点拒绝了本机 IP（可能需要挂代理，或在设置里换域名）。原文：${s}`
  if (/超时|TimeoutError/.test(s)) return `请求超时（可能是网络慢或被限速）。可以调大「单次请求超时」。原文：${s}`
  return s
}

// ───────────────────────── 目录统计 / 书架扫描 ─────────────────────────

async function dirSize(root) {
  let bytes = 0
  let files = 0
  const walk = async (p) => {
    let entries = []
    try {
      entries = await fsp.readdir(p, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const target = path.join(p, e.name)
      if (e.isDirectory()) await walk(target)
      else {
        try {
          bytes += (await fsp.stat(target)).size
          files += 1
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(root)
  return { bytes, files }
}

async function scanLibrary(root) {
  const out = []
  let groups = []
  try {
    groups = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue
    const groupPath = path.join(root, g.name)
    let subs = []
    try {
      subs = await fsp.readdir(groupPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sub of subs) {
      if (!sub.isDirectory()) continue
      const dir = path.join(groupPath, sub.name)
      let meta = null
      try {
        meta = JSON.parse(await fsp.readFile(path.join(dir, 'metadata.json'), 'utf8'))
      } catch {
        meta = null
      }
      let mtime = Date.now()
      let pdf = false
      try {
        mtime = (await fsp.stat(dir)).mtimeMs
        pdf = (await fsp.readdir(dir)).some((f) => f.toLowerCase().endsWith('.pdf'))
      } catch {
        /* ignore */
      }
      const m = String(sub.name).match(/^(\d+)-(.*)$/)
      out.push({
        id: meta?.id || (m ? m[1] : String(g.name).replace(/^jm-/, '')),
        name: meta?.name || (m ? m[2] : sub.name),
        pages: Number(meta?.pagesOk || meta?.pages || 0) || 0,
        pdf,
        mtime,
        dir,
        meta,
      })
    }
  }
  return out
}

/** 找一张能当缩略图的图：优先 worker 生成的已还原封面，其次第一张页面图（递归 ≤3 层）。 */
function firstPageImage(dir, depth = 0) {
  try {
    // 优先用「已还原」的封面：原图是竖切打乱的，直接当封面会错位
    const restored = path.join(dir, 'cover.jpg')
    try {
      if (fs.statSync(restored).size > 1024) return restored
    } catch {
      /* 没有就往下找 */
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const images = entries
      .filter((x) => x.isFile() && /\.(jpe?g|png|webp)$/i.test(x.name))
      .map((x) => x.name)
      .sort()
    for (const f of images) {
      const p = path.join(dir, f)
      const st = fs.statSync(p)
      if (st.isFile() && st.size > 4096) return p
    }
    if (depth < 3) {
      const dirs = entries.filter((x) => x.isDirectory()).map((x) => x.name).sort()
      for (const d of dirs) {
        const hit = firstPageImage(path.join(dir, d), depth + 1)
        if (hit) return hit
      }
    }
  } catch {
    /* 目录读不了就算了 */
  }
  return ''
}

// ───────────────────────── 清单：今日 / 更新 / 收藏 ─────────────────────────

/** 本地书架结构化条目（给信息图用）。 */
async function buildTodayItems(root, { limit = 50 } = {}) {
  const entries = await scanLibrary(root)
  if (!entries.length) return []

  const detail = new Map()
  for (const e of entries) detail.set(String(e.id), e.meta || null)
  const stamp = (e) => {
    const iso = detail.get(String(e.id))?.downloadedAt
    const t = iso ? Date.parse(iso) : NaN
    return Number.isFinite(t) ? t : Number(e.mtime || 0)
  }
  entries.sort((a, b) => stamp(b) - stamp(a))
  const shown = entries.slice(0, limit)

  await ensureTranslatedTitles(shown.map((e) => {
    const meta = detail.get(String(e.id)) || {}
    const zh = toSimplified(String(meta.name || e.name || '').trim())
    return { title: zh, apply: (t) => { const x = toSimplified(String(t || '').trim()); if (x) meta.name = x } }
  }))

  const mapped = shown.map((e) => {
    const meta = detail.get(String(e.id)) || {}
    const rawName = toSimplified(String(meta.name || e.name || `JM${e.id}`).trim())
    const name = cleanTitle(rawName) || rawName
    const pages = Number(meta.pages || e.pages || 0)
    const authors = Array.isArray(meta.authors)
      ? meta.authors.map((a) => toSimplified(String(a).trim())).filter((a) => a && a !== 'N/A')
      : []
    const tags = Array.isArray(meta.tags) ? meta.tags.map((t) => toSimplified(String(t).trim())).filter(Boolean) : []
    return {
      id: String(e.id),
      title: name,
      kind: [pages ? `${pages} 页` : '', e.pdf ? 'PDF' : ''].filter(Boolean).join('·'),
      tags: [...authors.slice(0, 2), ...tags.slice(0, 3)],
      cover: firstPageImage(e.dir),
    }
  })
  // 封面：本地没有已还原封面（cover.jpg）的，尽量换成站点官方封面。
  // 必须限时限量：站点慢的时候一本就要几十秒，会把消息处理（30 秒）拖超时。
  const deadline = Date.now() + 6000
  let fetched = 0
  for (const it of mapped) {
    if (/cover\.jpg$/i.test(String(it.cover || ''))) continue
    if (fetched >= 8 || Date.now() > deadline) break
    fetched += 1
    try {
      const site = await withTimeout(fetchSiteCover(it.id), 2500)
      if (site) it.cover = site
    } catch {
      /* 拉不到就继续用本地封面 */
    }
  }
  return mapped
}

/** Promise.race 的小工具：超时返回 ''，原 promise 继续跑但结果被忽略。 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(''), ms)),
  ])
}

/** 文字版书架（信息图渲染失败时降级）。 */
async function buildTodayList(root, { limit = 50 } = {}) {
  const entries = await scanLibrary(root)
  if (!entries.length) return { text: '', count: 0 }
  const detail = new Map()
  for (const e of entries) detail.set(String(e.id), e.meta || null)
  const stamp = (e) => {
    const iso = detail.get(String(e.id))?.downloadedAt
    const t = iso ? Date.parse(iso) : NaN
    return Number.isFinite(t) ? t : Number(e.mtime || 0)
  }
  entries.sort((a, b) => stamp(b) - stamp(a))
  const shown = entries.slice(0, limit)

  await ensureTranslatedTitles(shown.map((e) => {
    const meta = detail.get(String(e.id)) || {}
    const zh = toSimplified(String(meta.name || e.name || '').trim())
    return { title: zh, apply: (t) => { const x = toSimplified(String(t || '').trim()); if (x) meta.name = x } }
  }))

  const lines = shown.map((e) => {
    const meta = detail.get(String(e.id)) || {}
    const rawName = toSimplified(String(meta.name || e.name || `JM${e.id}`).trim())
    let name = rawName
      .replace(/^\s*(?:\[[^\]]*\]|\([^)]*\)|【[^】]*】)+\s*/g, '')
      .replace(/\s*\[[^\]]*?(?:漢化|汉化|翻譯|翻译|漢化組|字幕|掃圖|嵌字)[^\]]*?\]\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
    if (!name) name = rawName
    const shortName = name.length > 42 ? `${name.slice(0, 42)}…` : name
    const authors = Array.isArray(meta.authors)
      ? meta.authors.map((a) => toSimplified(String(a).trim())).filter((a) => a && a !== 'N/A')
      : []
    const tags = Array.isArray(meta.tags) ? meta.tags.map((t) => toSimplified(String(t).trim())).filter(Boolean) : []
    const pages = Number(meta.pages || e.pages || 0)
    const bits = []
    if (authors.length) bits.push(`作者：${authors.slice(0, 3).join('、')}${authors.length > 3 ? ' 等' : ''}`)
    if (pages) bits.push(`${pages} 页`)
    if (tags.length) bits.push(`标签：${tags.slice(0, 5).join('/')}${tags.length > 5 ? ' 等' : ''}`)
    if (e.pdf) bits.push('有 PDF')
    const fsName = toSimplified(String(meta?.firstSubmitter?.name || '').trim())
    const fsId = String(meta?.firstSubmitter?.id || '').trim()
    let submitter = ''
    if (fsName && fsId) submitter = `${fsName}(${fsId})`
    else if (fsName) submitter = fsName
    else if (fsId) submitter = fsId
    let line = `· JM${e.id}「${shortName}」${bits.length ? `— ${bits.join(' · ')}` : ''}`
    if (submitter) line += `（首次发车：${submitter}）`
    return line
  })

  const head = `本地漫画共 ${entries.length} 本${entries.length > shown.length ? `（列出最近 ${shown.length} 本）` : ''}：`
  return { text: `${head}\n${lines.join('\n')}\n\n想下载哪本，直接发编号（如 jm${shown[0].id}）即可。`, count: entries.length }
}

// ───────────────────────── 清理 ─────────────────────────

async function cleanupLocal() {
  const days = cfg().keepDays
  if (!days) return { removed: 0 }
  const root = downloadRoot()
  if (!fs.existsSync(root)) return { removed: 0 }
  const deadline = Date.now() - days * 86400000
  let removed = 0
  try {
    const groups = await fsp.readdir(root, { withFileTypes: true })
    for (const g of groups) {
      if (!g.isDirectory() || !/^jm-\d+$/.test(g.name)) continue
      const gp = path.join(root, g.name)
      for (const item of await fsp.readdir(gp, { withFileTypes: true })) {
        const target = path.join(gp, item.name)
        try {
          const st = await fsp.stat(target)
          if (st.mtimeMs < deadline) {
            await fsp.rm(target, { recursive: true, force: true })
            removed += 1
          }
        } catch {
          /* 单个失败不影响其它 */
        }
      }
      try {
        if ((await fsp.readdir(gp)).length === 0) await fsp.rmdir(gp)
      } catch {
        /* ignore */
      }
    }
  } catch (error) {
    warn(`本地清理出错（已跳过）：${error?.message ?? error}`)
  }
  return { removed }
}

async function cleanupGroupFiles() {
  const days = cfg().groupFileKeepDays
  if (!days) return
  const deadline = Date.now() - days * 86400000
  for (const [key, item] of [...uploadedGroupFiles]) {
    if (item.at > deadline) continue
    uploadedGroupFiles.delete(key)
    const [, groupId] = String(item.chatKey).split(':')
    const r = await deleteGroupFile(onebot, groupId, item.fileId)
    log(`群文件到期清理：${item.name} → ${r.ok ? '已删除' : `删除失败 ${r.error || '（需要 onebot.admin 权限）'}`}`)
  }
  saveUploadedGroupFiles()
}

// ───────────────────────── 指令解析 ─────────────────────────

// 「今日JM」：必须带「今日/今天/本日」前缀，或带「列表/清单/目录/有哪些」后缀 ——
// 否则单说一个 "jm" 也会被当成查书架（旧版正则的坑，实测踩到）。
const TODAY_RE = /^(?:(?:今日|今天|本日)\s*(?:的|有(?:啥|什么|哪些))?\s*(?:JM|jm|Jm|禁漫|本子)(?:\s*(?:列表|清单|目录|有哪些|有啥|有什么|都有啥|都有什么))?|(?:JM|jm|Jm|禁漫|本子)\s*(?:列表|清单|目录|有哪些|有啥|有什么|都有啥|都有什么))$/
const UPDATE_RE = /^(?:(?:今日|今天|本日|最近|最新)\s*(?:的)?\s*)?(?:JM|jm|Jm|禁漫|本子)?\s*(?:更新|日更|新更)(?:列表|清单|目录|了|有啥|有什么|有哪些|啥)?(?:JM|jm|Jm|禁漫|本子)?$/
const CONTROL_RE = /^(暂停下载|继续下载|删除\s*JM)\s*[-_:#：]?\s*(?:JM)?(\d{2,9})$/i
const STATUS_RE = /^(?:下好了吗|下载进度|怎么没动静|好了没|下完了吗)[？?！!。.\s]*$/
const LIBRARY_RE = /^(?:本地收藏|本地漫画|收藏列表|书架|本地有哪几本|有哪些漫画)[？?！!。.\s]*$/
const ENV_RE = /^(?:支持\s*PDF\s*吗|支持pdf吗|存储状态|环境状态|磁盘满了吗|群文件还有空间吗|还有空间吗)[？?！!。.\s]*$/
const GROUP_ON_RE = /^(?:开启|打开|开通)\s*(?:JM|jm|Jm|禁漫)$/
const GROUP_OFF_RE = /^(?:关闭|停用)\s*(?:JM|jm|Jm|禁漫)$/
const GROUP_LIST_RE = /^(?:JM|jm|Jm|禁漫)群(?:列表|名单)$/
const GROUP_ALL_RE = /^(?:JM|jm|Jm|禁漫)所有群(?:开放|全开)?$/

/** 认「像漫画 ID 的下载请求」：jm123 / 链接 / @我 + 纯数字。 */
function matchDownload(session, raw) {
  const text = String(raw || '')
  const jmPrefix = text.match(/(?:^|[^0-9A-Za-z])(?:jm|JM|Jm)[\s\-_:：#]*(\d{2,9})(?!\d)/)
  const albumLink = text.match(/\/(?:album|photo)\/(\d{2,9})(?!\d)/)
  let m = jmPrefix || albumLink
  let strong = Boolean(m)
  if (!m && (session.mentioned || session.chat_type === 'private')) {
    const bare = text.trim().match(/^#?(\d{5,9})$/)
    if (bare) {
      m = bare
      strong = true
    }
  }
  if (!m) return null
  const id = engine.normalizeAlbumId(m[1])
  return id && strong ? { id } : null
}

// ───────────────────────── 指令处理 ─────────────────────────

/**
 * 把一本排进队列（不发消息）。返回 { ok, text } 或 { ok:false, error }。
 * 消息路径和 AI 工具路径共用，避免两套判断漂移。
 */
async function enqueueDownload(session, id) {
  const chatKey = chatKeyOf(session)
  const c = cfg()

  const gate = gateText(chatKey)
  if (gate) return { ok: false, error: gate }
  if (!c.enabled) {
    return { ok: false, error: '漫画下载功能被关掉了（插件设置里的「启用下载功能」）。请让管理员打开。' }
  }
  const perm = checkTrigger(session)
  if (!perm.ok) return { ok: false, error: perm.reason }
  if (!/^\d{2,9}$/.test(id)) {
    return { ok: false, error: '没有拿到有效的漫画 ID：要纯数字，例如 jm123456。' }
  }
  if (activeTasks.has(id)) {
    const t = activeTasks.get(id)
    return {
      ok: true,
      queued: false,
      text: `JM${id} 已经在处理中（阶段：${t.stage}，已开始 ${Math.round((Date.now() - t.startedAt) / 1000)} 秒），不要重复提交。`,
    }
  }

  const whoName = String(session.nickname || '').trim()
  const who = String(session.user_id || '')
  const attributionKey = `${chatKey}:${id}`
  if (!firstSubmitters.has(attributionKey)) {
    firstSubmitters.set(attributionKey, { id: who, name: whoName, at: Date.now() })
    if (!whoName) warn(`JM${id} 没能认出首次发车的人（nickname 为空）→ 先留空，不写占位名`)
  }

  activeTasks.set(id, {
    albumId: id,
    chatKey,
    kind: session.chat_type,
    who,
    whoName,
    control: { paused: false, deleted: false, child: null },
    stage: 'queued',
    startedAt: Date.now(),
    addedAt: Date.now(),
    chat: chatOf(session),
  })
  activeByChat.set(chatKey, id)
  taskQueue.push(id)
  saveQueue()
  void pump()

  // 回执里的"计划"不阻塞：Python 探测是 spawnSync，工具调用只有 8 秒预算，
  // 这里只按设置描述，真实能力在 runJob 里探测并在结果里体现。
  const plan = [
    c.outputFormat === 'pdf' ? '合成 PDF' : '保留图片',
    c.restore ? '还原竖切' : '',
    c.uploadMode === 'off' ? '不上传' : '上传到本会话',
  ].filter(Boolean).join(' + ')

  return {
    ok: true,
    queued: true,
    text: `JM${id} 已经排上队开始处理了（${plan}）。\n`
      + '会按顺序一本一本跑，跟这次对话结不结束无关，跑完自动把结果发到群里。'
      + (activeTasks.size > 1 ? `\n当前队列/处理中一共 ${activeTasks.size} 本。` : ''),
  }
}

/** 消息里的下载请求：入队。成功时不发回执——第 1 条消息（封面+书名）就是回执。 */
async function handleDownload(session, id) {
  const chat = chatOf(session)
  const r = await enqueueDownload(session, id)
  if (!r.ok) await sendText(chat, r.error)
  else if (r.queued === false) await sendText(chat, r.text)
}

async function handleGroupToggle(session, action) {
  const chatKey = chatKeyOf(session)
  const chat = chatOf(session)
  const [kind, chatId] = chatKey.split(':')
  const st = loadGroupState()

  if (action === 'list') {
    const ids = Object.keys(st.groups || {}).filter(Boolean)
    const text = ids.length
      ? `📋 已开启 JM 的群（${ids.length} 个）：\n${ids.map((gid, i) => {
          const g = st.groups[gid] || {}
          return `${i + 1}. ${gid}${g.name ? `「${g.name}」` : ''}`
        }).join('\n')}\n\n在目标群里发「开启JM」新增、「关闭JM」移除；「JM所有群开放」恢复所有群可用。`
      : '当前所有群都可用 JM（未开启白名单模式）。\n在目标群里发「开启JM」即开启白名单模式并加入该群。'
    await sendText(chat, text)
    return
  }

  if (kind !== 'group') {
    await sendText(chat, '开启/关闭是按群生效的。请到目标群里发「开启JM」或「关闭JM」。')
    return
  }
  if (!isManager(session)) {
    await sendText(chat, `只有群主/管理员（或白名单 QQ）能开关 JM 功能（你是 ${session.role || '普通成员'}）。`)
    return
  }

  if (action === 'on') {
    let gname = ''
    try {
      const gi = await onebot.call('get_group_info', { group_id: Number(chatId) })
      gname = String(gi?.group_name || '')
    } catch {
      /* 拿不到群名就不显示 */
    }
    st.groups[chatId] = { by: String(session.user_id), name: gname, at: new Date().toISOString() }
    saveGroupState(st)
    const wasFirst = Object.keys(st.groups).filter(Boolean).length === 1
    const extra = wasFirst
      ? '\n（已进入白名单模式：从现在起只有已开启的群能用 JM，私聊不受影响。「JM所有群开放」可恢复。）'
      : ''
    await sendText(chat, `✅ 已在本群${gname ? `「${gname}」` : ''}开启 JM 功能${extra}`)
    return
  }
  if (action === 'off') {
    const had = Boolean(st.groups[chatId])
    delete st.groups[chatId]
    saveGroupState(st)
    const rest = Object.keys(st.groups).filter(Boolean).length
    const extra = rest === 0 ? '\n（名单已清空：恢复为所有群都可用 JM。）' : ''
    await sendText(chat, had ? `✅ 已在本群关闭 JM 功能。群友再发 JM 请求会被婉拒。${extra}` : `本群本来就没有开启 JM。${extra}`)
    return
  }
  st.groups = {}
  saveGroupState(st)
  await sendText(chat, '✅ 已恢复默认：所有群都可用 JM。')
}

async function replyTodayList(session) {
  const chatKey = chatKeyOf(session)
  const chat = chatOf(session)
  const gate = gateText(chatKey)
  if (gate) {
    await sendText(chat, gate)
    return true
  }
  const root = downloadRoot()
  const emptyText = '本地漫画列表是空的。把漫画编号发给我就能下。'
  if (fs.existsSync(root)) {
    try {
      const items = await buildTodayItems(root)
      if (!items.length) {
        await sendText(chat, emptyText)
        return true
      }
      const payload = {
        title: `📚 今日JM 本地书架 ${items.length} 本`,
        subtitle: `${new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)}（东八区）· 已删除的本子自动移出`,
        footnote: `共 ${items.length} 本 · 发漫画编号即可下载`,
        items,
      }
      const imagePath = await renderDigestImage({ payload, outPath: path.join(DATA_DIR, 'today-list.jpg') })
      const sent = await sendImageWithText(
        chat,
        `📚 今日JM 本地书架（${items.length} 本）\n想下载哪本，直接发编号即可。`,
        imagePath,
      )
      if (sent) return true
      warn('今日JM 信息图发送失败，降级文字版')
    } catch (imgErr) {
      warn(`今日JM 信息图路径失败，降级文字版：${imgErr?.message ?? imgErr}`)
    }
  }
  const built = fs.existsSync(root) ? await buildTodayList(root) : { text: '' }
  await sendText(chat, built.text || emptyText)
  return true
}

async function replyUpdates(session) {
  const chatKey = chatKeyOf(session)
  const chat = chatOf(session)
  const gate = gateText(chatKey)
  if (gate) {
    await sendText(chat, gate)
    return true
  }
  try {
    const payload = await loadDigestItems({ simplify: toSimplified, translate: ensureTranslatedTitles })
    if (!payload.items.length) {
      await sendText(chat, '今天还没有采集到禁漫更新（每 30 分钟自动抓一次，先等等再看）。')
      return true
    }
    const full = {
      title: `📥 今日禁漫更新 ${payload.items.length} 本`,
      subtitle: `${payload.date} · 截至 ${payload.until} · 发漫画编号即可下载`,
      footnote: `共 ${payload.items.length} 本（站点当日新上架/新章节）`,
      items: payload.items,
    }
    try {
      const imagePath = await renderDigestImage({ payload: full })
      const sent = await sendImageWithText(
        chat,
        `📥 今日禁漫更新 ${payload.items.length} 本（截至 ${payload.until}）\n想下载哪本，直接发编号即可。`,
        imagePath,
      )
      if (sent) return true
    } catch (imgErr) {
      warn(`更新JM 信息图渲染失败，降级文字版：${imgErr?.message ?? imgErr}`)
    }
    const digest = await buildDigestFromState({ simplify: toSimplified, translate: ensureTranslatedTitles })
    await sendText(chat, digest.text)
  } catch (error) {
    warn(`生成更新JM失败：${error?.message ?? error}`)
    await sendText(chat, `生成更新清单失败：${error?.message ?? error}`)
  }
  return true
}

async function replyStatus(session) {
  const chatKey = chatKeyOf(session)
  const chat = chatOf(session)
  const gate = gateText(chatKey)
  if (gate) {
    await sendText(chat, gate)
    return true
  }
  await loadHistory()
  const lines = []
  const waiting = taskQueue.map((id) => activeTasks.get(id)).filter((t) => t && (!chatKey || t.chatKey === chatKey))
  if (waiting.length) lines.push(`排队中 ${waiting.length} 本（按此顺序）：${waiting.map((t) => `JM${t.albumId}`).join('、')}`)
  const mine = [...activeTasks.values()].filter((t) => t.stage !== 'queued' && (!chatKey || t.chatKey === chatKey))
  if (mine.length) {
    lines.push(`正在处理 ${mine.length} 本：`)
    for (const t of mine) lines.push(`· JM${t.albumId}（${t.stage}，已 ${Math.round((Date.now() - t.startedAt) / 1000)} 秒）`)
  } else {
    lines.push('当前没有正在处理的任务（排队情况看上一行）。')
  }
  const recent = taskHistory.filter((h) => !chatKey || h.chatKey === chatKey).slice(0, 5)
  if (recent.length) {
    lines.push('', '最近记录：')
    for (const h of recent) {
      const when = String(h.at || '').slice(5, 16).replace('T', ' ')
      lines.push(h.ok
        ? `· ${when} JM${h.id}「${toSimplified(h.title || '')}」成功，${h.pagesOk || 0}/${h.pages || 0} 张`
        : `· ${when} JM${h.id} 失败（${h.stage}）：${h.error || '未知原因'}`)
    }
  }
  await sendText(chat, lines.join('\n'))
  return true
}

async function replyLibrary(session) {
  const chatKey = chatKeyOf(session)
  const chat = chatOf(session)
  const gate = gateText(chatKey)
  if (gate) {
    await sendText(chat, gate)
    return true
  }
  const root = downloadRoot()
  if (!fs.existsSync(root)) {
    await sendText(chat, `本地还没有任何漫画（目录 ${root} 还不存在）。`)
    return true
  }
  const entries = await scanLibrary(root)
  if (!entries.length) {
    await sendText(chat, '本地收藏是空的。群友把漫画 ID 发给我就能下。')
    return true
  }
  entries.sort((a, b) => b.mtime - a.mtime)
  const lines = entries.slice(0, 30).map((e) => {
    const when = new Date(e.mtime).toISOString().slice(0, 16).replace('T', ' ')
    return `· JM${e.id}「${e.name}」${e.pages ? `${e.pages} 张 · ` : ''}${e.pdf ? '有 PDF · ' : ''}${when}`
  })
  await sendText(chat, `本地收藏共 ${entries.length} 本（列出最近 ${Math.min(30, entries.length)} 本）：\n${lines.join('\n')}\n\n目录：${root}`)
  return true
}

async function replyEnv(session) {
  const chat = chatOf(session)
  const chatKey = chatKeyOf(session)
  const gate = gateText(chatKey)
  if (gate) {
    await sendText(chat, gate)
    return true
  }
  const c = cfg()
  const root = downloadRoot()
  const usage = await dirSize(root).catch(() => ({ bytes: 0, files: 0 }))
  const worker = detectWorker()
  const lines = [
    `下载目录：${root}`,
    `已占用：${humanSize(usage.bytes)}（${usage.files} 个文件）`,
    `清理策略：本地保留 ${c.keepDays || '不'} 天${c.groupFileKeepDays ? `，群文件 ${c.groupFileKeepDays} 天后自动删除` : ''}`,
    `输出格式：${c.outputFormat === 'pdf' ? 'PDF' : '原始图片'}${c.restore ? '（开启竖切还原）' : ''}`,
    `合成 PDF 后删除原图：${c.deleteImagesAfterPdf ? '已开启（PDF 失败时会自动保留原图）' : '未开启'}`,
    `还原/PDF 能力：${worker.ok ? `可用（Python ${String(worker.python).split(/[\\/]/).pop()}，Pillow ${worker.pillow}）` : `不可用 —— ${worker.error}。会降级为原样保存图片。`}`,
    `上传模式：${{ off: '不上传', request: '传回提出请求的会话', group: '只传群', private: '只传私聊' }[c.uploadMode]}`,
    `单文件上限：${c.maxUploadMB} MB${c.rejectOversize ? '（超限拒绝）' : '（超限自动分卷）'}`,
    `允许触发：${c.allowIds ? `仅管理员/白名单（${c.allowIds}）` : '所有人'}`,
  ]
  if (session.chat_type === 'group') {
    const q = await groupQuota(onebot, session.chat_id)
    lines.push(q.ok
      ? `本群群文件：${q.fileCount}/${q.limitCount} 个，已用 ${humanSize(q.usedSpace)} / ${humanSize(q.totalSpace)}`
      : `本群群文件配额查询失败：${q.error}`)
  }
  await sendText(chat, lines.join('\n'))
  return true
}

async function handleMessage({ session }) {
  const raw = String(session.text ?? '').trim()
  if (!raw) return { handled: false }
  const text = raw.replace(/^[\/!.#]+/, '').trim()
  if (!text) return { handled: false }

  try {
    // 群开关：未开启的群里也要能发「开启JM」，所以放在门禁之前
    if (GROUP_ON_RE.test(text)) {
      await handleGroupToggle(session, 'on')
      return { handled: true }
    }
    if (GROUP_OFF_RE.test(text)) {
      await handleGroupToggle(session, 'off')
      return { handled: true }
    }
    if (GROUP_LIST_RE.test(text)) {
      await handleGroupToggle(session, 'list')
      return { handled: true }
    }
    if (GROUP_ALL_RE.test(text)) {
      await handleGroupToggle(session, 'all')
      return { handled: true }
    }

    // 控制指令
    const control = CONTROL_RE.exec(text)
    if (control) {
      const chatKey = chatKeyOf(session)
      const chat = chatOf(session)
      const gate = gateText(chatKey)
      if (gate) {
        await sendText(chat, '本群还没有开启 JM 漫画功能，暂停/继续/删除也用不了。群主/管理员在群里 @我 说「开启JM」即可开通。')
        return { handled: true }
      }
      const perm = checkTrigger(session)
      if (!perm.ok) {
        await sendText(chat, perm.reason)
        return { handled: true }
      }
      const action = control[1].startsWith('暂停') ? 'pause' : control[1].startsWith('继续') ? 'resume' : 'delete'
      const id = engine.normalizeAlbumId(control[2])
      const result = await performControl({ action, albumId: id, chatKey })
      await sendText(chat, result)
      return { handled: true }
    }

    // 清单类
    if (TODAY_RE.test(text)) return { handled: await replyTodayList(session) }
    if (UPDATE_RE.test(text)) return { handled: await replyUpdates(session) }
    if (STATUS_RE.test(text)) return { handled: await replyStatus(session) }
    if (LIBRARY_RE.test(text)) return { handled: await replyLibrary(session) }
    if (ENV_RE.test(text)) return { handled: await replyEnv(session) }

    // 下载 / 控制指令写错参数时给一句用法（也算认领，别掉给 AI 瞎猜）
    const hit = matchDownload(session, text)
    if (!hit) {
      const usageLike = /^(?:jm\b|暂停下载|继续下载|删除\s*JM)/i.test(text)
      if (!usageLike) return { handled: false }
      await sendText(
        chatOf(session),
        '用法：\n'
        + '· jm <漫画ID>（例如 jm123456，也可以直接发漫画链接）\n'
        + '· 暂停下载 <ID> / 继续下载 <ID> / 删除JM <ID>\n'
        + '· 今日JM、更新JM、下好了吗、本地收藏、开启JM、关闭JM、JM群列表',
      )
      return { handled: true }
    }
    await handleDownload(session, hit.id)
    return { handled: true }
  } catch (error) {
    warn(`处理消息失败：${error?.stack ?? error}`)
    await sendText(chatOf(session), `处理失败：${error?.message ?? error}`)
    return { handled: true }
  }
}

// ───────────────────────── 给 AI 用的工具 ─────────────────────────

function toolChat(session) {
  return session ? chatOf(session) : null
}

async function callTool({ name, args, session }) {
  const chat = toolChat(session)
  const chatKey = session ? chatKeyOf(session) : ''
  const a = args || {}

  try {
    if (name === 'jm_download') {
      if (!session) return { ok: false, error: '这个工具需要会话上下文' }
      const id = engine.normalizeAlbumId(a.album_id)
      if (!id) return { ok: false, error: 'album_id 必须是纯数字漫画 ID（例如 123456）' }
      const r = await enqueueDownload(session, id)
      return r.ok ? { ok: true, data: { text: r.text } } : { ok: false, error: r.error }
    }

    if (name === 'jm_control') {
      if (!session) return { ok: false, error: '这个工具需要会话上下文' }
      const gate = gateText(chatKey)
      if (gate) return { ok: false, error: gate }
      const action = String(a.action || '').toLowerCase()
      const id = engine.normalizeAlbumId(a.album_id)
      if (!['pause', 'resume', 'delete'].includes(action)) return { ok: false, error: 'action 只能是 pause / resume / delete' }
      if (!id) return { ok: false, error: 'album_id 必须是纯数字 ID' }
      const text = await performControl({ action, albumId: id, chatKey })
      await sendText(chat, text)
      return { ok: true, data: { text } }
    }

    if (name === 'jm_task_status') {
      if (!session) return { ok: false, error: '这个工具需要会话上下文' }
      await replyStatus(session)
      return { ok: true, data: { text: '进度已发到会话。' } }
    }

    if (name === 'jm_today_list') {
      if (!session) return { ok: false, error: '这个工具需要会话上下文' }
      const gate = gateText(chatKey)
      if (gate) return { ok: false, error: gate }
      // 工具超时只有 8 秒：信息图要读目录 + 拉封面 + 跑 Python，放后台做，先回执
      void replyTodayList(session).catch((e) => warn(`今日JM 后台任务失败：${e?.message ?? e}`))
      return { ok: true, data: { text: '正在生成今日JM 信息图，好了会直接发到会话，不需要复述。' } }
    }

    if (name === 'jm_daily_updates') {
      if (!session) return { ok: false, error: '这个工具需要会话上下文' }
      const gate = gateText(chatKey)
      if (gate) return { ok: false, error: gate }
      void replyUpdates(session).catch((e) => warn(`更新JM 后台任务失败：${e?.message ?? e}`))
      return { ok: true, data: { text: '正在生成更新清单信息图，好了会直接发到会话，不需要复述。' } }
    }

    if (name === 'jm_group_toggle') {
      if (!session) return { ok: false, error: '这个工具需要会话上下文' }
      const action = String(a.action || 'list').toLowerCase()
      await handleGroupToggle(session, ['on', 'off', 'list', 'all'].includes(action) ? action : 'list')
      return { ok: true, data: { text: '结果已发到会话。' } }
    }

    if (name === 'jm_library') {
      if (!session) return { ok: false, error: '这个工具需要会话上下文' }
      await replyLibrary(session)
      return { ok: true, data: { text: '收藏列表已发到会话。' } }
    }

    if (name === 'jm_storage') {
      if (!session) return { ok: false, error: '这个工具需要会话上下文' }
      await replyEnv(session)
      return { ok: true, data: { text: '环境状态已发到会话。' } }
    }

    return { ok: false, error: `未知工具 ${name}` }
  } catch (error) {
    warn(`工具 ${name} 执行失败：${error?.message ?? error}`)
    return { ok: false, error: error?.message ?? String(error) }
  }
}

// ───────────────────────── 生命周期 ─────────────────────────

function startTimers() {
  // 每日更新采集：每 30 分钟一轮；启动后 90 秒先跑一次（别和插件启动抢网络）
  const collectTimer = setInterval(() => {
    collectDaily({ pages: 3 }).catch((e) => warn(`更新采集失败：${e?.message ?? e}`))
  }, 30 * 60 * 1000)
  const firstCollect = setTimeout(() => {
    collectDaily({ pages: 3 }).catch((e) => warn(`更新采集失败：${e?.message ?? e}`))
  }, 90 * 1000)

  // 本地/群文件清理：每 6 小时，启动后 20 秒先跑一次
  const cleanupTimer = setInterval(() => {
    void cleanupLocal()
    void cleanupGroupFiles()
  }, 6 * 3600 * 1000)
  const firstCleanup = setTimeout(() => {
    void cleanupLocal()
  }, 20 * 1000)

  timers = [collectTimer, firstCollect, cleanupTimer, firstCleanup]
}

function stopTimers() {
  for (const t of timers) {
    clearInterval(t)
    clearTimeout(t)
  }
  timers = []
}

serve({
  async initialize({ settings: initial, data_dir, plugin_id }) {
    settings = initial || {}
    // 数据目录用框架给的（绝对路径）；没有就退回运行区 data/。
    // 这一步也覆盖"手工改过 runtime_dir"的情况，不靠猜目录层级。
    const fromHost = String(data_dir || '').trim()
    if (fromHost && path.isAbsolute(fromHost)) DATA_DIR = fromHost
    fs.mkdirSync(DATA_DIR, { recursive: true })

    configureDaily({
      dataRoot: () => downloadRoot(),
      client: () => client(),
      warn: (msg) => warn(msg),
    })

    await loadHistory()
    loadUploadedGroupFiles()
    const resumed = loadQueue()
    // 等握手彻底结束再续跑（initialize 里立刻发消息可能赶上宿主还没准备好）
    if (resumed) setTimeout(() => { void pump() }, 1500)
    startTimers()
    // 预热 Python 探测：第一次 spawnSync 可能要一两秒，别让它落在工具调用的 8 秒预算里
    setTimeout(() => {
      try {
        detectWorker()
      } catch {
        /* 探测失败会在真正用到时再报 */
      }
    }, 5000)

    log(`禁漫下载已就绪：目录 ${downloadRoot()}，输出 ${cfg().outputFormat}，队列 ${resumed} 本`)
    // 把"路径从哪来"写进日志：出问题时一眼能看出用的是框架配置还是插件设置
    log('运行环境', {
      plugin: plugin_id || process.env.QIXIN_PLUGIN_ID || '',
      dataDir: DATA_DIR,
      python: process.env.QIXIN_PYTHON || '自动探测',
      experimental: process.env.QIXIN_EXPERIMENTAL === '1',
    })
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...(values || {}) }
    resetWorkerCache()
    resetPythonCache()
    log('设置已更新')
    return { ok: true }
  },

  async handle_message(params) {
    return handleMessage(params)
  },

  async call_tool(params) {
    return callTool(params)
  },

  async shutdown() {
    stopTimers()
    for (const task of activeTasks.values()) {
      try {
        task.control?.child?.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
    log('禁漫下载已停止（进行中的下载会保留已下好的部分）')
    return {}
  },
})
