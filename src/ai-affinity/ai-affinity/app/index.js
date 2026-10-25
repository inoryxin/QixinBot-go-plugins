// 好感度：记住每个人和她的关系。
//
// 为什么独立插件：
//  - 它是长期数据（会一直涨/跌），不该塞在对话插件里
//  - 别的插件（主动发言、群管理）也能读，AI 只是它的一个消费者
//
// 数据落在 plugins 共用的 db.sqlite 里（表 affinity），跟着插件一起备份。

import { serve, host } from '../_sdk/qixin.mjs'

let settings = {}

const LEVELS = [
  { min: 500, level: '离不开', title: '离不开你' },
  { min: 300, level: '亲密', title: '很亲近' },
  { min: 150, level: '熟人', title: '算熟' },
  { min: 80, level: '朋友', title: '是朋友' },
  { min: 30, level: '认识', title: '算认识' },
  { min: -100, level: '陌生', title: '还陌生' },
]

function levelOf(score) {
  for (const l of LEVELS) if (score >= l.min) return l
  return LEVELS[LEVELS.length - 1]
}

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function db(op, sql, params = []) {
  const r = await host.capability('db.sqlite', { op, sql, params })
  if (!r?.ok) throw new Error(r?.error || 'db.sqlite 调用失败')
  return r.data
}

async function ensureSchema() {
  await db('exec', `CREATE TABLE IF NOT EXISTS affinity (
    user_id INTEGER PRIMARY KEY,
    score   INTEGER NOT NULL DEFAULT 0,
    note    TEXT NOT NULL DEFAULT '',
    updated INTEGER NOT NULL DEFAULT 0
  )`)
}

async function getRow(userID) {
  const r = await db('get', `SELECT user_id, score, note, updated FROM affinity WHERE user_id = ?`, [userID])
  const base = Number(settings.base_score ?? 30)
  return r.row || { user_id: userID, score: base, note: '', updated: 0 }
}

async function setScore(userID, score) {
  // 主人永远满，不允许被改低
  if (isMaster(userID)) score = 1000
  const s = Math.max(-999, Math.min(9999, Math.round(score)))
  await db('exec',
    `INSERT INTO affinity (user_id, score, updated) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET score = excluded.score, updated = excluded.updated`,
    [userID, s, nowSec()])
  return s
}

async function addScore(userID, delta) {
  const row = await getRow(userID)
  return setScore(userID, Number(row.score || 0) + Number(delta || 0))
}

async function topList(limit = 10) {
  const r = await db('all',
    `SELECT user_id, score, updated FROM affinity ORDER BY score DESC LIMIT ?`,
    [Math.max(1, Math.min(50, limit))])
  return r.rows || []
}

function masterList() {
  return String(settings.master_qq || '')
    .split(/[,，\s]+/)
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
}

function isMaster(userID) {
  return masterList().includes(Number(userID))
}

// 关系语气：主人 > 明显好 > 一般 > 偏冷 > 阴阳怪气
function toneOf(score, base, mastered) {
  if (mastered) return 'master'
  if (score >= base + 150) return 'warm'
  if (score <= base - 60) return 'cold' // 关系差：阴阳怪气
  if (score <= base - 25) return 'cool'
  return 'normal'
}

function payload(userID, row) {
  const base = Number(settings.base_score ?? 30)
  const mastered = isMaster(userID)
  const score = mastered ? 1000 : Number(row.score || 0)
  const l = levelOf(score)
  return {
    user_id: Number(row.user_id || userID),
    score,
    base,
    is_master: mastered,
    tone: toneOf(score, base, mastered),
    level: l.level,
    title: l.title,
    note: row.note || '',
    relation: row.note || l.title,
  }
}

// 可疑"坏话"：命中才值得花钱让模型判断（大部分句子直接跳过）
const NEG_RE = /(傻|笨|蠢|滚|烦|讨厌|去死|废物|垃圾|闭嘴|别说话|恶心|丑|烂|弱智|神经|有病|阴阳|爬|寄了|你行不行|没用)/

function suspicious(text) {
  return NEG_RE.test(String(text || ''))
}

