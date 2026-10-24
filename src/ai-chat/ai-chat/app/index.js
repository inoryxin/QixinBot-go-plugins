// AI 聊天插件 v2
//
// 记忆设计（关键）：
//   个人记忆 —— 按 user_id 存，跨群跨私聊连续。"这个人以前说过什么"
//   群上下文 —— 按 chat_id 存，这个群最近在聊什么
//   认人靠 QQ 号，昵称只是展示，换群改名不影响
//
// 人设分两种场景：group / private，各自独立
// 好感度走 affinity.get 能力，没装就跳过
import { serve, host, chatOf } from '../_sdk/qixin.mjs'

let settings = {}

const lastTrigger = new Map()

// ---------------------------------------------------------------- 懒初始化

let ready = false
let readyPromise = null

function ensureReady() {
  if (ready) return Promise.resolve()
  if (!readyPromise) {
    readyPromise = (async () => {
      await ensureSchema()
      await seedFallbackPersonas()
      ready = true
    })().catch((err) => {
      readyPromise = null
      throw err
    })
  }
  return readyPromise
}

async function db(op, sql, params = []) {
  const r = await host.capability('db.sqlite', { op, sql, params })
  if (!r?.ok) throw new Error(r?.error || 'db.sqlite 调用失败')
  return r.data
}

async function ensureSchema() {
  await db('exec', `
    CREATE TABLE IF NOT EXISTS ai_persona (
      name    TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      ts      INTEGER NOT NULL
    );

  CREATE TABLE IF NOT EXISTS ai_message (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_type TEXT    NOT NULL,
      chat_id   INTEGER NOT NULL,
      user_id   INTEGER NOT NULL,
      role      TEXT    NOT NULL,
      content   TEXT    NOT NULL,
      ts        INTEGER NOT NULL
    )`)

  // 按人查（跨会话）
  await db('exec', `CREATE INDEX IF NOT EXISTS idx_msg_user ON ai_message(user_id, id)`)
  // 按会话查
  await db('exec', `CREATE INDEX IF NOT EXISTS idx_msg_chat ON ai_message(chat_type, chat_id, id)`)

  // 记住每个人的最新昵称：换群改名也能对上号
  await db('exec', `
    CREATE TABLE IF NOT EXISTS ai_user (
      user_id   INTEGER PRIMARY KEY,
      nickname  TEXT,
      last_seen INTEGER NOT NULL
    )`)

  await db('exec', `
    CREATE TABLE IF NOT EXISTS ai_persona (
      name    TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      ts      INTEGER NOT NULL
    )`)

  await db('exec', `
    CREATE TABLE IF NOT EXISTS ai_slang_ban (
      chat_type TEXT NOT NULL,
      chat_id   INTEGER NOT NULL,
      term      TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      PRIMARY KEY (chat_type, chat_id, term)
    );

  CREATE TABLE IF NOT EXISTS ai_glossary (
      chat_type TEXT NOT NULL,
      chat_id   INTEGER NOT NULL,
      term      TEXT NOT NULL,
      meaning   TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      PRIMARY KEY (chat_type, chat_id, term)
    );

  CREATE TABLE IF NOT EXISTS ai_knowledge (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      content TEXT NOT NULL,
      ts      INTEGER NOT NULL
    )`)
}



// ---------------------------------------------------------------- 记忆

function now() {
  return Math.floor(Date.now() / 1000)
}

