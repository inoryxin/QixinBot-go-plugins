// 贴吧鱼模式：融合自 tieba-mouth 1.1.0（QQ Agent 技能），并进人设插件。
//
// 为什么要融合：贴吧模式的本质是「换一套系统提示词 + 按群开关」，
// 而 QixinBot 里系统提示词的唯一来源就是本插件的 persona.render。
// 拆成两个插件的话，ai-chat 得同时问两家、还要保证注入顺序，反而更绕。
//
// 职责：
//   · 认「切换贴吧鱼模式 / 关闭贴吧模式」这类自然语言指令（按群落盘）
//   · 模式开着的会话，render() 里追加贴吧口吻 + 本轮语料抽样
//   · 提供 tieba_add / tieba_stats 两个工具，让模型自己扩语料库
//
// 存储（都在插件 data 目录，绝不写 plugins 目录）：
//   tieba-corpus.json   语料（种子 + 用户/模型新增）
//   tieba-modes.json    哪些会话开着模式

import fs from 'node:fs'
import path from 'node:path'
import { CORPUS_SEED } from './tieba_corpus.js'
import {
  STYLE_RULES, IDENTITY_RULES, ATTACK_RULES, GUARD_RULES, ON_LINES, OFF_LINES,
} from './tieba_rules.js'

const HINT_HEAD = '【贴吧鱼模式】'
// 动态语料块用独立标记：静态段正文也以 HINT_HEAD 开头，用同一个标记判断"已注入"会永远跳过
const CORPUS_MARK = '【贴吧语料·本轮】'
const MAX_CORPUS = 800
const MODE_TTL_DAYS = 365

const ON_CMDS = ['切换贴吧鱼模式', '开启贴吧鱼模式', '打开贴吧鱼模式', '切到贴吧鱼模式', '贴吧鱼模式开启', '贴吧鱼模式']
const OFF_CMDS = ['关闭贴吧模式', '关闭贴吧鱼模式', '退出贴吧鱼模式', '退出贴吧模式', '关掉贴吧模式', '关掉贴吧鱼模式', '贴吧模式关闭']
const CMD_PREFIX = ['帮我', '请', '麻烦', '给我', '现在', '立刻', '赶紧', '快点']

const KINDS = ['slang', 'pattern', 'reply', 'meme']

