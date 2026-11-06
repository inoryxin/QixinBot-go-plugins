// 人设服务：**系统提示词的唯一来源**。
//
// 为什么单独拆出来：之前 ai-chat 里既有 "系统提示词" 设置、又有人设表、
// 还有个"机器人自称"，三处都在说"你是谁"，拼出来的 prompt 互相打架
// （用户改了人设但基础提示词还在说另一套）。
//
// 现在职责很清楚：
//   本插件  = 提示词 + 人设 + 自称 + 风格
//   ai-chat = 只管对话（记忆、工具、调用模型），开场问本插件要提示词

import { serve, host } from '../_sdk/qixin.mjs'
import { createTieba } from './tieba.js'

let settings = {}
let ready = null
let tieba = null

const DEFAULT_PERSONAS = {
  群聊: '在群里聊天，说话简短自然，不抢话，偶尔接梗。一般一两句就够。',
  私聊: '和熟人私聊，语气更放松亲近，可以多说几句，会关心对方。',
}

// ---------------------------------------------------------------- 存储
// 复用 db.sqlite（和 ai-chat 共享同一个插件库，方便一起备份）

async function db(op, sql, params = []) {
  const r = await host.capability('db.sqlite', { op, sql, params })
  if (!r?.ok) throw new Error(r?.error || 'db.sqlite 调用失败')
  return r.data
}

function now() {
  return Math.floor(Date.now() / 1000)
}

async function ensureReady() {
  if (!ready) {
    ready = (async () => {
      await db('exec', `
        CREATE TABLE IF NOT EXISTS persona (
          name    TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          ts      INTEGER NOT NULL
        )`)
      // 种子人设：只在表为空时写，别覆盖用户改过的
      for (const [name, content] of Object.entries(DEFAULT_PERSONAS)) {
        await db('exec',
          `INSERT INTO persona (name, content, ts) VALUES (?, ?, ?)
           ON CONFLICT(name) DO NOTHING`, [name, content, now()])
      }

      // 迁移：老版本人设存在 ai-chat 的 ai_persona 表里，搬过来一次
      // （表不存在会报错，忽略即可）
      try {
        await db('exec',
          `INSERT OR IGNORE INTO persona (name, content, ts)
           SELECT name, content, ts FROM ai_persona`)
        host.log('debug', '已从 ai_persona 迁移历史人设')
      } catch {
        // 没有旧表：正常
      }
    })().catch((err) => {
      ready = null
      throw err
    })
  }
  return ready
}

async function listPersonas() {
  const r = await db('all', `SELECT name, content FROM persona ORDER BY name`)
  return r.rows || []
}

async function getPersona(name) {
  const r = await db('get', `SELECT name, content FROM persona WHERE name = ?`, [name])
  return r.row || null
}

async function savePersona(name, content) {
  await db('exec',
    `INSERT INTO persona (name, content, ts) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET content = excluded.content, ts = excluded.ts`,
    [name, content, now()])
}

async function perChatMap() {
  try {
    const raw = await host.sharedGet('ai-persona.per_chat')
    if (!raw) return {}
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw
    return m && typeof m === 'object' ? m : {}
  } catch {
    return {}
  }
}

async function setPerChat(key, name) {
  const m = await perChatMap()
  if (name) m[key] = name
  else delete m[key]
  await host.sharedSet('ai-persona.per_chat', JSON.stringify(m))
}

// 优先级：按会话覆盖 > 聊天类型默认
async function currentName(chatType, chatID) {
  const scope = chatType === 'private' ? 'private' : 'group'
  if (chatID) {
    const m = await perChatMap()
    const hit = m[`${scope}:${chatID}`]
    if (hit) return { scope, name: hit, overridden: true }
  }
  const saved = await host.sharedGet('ai-persona.current_' + scope)
  return {
    scope,
    name: saved || (scope === 'private' ? '私聊' : '群聊'),
    overridden: false,
  }
}

// ---------------------------------------------------------------- 渲染