// 让模型判断这句话对"她"的态度，输出 JSON。
// 关键是**结合语境**：反讽、调情、吐槽都不该掉分，真攻击才掉。
async function judgeIntent(session, text) {
  try {
    const recent = await db('all',
      `SELECT role, content FROM ai_message
       WHERE chat_type = ? AND chat_id = ? ORDER BY id DESC LIMIT 4`,
      [session.chat_type, session.chat_id])
    const ctx = (recent.rows || [])
      .slice()
      .reverse()
      .map((m) => `${m.role === 'user' ? '对方' : '我'}：${String(m.content).slice(0, 60)}`)
      .join('\n')

    const prompt =
      `下面是一段聊天。判断最后一句"对方"的话是在对"我"（机器人）表达什么，只输出 JSON：\n` +
      `{"delta": -5 到 3 的整数, "intent": "调情/反讽/吐槽/玩笑/攻击/正常"}\n\n` +
      `规则：\n` +
      `- 调情、打情骂俏、反讽、玩梗、熟人吐槽 → delta 0 或正数\n` +
      `- 真的在骂人、羞辱、驱赶、恶意攻击 → delta 负数\n` +
      `- 拿不准就给 0\n\n` +
      `聊天记录：\n${ctx}\n对方：${String(text).slice(0, 200)}\n`

    const r = await host.capability('llm.chat', {
      messages: [{ role: 'user', content: prompt }],
    })
    if (!r?.ok) return null
    const m = String(r.data?.text || '').match(/\{[\s\S]*\}/)
    if (!m) return null
    const obj = JSON.parse(m[0])
    const delta = Math.max(-5, Math.min(3, Number(obj.delta) || 0))
    return { delta, intent: String(obj.intent || '') }
  } catch (e) {
    host.log('debug', '意图判断失败: ' + e.message)
    return null
  }
}

// 坏话掉分：每天有上限；主人不掉
async function maybePunish(session) {
  if (!settings.judge_enabled) return
  const uid = Number(session.user_id || 0)
  if (!uid || isMaster(uid)) return
  if (!suspicious(session.text)) return

  const key = `judge:${today()}`
  const used = Number(await host.storage.get(key)) || 0
  const cap = Number(settings.judge_max_per_day) || 10
  if (used >= cap) return
  await host.storage.set(key, used + 1)

  const verdict = await judgeIntent(session, session.text)
  if (!verdict || verdict.delta === 0) {
    host.log('info', `判断 user=${uid} intent=${verdict?.intent || '?'} delta=0（不扣）`)
    return
  }

  let delta = verdict.delta
  const row = await getRow(uid)
  const base = Number(settings.base_score ?? 30)
  // 基础分以下才允许明显掉；已经很低就不再踩
  if (delta < 0) {
    if (Number(row.score) <= base - 100) return
    const lossKey = `loss:${uid}:${today()}`
    const lost = Number(await host.storage.get(lossKey)) || 0
    const lossCap = Number(settings.daily_loss) || 5
    delta = -Math.min(Math.abs(delta), Math.max(0, lossCap - lost))
    if (delta === 0) return
    await host.storage.set(lossKey, lost + Math.abs(delta))
  }

  await addScore(uid, delta)
  host.log('info', `判断 user=${uid} intent=${verdict.intent} delta=${delta}`)
}

// 靠聊天涨好感：每人每天有上限，私聊另加// 靠聊天涨好感：每人每天有上限，私聊另加
async function gainFromChat(session) {
  const uid = Number(session.user_id || 0)
  if (!uid) return
  const daily = Number(settings.daily_gain) || 0
  const bonus = session.chat_type === 'private' ? Number(settings.private_bonus) || 0 : 0
  const cap = Math.max(0, daily + bonus)
  if (cap <= 0) return

  const key = `gain:${uid}:${today()}`
  const used = Number(await host.storage.get(key)) || 0
  if (used >= cap) return

  await addScore(uid, 1)
  await host.storage.set(key, used + 1)
}