function num(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function hash(text) {
  let h = 2166136261
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

function normText(text) {
  return String(text ?? '')
    .replace(/[\s，。！？、~～…·.,!?;；:：""''《》【】[\]（）()]/g, '')
    .trim()
}

function readJsonSafe(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(raw)
}

/** 解析「切换/关闭贴吧模式」：true=开 false=关 null=不是指令 */
function parseSwitch(text) {
  let t = String(text ?? '').trim()
  if (!t) return null
  // 去掉开头礼貌词（可以叠加：麻烦帮我…）
  let changed = true
  while (changed) {
    changed = false
    for (const p of CMD_PREFIX) {
      if (t.startsWith(p)) {
        t = t.slice(p.length).trim()
        changed = true
      }
    }
  }
  const flat = normText(t)
  if (!flat) return null
  if (ON_CMDS.includes(flat)) return true
  if (OFF_CMDS.includes(flat)) return false
  return null
}

function pickReply(list) {
  return list[Math.floor(Math.random() * list.length)] || list[0] || ''
}

export function createTieba({ dataDir, getSettings, log = () => {}, warn = () => {} }) {
  const dir = String(dataDir || '')
  const corpusFile = path.join(dir, 'tieba-corpus.json')
  const modeFile = path.join(dir, 'tieba-modes.json')

  let corpus = []
  let modes = {}
  let loaded = false

  const cfg = () => getSettings() || {}
  const enabled = () => cfg().tieba_enabled !== false
  const identityOn = () => cfg().tieba_identity !== false

  function blockedWords() {
    return String(cfg().tieba_blocked_words || '')
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }

  function ensureDir() {
    if (!dir) return
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* 已存在 */
    }
  }

  // ---------------------------------------------------------------- 语料

  function normalizeItem(raw, index) {
    if (!raw || typeof raw !== 'object') return null
    const phrase = String(raw.phrase ?? '').trim().slice(0, 40)
    if (!phrase) return null
    return {
      id: String(raw.id || `c${index}_${hash(phrase)}`),
      kind: KINDS.includes(raw.kind) ? raw.kind : 'slang',
      phrase,
      meaning: String(raw.meaning ?? '').slice(0, 120),
      bar: String(raw.bar ?? '').slice(0, 40),
      example: String(raw.example ?? '').slice(0, 120),
      addedAt: Number(raw.addedAt) || 0,
    }
  }

  function readCorpusFile() {
    try {
      const data = readJsonSafe(corpusFile)
      const list = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : []
      return list.map(normalizeItem).filter(Boolean)
    } catch {
      return null
    }
  }

  function writeCorpusFile() {
    ensureDir()
    const tmp = `${corpusFile}.tmp`
    const payload = { version: 1, updatedAt: Date.now(), count: corpus.length, items: corpus }
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 1), 'utf8')
    fs.renameSync(tmp, corpusFile)
  }

  function saveCorpus() {
    if (corpus.length > MAX_CORPUS) corpus = corpus.slice(-MAX_CORPUS)
    writeCorpusFile()
  }

  function loadCorpus() {
    ensureDir()
    const saved = readCorpusFile()
    if (!saved || !saved.length) {
      corpus = CORPUS_SEED.map(normalizeItem).filter(Boolean)
      writeCorpusFile()
      log(`贴吧语料库初始化：${corpus.length} 条（种子）`)
      return
    }
    corpus = saved
    // 种子升级：新版种子自动并入，不动用户自己加的
    const have = new Set(corpus.map((it) => it.phrase))
    let added = 0
    for (const seed of CORPUS_SEED) {
      const item = normalizeItem(seed, corpus.length)
      if (!item || have.has(item.phrase)) continue
      have.add(item.phrase)
      item.addedAt = Date.now()
      item.id = `s${Date.now().toString(36)}_${hash(item.phrase)}`
      corpus.push(item)
      added += 1
    }
    if (added) {
      saveCorpus()
      log(`贴吧语料库并入新版种子 ${added} 条（共 ${corpus.length} 条）`)
    }
  }

  /** 确定性洗牌：同一批语料在 rotateMinutes 内固定，不会每轮抖。 */
  function rng(seedText) {
    let s = 0
    for (const ch of String(seedText)) s = (s * 31 + ch.codePointAt(0)) >>> 0
    return () => {
      s ^= s << 13
      s >>>= 0
      s ^= s >> 17
      s ^= s << 5
      s >>>= 0
      return s / 4294967296
    }
  }

  function sampleCorpus(chatKey = '') {
    const count = num(cfg().tieba_sample_count, 6, 2, 20)
    const minutes = num(cfg().tieba_rotate_minutes, 3, 1, 60)
    const blocked = blockedWords()
    const pool = corpus.filter((it) => !blocked.some((w) => it.phrase.includes(w) || it.meaning.includes(w)))
    if (!pool.length) return []
    const bucket = Math.floor(Date.now() / (minutes * 60_000))
    const rand = rng(`${chatKey}|${bucket}|${pool.length}`)
    const want = [
      ['slang', Math.max(2, Math.round(count * 0.5))],
      ['pattern', Math.max(1, Math.round(count * 0.2))],
      ['reply', 1],
      ['meme', 1],
    ]
    const picked = []
    const taken = new Set()
    const shuffled = (list) => {
      const arr = list.slice()
      for (let i = arr.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1))
        ;[arr[i], arr[j]] = [arr[j], arr[i]]
      }
      return arr
    }
    for (const [kind, n] of want) {
      for (const it of shuffled(pool.filter((x) => x.kind === kind))) {
        if (picked.filter((x) => x.kind === kind).length >= n) break
        if (taken.has(it.id)) continue
        picked.push(it)
        taken.add(it.id)
      }
    }
    for (const it of shuffled(pool)) {
      if (picked.length >= count) break
      if (taken.has(it.id)) continue
      picked.push(it)
      taken.add(it.id)
    }
    return picked.slice(0, count)
  }

  function formatSamples(items) {
    return items
      .map((it) => {
        const bar = it.bar ? `（${it.bar}）` : ''
        const mean = it.meaning ? `：${it.meaning}` : ''
        return `- ${it.phrase}${mean}${bar}`
      })
      .join('\n')
  }

  // ---------------------------------------------------------------- 模式

  function loadModes() {
    try {
      const raw = readJsonSafe(modeFile)
      const obj = raw && typeof raw === 'object' ? raw : {}
      const now = Date.now()
      const ttl = MODE_TTL_DAYS * 86400_000
      modes = {}
      for (const [key, value] of Object.entries(obj)) {
        if (!value || typeof value !== 'object') continue
        const at = Number(value.at) || 0
        if (at && now - at > ttl) continue
        modes[key] = { on: value.on === true, at, by: String(value.by ?? '') }
      }
    } catch {
      modes = {}
    }
  }

  function saveModes() {
    ensureDir()
    try {
      const tmp = `${modeFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(modes, null, 1), 'utf8')
      fs.renameSync(tmp, modeFile)
    } catch (error) {
      warn(`贴吧模式状态写盘失败：${error?.message ?? error}`)
    }
  }

  function chatKeyOf(session) {
    const type = session?.chat_type === 'private' ? 'private' : 'group'
    return `${type}:${session?.chat_id ?? 0}`
  }

  function isOn(chatKey) {
    return modes[String(chatKey ?? '')]?.on === true
  }

  function setMode(chatKey, on, by = '') {
    const key = String(chatKey ?? '')
    if (!key) return false
    modes[key] = { on: Boolean(on), at: Date.now(), by: String(by || '') }
    saveModes()
    return true
  }

  // ---------------------------------------------------------------- 提示词

  function styleSection(chatKey) {
    const parts = [
      `${HINT_HEAD}只在本群（${chatKey}）开着贴吧鱼模式，就用吧友的口吻说话，别解释、别切换回去。\n其它群/私聊保持原人设，别把这个腔调带过去。\n聊天记录里你之前的回复可能是正常语气（那是没开模式时留的），不要模仿那种语气。`,
      STYLE_RULES,
    ]
    if (identityOn()) parts.push(IDENTITY_RULES, ATTACK_RULES)
    parts.push(GUARD_RULES)
    return parts.join('\n\n')
  }

  function corpusHint(chatKey) {
    const items = sampleCorpus(chatKey)
    const enforce = '【对线提醒】现在是对线，不是陪聊。对方骂你就骂回去，禁止劝睡/关心/讲道理/说"没活了"这种软话。'
    if (!items.length) return `${CORPUS_MARK}${enforce}\n（语料库是空的，先用 tieba_add 记几条吧友用语）`
    return `${CORPUS_MARK}${enforce}\n本轮的贴吧语料（挑 1~2 个用，别全用上）：\n${formatSamples(items)}`
  }

  /** render() 用：模式开着才返回两段（静态口吻 + 本轮语料）。 */
  function promptParts(chatType, chatID) {
    if (!enabled()) return []
    const key = `${chatType === 'private' ? 'private' : 'group'}:${chatID ?? 0}`
    if (!chatID || !isOn(key)) return []
    return [styleSection(key), corpusHint(key)]
  }

  // ---------------------------------------------------------------- 指令

  function statusText(session) {
    const key = chatKeyOf(session)
    const on = isOn(key)
    const open = Object.entries(modes).filter(([, v]) => v?.on).map(([k]) => k)
    const lines = [
      `贴吧鱼模式：当前会话${on ? '已开启' : '未开启'}（${key}）`,
      `语料库 ${corpus.length} 条；开着的会话 ${open.length} 个${open.length ? `：${open.slice(0, 5).join('、')}` : ''}`,
      '',
      '开启：@我 切换贴吧鱼模式（或 /贴吧 开）',
      '关闭：@我 关闭贴吧模式（或 /贴吧 关）',
    ]
    return lines.join('\n')
  }

  /**
   * 处理贴吧指令。返回 true 表示这条消息已被本功能接管（不再交给 AI）。
   * 注意：插件开了 require_prefix=false，每条消息都会走到这里，
   * 所以前面全是字符串判断，不做 IO。
   */
  function handle(session, text, reply) {
    if (!enabled()) return false
    const raw = String(text || '').trim()
    if (!raw) return false

    const explicit = /^贴吧(\s|$)/.test(raw)
    const cmd = explicit ? parseExplicit(raw) : parseSwitch(raw)
    if (cmd === null || cmd === undefined) return false

    const isGroup = session?.chat_type !== 'private'
    // 自然语言切换在群里默认要求 @；显式 /贴吧 命令不需要
    if (isGroup && !explicit && cfg().tieba_require_mention !== false && session?.mentioned !== true) {
      return false
    }
    // 纯文字「贴吧...」没 @ 也没前缀时不当命令，免得群里随口一句就触发
    if (isGroup && explicit && !session?.has_prefix && session?.mentioned !== true) {
      return false
    }

    if (cmd === 'status') {
      void reply(statusText(session))
      return true
    }

    const key = chatKeyOf(session)
    setMode(key, cmd === true, `${session?.nickname || ''}(${session?.user_id ?? ''})`)
    const line = pickReply(cmd ? ON_LINES : OFF_LINES)
    log(`贴吧模式${cmd ? '开' : '关'}：${key}`)
    void reply(line)
    return true
  }

  function parseExplicit(text) {
    const rest = normText(text.replace(/^贴吧/, ''))
    if (!rest || rest === '状态' || rest === '看' || rest === '列表') return 'status'
    if (['开', '开启', '打开', 'on', '启动'].includes(rest)) return true
    if (['关', '关闭', '退出', 'off', '停止'].includes(rest)) return false
    return 'status'
  }

  // ---------------------------------------------------------------- 工具

  function add(args = {}) {
    const phrase = String(args.phrase ?? '').trim().slice(0, 40)
    if (!phrase) return '没给 phrase，记不了。'
    const dup = corpus.find((it) => it.phrase === phrase)
    if (dup) {
      if (args.meaning) dup.meaning = String(args.meaning).slice(0, 120)
      if (args.bar) dup.bar = String(args.bar).slice(0, 40)
      if (args.example) dup.example = String(args.example).slice(0, 120)
      saveCorpus()
      return `「${phrase}」已经在库里了（${dup.kind}），这次只更新了解释。`
    }
    const item = normalizeItem({
      kind: args.kind,
      phrase,
      meaning: args.meaning,
      bar: args.bar,
      example: args.example,
      addedAt: Date.now(),
    })
    item.id = `c${Date.now().toString(36)}_${hash(phrase)}`
    corpus.push(item)
    saveCorpus()
    const bar = item.bar ? `，来自${item.bar}` : ''
    return `记下了：「${phrase}」（${item.kind}${bar}）。库里现在 ${corpus.length} 条。`
  }

  function stats(args = {}) {
    const byKind = { slang: 0, pattern: 0, reply: 0, meme: 0 }
    for (const it of corpus) byKind[it.kind] = (byKind[it.kind] || 0) + 1
    const bars = new Map()
    for (const it of corpus) if (it.bar) bars.set(it.bar, (bars.get(it.bar) || 0) + 1)
    const topBars = [...bars.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([bar, n]) => `${bar}(${n})`)
      .join('、')
    const n = num(args.sample, 5, 0, 20)
    const sample = n ? sampleCorpus('stats').slice(0, n) : []
    return (
      `语料 ${corpus.length} 条：口癖 ${byKind.slang} / 句式 ${byKind.pattern} / 接话 ${byKind.reply} / 梗 ${byKind.meme}\n`
      + `出处分布：${topBars || '（未标出处）'}\n`
      + (sample.length ? `随手抽：\n${formatSamples(sample)}` : '（库里没东西）')
    )
  }

  function load() {
    if (loaded) return
    loaded = true
    ensureDir()
    loadModes()
    loadCorpus()
    const open = Object.entries(modes).filter(([, v]) => v?.on).map(([k]) => k)
    log(`贴吧鱼模式已加载：语料 ${corpus.length} 条；开着的会话 ${open.length} 个`)
  }

  return {
    load,
    handle,
    promptParts,
    statusText,
    add,
    stats,
    isOn,
    setMode,
    chatKeyOf,
    get corpusSize() {
      return corpus.length
    },
  }
}