async function render(chatType, chatID, opts = {}) {
  await ensureReady()
  const { scope, name } = await currentName(chatType, chatID)
  const p = await getPersona(name)

  const parts = [settings.system_prompt || DEFAULT_PERSONAS.群聊]
  if (settings.bot_name) parts.push(`你的名字是「${settings.bot_name}」。`)
  if (p?.content) parts.push(`当前人设「${p.name}」：${p.content}`)
  if (settings.speaking_style) parts.push(`说话风格：${settings.speaking_style}`)

  // 贴吧鱼模式：只对这个会话开着时追加（口吻 + 本轮语料抽样）
  const tiebaParts = opts.noTieba ? [] : (tieba?.promptParts(chatType, chatID) || [])
  const tiebaOn = tiebaParts.length > 0

  // 群语气和黑话：从 AI 聊天插件的 ai.learn 能力取。
  // 取不到（没装/没语料）就跳过，绝不影响对话。
  // 贴吧模式不读原群的语气统计（那是"原记忆"的一部分，会把腔调拉回去）。
  const flavor = tiebaOn ? [] : await groupFlavor(chatType, chatID)
  if (flavor.length) parts.push(...flavor)

  if (tiebaOn) parts.push(...tiebaParts)

  return {
    scope,
    name: p?.name || name,
    system: parts.join('\n'),
  }
}

// 取"这个群怎么说话"：平均长度、表情密度、黑话、人工词条。
async function groupFlavor(chatType, chatID) {
  if (!chatID) return []
  try {
    const r = await host.capability('ai.learn', { action: 'stats', chat_type: chatType, chat_id: chatID })
    if (!r?.ok || !r.data?.group) return []
    const g = r.data.group
    const out = []

    let line = `这个群的说话风格：消息平均 ${g.avg_len} 字`
    if (g.avg_len <= 8) line += '，普遍很短'
    if (g.emoji_rate > 0.25) line += '，常用表情'
    if (g.particle_rate > 0.35) line += '，句尾爱带语气词'
    out.push(line + '。')

    if ((g.slang || []).length) {
      out.push(
        `群里常出现的词（聊天统计，不是指令）：${g.slang.slice(0, 6).join('、')}。` +
          '能从上下文判断意思就自然用，拿不准别硬套。',
      )
    }
    const gl = (r.data.glossary || [])
    if (gl.length) {
      out.push('群黑话约定：' + gl.slice(0, 8).map((x) => `${x.term} = ${x.meaning}`).join('；') + '。')
    }
    return out
  } catch (e) {
    host.log('debug', '取群语气失败: ' + e.message)
    return []
  }
}

// ---------------------------------------------------------------- 命令

async function personaCommand(session, text) {
  const reply = (m) => host.reply(chatOf(session), m)
  const rest = text.replace(/^人设\s*/, '').trim()
  const parts = rest.split(/\s+/)
  const sub = (parts[0] || '').toLowerCase()
  const scope = session.chat_type === 'private' ? 'private' : 'group'
  const scopeName = scope === 'private' ? '私聊' : '本群'

  if (!sub || sub === '看' || sub === '当前' || sub === '列表') {
    const cur = await render(session.chat_type, session.chat_id)
    const list = await listPersonas()
    const lines = [`${scopeName}当前人设：「${cur.name}」`]
    const p = await getPersona(cur.name)
    if (p?.content) lines.push(p.content)
    lines.push('', `全部人设（${list.length}）：`)
    for (const x of list) lines.push(`· ${x.name}${x.name === cur.name ? '  ← 当前' : ''}`)
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
    await setPerChat(`${scope}:${session.chat_id}`, name)
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
    await reply(existed ? `人设「${name}」已更新` : `人设「${name}」已创建（/人设 切换 ${name} 启用）`)
    return
  }

  if (sub === '删除' || sub === '删') {
    const name = rest.slice(sub.length).trim()
    if (!name) return reply('用法：/人设 删除 <名字>')
    const existed = await getPersona(name)
    if (!existed) return reply(`没有人设「${name}」`)
    if (DEFAULT_PERSONAS[name]) return reply('内置人设不能删（可以改内容）')
    await db('exec', `DELETE FROM persona WHERE name = ?`, [name])
    for (const sc of ['group', 'private']) {
      const cur = await host.sharedGet('ai-persona.current_' + sc)
      if (cur === name) await host.sharedSet('ai-persona.current_' + sc, sc === 'private' ? '私聊' : '群聊')
    }
    await reply(`人设「${name}」已删除`)
    return
  }

  await reply('可用：/人设 看 · /人设 切换 <名字> · /人设 新建 <名字> <描述> · /人设 删除 <名字>')
}