serve({
  async initialize({ settings: s }) {
    settings = s || {}
    await ensureSchema()
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...values }
    return { ok: true }
  },

  async observe_message({ session }) {
    try {
      if (!settings.enabled) return {}
      if (session.has_prefix) return {}
      await ensureSchema()
      await gainFromChat(session)
      await maybePunish(session)
      return {}
    } catch (e) {
      host.log('debug', '好感度记录失败: ' + e.message)
      return {}
    }
  },

  async call_tool({ name, args }) {
    if (name === 'affinity.get') {
      const uid = Number(args?.user_id || 0)
      if (!uid) return { ok: false, error: '需要 user_id' }
      await ensureSchema()
      return { ok: true, data: payload(uid, await getRow(uid)) }
    }

    if (name === 'affinity.manage') {
      const action = String(args?.action || '')
      await ensureSchema()
      try {
        if (action === 'list' || action === 'top') {
          const rows = await topList(Number(args?.limit) || 20)
          return { ok: true, data: { users: rows.map((r) => payload(r.user_id, r)) } }
        }
        if (action === 'get') {
          const uid = Number(args?.user_id || 0)
          if (!uid) return { ok: false, error: '需要 user_id' }
          return { ok: true, data: payload(uid, await getRow(uid)) }
        }
        if (action === 'set') {
          const uid = Number(args?.user_id || 0)
          if (!uid) return { ok: false, error: '需要 user_id' }
          const score = await setScore(uid, Number(args?.score) || 0)
          return { ok: true, data: payload(uid, await getRow(uid)) }
        }
        if (action === 'add') {
          const uid = Number(args?.user_id || 0)
          if (!uid) return { ok: false, error: '需要 user_id' }
          await addScore(uid, Number(args?.delta) || 0)
          return { ok: true, data: payload(uid, await getRow(uid)) }
        }
        if (action === 'note' || action === 'relation') {
          const uid = Number(args?.user_id || 0)
          if (!uid) return { ok: false, error: '需要 user_id' }
          const note = String(args?.note ?? args?.relation ?? '').trim()
          await db('exec', `INSERT INTO affinity (user_id, score, note, updated) VALUES (?, 0, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET note = excluded.note, updated = excluded.updated`,
            [uid, note, Math.floor(Date.now() / 1000)])
          return { ok: true, data: payload(uid, await getRow(uid)) }
        }
        return { ok: false, error: `未知 action: ${action}` }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    }
    return { ok: false, error: '未知能力: ' + name }
  },

  async handle_message({ session }) {
    const text = (session.text || '').trim()
    if (!/^好感(\s|$)/.test(text)) return { handled: false }

    const reply = (m) => host.reply(chatOf(session), m)
    const rest = text.replace(/^好感\s*/, '').trim()
    const parts = rest.split(/\s+/)
    const sub = (parts[0] || '').toLowerCase()
    await ensureSchema()

    // /好感 榜
    if (sub === '榜' || sub === '排行' || sub === 'top') {
      const rows = await topList(Number(parts[1]) || 10)
      if (!rows.length) {
        await reply('还没有人上过榜')
        return { handled: true }
      }
      const lines = ['好感度排行：']
      rows.forEach((r, i) => {
        const p = payload(r.user_id, r)
        lines.push(`${i + 1}. ${r.user_id}　${p.score}　${p.level}`)
      })
      await reply(lines.join('\n'))
      return { handled: true }
    }

    // /好感 加|设 <QQ> <分值>  （管理员）
    if (sub === '加' || sub === '设') {
      if (!(session.role === 'owner' || session.role === 'admin')) {
        await reply('只有管理员能改好感度')
        return { handled: true }
      }
      const uid = Number(parts[1] || 0)
      const n = Number(parts[2] || 0)
      if (!uid || !Number.isFinite(n)) {
        await reply(`用法：/好感 ${sub} <QQ> <分值>`)
        return { handled: true }
      }
      if (sub === '设') await setScore(uid, n)
      else await addScore(uid, n)
      const p = payload(uid, await getRow(uid))
      await reply(`${uid} 现在是 ${p.score}（${p.level}）`)
      return { handled: true }
    }

    // /好感 [QQ]：默认看自己；群里 @ 了人就看那个人
    let target = Number(parts[0] || 0)
    if (!target) {
      const mentioned = Array.isArray(session.mentions) ? session.mentions : []
      target = Number(mentioned[0] || 0) || Number(session.user_id || 0)
    }
    const p = payload(target, await getRow(target))
    const you = target === Number(session.user_id) ? '你' : `${target}`
    await reply(`我对${you}的好感度：${p.score}（${p.level}·${p.title}）`)
    return { handled: true }
  },
})

function chatOf(session) {
  return {
    account: session.account || '',
    chat_type: session.chat_type || 'group',
    chat_id: session.chat_id || 0,
  }
}