async function remember(session, role, content) {
  const uid = role === 'user' ? session.user_id : session.self_id || 0
  await db('exec',
    `INSERT INTO ai_message (chat_type, chat_id, user_id, role, content, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [session.chat_type, session.chat_id, uid, role, content, now()],
  )

  // 更新昵称表（只对真实用户）
  if (role === 'user' && session.user_id) {
    await db('exec',
      `INSERT INTO ai_user (user_id, nickname, last_seen) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET nickname = excluded.nickname, last_seen = excluded.last_seen`,
      [session.user_id, session.nickname || '', now()],
    )
  }

  // 个人记忆上限：这个 QQ 的全部消息只留最近 N 条（跨会话）
  if (role === 'user' && session.user_id) {
    const cap = Math.max(50, Math.min(5000, Number(settings.personal_memory) || 500))
    await db('exec',
      `DELETE FROM ai_message
       WHERE role = 'user' AND user_id = ? AND id NOT IN (
         SELECT id FROM ai_message WHERE role = 'user' AND user_id = ?
         ORDER BY id DESC LIMIT ?
       )`,
      [session.user_id, session.user_id, cap])
  }

  // 按群滚动清理
  const limit = Math.max(50, Number(settings.memory_limit) || 1000)
  await db('exec',
    `DELETE FROM ai_message
     WHERE chat_type = ? AND chat_id = ?
       AND id NOT IN (
         SELECT id FROM ai_message WHERE chat_type = ? AND chat_id = ?
         ORDER BY id DESC LIMIT ?
       )`,
    [session.chat_type, session.chat_id, session.chat_type, session.chat_id, limit],
  )
}

// 个人记忆：这个 QQ 号说过的话（跨群跨私聊）
// 个人记忆 = 这个 QQ 在**别的会话**里说过的话。
// 跟 QQ 走，不跟群走：群里聊过的，私聊能接着聊。
async function personalHistory(userID, limit, exclude = {}) {
  if (!userID || limit <= 0) return []
  const r = await db('all',
    `SELECT content, ts, chat_type, chat_id FROM ai_message
     WHERE user_id = ? AND role = 'user'
       AND NOT (chat_type = ? AND chat_id = ?)
     ORDER BY id DESC LIMIT ?`,
    [userID, exclude.chat_type || '', exclude.chat_id || 0, limit],
  )
  return (r.rows || []).reverse()
}

// 群上下文：这个会话最近的消息（所有人）
async function chatHistory(chatType, chatID, limit) {
  const r = await db('all',
    `SELECT user_id, role, content FROM ai_message
     WHERE chat_type = ? AND chat_id = ?
     ORDER BY id DESC LIMIT ?`,
    [chatType, chatID, limit],
  )
  return (r.rows || []).reverse()
}

// 批量拿昵称，避免逐条查
async function nicknamesOf(userIDs) {
  const ids = [...new Set(userIDs.filter((x) => x && x > 0))]
  if (!ids.length) return new Map()
  const placeholders = ids.map(() => '?').join(',')
  const r = await db('all',
    `SELECT user_id, nickname FROM ai_user WHERE user_id IN (${placeholders})`,
    ids,
  )
  const map = new Map()
  for (const row of r.rows || []) map.set(row.user_id, row.nickname || '')
  return map
}

function scopeOf(chatType) {
  return chatType === 'private' ? 'private' : 'group'
}



// ---------------------------------------------------------------- 兜底人设
// 装了 ai-persona 插件时，人设由它管，这里全部让位；
// 没装的时候，ai-chat 自己也能设人设（老版本行为）。

const FALLBACK_PERSONAS = {
  群聊: '在群里聊天，说话简短自然，不抢话，偶尔接梗。一般一两句就够。',
  私聊: '和熟人私聊，语气更放松亲近，可以多说几句，会关心对方。',
}

// personaPluginReady 缓存：人设插件在不在（每进程只测一次）
let personaPluginFound = null
async function hasPersonaPlugin() {
  if (personaPluginFound !== null) return personaPluginFound
  try {
    const r = await host.capability('persona.render', { chat_type: 'group' })
    personaPluginFound = !!(r && r.ok)
  } catch {
    personaPluginFound = false
  }
  return personaPluginFound
}

async function seedFallbackPersonas() {
  for (const [name, content] of Object.entries(FALLBACK_PERSONAS)) {
    await db('exec',
      `INSERT INTO ai_persona (name, content, ts) VALUES (?, ?, ?)
       ON CONFLICT(name) DO NOTHING`, [name, content, now()])
  }
}

async function savePersona(name, content) {
  await db('exec',
    `INSERT INTO ai_persona (name, content, ts) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET content = excluded.content, ts = excluded.ts`,
    [name, content, now()])
}

async function getPersona(name) {
  const r = await db('get', `SELECT name, content FROM ai_persona WHERE name = ?`, [name])
  return r.row || null
}

async function listPersonas() {
  const r = await db('all', `SELECT name, content FROM ai_persona ORDER BY name`)
  return r.rows || []
}

async function currentPersonaFor(chatType) {
  const scope = chatType === 'private' ? 'private' : 'group'
  const name = (await host.sharedGet('ai-chat.persona_' + scope)) ||
    (scope === 'private' ? '私聊' : '群聊')
  const p = await getPersona(name)
  return { scope, name: p?.name || name, content: p?.content || '' }
}

async function personaCommand(session, text) {
  const reply = (m) => host.reply(chatOf(session), m)
  const rest = text.replace(/^人设\s*/, '').trim()
  const parts = rest.split(/\s+/)
  const sub = (parts[0] || '').toLowerCase()
  const scope = session.chat_type === 'private' ? 'private' : 'group'
  const scopeName = scope === 'private' ? '私聊' : '本群'

  if (!sub || sub === '看' || sub === '当前' || sub === '列表') {
    const cur = await currentPersonaFor(session.chat_type)
    const list = await listPersonas()
    const lines = [`${scopeName}当前人设：「${cur.name}」`]
    if (cur.content) lines.push(cur.content)
    lines.push('', `全部人设（${list.length}）：`)
    for (const p of list) lines.push(`· ${p.name}${p.name === cur.name ? '  ← 当前' : ''}`)
    lines.push('', '切换：/人设 切换 <名字>', '新建/修改：/人设 新建 <名字> <描述>')
    await reply(lines.join('\n'))
    return
  }

  if (sub === '切换' || sub === '用' || sub === '切') {
    const name = rest.slice(sub.length).trim()
    if (!name) return reply('用法：/人设 切换 <名字>（先 /人设 看名单）')
    const p = await getPersona(name)
    if (!p) {
      const names = (await listPersonas()).map((x) => x.name).join('、')
      return reply(`没有人设「${name}」\n现有：${names}`)
    }
    await host.sharedSet('ai-chat.persona_' + scope, name)
    await reply(`${scopeName}已切换到「${name}」`)
    return
  }

  if (sub === '新建' || sub === '改' || sub === '修改') {
    const body = rest.slice(sub.length).trim()
    const sp = body.search(/\s/)
    const name = sp < 0 ? body : body.slice(0, sp)
    const content = sp < 0 ? '' : body.slice(sp + 1).trim()
    if (!name) return reply('用法：/人设 新建 <名字> <描述>')
    const existed = await getPersona(name)
    if (!content) {
      if (!existed) return reply(`人设「${name}」不存在，新建要带描述：/人设 新建 ${name} <描述>`)
      return reply(`「${name}」当前描述：\n${existed.content}\n\n要改就：/人设 新建 ${name} <新描述>`)
    }
    await savePersona(name, content)
    await reply(existed ? `人设「${name}」已更新` : `人设「${name}」已创建（用 /人设 切换 ${name} 启用）`)
    return
  }

  if (sub === '删除' || sub === '删') {
    const name = rest.slice(sub.length).trim()
    if (!name) return reply('用法：/人设 删除 <名字>')
    const existed = await getPersona(name)
    if (!existed) return reply(`没有人设「${name}」`)
    if (FALLBACK_PERSONAS[name]) return reply('内置人设不能删（可以改内容）')
    await db('exec', `DELETE FROM ai_persona WHERE name = ?`, [name])
    for (const sc of ['group', 'private']) {
      const cur = await currentPersonaFor(sc)
      if (cur.name === name) await host.sharedSet('ai-chat.persona_' + sc, sc === 'private' ? '私聊' : '群聊')
    }
    await reply(`人设「${name}」已删除`)
    return
  }

  await reply('可用：/人设 看 · /人设 切换 <名字> · /人设 新建 <名字> <描述> · /人设 删除 <名字>')
}

// 按相关度召回个人记忆。
//
// 先拿最近 base 条保证"记得住近况"，再用当前消息里的词去匹配历史，
// 匹配到就多带（最多 maxN 条）。不调模型，纯 SQL。
async function recallPersonal(session, text, base, maxN) {
  const exclude = { chat_type: session.chat_type, chat_id: session.chat_id }
  const seen = new Set()
  const out = []

  const push = (rows) => {
    for (const r of rows || []) {
      if (out.length >= maxN) return
      if (seen.has(r.content)) continue
      seen.add(r.content)
      out.push(r)
    }
  }

  if (base > 0) {
    push(await personalHistory(session.user_id, base, exclude))
  }

  const words = []
  const clean = String(text || '').replace(/[^\p{Script=Han}a-zA-Z0-9]/gu, ' ').trim()
  for (const w of clean.split(/\s+/)) {
    if (!w) continue
    if (/^[a-zA-Z0-9]+$/.test(w)) {
      if (w.length >= 2) words.push(w)
    } else {
      for (let i = 0; i + 1 < w.length && words.length < 6; i += 2) words.push(w.slice(i, i + 2))
      if (w.length >= 2) words.push(w)
    }
  }

  if (words.length && session.user_id) {
    const uniq = [...new Set(words)].slice(0, 6)
    const cond = uniq.map(() => 'content LIKE ?').join(' OR ')
    const r = await db('all',
      `SELECT content, ts, chat_type, chat_id FROM ai_message
       WHERE user_id = ? AND role = 'user'
         AND NOT (chat_type = ? AND chat_id = ?)
         AND (${cond})
       ORDER BY id DESC LIMIT ?`,
      [session.user_id, exclude.chat_type, exclude.chat_id, ...uniq.map((w) => `%${w}%`), maxN])
    push(r.rows)
  }

  return out
}

// 用模型描述一张图（私聊记忆用）。失败返回空串，不阻塞记忆。
async function describeImage(url) {
  try {
    const dataURL = await toDataURL(url)
    const r = await host.capability('llm.chat', {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '用一句话客观描述这张图（是谁/在做什么/什么东西）。不要评价，不要寒暄。' },
          { type: 'image_url', image_url: { url: dataURL } },
        ],
      }],
    })
    if (!r?.ok) return ''
    return String(r.data?.text || '').trim().slice(0, 120)
  } catch (e) {
    host.log('debug', '识图失败: ' + e.message)
    return ''
  }
}

// ---------------------------------------------------------------- 知识库

async function searchKnowledge(text) {
  const words = (text || '')
    .split(/[\s,，。.!！?？、]/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
    .slice(0, 5)
  if (!words.length) return []

  const hits = []
  for (const w of words) {
    const r = await db('all', `SELECT keyword, content FROM ai_knowledge WHERE keyword LIKE ? LIMIT 2`, [`%${w}%`])
    for (const row of r.rows || []) {
      if (!hits.find((h) => h.keyword === row.keyword)) hits.push(row)
    }
  }
  return hits.slice(0, 3)
}

// ---------------------------------------------------------------- 好感度

// 可选能力探测：插件没装/调用失败都返回 null，绝不影响主流程。
async function optionalCapability(name, args = {}) {
  try {
    const r = await host.capability(name, args)
    if (!r || r.ok === false) return null
    return r.data ?? null
  } catch {
    return null
  }
}

// 可选依赖：好感度插件装了就用，没装返回 null
async function affinityOf(userID) {
  if (!settings.use_affinity || !userID) return null
  try {
    const r = await host.capability('affinity.get', { user_id: userID })
    if (!r?.ok) return null
    return r.data || null
  } catch {
    return null
  }
}

// ---- 屏蔽：删掉自动学到但不想要的词 ----
// 自动统计是算出来的，没法"删除"，所以用屏蔽表：
// 统计和 prompt 里都跳过这些词。人工词条（ai_glossary）另算。

async function bannedSet(chatType, chatID) {
  const r = await db(
    'all',
    `SELECT term FROM ai_slang_ban WHERE chat_type = ? AND chat_id = ?`,
    [chatType, chatID],
  )
  return new Set((r.rows || []).map((x) => x.term))
}

async function banTerm(chatType, chatID, term) {
  await db(
    'exec',
    `INSERT INTO ai_slang_ban (chat_type, chat_id, term, ts) VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_type, chat_id, term) DO NOTHING`,
    [chatType, chatID, term, now()],
  )
}

async function unbanTerm(chatType, chatID, term) {
  const r = await db(
    'exec',
    `DELETE FROM ai_slang_ban WHERE chat_type = ? AND chat_id = ? AND term = ?`,
    [chatType, chatID, term],
  )
  return r.affected > 0
}

// 哪些群有语料（给面板选）
async function learnGroups(limit = 50) {
  const r = await db(
    'all',
    // 只统计"能学的"：空内容和 [图片] 不算，不然下拉显示 61 条、
    // 下面统计却说 30 条，对不上。
    `SELECT chat_type, chat_id,
            SUM(content <> '' AND content <> '[图片]') AS n
     FROM ai_message WHERE role = 'user'
     GROUP BY chat_type, chat_id
     HAVING n > 0
     ORDER BY n DESC LIMIT ?`,
    [limit],
  )
  return r.rows || []
}

// ---- 面板用的统计 ----
async function learnStats(chatType, chatID) {
  const group = await groupStyle(chatType, chatID, 200, true) // 带屏蔽词，供面板展示/恢复
  const gl = await glossaryList(chatType, chatID)
  const banned = await bannedSet(chatType, chatID)
  return {
    group: group ? { ...group, banned: [...banned] } : null,
    glossary: gl,
    banned: [...banned],
  }
}

// ---------------------------------------------------------------- 语气 / 黑话命令

// /语气            我和这个群学到了什么
// /黑话            群里的高频词 + 已录入的含义
// /黑话 加 词 含义  教一个（管理员）
// /黑话 删 词      删一个（管理员）
async function styleCommand(session, text) {
  const reply = (m) => host.reply(chatOf(session), m)
  const [head, ...tail] = text.trim().split(/\s+/)
  const group = await groupStyle(session.chat_type, session.chat_id)
  const user = await userStyle(session.user_id)

  if (head === '语气') {
    if (!group && !user) return reply('消息还太少，等群里多聊几句我就能总结出风格了。')
    const lines = []
    if (group) {
      lines.push(`本群近 ${group.n} 条消息：`)
      lines.push(`· 平均 ${group.avg_len} 字${group.avg_len <= 8 ? '（挺短）' : ''}`)
      if (group.emoji_rate > 0.05) lines.push(`· ${Math.round(group.emoji_rate * 100)}% 的消息带表情`)
      if (group.particle_rate > 0.05) lines.push(`· ${Math.round(group.particle_rate * 100)}% 带语气词`)
      if (group.slang.length) lines.push(`· 常见词：${group.slang.slice(0, 6).join('、')}`)
    }
    if (user) {
      lines.push('', `你最近 ${user.n} 条：平均 ${user.avg_len} 字${user.emoji_rate > 0.3 ? '，爱发表情' : ''}`)
    }
    lines.push('', '想教我群黑话：/黑话 加 <词> <含义>')
    await reply(lines.join('\n'))
    return
  }

  // 黑话
  const sub = tail[0] || ''
  if (sub === '加' || sub === '添加') {
    const body = tail.slice(1).join(' ').trim()
    const sp = body.search(/\s/)
    const term = sp < 0 ? body : body.slice(0, sp)
    const meaning = sp < 0 ? '' : body.slice(sp + 1).trim()
    if (!term || !meaning) return reply('用法：/黑话 加 <词> <含义>\n例如：/黑话 加 草 表示好笑或无语')
    await glossarySave(session.chat_type, session.chat_id, term, meaning)
    await reply(`记住了：「${term}」= ${meaning}`)
    return
  }
  if (sub === '屏蔽') {
    const term = tail.slice(1).join(' ').trim()
    if (!term) return reply('用法：/黑话 屏蔽 <词>\n（屏蔽自动统计出来的词，不再出现在统计里）')
    await banTerm(session.chat_type, session.chat_id, term)
    return reply(`已屏蔽「${term}」，以后不会出现在学到的词里（/黑话 恢复 ${term} 可以撤回）`)
  }
  if (sub === '恢复') {
    const term = tail.slice(1).join(' ').trim()
    if (!term) return reply('用法：/黑话 恢复 <词>')
    const ok = await unbanTerm(session.chat_type, session.chat_id, term)
    return reply(ok ? `已恢复「${term}」` : `「${term}」本来就没被屏蔽`)
  }
  if (sub === '删' || sub === '删除') {
    const term = tail.slice(1).join(' ').trim()
    if (!term) return reply('用法：/黑话 删 <词>')
    const ok = await glossaryDelete(session.chat_type, session.chat_id, term)
    await reply(ok ? `已删掉「${term}」` : `没有「${term}」这个词条`)
    return
  }

  const gl = await glossaryList(session.chat_type, session.chat_id)
  const lines = []
  if (group?.slang.length) {
    lines.push(`本群高频词（自动统计，共 ${group.slang.length}）：`)
    lines.push('· ' + group.slang.join('、'))
  } else {
    lines.push('还没统计出高频词（消息太少）。')
  }
  lines.push('')
  if (gl.length) {
    lines.push(`已录入含义（${gl.length}）：`)
    for (const g of gl) lines.push(`· ${g.term} = ${g.meaning}`)
  } else {
    lines.push('还没有录入过含义。教我一个：/黑话 加 <词> <含义>')
  }
  await reply(lines.join('\n'))
}

// ---------------------------------------------------------------- 语气 / 黑话

// 从群聊里学"怎么说话"：平均长度、表情频率、语气词、高频词组。
//
// 为什么按群而不是按人：群黑话是群体现象（"草""确实""乐"），
// 单个人的习惯只是其中一部分。用最近 200 条消息统计，够新也能反映群体。

const STOP_WORDS = new Set([
  '什么', '这个', '那个', '我们', '你们', '他们', '她们', '然后', '就是', '因为', '所以',
  '但是', '可以', '没有', '不是', '一个', '现在', '时候', '知道', '觉得', '自己', '还是',
  '已经', '不过', '而且', '如果', '这样', '那样', '怎么', '为什么', '东西', '事情', '真的',
  '有点', '一点', '一下', '感觉', '应该', '可能', '需要', '看看', '时候', '今天', '明天',
])

// 单字黑话要排除的高频字（"的""了""是"这种，单独统计没意义）
const STOP_CHARS = new Set('的了是我你他她它们这那在有就都又还很吧啊呢吗嘛哦呀么和与或但所以在个上中下不没要会能对好也可别让人来去到说看想让给被把')

const PARTICLE_RE = /[啊啦嘛哦呀吧呢欸诶]/g
const EMOJI_RE = /\p{Extended_Pictographic}/u

// 只留中文/字母/数字，去掉标点、表情、链接——n-gram 统计才干净
function cleanText(t) {
  return String(t || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\[[^\]]{1,10}\]/g, ' ')   // [图片] [表情] 这类占位
    .replace(/[^\p{Script=Han}a-zA-Z0-9]/gu, '')
}

// 群黑话 = **反复出现的短句**。
//
// 为什么不用 n-gram：中文没分词，"怎么/什么/学校长"会被切成
// 「怎」「什」「校长」这种碎片，统计出来全是噪音（用户原话："学的什么玩意"）。
//
// 改成：只看长度 ≤8 的短消息，整句计数，出现 ≥2 次才算。
// 群里的黑话本来就是这样——"草""确实""笑死""离谱"。
const SLANG_SINGLE = new Set('草靠淦乐笑哈6')

function topPhrases(texts, limit = 8) {
  const counts = new Map()
  const where = new Map() // 词 → 出现在第几条，用于"至少两条不同消息"
  texts.forEach((raw, idx) => {
    const s = cleanText(raw)
    if (!s) return
    const n = [...s].length
    if (n > 8) return // 长消息里的词不算黑话，那是正常聊天
    if (n === 1 && !SLANG_SINGLE.has(s)) return // 单字只认语气/梗字
    if (STOP_WORDS.has(s)) return
    counts.set(s, (counts.get(s) || 0) + 1)
    if (!where.has(s)) where.set(s, new Set())
    where.get(s).add(idx)
  })

  const repeated = [...counts]
    .filter(([w, c]) => c >= 2 && (where.get(w)?.size || 0) >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .map(([w]) => w)

  // 再补一层：常见网络用语只要在这个群出现 ≥2 次就算（中文没法分词，
  // 但"草/笑死/离谱/破防"这些是有确定写法的，用词表识别比切词可靠得多）
  for (const w of COMMON_SLANG) {
    if (repeated.includes(w)) continue
    const n = texts.reduce((acc, t) => acc + (String(t).includes(w) ? 1 : 0), 0)
    if (n >= 2) repeated.push(w)
  }

  return repeated.slice(0, limit)
}

// 常见网络用语（不需要分词就能识别的）
const COMMON_SLANG = [
  '草', '靠', '淦', '笑死', '离谱', '确实', '绝了', '牛逼', '绷不住', '破防',
  '麻了', '摆烂', '抽象', '社死', '好家伙', '逆天', '真香', '无语', '急了', '典',
  '寄', '润', '卷', '躺平', '干饭', '摸鱼', '乐子', '难绷', '笑不活了', '尊嘟',
  '哒咩', '栓Q', '家人们', '谁懂啊', '我哭死', '狠狠', '开摆', '啊对对对', '贴贴',
  '乐', '哈', '6', '拉了', '稳', '秀', '离谱他妈',
]

async function groupStyle(chatType, chatID, limit = 200, keepBanned = false) {
  const r = await db(
    'all',
    `SELECT content FROM ai_message
     WHERE chat_type = ? AND chat_id = ? AND role = 'user'
     ORDER BY id DESC LIMIT ?`,
    [chatType, chatID, limit],
  )
  const rows = r.rows || []
  const texts = rows.map((x) => String(x.content || '')).filter((t) => t && t !== '[图片]')
  if (texts.length < 10) return null

  let len = 0
  let emoji = 0
  let particle = 0
  let bang = 0
  for (const t of texts) {
    len += [...t].length
    if (EMOJI_RE.test(t)) emoji++
    if (PARTICLE_RE.test(t)) particle++
    if (/[!！]{1,}/.test(t)) bang++
    PARTICLE_RE.lastIndex = 0
  }
  const n = texts.length
  const all = topPhrases(texts, 30)
  const banned = await bannedSet(chatType, chatID)
  const slang = all.filter((w) => !banned.has(w))

  const out = {
    n,
    avg_len: Math.round(len / n),
    emoji_rate: emoji / n,
    particle_rate: particle / n,
    bang_rate: bang / n,
    slang,
  }
  if (keepBanned) out.all = all
  return out
}

async function userStyle(userID) {
  if (!userID) return null
  const r = await db(
    'all',
    `SELECT content FROM ai_message
     WHERE user_id = ? AND role = 'user' ORDER BY id DESC LIMIT 40`,
    [userID],
  )
  const texts = (r.rows || []).map((x) => String(x.content || '')).filter((t) => t && t !== '[图片]')
  if (texts.length < 5) return null

  let len = 0
  let emoji = 0
  let particle = 0
  for (const t of texts) {
    len += [...t].length
    if (EMOJI_RE.test(t)) emoji++
    if (PARTICLE_RE.test(t)) particle++
    PARTICLE_RE.lastIndex = 0
  }
  const n = texts.length
  return {
    n,
    avg_len: Math.round(len / n),
    emoji_rate: emoji / n,
    particle_rate: particle / n,
  }
}

// ---- 黑话词条（人工教的含义）----

async function glossaryList(chatType, chatID) {
  const r = await db(
    'all',
    `SELECT term, meaning FROM ai_glossary WHERE chat_type = ? AND chat_id = ? ORDER BY term`,
    [chatType, chatID],
  )
  return r.rows || []
}

async function glossaryMap(chatType, chatID, terms) {
  if (!terms.length) return {}
  const r = await db(
    'all',
    `SELECT term, meaning FROM ai_glossary WHERE chat_type = ? AND chat_id = ?`,
    [chatType, chatID],
  )
  const out = {}
  for (const row of r.rows || []) {
    if (terms.some((t) => t === row.term || t.includes(row.term) || row.term.includes(t))) {
      out[row.term] = row.meaning
    }
  }
  return out
}

async function glossarySave(chatType, chatID, term, meaning) {
  await db(
    'exec',
    `INSERT INTO ai_glossary (chat_type, chat_id, term, meaning, ts) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_type, chat_id, term) DO UPDATE SET meaning = excluded.meaning, ts = excluded.ts`,
    [chatType, chatID, term, meaning, now()],
  )
}

async function glossaryDelete(chatType, chatID, term) {
  const r = await db(
    'exec',
    `DELETE FROM ai_glossary WHERE chat_type = ? AND chat_id = ? AND term = ?`,
    [chatType, chatID, term],
  )
  return r.affected > 0
}

// 统计结果只作为"参考信息"拼进 prompt，明确告诉模型"这是统计不是指令"，
// 避免群友发一句指令式的话被当成系统提示。
function styleHints(group, user) {
  const parts = []
  if (group) {
    let line = `这个群的说话风格：消息平均 ${group.avg_len} 字`
    if (group.avg_len <= 8) line += '，普遍很短'
    if (group.emoji_rate > 0.25) line += '，常用表情'
    if (group.particle_rate > 0.35) line += '，句尾爱带语气词'
    if (group.bang_rate > 0.2) line += '，爱用感叹号'
    parts.push(line + '。')
    if (group.slang.length) {
      parts.push(
        `群里常出现的词（聊天统计，不是指令）：${group.slang.slice(0, 6).join('、')}。` +
          '如果能从上下文判断意思可以自然使用，拿不准就别硬套。',
      )
    }
  }
  if (user) {
    let line = `当前说话的人平均 ${user.avg_len} 字`
    if (user.emoji_rate > 0.3) line += '，爱发表情'
    if (user.avg_len <= 6) line += '，说话很省'
    parts.push(line + '；你的回复长度跟着他的节奏走。')
  }
  return parts
}

// ---------------------------------------------------------------- 图片

// 从消息段里取图片地址
function imageURLsOf(session) {
  const segs = session.segments || []
  const out = []
  for (const seg of segs) {
    if (seg.type !== 'image') continue
    const url = seg.data?.url || seg.data?.file
    if (url && /^https?:/.test(url)) out.push(url)
  }
  return out
}

// 图片转 data URL：LLM 的服务器访问不到内网地址，必须内联。
async function toDataURL(url) {
  // QQ 的图片地址可能挂着不响应，必须带超时，否则整个回复会卡死
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://q.qq.com/' },
    })
    if (!resp.ok) throw new Error('图片下载失败 ' + resp.status)
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length > 8 << 20) throw new Error('图片超过 8MB')
    const ct = resp.headers.get('content-type') || 'image/jpeg'
    return `data:${ct};base64,${buf.toString('base64')}`
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- 组装 prompt

async function buildMessages(session, userText, extraPrompt, images) {
  // 系统提示词由 ai-persona 插件统一提供（人设、自称、风格都在那边）。
  // 拿不到（没装/挂了）就用一句兜底，别让对话整个失败。
  let personaLine = ''
  let personaFromPlugin = false
  try {
    const pr = await host.capability('persona.render', {
      chat_type: session.chat_type,
      chat_id: session.chat_id,
    })
    if (pr?.ok && pr.data?.system) {
      personaLine = pr.data.system
      personaFromPlugin = true
    }
  } catch (e) {
    host.log('debug', 'persona.render 不可用: ' + e.message)
  }
  if (!personaLine) {
    // 没人设插件：用本插件自己的设置 + 内置人设，保证"能设人设"
    const cur = await currentPersonaFor(session.chat_type)
    const own = [settings.system_prompt || '你是一个群聊里的朋友，说话自然简短。']
    if (settings.bot_name) own.push(`你的名字是「${settings.bot_name}」。`)
    if (cur.content) own.push(`当前人设「${cur.name}」：${cur.content}`)
    if (settings.speaking_style) own.push(`说话风格：${settings.speaking_style}`)
    personaLine = own.join('\n')
  }
  const parts = [personaLine]

  // 好感度：影响语气
  if (session.user_id) {
    const aff = await affinityOf(session.user_id)
    if (aff) {
      const score = typeof aff.score === 'number' ? aff.score : aff.affinity
      const level = aff.level || aff.title
      if (score !== undefined) {
        parts.push(`你对当前说话的人好感度是 ${score}${level ? `（${level}）` : ''}，据此调整语气。`)
        host.log('debug', `好感度 user=${session.user_id} score=${score} level=${level || '-'}`)
      }
    }
  }

  // 群语气 / 黑话：**人设插件在场时由它拼**（它拿得到同一份数据），
  // 这里只在没有插件时兜底，避免同一段提示词出现两次。
  try {
    if (!personaFromPlugin) {
      const gs = await groupStyle(session.chat_type, session.chat_id)
    const us = await userStyle(session.user_id)
    const hints = styleHints(gs, us)
    if (hints.length) parts.push(...hints)

    // 已录入含义的黑话：只挑这次对话里出现过的，别整本塞进去
    const recent = [userText || ''].concat(gs?.slang || []).join(' ')
    const gl = await glossaryMap(session.chat_type, session.chat_id, gs?.slang || [])
    const known = Object.entries(gl)
    if (known.length) {
      const used = known.filter(([term]) => recent.includes(term))
      if (used.length) {
        parts.push('群黑话约定：' + used.map(([t, m]) => `${t} = ${m}`).join('；') + '。')
      }
    }
    }
  } catch (e) {
    host.log('debug', '语气统计跳过: ' + e.message)
  }

  // 聊天风格：真人聊天很少打句号，短句、用空格隔开
  parts.push('回复像手机聊天：短句，尽量别用句号，用空格或换行断开，别写成文章。')

  // 她的生活：让回复带上"此刻在干嘛"（装了就生效，没装不影响）
  const life = await optionalCapability('life.now')
  host.log('debug', 'buildMessages life=' + (life?.text || '无'))
  if (life && life.text) {
    parts.push(`你此刻的状态：${life.text}。回复必须符合这个状态——在忙就短一点，睡着被叫醒就迷糊一点。`)
  }

  // 时间感：让话题符合时段（中午聊吃啥、晚上聊下班，别半夜问午饭）
  parts.push(timeHint())

  if (extraPrompt) parts.push(extraPrompt)

  if (userText) {
    const kb = await searchKnowledge(userText)
    if (kb.length) {
      parts.push('参考知识：\n' + kb.map((k) => `- ${k.keyword}: ${k.content}`).join('\n'))
    }
  }

  parts.push('回复要短，一般一两句。不要用 Markdown 列表和标题。')

  const messages = [{ role: 'system', content: parts.join('\n') }]

  // ① 个人记忆：这个人以前说过什么（跨群）
  // 动态召回：平常只带几条；聊到相关话题（提到人名/事物）才多带。
  // 固定带 10 条的话，闲聊每轮都在为无关记忆付 token。
  const base = Math.max(0, Math.min(10, Number(settings.memory_base) || 3))
  const maxN = Math.max(base, Math.min(30, Number(settings.memory_max) || 15))
  const personal = await recallPersonal(session, userText, base, maxN)
  host.log('debug', `记忆召回 n=${personal.length} base=${base} max=${maxN}`)
  if (personal.length) {
    const lines = personal
      .map((m) => `- [${m.chat_type === 'private' ? '私聊' : '群'}] ${m.content.replace(/\n/g, ' ')}`)
      .join('\n')
    messages.push({
      role: 'system',
      content:
        `关于当前说话的人（同一个 QQ，可能来自别的群/私聊），他最近说过：\n${lines}\n` +
        '如果聊到相关话题可以自然接上，但别主动抖机灵复述。',
    })
  }

  // ② 群上下文：最近这段对话
  // 群里只带最近 N 条（默认 20）：带整段历史既费 token 又容易跑题
  const ctxSize = Math.max(4, Math.min(50, Number(settings.context_size) || 20))
  const history = await chatHistory(session.chat_type, session.chat_id, ctxSize)
  const names = await nicknamesOf(history.map((m) => m.user_id))

  for (const m of history) {
    // 群里的纯图片占位不进上下文：占 token 又提供不了信息
    // （私聊的图片会存描述，不会走到这里）
    if (session.chat_type !== 'private' && m.role === 'user' && m.content === '[图片]') continue

    if (m.role === 'assistant') {
      messages.push({ role: 'assistant', content: m.content })
    } else {
      const who = names.get(m.user_id) || String(m.user_id)
      messages.push({ role: 'user', content: `${who}: ${m.content}` })
    }
  }

  // 当前这句：有图就用多模态格式
  if (userText || (images && images.length)) {
    const who = session.nickname || String(session.user_id)
    const last = history[history.length - 1]
    // 空文本不能拿来判重（图片消息 text 就是空的），否则整块被跳过、图片也丢了
    const duplicate = !!userText && last && last.content === userText
    if (!duplicate) {
      if (images && images.length) {
        const parts = []
        if (userText) parts.push({ type: 'text', text: `${who}: ${userText}` })
        for (const url of images) {
          try {
            parts.push({ type: 'image_url', image_url: { url: await toDataURL(url) } })
          } catch (err) {
            host.log('warn', '图片处理失败: ' + err.message)
            parts.push({ type: 'text', text: `（${who} 发了一张图片，但没能加载）` })
          }
        }
        messages.push({ role: 'user', content: parts })
      } else {
        messages.push({ role: 'user', content: `${who}: ${userText}` })
      }
    }
  }

  return messages
}

// ---------------------------------------------------------------- LLM

async function askLLM(messages, tools) {
  const args = { messages }
  if (tools && tools.length) args.tools = tools
  const r = await host.capability('llm.chat', args)
  if (!r?.ok) return { ok: false, error: r?.error || 'LLM 调用失败' }
  return {
    ok: true,
    text: String(r.data?.text || '').trim(),
    toolCalls: Array.isArray(r.data?.tool_calls) ? r.data.tool_calls : [],
  }
}

// 把宿主声明的工具转成 OpenAI 的 function 格式
async function loadToolDefs(session) {
  try {
    const tools = await host.listTools(session)
    return (tools || []).map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
      },
    }))
  } catch {
    return []
  }
}

// 执行一次工具调用
async function runToolCall(call, session) {
  const name = call?.function?.name
  let args = {}
  try {
    args = JSON.parse(call?.function?.arguments || '{}')
  } catch {
    return { ok: false, text: '参数不是合法 JSON' }
  }
  try {
    // 工具走 host.callTool，不是 host.capability —— 两条不同的通道
    const r = await host.callTool(name, args, session || null)
    if (r?.ok) {
      const text = r.data?.text ?? JSON.stringify(r.data ?? '')
      return { ok: true, text: String(text) }
    }
    return { ok: false, text: r?.error || '工具执行失败' }
  } catch (err) {
    return { ok: false, text: err.message }
  }
}

// ---------------------------------------------------------------- 触发

function shouldTrigger(session) {
  const text = (session.text || '').trim()
  // 纯图片消息 text 是空的，但仍然是消息，不能在这里被丢掉
  const hasImage = imageURLsOf(session).length > 0
  if (!text && !hasImage) return false
  // 私聊：每条都回
  if (session.chat_type === 'private') return true

  // 被 @：按设置必回（和"随机插话"互不排斥）
  if (session.mentioned) return settings.reply_on_mention !== false

  // 没 @ 的群聊：随机插话（0 = 不插话）
  const chance = Math.max(0, Math.min(100,
    Number(settings.group_chance_pct ?? settings.trigger_prob) || 0))
  if (chance <= 0) return false

  const key = session.chat_type + ':' + session.chat_id
  const cd = Math.max(0, Number(settings.cooldown) || 0) * 1000
  if (cd > 0 && lastTrigger.has(key) && Date.now() - lastTrigger.get(key) < cd) return false

  return Math.random() * 100 < chance
}

// ---------------------------------------------------------------- 回复

// ---------------------------------------------------------------- 记忆管理

async function memoryGroups() {
  const r = await db('all',
    `SELECT chat_type, chat_id, COUNT(*) AS n, MAX(ts) AS last
     FROM ai_message GROUP BY chat_type, chat_id ORDER BY last DESC LIMIT 50`)
  return r.rows || []
}

async function memoryRecent(chatType, chatID, limit = 20) {
  const r = await db('all',
    `SELECT id, role, user_id, content, ts FROM ai_message
     WHERE chat_type = ? AND chat_id = ? ORDER BY id DESC LIMIT ?`,
    [chatType, chatID, Math.max(1, Math.min(100, limit | 0 || 20))])
  return r.rows || []
}

async function memoryDelete(id) {
  const r = await db('exec', `DELETE FROM ai_message WHERE id = ?`, [id])
  return r.affected > 0
}

async function memoryClear(chatType, chatID) {
  const r = await db('exec', `DELETE FROM ai_message WHERE chat_type = ? AND chat_id = ?`, [chatType, chatID])
  return r.affected || 0
}

async function memoryClearKw(chatType, chatID, kw) {
  const r = await db('exec',
    `DELETE FROM ai_message WHERE chat_type = ? AND chat_id = ? AND content LIKE ?`,
    [chatType, chatID, `%${kw}%`])
  return r.affected || 0
}

function isAdmin(session) {
  return session.role === 'owner' || session.role === 'admin'
}

async function memoryCommand(session, text) {
  const reply = (m) => host.reply(chatOf(session), m)
  const rest = text.replace(/^记忆\s*/, '').trim()
  const parts = rest.split(/\s+/)
  const sub = (parts[0] || '').toLowerCase()
  const ct = session.chat_type
  const cid = session.chat_id

  if (!sub) {
    const rows = await memoryRecent(ct, cid, 6)
    const total = (await memoryGroups()).find((g) => g.chat_type === ct && String(g.chat_id) === String(cid))
    const lines = [`这个会话记住了 ${total ? total.n : 0} 条（最多留 ${settings.memory_limit || 1000} 条）`]
    if (rows.length) {
      lines.push('最近几条：')
      for (const m of rows.slice().reverse()) {
        const who = m.role === 'user' ? '你' : '我'
        lines.push(`· ${who}：${String(m.content).slice(0, 30)}`)
      }
    } else {
      lines.push('（还是空的）')
    }
    lines.push('', '/记忆 清空（管理员）会删掉这个会话的全部记忆')
    await reply(lines.join('\n'))
    return
  }

  if (sub === '清空' || sub === '删') {
    if (!isAdmin(session)) return reply('只有管理员能清记忆')
    if (sub === '清空') {
      const n = await memoryClear(ct, cid)
      return reply(`已清空这个会话的 ${n} 条记忆（我跟你之间会重新认识）`)
    }
    const kw = parts.slice(1).join(' ').trim()
    if (!kw) return reply('用法：/记忆 删 <关键词>')
    const n = await memoryClearKw(ct, cid, kw)
    return reply(n ? `删掉 ${n} 条包含「${kw}」的记忆` : `没有包含「${kw}」的记忆`)
  }

  await reply('可用：/记忆 看 · /记忆 清空（管理员）· /记忆 删 <关键词>（管理员）')
}

// ---------------------------------------------------------------- 时间感

// 让模型知道现在几点、该聊什么。不然它会在半夜问"中午吃了吗"。
function timeHint() {
  const d = new Date()
  const h = d.getHours()
  const mm = String(d.getMinutes()).padStart(2, '0')
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  const now = `${wd} ${String(h).padStart(2, '0')}:${mm}`

  let topic = ''
  if (h >= 5 && h < 9) topic = '早上：可以聊起床、早餐、通勤；别提午饭和晚饭'
  else if (h >= 9 && h < 11) topic = '上午：聊上班/上课；别问睡没睡'
  else if (h >= 11 && h < 13) topic = '中午：聊午饭吃什么、午休'
  else if (h >= 13 && h < 17) topic = '下午：可以聊犯困、摸鱼、下午茶；别问午饭吃了没'
  else if (h >= 17 && h < 19) topic = '傍晚：聊下班、晚饭'
  else if (h >= 19 && h < 23) topic = '晚上：聊晚饭、休息、追剧打游戏；别问午饭'
  else topic = '深夜：这个点该睡了；别聊午饭，别显得精神抖擞'

  return `现在是 ${now}。${topic}。对方问时间就按这个答。`
}

// ---------------------------------------------------------------- 分段发送

// 真人聊天一般不打句号，短句，用空格或换行隔开。
// 所以切分**不靠标点**：优先在空格/换行处断，没有就按长度切。
function splitReply(text, maxChars, wantParts) {
  const s = String(text).trim()
  if (!s) return []

  const max = Math.max(8, maxChars | 0 || 30)
  const n = Math.max(1, Math.min(5, wantParts | 0 || 1))

  // **换行本身就是人类的分段**：模型写了多行，就按行发，别塞进一条。
  const paras = s.split(/\n+/).map((x) => x.trim()).filter(Boolean)
  if (paras.length > 1) {
    if (paras.length > 5) {
      const head = paras.slice(0, 4)
      head.push(paras.slice(4).join(' '))
      return head
    }
    return paras
  }

  if (n === 1) return [s]

  // 目标多条 + 有空格：按空格分组成 n 条。
  // 光看长度的话，短回复（"嗯 么么 睡吧"）永远只发一条，概率形同虚设。
  const tokens = s.split(/\s+/).filter(Boolean)
  if (tokens.length >= 2 && tokens.length >= n) {
    const parts = []
    let i = 0
    let left = n
    while (i < tokens.length && left > 0) {
      const remain = tokens.length - i
      const take = Math.max(1, Math.ceil(remain / left))
      let chunk = tokens.slice(i, i + take).join(' ')
      // 单条超长：把词让给下一组
      while (chunk.length > max && take > 1) {
        chunk = tokens.slice(i, i + take - 1).join(' ')
        break
      }
      parts.push(chunk)
      i += take
      left--
    }
    if (i < tokens.length && parts.length) {
      parts[parts.length - 1] = parts[parts.length - 1] + ' ' + tokens.slice(i).join(' ')
    }
    return parts.filter(Boolean)
  }

  if (s.length <= max) return [s]

  const parts = []
  let rest = s
  let left = n

  while (left > 1 && rest.length > max * 0.6) {
    const target = Math.min(max, Math.ceil(rest.length / left))
    let cut = -1

    // 在目标位置附近找空白（空格/换行）当断点，最多偏离 40%
    const window = Math.floor(target * 0.4)
    for (let d = 0; d <= window; d++) {
      const back = target - d
      const fwd = target + d
      if (back > 0 && /\s/.test(rest[back - 1])) { cut = back; break }
      if (fwd < rest.length && /\s/.test(rest[fwd - 1])) { cut = fwd; break }
    }
    if (cut <= 0) cut = target // 没有空白就按长度硬切

    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
    left--
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}

// 按设置里的概率决定这次分几条
function targetParts() {
  const weights = [1, 2, 3, 4, 5].map((i) => Math.max(0, Number(settings['split_pct_' + i]) || 0))
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0) return 1
  let r = Math.random() * total
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]
    if (r < 0) return i + 1
  }
  return 1
}

async function sendSplit(chat, text) {
  const enabled = settings.split_enabled !== false
  const parts = enabled
    ? splitReply(text, Number(settings.split_max_chars) || 30, targetParts())
    : [text]

  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      const gap = Math.max(120, Math.min(3000, Number(settings.split_delay_ms) || 500))
      await new Promise((res) => setTimeout(res, gap))
    }
    await host.reply(chat, parts[i])
  }
  return parts.length
}

async function respond(session, userText, extraPrompt, images) {
  const t0 = Date.now()
  host.log('info', `respond 开始 images=${(images || []).length}`)

  const messages = await buildMessages(session, userText, extraPrompt, images)
  host.log('info', `respond 上下文就绪 msgs=${messages.length} 耗时=${Date.now() - t0}`)

  const tools = await loadToolDefs(session)
  let r = await askLLM(messages, tools)
  host.log('info', `respond LLM ${r.ok ? 'ok' : 'fail:' + r.error} tools=${tools.length} 耗时=${Date.now() - t0}`)
  if (!r.ok) return { ok: false, error: r.error }

  // 模型要调工具：执行后把结果喂回去，最多循环 3 轮
  let rounds = 0
  while (r.toolCalls.length && rounds < 3) {
    rounds++
    messages.push({ role: 'assistant', content: r.text || '', tool_calls: r.toolCalls })

    for (const call of r.toolCalls) {
      const result = await runToolCall(call, session)
      host.log('info', `工具 ${call?.function?.name} -> ${result.ok ? 'ok' : 'fail'} ${result.text.slice(0, 60)}`)
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result.ok ? result.text : `执行失败：${result.text}`,
      })
    }

    r = await askLLM(messages, tools)
    if (!r.ok) return { ok: false, error: r.error }
    host.log('info', `工具回合 ${rounds} 完成，还有 ${r.toolCalls.length} 个待调`)
  }

  if (!r.text) return { ok: false, error: 'LLM 没有产出文本' }
  const text = r.text

  const delay = Math.max(0, Number(settings.reply_typing) || 0)
  if (delay > 0) await new Promise((res) => setTimeout(res, Math.min(delay, 3000)))

  try {
    const n = await sendSplit(chatOf(session), text)
    host.log('info', `respond 已发送 parts=${n} 耗时=${Date.now() - t0}`)
  } catch (err) {
    host.log('error', '发送失败: ' + err.message)
    return { ok: false, error: err.message }
  }
  await remember(session, 'assistant', text)
  return { ok: true, text }
}

// ---------------------------------------------------------------- 服务

serve({
  async initialize({ settings: initial }) {
    settings = initial || {}
    host.log('info', `AI 聊天启动，模式=${settings.trigger_mode || 'mention'}`)
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...values }
    return { ok: true }
  },

  async handle_message({ session }) {
    const text = (session.text || '').trim()
    const segTypes = (session.segments || []).map((x) => x.type).join(',')
    const imgCount = imageURLsOf(session).length
    host.log('debug', `收到 chat=${session.chat_type} text=${JSON.stringify(text)} segs=[${segTypes}] images=${imgCount}`)
    if (!text && imgCount === 0) return { handled: false }

    host.log('info', 'H1 开始 ensureReady')
    try {
      await ensureReady()
    } catch (err) {
      host.log('error', '初始化失败: ' + err.message)
      return { handled: false }
    }
    host.log('info', 'H2 ensureReady 完成')

    const imgsForStore = imageURLsOf(session)
    const storeText = text || (imgsForStore.length ? '[图片]' : '')
    // 记忆统一由 observe_message 写（那条路径能看到所有消息，
    // 包括被 keyword-reply 之类抢先认领的），这里不再重复存。


    // 人设命令：装了 ai-persona 就让位（它的人设功能更完整），
    // 没装就用本插件内置的那套（老版本行为，别让用户没法设人设）
    if (/^人设(\s|$)/.test(text)) {
      if (await hasPersonaPlugin()) return { handled: false }
      await personaCommand(session, text)
      return { handled: true }
    }

    // 记忆管理
    if (/^记忆(\s|$)/.test(text)) {
      await memoryCommand(session, text)
      return { handled: true }
    }

    // 语气 / 黑话
    if (/^(语气|黑话)(\s|$)/.test(text)) {
      await styleCommand(session, text)
      return { handled: true }
    }

    const trig = shouldTrigger(session)
    host.log('info', 'H4 shouldTrigger=' + trig)
    if (!trig) return { handled: false }

    const cleaned = text.replace(/^@\S+\s*/, '').trim() || text
    const images = imageURLsOf(session)
    lastTrigger.set(session.chat_type + ':' + session.chat_id, Date.now())
    host.log('info', 'H5 进入 respond images=' + images.length)

    try {
      await respond(session, cleaned, null, images)
      host.log('info', 'H6 respond 返回')
    } catch (err) {
      host.log('error', '回复失败: ' + err.message)
    }
    return { handled: true }
  },

  // 框架把每条消息都抄一份过来（即使别的插件已认领）。
  // 只存文字/图片占位，命令不存（前缀消息不是聊天语料）。
  async observe_message({ session }) {
    try {
      await ensureReady()
      if (session.has_prefix) return {}
      const text = (session.text || '').trim()
      const imgs = imageURLsOf(session)

      // 私聊里的图片：先让模型看一眼，把**描述**存进记忆。
      // 这样过一会儿问"我刚发了什么图"还能答上来，而不是只留个 [图片]。
      let picDesc = ''
      if (session.chat_type === 'private' && imgs.length) {
        picDesc = await describeImage(imgs[0])
      }

      let content = text
      if (picDesc) {
        content = text ? `${text}（图片：${picDesc}）` : `[图片] ${picDesc}`
      } else if (!content && imgs.length) {
        content = '[图片]'
      }
      if (!content) return {}

      await remember(session, 'user', content)
      return {}
    } catch (e) {
      host.log('debug', 'observe 记录失败: ' + e.message)
      return {}
    }
  },

  async call_tool({ name, args }) {
    await ensureReady()
    if (name === 'ai.chat') return await toolChat(args)
    if (name === 'ai.learn') return await toolLearn(args)
    if (name === 'ai.memory') return await toolMemory(args)
    return { ok: false, error: `未知能力 ${name}` }
  },

  async run_task({ task }) {
    await ensureReady()
    if (task === 'cleanup') {
      await db('exec', `DELETE FROM ai_message WHERE ts < ?`, [now() - 30 * 86400])
      host.log('info', '清理旧记忆完成')
    }
    return { ok: true }
  },
})

// ---------------------------------------------------------------- 能力

async function toolChat(args) {
  const { text, chat_type, chat_id, user_id, nickname, prompt, account, images } = args || {}
  const imgsArg = Array.isArray(images) ? images : []
  if (!text && imgsArg.length === 0) return { ok: false, error: '需要 text 或 images' }

  const session = {
    account: account || '',
    chat_type: chat_type || 'private',
    chat_id: chat_id || 0,
    user_id: user_id || 0,
    nickname: nickname || '系统',
    self_id: 0,
  }

  const imgs = imgsArg

  // 没指定会话：只生成不发送，但工具一样要给（否则问「灯关了吗」它只会瞎猜）
  if (!session.chat_id) {
    const messages = await buildMessages(session, text, prompt, imgs)
    const tools = await loadToolDefs(session)
    host.log('info', `纯生成 tools=${tools.length} [${tools.map((t) => t.function.name).join(',')}]`)
    let r = await askLLM(messages, tools)
    if (!r.ok) return { ok: false, error: r.error }
    host.log('info', `纯生成 LLM 返回 toolCalls=${r.toolCalls.length}`)

    let rounds = 0
    while (r.toolCalls.length && rounds < 3) {
      rounds++
      messages.push({ role: 'assistant', content: r.text || '', tool_calls: r.toolCalls })
      for (const call of r.toolCalls) {
        const result = await runToolCall(call, session)
        host.log('info', `工具 ${call?.function?.name}(${call?.function?.arguments}) -> ${result.ok ? 'ok' : 'fail'}: ${String(result.text).slice(0, 80)}`)
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result.ok ? result.text : `执行失败：${result.text}`,
        })
      }
      r = await askLLM(messages, tools)
      if (!r.ok) return { ok: false, error: r.error }
    }
    return { ok: true, data: { text: r.text } }
  }

  const r = await respond(session, text, prompt, imgs)
  return r.ok ? { ok: true, data: { text: r.text } } : { ok: false, error: r.error }
}

// 面板用的"学到什么"接口：看、屏蔽、恢复、管人工词条。
async function toolMemory(args) {
  const action = String(args?.action || '')
  const chatType = String(args?.chat_type || 'group')
  const chatID = Number(args?.chat_id || 0)

  try {
    if (action === 'groups') {
      return { ok: true, data: { groups: await memoryGroups() } }
    }
    if (action === 'recent') {
      return { ok: true, data: { messages: await memoryRecent(chatType, chatID, Number(args?.limit) || 20) } }
    }
    if (action === 'delete') {
      const id = Number(args?.id || 0)
      if (!id) return { ok: false, error: '需要 id' }
      return { ok: true, data: { deleted: await memoryDelete(id) } }
    }
    if (action === 'clear') {
      return { ok: true, data: { cleared: await memoryClear(chatType, chatID) } }
    }
    if (action === 'clear_kw') {
      const kw = String(args?.keyword || '').trim()
      if (!kw) return { ok: false, error: '需要 keyword' }
      return { ok: true, data: { deleted: await memoryClearKw(chatType, chatID, kw) } }
    }
    return { ok: false, error: `未知 action: ${action}` }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

async function toolLearn(args) {
  const action = String(args?.action || '')
  const chatType = String(args?.chat_type || 'group')
  const chatID = Number(args?.chat_id || 0)
  const term = String(args?.term || '').trim()
  const meaning = String(args?.meaning || '').trim()

  if (action === 'groups') {
    const rows = await learnGroups()
    return {
      ok: true,
      data: {
        groups: rows.map((r) => ({
          chat_type: r.chat_type,
          chat_id: r.chat_id,
          count: r.n,
        })),
      },
    }
  }

  // 注意别用 !chatID：chat_id=0 是合法的（虽然不该出现），
  // 用 falsy 判断会导致它永远删不掉。
  if (args?.chat_id === undefined || args?.chat_id === null) {
    return { ok: false, error: '需要 chat_id' }
  }

  if (action === 'stats') {
    const st = await learnStats(chatType, chatID)
    return { ok: true, data: st }
  }

  if (action === 'forget') {
    // 删掉这个会话的所有语料：测试群、不想学的群用这个
    await db('exec', `DELETE FROM ai_message WHERE chat_type = ? AND chat_id = ?`, [chatType, chatID])
    await db('exec', `DELETE FROM ai_glossary WHERE chat_type = ? AND chat_id = ?`, [chatType, chatID])
    await db('exec', `DELETE FROM ai_slang_ban WHERE chat_type = ? AND chat_id = ?`, [chatType, chatID])
    return { ok: true, data: { forgotten: `${chatType}:${chatID}` } }
  }

  if (action === 'ban') {
    if (!term) return { ok: false, error: '需要 term' }
    await banTerm(chatType, chatID, term)
    return { ok: true, data: { banned: term } }
  }

  if (action === 'unban') {
    if (!term) return { ok: false, error: '需要 term' }
    const ok = await unbanTerm(chatType, chatID, term)
    return { ok: true, data: { unbanned: term, existed: ok } }
  }

  if (action === 'gloss_add') {
    if (!term || !meaning) return { ok: false, error: '需要 term 和 meaning' }
    await glossarySave(chatType, chatID, term, meaning)
    return { ok: true, data: { term, meaning } }
  }

  if (action === 'gloss_delete') {
    if (!term) return { ok: false, error: '需要 term' }
    const ok = await glossaryDelete(chatType, chatID, term)
    return { ok: true, data: { deleted: term, existed: ok } }
  }

  return { ok: false, error: `未知 action: ${action}` }
}