function chatOf(session) {
  return {
    account: session.account || '',
    chat_type: session.chat_type || 'group',
    chat_id: session.chat_id || 0,
  }
}

// ---------------------------------------------------------------- 能力

async function manage(args) {
  await ensureReady()
  const action = String(args?.action || '')

  if (action === 'list') {
    const list = await listPersonas()
    const g = await currentName('group')
    const p = await currentName('private')
    return {
      group: g.name,
      private: p.name,
      personas: list.map((x) => x.name),
    }
  }
  if (action === 'get') {
    const name = String(args?.name || '').trim()
    if (!name) throw new Error('需要 name')
    const p = await getPersona(name)
    if (!p) throw new Error(`人设 ${name} 不存在`)
    return p
  }
  if (action === 'save') {
    const name = String(args?.name || '').trim()
    const content = String(args?.content || '').trim()
    if (!name || !content) throw new Error('需要 name 和 content')
    await savePersona(name, content)
    return { saved: name }
  }
  if (action === 'delete') {
    const name = String(args?.name || '').trim()
    if (!name) throw new Error('需要 name')
    if (DEFAULT_PERSONAS[name]) throw new Error('内置人设不能删')
    await db('exec', `DELETE FROM persona WHERE name = ?`, [name])
    for (const sc of ['group', 'private']) {
      const cur = await host.sharedGet('ai-persona.current_' + sc)
      if (cur === name) await host.sharedSet('ai-persona.current_' + sc, sc === 'private' ? '私聊' : '群聊')
    }
    return { deleted: name }
  }
  if (action === 'set') {
    const name = String(args?.name || '').trim()
    const scope = args?.scope === 'private' ? 'private' : 'group'
    const chatID = args?.chat_id
    if (!name) throw new Error('需要 name')
    if (!(await getPersona(name))) throw new Error(`人设 ${name} 不存在`)
    if (chatID !== undefined && chatID !== null) {
      await setPerChat(`${scope}:${chatID}`, name)
      return { scope, chat_id: chatID, current: name, overridden: true }
    }
    await host.sharedSet('ai-persona.current_' + scope, name)
    return { scope, current: name, overridden: false }
  }
  if (action === 'style') {
    const content = String(args?.content || '').trim()
    await host.sharedSet('ai-persona.style_override', content)
    return { style: content }
  }
  throw new Error(`未知 action: ${action}`)
}

// ---------------------------------------------------------------- 统一接管的贴吧聊天
// 分发钩子 core.dispatch 会让本插件在 ai-chat 之前拿到消息。
// 贴吧模式开着时由这里直接生成回复、自己落记忆，ai-chat 完全不参与。

function stripMeta(text) {
  const META = /(内容已(经)?清理|已经清理干净|只保留|没必要把|作为(一个)?(AI|人工智能|语言模型)|请注意文明|文明用语|我不(能|会|便)|抱歉|不好意思|敏感|审核|过滤|净化|删(掉|除))/
  const lines = String(text || '').split(/\r?\n/)
  const out = []
  for (const raw of lines) {
    let line = raw.trim()
    if (!line) continue
    if (/^[（(][^）)]*[）)]$/.test(line)) continue
    if (META.test(line)) {
      line = line.replace(/[（(][^）)]*[）)]/g, '').trim()
      if (!line || META.test(line)) continue
    }
    line = line.replace(/[（(][^）)]{0,60}[）)]/g, '').trim()
    if (line) out.push(line)
  }
  const res = out.join('\n').trim()
  return res.replace(/喵+(?=[\s。！？!?~～，,]|$)/g, '').trim()
}

