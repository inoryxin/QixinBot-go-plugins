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
      await seedPersonas()
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
    CREATE TABLE IF NOT EXISTS ai_knowledge (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      content TEXT NOT NULL,
      ts      INTEGER NOT NULL
    )`)
}

async function seedPersonas() {
  const list = await db('all', `SELECT name FROM ai_persona`)
  const have = new Set((list.rows || []).map((r) => r.name))
  if (!have.has('群聊')) {
    await savePersona('群聊', '在群里聊天，说话简短自然，不抢话，偶尔接梗。一般一两句就够。')
  }
  if (!have.has('私聊')) {
    await savePersona('私聊', '和熟人私聊，语气更放松亲近，可以多说几句，会关心对方。')
  }
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
async function personalHistory(userID, limit) {
  if (!userID || limit <= 0) return []
  const r = await db('all',
    `SELECT content, ts FROM ai_message
     WHERE user_id = ? AND role = 'user'
     ORDER BY id DESC LIMIT ?`,
    [userID, limit],
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

// ---------------------------------------------------------------- 人设

async function savePersona(name, content) {
  await db('exec',
    `INSERT INTO ai_persona (name, content, ts) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET content = excluded.content, ts = excluded.ts`,
    [name, content, now()],
  )
}

async function getPersona(name) {
  const r = await db('get', `SELECT name, content FROM ai_persona WHERE name = ?`, [name])
  return r.row || null
}

async function listPersonas() {
  const r = await db('all', `SELECT name, content FROM ai_persona ORDER BY name`)
  return r.rows || []
}

function scopeOf(chatType) {
  return chatType === 'private' ? 'private' : 'group'
}

async function currentPersonaFor(chatType) {
  const scope = scopeOf(chatType)
  const fallback = scope === 'private' ? '私聊' : '群聊'
  const name = (await host.sharedGet('ai-chat.persona_' + scope)) || fallback
  const p = await getPersona(name)
  return { scope, name, content: p?.content || '' }
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
  const persona = await currentPersonaFor(session.chat_type)
  const parts = [settings.system_prompt || '你是一个群聊里的朋友，说话自然简短。']

  if (settings.bot_name) parts.push(`你的名字是「${settings.bot_name}」。`)
  if (persona.content) parts.push(`当前人设「${persona.name}」：${persona.content}`)

  // 好感度：影响语气
  if (session.user_id) {
    const aff = await affinityOf(session.user_id)
    if (aff) {
      const score = typeof aff.score === 'number' ? aff.score : aff.affinity
      const level = aff.level || aff.title
      if (score !== undefined) {
        parts.push(`你对当前说话的人好感度是 ${score}${level ? `（${level}）` : ''}，据此调整语气。`)
      }
    }
  }

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
  const personalLimit = Number(settings.personal_memory) || 200
  const personal = await personalHistory(session.user_id, Math.min(personalLimit, 10))
  if (personal.length) {
    const lines = personal.map((m) => '- ' + m.content.replace(/\n/g, ' ')).join('\n')
    messages.push({
      role: 'system',
      content: `关于当前说话的人，他以前说过：\n${lines}`,
    })
  }

  // ② 群上下文：最近这段对话
  const ctxSize = Math.max(4, Number(settings.context_size) || 20)
  const history = await chatHistory(session.chat_type, session.chat_id, ctxSize)
  const names = await nicknamesOf(history.map((m) => m.user_id))

  for (const m of history) {
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
  if (session.chat_type === 'private') return true
  if (session.mentioned) return true

  const mode = settings.trigger_mode || 'mention'
  if (mode === 'mention') return false
  if (mode === 'always') return true

  const key = session.chat_type + ':' + session.chat_id
  const cd = Math.max(0, Number(settings.cooldown) || 0) * 1000
  if (cd > 0 && lastTrigger.has(key) && Date.now() - lastTrigger.get(key) < cd) return false

  const p = Math.max(0, Math.min(100, Number(settings.trigger_prob) || 0))
  return Math.random() * 100 < p
}

// ---------------------------------------------------------------- 回复

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
    await host.reply(chatOf(session), text)
    host.log('info', `respond 已发送 耗时=${Date.now() - t0}`)
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
    if (storeText) {
      try {
        await remember(session, 'user', storeText)
        host.log('info', 'H3 remember 完成')
      } catch (err) {
        host.log('warn', '记录失败: ' + err.message)
      }
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

  async call_tool({ name, args }) {
    await ensureReady()
    if (name === 'ai.chat') return await toolChat(args)
    if (name === 'ai.persona') return await toolPersona(args)
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

async function toolPersona(args) {
  const { action, name, content, scope } = args || {}

  switch (action) {
    case 'list': {
      const list = await listPersonas()
      const g = await currentPersonaFor('group')
      const p = await currentPersonaFor('private')
      return { ok: true, data: { group: g.name, private: p.name, personas: list.map((x) => x.name) } }
    }
    case 'get': {
      if (!name) return { ok: false, error: '需要 name' }
      const p = await getPersona(name)
      return p ? { ok: true, data: p } : { ok: false, error: `人设 ${name} 不存在` }
    }
    case 'set': {
      if (!name) return { ok: false, error: '需要 name' }
      const p = await getPersona(name)
      if (!p) return { ok: false, error: `人设 ${name} 不存在` }
      const s = scope === 'private' ? 'private' : scope === 'group' ? 'group' : null
      if (!s) return { ok: false, error: '需要 scope: group 或 private' }
      await host.sharedSet('ai-chat.persona_' + s, name)
      return { ok: true, data: { scope: s, current: name } }
    }
    case 'save': {
      if (!name || !content) return { ok: false, error: '需要 name 和 content' }
      await savePersona(name, content)
      return { ok: true, data: { saved: name } }
    }
    case 'style': {
      if (!content) return { ok: false, error: '需要 content' }
      await host.sharedSet('ai-chat.speaking_style', content)
      return { ok: true, data: { style: content } }
    }
    default:
      return { ok: false, error: `未知 action: ${action}（可用 list/get/set/save/style）` }
  }
}
