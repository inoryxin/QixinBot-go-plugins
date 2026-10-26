import { serve, host } from '../_sdk/qixin.mjs'
import { AcpTcpClient } from './acp.mjs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'

let settings = {}
let mode = 'idle' // idle | starting | dsh
let acp = null
let sessionId = ''
let busy = false
let relayBusy = false

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chatOf = (s) => ({ account: s.account, chat_type: s.chat_type, chat_id: s.chat_id })
const agentBase = () => `http://${String(settings.agentHost || '10.0.0.99:3097').replace(/^https?:\/\//, '').replace(/\/+$/, '')}`

function ownerIds() {
  return String(process.env.QIXIN_OWNER || '')
    .split(/[,，\s]+/).map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0)
}
function isOwner(session) {
  const owners = ownerIds()
  return session.role === 'owner' || !owners.length || owners.includes(Number(session.user_id))
}

function probePort(host, port, timeout = 2500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    const done = (value) => { socket.destroy(); resolve(value) }
    socket.setTimeout(timeout, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

async function waitPort(host, port, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probePort(host, port)) return true
    await sleep(5000)
  }
  throw new Error(`等待${label}超时`)
}

function haRequest(method, pathName, body) {
  return new Promise((resolve, reject) => {
    const base = String(settings.haUrl || 'https://10.0.0.123:8123').replace(/\/+$/, '')
    const url = new URL(base + pathName)
    const lib = url.protocol === 'https:' ? https : http
    const payload = body ? JSON.stringify(body) : ''
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      rejectUnauthorized: false,
      headers: {
        Authorization: `Bearer ${settings.haToken || ''}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        if ((res.statusCode || 500) >= 400) return reject(new Error(`HA HTTP ${res.statusCode}: ${text.slice(0, 200)}`))
        try { resolve(text ? JSON.parse(text) : {}) } catch { resolve({}) }
      })
    })
    req.setTimeout(10000, () => req.destroy(new Error('HA 请求超时')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function ensureWindows(session) {
  const pcHost = settings.pcHost || '10.0.0.99'
  try {
    await agent('/status', { timeout: 25000 })
    return true
  } catch {}

  // Windows 已经开着但管家刚被关掉（比如关闭 DSH 时误杀 node）：
  // 不要误判成电脑关机去走 HA/Arch，等管家自愈即可。
  if ((await probePort(pcHost, 3389)) || (await probePort(pcHost, 445))) {
    await host.reply(chatOf(session), 'Windows 已开机，等 PC 管家启动…')
    const deadline = Date.now() + (Number(settings.agentWaitMs) || 60000)
    while (Date.now() < deadline) {
      try { await agent('/status', { timeout: 10000 }); return true } catch {}
      await sleep(3000)
    }
    throw new Error('Windows 开着，但 PC 管家没起来')
  }

  const archPort = Number(settings.archPort) || 22222
  if (!(await probePort(pcHost, archPort))) {
    const entity = String(settings.haEntity || 'switch.lemesh_cn_1117316460_sw0a04_on_p_2_1')
    const state = await haRequest('GET', `/api/states/${encodeURIComponent(entity)}`)
    if (state.state !== 'on') {
      await haRequest('POST', '/api/services/switch/turn_on', { entity_id: entity })
      await host.reply(chatOf(session), '插座已通电，等电脑开机…')
    } else {
      await host.reply(chatOf(session), '插座是通电的，电脑可能在启动…')
    }
    await host.reply(chatOf(session), '等 Arch 起来（大约一分钟）…')
    await waitPort(pcHost, archPort, Number(settings.bootTimeoutMs) || 180000, 'Arch 启动')
  }
  await host.reply(chatOf(session), 'Arch 已在线，发重启指令切到 Windows…')
  await fetch(String(settings.archLaunchUrl || `http://${pcHost}:22222/launch?token=111111&app=reboot`), { signal: AbortSignal.timeout(10000) })
  await host.reply(chatOf(session), '等 Windows 重启（大约一分钟）…')
  const deadline = Date.now() + (Number(settings.bootTimeoutMs) || 180000)
  while (Date.now() < deadline) {
    try { await agent('/status', { timeout: 25000 }); return true } catch {}
    await sleep(5000)
  }
  throw new Error('Windows PC 管家没起来')
}

async function agent(pathName, init = {}) {
  const r = await fetch(agentBase() + pathName, {
    ...init,
    headers: { Authorization: `Bearer ${settings.agentToken || 'pc-7f3a91c2'}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(init.timeout || 60000),
  })
  if (!r.ok) throw new Error(`PC 管家 HTTP ${r.status}`)
  const type = r.headers.get('content-type') || ''
  return type.includes('application/json') ? r.json() : Buffer.from(await r.arrayBuffer())
}

function gb(bytes) { return `${(Number(bytes) / 1024 ** 3).toFixed(1)} GB` }
function uptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600)
  return d ? `${d} 天 ${h} 小时` : `${h} 小时`
}

async function statusText() {
  const d = await agent('/status', { timeout: 20000 })
  const used = d.memory.total - d.memory.free
  const lines = [
    `💻 ${d.host}（${d.platform}）`,
    `运行 ${uptime(d.uptimeSec)} · CPU ${String(d.cpu.model).split('@')[0].trim()} ×${d.cpu.cores}`,
    `内存 ${gb(used)} / ${gb(d.memory.total)}`,
  ]
  for (const disk of d.disks || []) {
    const u = disk.total - disk.free
    lines.push(`磁盘 ${disk.name} ${gb(u)} / ${gb(disk.total)}（${disk.total ? Math.round((u / disk.total) * 100) : 0}%）`)
  }
  if (d.battery?.percent != null) lines.push(`电池 ${d.battery.percent}%`)
  lines.push(`DSH：web ${d.dsh?.web ? '在线' : '离线'} · ACP ${d.dsh?.bridge ? '在线' : '离线'}`)
  return lines.join('\n')
}

async function sendScreenshot(session) {
  const buffer = await agent('/screen', { timeout: 30000 })
  await host.reply(chatOf(session), [{ type: 'image', data: { file: `base64://${buffer.toString('base64')}` } }])
}

async function dshServices(withWeb) {
  return agent(`/ensure-dsh?web=${withWeb ? '1' : '0'}`, { method: 'POST', timeout: withWeb ? 60000 : 20000 })
}

async function readState() {
  return (await host.storage.get('dsh')) || {}
}
async function saveState(patch) {
  const prev = await readState()
  await host.storage.set('dsh', { ...prev, ...patch, updatedAt: Date.now() })
}

function normalizeId(v) { return String(v ?? '').replace(/^session-/, '') }
function shortTitle(title, fallback) {
  const text = String(title ?? '').trim() || fallback
  const chars = Array.from(text)
  return chars.length <= 14 ? text : `${chars.slice(0, 13).join('')}…`
}
function workspaceName() {
  return String(settings.workspace || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'xin'
}

async function loadLocalTitles() {
  return (await host.storage.get('sessionTitles')) || {}
}
async function saveLocalTitles(all) { await host.storage.set('sessionTitles', all) }
async function touchTitle(id, text) {
  const key = normalizeId(id)
  if (!key) return
  const all = await loadLocalTitles()
  const now = Date.now()
  const prev = all[key] || { createdAt: now }
  all[key] = { ...prev, title: prev.title || (text ? shortTitle(text, '') : ''), lastUsedAt: now }
  await saveLocalTitles(all)
}
async function setSessionTitle(id, title) {
  const key = normalizeId(id)
  if (!key || !title) return
  const all = await loadLocalTitles()
  all[key] = { ...(all[key] || { createdAt: Date.now() }), title, lastUsedAt: Date.now() }
  await saveLocalTitles(all)
}

async function sessionTitles(cwd) {
  const port = Number(settings.metaPort) || 3098
  try {
    const r = await fetch(`http://${settings.acpHost}:${port}/sessions?cwd=${encodeURIComponent(cwd)}`, { signal: AbortSignal.timeout(3000) })
    if (!r.ok) return new Map()
    const data = await r.json()
    const map = new Map()
    for (const item of data.sessions || []) {
      map.set(normalizeId(item.sessionId), {
        title: String(item.title || ''),
        lastPromptAt: Number(item.lastPromptAt || 0),
        workspace: String(item.workspace || ''),
      })
    }
    return map
  } catch { return new Map() }
}

async function archivedIds() {
  const port = Number(settings.metaPort) || 3098
  try {
    const r = await fetch(`http://${settings.acpHost}:${port}/archived`, { signal: AbortSignal.timeout(3000) })
    if (!r.ok) return new Set()
    const data = await r.json()
    return new Set((data.ids || []).map(normalizeId))
  } catch { return new Set() }
}

async function allSessions() {
  const [result, dshTitles, archived] = await Promise.all([
    acp.listSessions(settings.workspace),
    sessionTitles(settings.workspace),
    archivedIds(),
  ])
  const current = normalizeId(sessionId)
  const state = await readState()
  const defaultId = normalizeId(state.defaultSessionId)
  const local = await loadLocalTitles()
  const wanted = workspaceName()
  const sessions = (result?.sessions || [])
    .filter((item) => {
      const id = normalizeId(item.sessionId)
      return !archived.has(id) || id === current || id === defaultId
    })
    .map((item) => {
      const id = normalizeId(item.sessionId)
      const dsh = dshTitles.get(id) || {}
      return {
        id,
        raw: item.sessionId,
        title: local[id]?.title || dsh.title || '',
        workspace: dsh.workspace || '',
        usedAt: local[id]?.lastUsedAt ?? dsh.lastPromptAt ?? 0,
      }
    })
    .filter((item) => !item.workspace || item.workspace === wanted || item.workspace === settings.workspace)

  const seen = new Set(sessions.map((x) => x.id))
  for (const [id, meta] of Object.entries(local)) {
    if (seen.has(id) || !meta.title) continue
    if (archived.has(id) && id !== current && id !== defaultId) continue
    sessions.push({ id, raw: id, title: meta.title, usedAt: meta.lastUsedAt || 0 })
  }

  const titled = sessions.filter((x) => x.title).sort((a, b) => b.usedAt - a.usedAt)
  const untitled = sessions.filter((x) => !x.title)
  const visible = titled.length ? titled : untitled
  if (current && !visible.some((x) => x.id === current)) visible.unshift({ id: current, raw: sessionId, title: '新会话', usedAt: Date.now() })
  return visible
}

async function titleOf(id) {
  const list = await allSessions()
  return list.find((x) => x.id === normalizeId(id))?.title || '新会话'
}

async function switchToDefault(session) {
  const state = await readState()
  const target = normalizeId(state.defaultSessionId)
  if (!target) return host.reply(chatOf(session), '还没有默认会话，先进一次大肥鱼模式。')
  try {
    await ensureAcp()
    let id
    try { id = await acp.resumeSession(target, settings.workspace) }
    catch (e) { if (!/already active/i.test(e.message)) throw e; id = target }
    sessionId = id
    await saveState({ active: true, sessionId: id })
    await setSessionTitle(id, '大肥鱼')
    await host.reply(chatOf(session), '已切回「大肥鱼」')
  } catch (e) { await host.reply(chatOf(session), `切换失败：${e.message}`) }
}

async function connectAcp(resume) {
  const deadline = Date.now() + 30000
  let last
  while (Date.now() < deadline) {
    const client = new AcpTcpClient({ host: settings.acpHost, port: Number(settings.acpPort) || 3099, token: settings.acpToken || '111111' })
    try {
      await client.connect(10000)
      await Promise.race([
        client.initialize(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ACP 初始化超时（10s）')), 10000)),
      ])
      let id
      if (resume) {
        try { id = await client.resumeSession(resume, settings.workspace) }
        catch (e) {
          if (!/already active/i.test(e.message)) throw e
          id = resume
        }
      } else {
        id = await client.newSession(settings.workspace)
      }
      acp = client
      sessionId = id
      return id
    } catch (e) {
      last = e
      client.close()
      if (/already active/i.test(e.message)) break
      await sleep(2000)
    }
  }
  throw last || new Error('连不上 ACP 桥')
}

async function ensureAcp() {
  if (acp?.connected) return acp
  try { acp?.close() } catch {}
  acp = null
  const state = await readState()
  await connectAcp(state.sessionId || '')
  return acp
}

async function openDshWeb(url) {
  let target = String(url || settings.webUrl || '').trim()
  if (!target) {
    try { target = (await agent('/dsh-url', { timeout: 5000 })).url || '' } catch {}
  }
  if (!/^https?:\/\//i.test(target)) return
  try { await agent(`/open?url=${encodeURIComponent(target)}`, { method: 'POST', timeout: 10000 }) } catch (e) { host.log('warn', `打开 DSH 网页失败: ${e.message}`) }
}

async function enter(session) {
  if (mode === 'dsh') return host.reply(chatOf(session), '已经在大肥鱼模式了，直接说事就行。')
  if (mode === 'starting') return host.reply(chatOf(session), '正在启动，等我一下。')
  mode = 'starting'
  busy = true
  try {
    await host.reply(chatOf(session), '大肥鱼模式启动中，先检查你电脑开没开…')
    await ensureWindows(session)
    await host.reply(chatOf(session), '正在连接 DSH…')
    const svc = await dshServices(true)
    if (!svc.bridge?.ready) throw new Error('ACP 桥没起来')
    const state = await readState()
    let id = ''
    let usedDefault = false
    if (state.defaultSessionId) {
      try { id = await connectAcp(state.defaultSessionId); usedDefault = true } catch {}
    }
    if (!id) id = await connectAcp('')
    const defaultId = usedDefault ? state.defaultSessionId : id
    await saveState({ active: true, sessionId: id, defaultSessionId: defaultId })
    await setSessionTitle(defaultId, '大肥鱼')
    mode = 'dsh'
    await openDshWeb(svc.web?.url)
    const title = await titleOf(id)
    await host.reply(chatOf(session), `大肥鱼模式已接管，当前会话：${title}（${String(id).slice(0, 8)}）。\n发「新会话」「会话列表」「切换 n」；发「退出大肥鱼模式」还给我。`)
  } catch (e) {
    mode = 'idle'
    try { acp?.close() } catch {}
    acp = null
    await host.reply(chatOf(session), `进入大肥鱼模式失败：${e.message}`)
  } finally { busy = false }
}

async function exit(session, shutdown) {
  mode = 'idle'
  try { acp?.close() } catch {}
  acp = null
  sessionId = ''
  await saveState({ active: false, sessionId: '' })
  if (shutdown) {
    try {
      await agent('/action?action=shutdown', { method: 'POST', timeout: 10000 })
      await host.reply(chatOf(session), '已退出大肥鱼模式，已发送 Windows 关机指令。')
    } catch (e) {
      await host.reply(chatOf(session), `已退出大肥鱼模式，但关机失败：${e.message}`)
    }
    return
  }
  await host.reply(chatOf(session), '已退出大肥鱼模式，聊天交回给我。')
}

async function uploadIncoming(session) {
  const paths = []
  const images = (session.segments || []).filter((x) => x?.type === 'image').slice(0, 3)
  for (let i = 0; i < images.length; i++) {
    const data = images[i].data || {}
    try {
      let buf
      if (data.url || /^https?:/i.test(data.file || '')) {
        const r = await fetch(data.url || data.file, { signal: AbortSignal.timeout(20000) })
        if (!r.ok) continue
        buf = Buffer.from(await r.arrayBuffer())
      } else if ((data.file || '').startsWith('base64://')) {
        buf = Buffer.from(data.file.slice(9), 'base64')
      } else continue
      if (!buf?.length) continue
      const up = await agent(`/upload?name=${encodeURIComponent(`qq-${Date.now()}-${i}.png`)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf, timeout: 30000,
      })
      if (up.path) paths.push(up.path)
    } catch (e) { host.log('warn', `上传 QQ 图片失败: ${e.message}`) }
  }
  return paths
}

function relayPrompt(text, imagePaths) {
  const persona = String(settings.relayPersona || '').trim()
  const lines = [
    '你正在通过 QQ 和老公私聊，消息会直接显示在 QQ 里。',
    '只回一条简短的消息（一两句），不要列表、标题、长段落，不要重复解释，不要发一堆消息。',
  ]
  if (persona) lines.push(persona)
  if (imagePaths.length) lines.push(`用户发来图片，PC 本地路径：${imagePaths.join('；')}`)
  lines.push(`用户消息：${text}`)
  return lines.join('\n')
}

async function sendLocalImages(session, text) {
  const paths = [...String(text || '').matchAll(/[A-Za-z]:\\[^\n\r"'`<>|]+?\.(?:png|jpe?g|gif|webp)/gi)]
    .map((m) => m[0])
    .filter((v, i, a) => a.indexOf(v) === i)
  for (const file of paths.slice(0, 3)) {
    try {
      const buf = await agent(`/file?path=${encodeURIComponent(file)}`, { timeout: 30000 })
      if (!buf?.length || buf.length > 8 * 1024 * 1024) continue
      await host.reply(chatOf(session), [{ type: 'image', data: { file: `base64://${buf.toString('base64')}` } }])
      host.log('info', `发送 DSH 图片 ${file}`)
    } catch (e) { host.log('warn', `发送图片 ${file} 失败: ${e.message}`) }
  }
}

async function relay(session, text) {
  if (!acp?.connected) {
    try { await ensureAcp() } catch (e) { return host.reply(chatOf(session), `DSH 没连上：${e.message}`) }
  }
  if (relayBusy) return host.reply(chatOf(session), '上一条还在跑，等它完事我马上接。')
  relayBusy = true
  const started = Date.now()
  const timer = setInterval(() => {
    const sec = Math.round((Date.now() - started) / 1000)
    if (sec > 30) host.reply(chatOf(session), `还在跑…已经 ${sec} 秒`).catch(() => {})
  }, 120000)
  try {
    const imagePaths = await uploadIncoming(session)
    await touchTitle(sessionId, text)
    const r = await acp.prompt(sessionId, relayPrompt(text, imagePaths), Number(settings.promptTimeoutMs) || 7200000)
    await host.reply(chatOf(session), r.text || `（DSH 没有说话，stopReason=${r.stopReason}）`)
    await sendLocalImages(session, r.text)
  } catch (e) {
    if (/超时/.test(e.message)) {
      acp.request('session/cancel', { sessionId }).catch(() => {})
      await host.reply(chatOf(session), '等太久了我先不催了，任务已让它停下。')
    } else {
      await host.reply(chatOf(session), `DSH 出错了：${e.message}`)
    }
  } finally { clearInterval(timer); relayBusy = false }
}

async function listSessions(session) {
  try {
    await ensureAcp()
    const list = (await allSessions()).slice(0, 12)
    if (!list.length) return host.reply(chatOf(session), '还没有历史会话。')
    const lines = list.map((x, i) => `${i + 1}. ${x.title}（${x.id.slice(0, 8)}）${x.id === normalizeId(sessionId) ? ' ←当前' : ''}`)
    await host.reply(chatOf(session), ['会话列表（只列 xin；发「切换 n」）：', ...lines].join('\n'))
  } catch (e) { await host.reply(chatOf(session), `读取会话失败：${e.message}`) }
}

async function switchSession(session, index) {
  try {
    await ensureAcp()
    const list = await allSessions()
    const target = list[index - 1]
    if (!target) return host.reply(chatOf(session), `没有第 ${index} 个会话。`)
    let id
    try { id = await acp.resumeSession(target.raw, settings.workspace) }
    catch (e) { if (!/already active/i.test(e.message)) throw e; id = target.raw }
    sessionId = id
    await saveState({ active: true, sessionId: id })
    await host.reply(chatOf(session), `已切换到「${target.title}」`)
  } catch (e) { await host.reply(chatOf(session), `切换失败：${e.message}`) }
}

serve({
  async initialize({ settings: s }) {
    settings = s || {}
    const state = await readState()
    if (state.active) {
      mode = 'starting'
      setTimeout(async () => {
        try {
          await dshServices(false)
          await connectAcp(state.sessionId || '')
          mode = 'dsh'
          host.log('info', `DSH 已重连 ${sessionId}`)
        } catch (e) {
          mode = 'idle'
          host.log('warn', `DSH 重连失败: ${e.message}`)
        }
      }, 3000)
    }
    host.log('info', '电脑管家插件启动')
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...(values || {}) }
    return { ok: true }
  },

  async handle_message({ session }) {
    if (!isOwner(session)) return { handled: false }
    const text = String(session.text || '').trim().replace(/^\//, '')
    if (!text) return { handled: false }

    try {
      if (/^电脑$/.test(text) || /^(pc|电脑状态)$/i.test(text)) {
        await host.reply(chatOf(session), await statusText())
        return { handled: true }
      }
      if (/^(截图|电脑截图|截屏)$/.test(text)) {
        await sendScreenshot(session)
        return { handled: true }
      }
      const act = /^电脑操作\s*(重启|睡眠|休眠|锁屏|注销)$/.exec(text)
      if (act) {
        const map = { 重启: 'restart', 睡眠: 'sleep', 休眠: 'hibernate', 锁屏: 'lock', 注销: 'logoff' }
        await agent(`/action?action=${map[act[1]]}`, { method: 'POST', timeout: 10000 })
        await host.reply(chatOf(session), `已发送「${act[1]}」指令。`)
        return { handled: true }
      }
      if (/^(进入大肥鱼模式|唤醒dsh|唤醒DSH)$/i.test(text)) {
        await enter(session)
        return { handled: true }
      }
      if (/^退出大肥鱼模式(并关机)?$/.test(text)) {
        await exit(session, /并关机$/.test(text))
        return { handled: true }
      }
      if (/^新会话$/.test(text)) {
        try {
          await ensureAcp()
          sessionId = await acp.newSession(settings.workspace)
          await saveState({ active: true, sessionId })
          await touchTitle(sessionId, '新会话')
          await host.reply(chatOf(session), '新会话开好了，直接说话就行。')
        } catch (e) { await host.reply(chatOf(session), `创建会话失败：${e.message}`) }
        return { handled: true }
      }
      if (/^会话列表$/.test(text)) { await listSessions(session); return { handled: true } }
      const sw = /^切换\s*(\d+)$/.exec(text)
      if (sw) { await switchSession(session, Number(sw[1])); return { handled: true } }
      if (/^(切换大肥鱼|回到大肥鱼)$/.test(text)) {
        await switchToDefault(session)
        return { handled: true }
      }

      if (mode !== 'dsh') return { handled: false }
      if (session.chat_type === 'group') return { handled: false }
      await relay(session, text)
      return { handled: true }
    } catch (e) {
      host.log('error', `电脑管家: ${e.message}`)
      await host.reply(chatOf(session), `操作失败：${e.message}`)
      return { handled: true }
    }
  },

  async call_tool({ name, args }) {
    try {
      if (name === 'get_pc_status') return { ok: true, data: { text: await statusText() } }
      if (name === 'pc_screenshot') {
        const buf = await agent('/screen', { timeout: 30000 })
        return { ok: true, data: { image: buf.toString('base64') } }
      }
      if (name === 'pc_action') {
        await agent(`/action?action=${encodeURIComponent(args?.action || '')}`, { method: 'POST', timeout: 10000 })
        return { ok: true, data: { text: `已发送 ${args?.action}` } }
      }
      if (name === 'get_dsh_status') {
        return { ok: true, data: { text: `模式：${mode}\nACP：${acp?.connected ? '已连接' : '未连接'}\n会话：${sessionId || '无'}` } }
      }
      return { ok: false, error: `未知工具 ${name}` }
    } catch (e) { return { ok: false, error: e.message } }
  },
})