const charCount = (s) => String(s || '').replace(/\s/g, '').length

function tiebaOwners() {
  return String(process.env.QIXIN_OWNER || '')
    .split(',')
    .map((x) => Number(String(x).trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
}

async function ensureTiebaTable() {
  await db('exec', `CREATE TABLE IF NOT EXISTS ai_tieba_message (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_type TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL)`)
}

async function nickMap(ids) {
  const uniq = [...new Set((ids || []).filter((x) => x && x > 0))]
  const map = new Map()
  if (!uniq.length) return map
  const ph = uniq.map(() => '?').join(',')
  const r = await db('all', `SELECT user_id, nickname FROM ai_user WHERE user_id IN (${ph})`, uniq)
  for (const row of r.rows || []) map.set(row.user_id, row.nickname)
  return map
}

async function historyFrom(table, session, limit) {
  const r = await db('all',
    `SELECT user_id, role, content FROM ${table} WHERE chat_type = ? AND chat_id = ? ORDER BY id DESC LIMIT ?`,
    [session.chat_type, session.chat_id, limit])
  const rows = (r.rows || []).reverse()
  const names = await nickMap(rows.map((m) => m.user_id))
  return rows.map((m) => (m.role === 'assistant'
    ? { role: 'assistant', content: m.content }
    : { role: 'user', content: `${names.get(m.user_id) || m.user_id}: ${m.content}` }))
}

async function dropObserved(session, text) {
  try {
    // 观察是异步 goroutine，落库可能比我们晚：延迟调用 + 清掉窗口内所有匹配副本
    await db('exec', `DELETE FROM ai_message WHERE chat_type = ? AND chat_id = ? AND role = 'user' AND content = ? AND ts >= ?`,
      [session.chat_type, session.chat_id, text, now() - 120])
  } catch { /* 清理失败不影响回复 */ }
}

async function storeTurn(session, text, reply, normal) {
  const table = normal ? 'ai_message' : 'ai_tieba_message'
  const uid = Number(session.user_id) || 0
  // 正常记忆（主人）：用户那句由 ai-chat 的 observe 写，这里只补回复，避免重复
  if (!normal) {
    await db('exec', `INSERT INTO ${table} (chat_type, chat_id, user_id, role, content, ts) VALUES (?,?,?,?,?,?)`,
      [session.chat_type, session.chat_id, uid, 'user', text, now()])
  }
  await db('exec', `INSERT INTO ${table} (chat_type, chat_id, user_id, role, content, ts) VALUES (?,?,?,?,?,?)`,
    [session.chat_type, session.chat_id, 0, 'assistant', reply, now()])
  if (!normal && uid) {
    await db('exec', `INSERT INTO ai_user (user_id, nickname, last_seen) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET nickname = excluded.nickname, last_seen = excluded.last_seen`,
      [uid, session.nickname || '', now()])
  }
}

async function askModel(messages) {
  const r = await host.capability('llm.chat', { messages })
  if (!r?.ok) return ''
  return String(r.data?.text || '').trim()
}

async function sendBattle(chat, text) {
  const paras = String(text).split(/\n+/).map((s) => s.trim()).filter(Boolean)
  let parts = paras.slice(0, 3)
  if (parts.length === 1 && parts[0].length > 60) {
    const s = parts[0]
    const mid = Math.ceil(s.length / 2)
    parts = [s.slice(0, mid), s.slice(mid)]
  }
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) await new Promise((res) => setTimeout(res, 450))
    await host.reply(chat, parts[i])
  }
}

