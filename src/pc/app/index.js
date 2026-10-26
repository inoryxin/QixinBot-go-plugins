import { serve, host } from '../_sdk/qixin.mjs'
import { AcpTcpClient } from './acp.mjs'
import dgram from 'node:dgram'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

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
  const host = settings.pcHost || '10.0.0.99'
  try {
    await agent('/status', { timeout: 5000 })
    return true
  } catch {}

  const archPort = Number(settings.archPort) || 22222
  if (!(await probePort(host, archPort))) {
    const entity = String(settings.haEntity || 'switch.lemesh_cn_1117316460_sw0a04_on_p_2_1')
    const state = await haRequest('GET', `/api/states/${encodeURIComponent(entity)}`)
    if (state.state !== 'on') {
      await haRequest('POST', '/api/services/switch/turn_on', { entity_id: entity })
      await host.reply(chatOf(session), '插座已通电，等电脑开机…')
    } else {
      await host.reply(chatOf(session), '插座是通电的，电脑可能在启动…')
    }
    await host.reply(chatOf(session), '等 Arch 起来（大约一分钟）…')
    await waitPort(host, archPort, Number(settings.bootTimeoutMs) || 180000, 'Arch 启动')
  }
  await host.reply(chatOf(session), 'Arch 已在线，发重启指令切到 Windows…')
  await fetch(String(settings.archLaunchUrl || `http://${host}:22222/launch?token=111111&app=reboot`), { signal: AbortSignal.timeout(10000) })
  await host.reply(chatOf(session), '等 Windows 重启（大约一分钟）…')
  const deadline = Date.now() + (Number(settings.bootTimeoutMs) || 180000)
  while (Date.now() < deadline) {
    try { await agent('/status', { timeout: 5000 }); return true } catch {}
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

async function wakeOnLan() {
  const mac = String(settings.macAddress || '50:6B:4B:1D:5B:A7').replace(/[^0-9a-f]/gi, '')
  if (mac.length !== 12) throw new Error('MAC 地址格式不对')
  const target = Buffer.alloc(6, 0xff)
  const addr = Buffer.from(mac, 'hex')
  const packet = Buffer.concat([target, ...Array(16).fill(addr)])
  const socket = dgram.createSocket('udp4')
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(() => {
      try { socket.setBroadcast(true) } catch {}
      socket.send(packet, 9, String(settings.broadcast || '255.255.255.255'), (err) => {
        socket.close()
        err ? reject(err) : resolve()
      })
    })
  })
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

async function connectAcp(resume) {
  const deadline = Date.now() + 30000
  let last
  while (Date.now() < deadline) {
    const client = new AcpTcpClient({ host: settings.acpHost, port: Number(settings.acpPort) || 3099, token: settings.acpToken || '111111' })
    try {
      await client.connect(10000)
      await client.initialize()
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
    let id
    try { id = await connectAcp(state.sessionId || '') }
    catch { id = await connectAcp('') }
    await saveState({ active: true, sessionId: id, defaultSessionId: state.defaultSessionId || id })
    mode = 'dsh'
    await openDshWeb(svc.web?.url)
    await host.reply(chatOf(session), `大肥鱼模式已接管，DSH 会话 ${String(id).slice(0, 8)}。\n发「新会话」「会话列表」「切换 n」；发「退出大肥鱼模式」还给我。`)
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
    try { await agent('/action?action=shutdown', { method: 'POST', timeout: 10000 }); await host.reply(chatOf(session), '已退出，电脑关机指令已发送。') }
    catch (e) { await host.reply(chatOf(session), `已退出，但关机失败：${e.message}`) }
  } else {
    await host.reply(chatOf(session), '已退出大肥鱼模式，聊天交回给我。')
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
    const r = await acp.prompt(sessionId, text, Number(settings.promptTimeoutMs) || 7200000)
    await host.reply(chatOf(session), r.text || `（DSH 没有说话，stopReason=${r.stopReason}）`)
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
    const r = await acp.listSessions(settings.workspace)
    const list = (r?.sessions || []).slice(0, 12)
    if (!list.length) return host.reply(chatOf(session), '还没有历史会话。')
    const lines = list.map((x, i) => `${i + 1}. ${x.sessionId.slice(0, 8)}${x.sessionId === sessionId ? ' ←当前' : ''}`)
    await host.reply(chatOf(session), ['会话列表（发「切换 n」）：', ...lines].join('\n'))
  } catch (e) { await host.reply(chatOf(session), `读取会话失败：${e.message}`) }
}

async function switchSession(session, index) {
  try {
    await ensureAcp()
    const r = await acp.listSessions(settings.workspace)
    const target = (r?.sessions || [])[index - 1]
    if (!target) return host.reply(chatOf(session), `没有第 ${index} 个会话。`)
    let id
    try { id = await acp.resumeSession(target.sessionId, settings.workspace) }
    catch (e) { if (!/already active/i.test(e.message)) throw e; id = target.sessionId }
    sessionId = id
    await saveState({ active: true, sessionId: id })
    await host.reply(chatOf(session), `已切换到 ${id.slice(0, 8)}`)
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
      const act = /^电脑操作\s*(开机|关机|重启|睡眠|休眠|锁屏|注销)$/.exec(text)
      if (act) {
        if (act[1] === '开机') {
          await wakeOnLan()
          await host.reply(chatOf(session), '已发送网络唤醒（需要主板/NIC 开 WOL）。')
          return { handled: true }
        }
        const map = { 关机: 'shutdown', 重启: 'restart', 睡眠: 'sleep', 休眠: 'hibernate', 锁屏: 'lock', 注销: 'logoff' }
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
          await host.reply(chatOf(session), '新会话开好了，直接说话就行。')
        } catch (e) { await host.reply(chatOf(session), `创建会话失败：${e.message}`) }
        return { handled: true }
      }
      if (/^会话列表$/.test(text)) { await listSessions(session); return { handled: true } }
      const sw = /^切换\s*(\d+)$/.exec(text)
      if (sw) { await switchSession(session, Number(sw[1])); return { handled: true } }
      if (/^(切换大肥鱼|回到大肥鱼)$/.test(text)) {
        const st = await readState()
        if (!st.defaultSessionId) { await host.reply(chatOf(session), '还没有默认会话，先进一次大肥鱼模式。'); return { handled: true } }
        try {
          await ensureAcp()
          sessionId = await acp.resumeSession(st.defaultSessionId, settings.workspace)
          await saveState({ active: true, sessionId })
          await host.reply(chatOf(session), '已切回大肥鱼。')
        } catch (e) { await host.reply(chatOf(session), `切换失败：${e.message}`) }
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
      if (name === 'pc_power_on') {
        await wakeOnLan()
        return { ok: true, data: { text: '已发送网络唤醒' } }
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