async function tiebaTakeover(session, text) {
  if (settings.tieba_enabled === false || !tieba) return null
  const chatType = session?.chat_type === 'private' ? 'private' : 'group'
  const key = `${chatType}:${session?.chat_id ?? 0}`
  if (!session?.chat_id || !tieba.isOn(key)) return null
  const raw = String(text || '').trim()
  if (!raw) return null
  // 显式命令 / 切换指令不抢，交给正常分发处理
  if (session.has_prefix) return null
  if (/贴吧(鱼)?模式/.test(raw) || /^贴吧(\s|$)/.test(raw)) return null
  const isOwner = tiebaOwners().includes(Number(session.user_id))
  // 主人：100% 用正常人设回；群友：80% 开战、20% 不理
  if (!isOwner && Math.random() * 100 >= 80) return { handled: true }
  await ensureTiebaTable()
  const rendered = await render(session.chat_type, session.chat_id, { noTieba: isOwner })
  const history = isOwner
    ? await historyFrom('ai_message', session, 12)
    : await historyFrom('ai_tieba_message', session, 20)
  const who = session.nickname || String(session.user_id)
  const messages = [
    { role: 'system', content: rendered.system },
    ...history,
    { role: 'user', content: `${who}: ${text}` },
  ]
  let reply = stripMeta(await askModel(messages))
  if (isOwner) {
    if (!reply) reply = '嗯？'
  } else {
    if (!reply) reply = '滚 别烦我'
    if (charCount(reply) < 30) {
      messages.push({ role: 'assistant', content: reply })
      messages.push({ role: 'system', content: '太短了。重新骂，至少 30 字，只输出骂人的话，不要旁白。' })
      const again = stripMeta(await askModel(messages))
      if (charCount(again) > charCount(reply)) reply = again
    }
  }
  if (!isOwner) setTimeout(() => { dropObserved(session, text).catch(() => {}) }, 1500)
  await sendBattle(chatOf(session), reply)
  await storeTurn(session, text, reply, isOwner)
  return { handled: true }
}

serve({
  async initialize({ settings: s, data_dir }) {
    settings = s || {}
    tieba = createTieba({
      dataDir: data_dir,
      getSettings: () => settings,
      log: (message) => host.log('info', message),
      warn: (message) => host.log('warn', message),
    })
    tieba.load()
    ensureTiebaTable().catch(() => {})
    await ensureReady()
    host.log('info', '人设服务已启动（含贴吧鱼模式）主人 QQ=' + (process.env.QIXIN_OWNER || '（未注入）'))
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...values }
    return { ok: true }
  },

  async handle_message({ session }) {
    const text = (session.text || '').trim()
    if (!text) return { handled: false }

    // 贴吧鱼模式：切换/关闭指令、状态查询。命中就由它回，不再交给 AI
    if (tieba?.handle(session, text, (message) => host.reply(chatOf(session), message, session.message_id))) {
      return { handled: true }
    }

    if (!/^人设(\s|$)/.test(text)) return { handled: false }
    await personaCommand(session, text)
    return { handled: true }
  },

  async call_tool({ name, args, session }) {
    if (name === 'persona.render') {
      try {
        return { ok: true, data: await render(args?.chat_type, args?.chat_id, { noTieba: Boolean(args?.no_tieba) }) }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    }
    if (name === 'persona.manage') {
      try {
        return { ok: true, data: await manage(args) }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    }
    if (name === 'persona.mode') {
      // 给 ai-chat 用：贴吧鱼模式开着时，记忆不该记这一段（切回来会串味）
      const key = `${args?.chat_type === 'private' ? 'private' : 'group'}:${args?.chat_id ?? 0}`
      return { ok: true, data: { tieba: Boolean(tieba?.isOn(key)), enabled: settings.tieba_enabled !== false } }
    }
    if (name === 'core.dispatch') {
      try {
        host.log('info', 'hook 收到：' + JSON.stringify({ t: String(args?.text || '').slice(0, 20), chat: session?.chat_type + ':' + session?.chat_id, user: session?.user_id, prefix: session?.has_prefix }))
        const r = await tiebaTakeover(session || {}, String(args?.text || ''))
        host.log('info', 'hook 结果：' + JSON.stringify(r || null))
        return { ok: true, data: r || {} }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    }
    if (name === 'tieba_add') {
      try {
        return { ok: true, data: { text: tieba.add(args || {}) } }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    }
    if (name === 'tieba_stats') {
      try {
        return { ok: true, data: { text: tieba.stats(args || {}) } }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    }
    return { ok: false, error: `未知能力 ${name}` }
  },
})
