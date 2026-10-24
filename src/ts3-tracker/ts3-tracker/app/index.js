// TS3 在线追踪
//
// 从 QixinBot 的 ts3-tracker 移植。原版用 module.exports + setup/setInterval，
// 这里换成 serve + handle_message + [[schedule]]。
//
// TeamSpeak 3 ServerQuery 是纯 TCP 文本协议：
//   连上 → 发命令（每行一条）→ 每条命令回一行数据 + 一行 `error id=0 msg=ok`
import net from 'node:net'
import { serve, host, chatOf } from '../_sdk/qixin.mjs'

let settings = {}
let lastPollAt = 0

// ---------------------------------------------------------------- ServerQuery

function escapeValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/ /g, '\\s')
    .replace(/\|/g, '\\p')
    .replace(/\//g, '\\/')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
}

function decodeValue(value) {
  return String(value ?? '')
    .replace(/\\s/g, ' ')
    .replace(/\\p/g, '|')
    .replace(/\\\//g, '/')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
}

function parseRecord(line) {
  const record = {}
  for (const field of String(line ?? '').split(/\s+/)) {
    const index = field.indexOf('=')
    if (index <= 0) continue
    record[field.slice(0, index)] = decodeValue(field.slice(index + 1))
  }
  return record
}

function parseList(line) {
  if (!line) return []
  return line.split('|').map(parseRecord)
}

// 一次连接跑完所有命令，按 `error id=` 分段收结果
function runQuery(commands, opts, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: opts.host, port: opts.queryPort })
    socket.setTimeout(timeoutMs)
    let buffer = ''
    let index = 0
    const results = []
    let settled = false

    const finish = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve(results)
    }

    socket.on('connect', () => {
      socket.write(commands.join('\n') + '\n')
    })

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      buffer = buffer.replace(/\r/g, '\n')
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line || line === 'TS3' || line.startsWith('Welcome to the TeamSpeak')) continue

        if (!line.startsWith('error id=')) {
          if (index < commands.length) {
            results[index] = results[index] || { lines: [] }
            results[index].lines.push(line)
          }
          continue
        }

        const error = parseRecord(line.replace(/^error\s+/, ''))
        results[index] = { ...results[index], lines: results[index]?.lines || [], error }
        index += 1
        if (index >= commands.length) finish()
      }
    })

    socket.on('timeout', () => finish(new Error('ServerQuery 超时')))
    socket.on('error', (error) => finish(new Error(`ServerQuery 连接失败：${error.message}`)))
    socket.on('close', () => {
      if (!settled) finish(new Error('ServerQuery 连接被关闭'))
    })
  })
}

function sqlOk(result) {
  return result?.error?.id === '0'
}

async function query() {
  const hostAddr = String(settings.host ?? '').trim() || '10.0.0.123'
  const queryPort = Number(settings.queryPort) || 10011
  const voicePort = Number(settings.voicePort) || 9987
  const timeoutMs = Number(settings.timeoutMs) || 10000

  const commands = []
  const username = String(settings.username ?? '').trim()
  const password = String(settings.password ?? '')
  if (username && password) {
    commands.push(`login ${escapeValue(username)} ${escapeValue(password)}`)
  }
  commands.push(`use port=${voicePort}`, 'channellist', 'clientlist', 'serverinfo')

  const results = await runQuery(commands, { host: hostAddr, queryPort }, timeoutMs)

  let offset = 0
  if (username && password) {
    const login = results[offset]
    offset += 1
    if (!sqlOk(login)) {
      throw new Error(`ServerQuery 登录失败：${login?.error?.msg || '未知错误'}`)
    }
  }

  const use = results[offset]
  const channelsResult = results[offset + 1]
  const clientsResult = results[offset + 2]
  const infoResult = results[offset + 3]

  if (!sqlOk(use)) throw new Error(`选择服务器失败：${use?.error?.msg || ''}`)
  if (!sqlOk(channelsResult) || !sqlOk(clientsResult)) {
    const message = channelsResult?.error?.msg || clientsResult?.error?.msg || ''
    throw new Error(
      message.includes('insufficient') || message.includes('permission')
        ? 'ServerQuery 权限不足，请在设置里填 Query 用户名和密码'
        : `查询失败：${message}`,
    )
  }

  const publicHost = String(settings.publicHost ?? '').trim()
  const publicPort = Number(settings.publicPort) || 0
  const publicAddress = !publicHost
    ? `${hostAddr}:${voicePort}`
    : publicPort > 0
      ? `${publicHost}:${publicPort}`
      : publicHost

  return {
    address: `${hostAddr}:${voicePort}`,
    publicAddress,
    channels: parseList(channelsResult.lines?.[0] ?? ''),
    clients: parseList(clientsResult.lines?.[0] ?? '').filter((item) => item.client_type !== '1'),
    info: parseRecord(infoResult?.lines?.[0] ?? ''),
  }
}

// ---------------------------------------------------------------- 渲染

function statusText(data) {
  const address = data.publicAddress || data.address
  if (!data.clients.length) return `TS3 ${address}\n当前没有人在线`

  const byChannel = new Map()
  for (const client of data.clients) {
    const cid = client.cid ?? '0'
    if (!byChannel.has(cid)) byChannel.set(cid, [])
    byChannel.get(cid).push(client.client_nickname ?? '未知')
  }

  const channelName = new Map(data.channels.map((c) => [c.cid, c.channel_name ?? '未知频道']))
  const lines = [`TS3 在线 ${data.clients.length} 人 · ${address}`]

  for (const [cid, names] of byChannel) {
    lines.push(`▸ ${channelName.get(cid) || `频道 ${cid}`}（${names.length}）`)
    for (const name of names.slice(0, 20)) lines.push(`  · ${name}`)
    if (names.length > 20) lines.push(`  · …还有 ${names.length - 20} 人`)
  }
  return lines.join('\n')
}

function infoText(data) {
  const info = data.info
  const uptime = Number(info.virtualserver_uptime) || 0
  const days = Math.floor(uptime / 86400)
  const hours = Math.floor((uptime % 86400) / 3600)
  const minutes = Math.floor((uptime % 3600) / 60)
  const running =
    [`${days} 天`, `${hours} 小时`, `${minutes} 分`].filter((p) => !p.startsWith('0 ')).join(' ') || '刚启动'

  return [
    `服务器：${info.virtualserver_name || '未知'}`,
    `地址：${data.publicAddress || data.address}`,
    `在线：${info.virtualserver_clientsonline ?? '?'} / ${info.virtualserver_maxclients ?? '?'}`,
    `频道：${info.virtualserver_channelsonline ?? data.channels.length}`,
    `运行：${running}`,
    `版本：${info.virtualserver_version || '未知'}`,
  ].join('\n')
}

function diffClients(before, after) {
  const beforeIds = new Set(before.map((item) => String(item.clid)))
  const afterIds = new Set(after.map((item) => String(item.clid)))
  return {
    joined: after.filter((item) => !beforeIds.has(String(item.clid))),
    left: before.filter((item) => !afterIds.has(String(item.clid))),
  }
}

// ---------------------------------------------------------------- 通知

function notifyTargets() {
  const groups = String(settings.notifyGroups ?? '')
    .split(/[|｜,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((id) => ({ chat_type: 'group', chat_id: Number(id) }))
  const users = String(settings.notifyUsers ?? '')
    .split(/[|｜,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((id) => ({ chat_type: 'private', chat_id: Number(id) }))
  return [...groups, ...users]
}

async function broadcast(message) {
  for (const chat of notifyTargets()) {
    try {
      await host.sendMessage(chat, [{ type: 'text', data: { text: message } }])
    } catch (error) {
      host.log('warn', `通知 ${chat.chat_type}:${chat.chat_id} 失败: ${error.message}`)
    }
  }
}

// ---------------------------------------------------------------- 轮询

async function poll() {
  if (!settings.notifyEnabled) return

  const data = await query()
  const current = data.clients.map((c) => ({
    clid: c.clid,
    name: c.client_nickname || '未知',
    cid: c.cid,
  }))

  const prevRaw = await host.storage.get('state')
  const prev = prevRaw && typeof prevRaw === 'object' ? prevRaw : null
  await host.storage.set('state', { at: Date.now(), clients: current })

  if (!prev || !Array.isArray(prev.clients)) return
  // 停机太久就别补发一堆历史变动了
  if (Date.now() - Number(prev.at || 0) > 600000) return

  const { joined, left } = diffClients(prev.clients, current)
  if (!joined.length && !left.length) return

  const channels = new Map(data.channels.map((c) => [c.cid, c.channel_name || '']))
  for (const client of joined) {
    const where = channels.get(client.cid) ? `（${channels.get(client.cid)}）` : ''
    await broadcast(`🔔 ${client.name} 进入了 TS3${where}\n当前在线 ${current.length} 人`)
  }
  for (const client of left) {
    await broadcast(`👋 ${client.name} 离开了 TS3\n当前在线 ${current.length} 人`)
  }
}

// ---------------------------------------------------------------- 服务

serve({
  async initialize({ settings: initial }) {
    settings = initial || {}
    host.log('info', `TS3 追踪启动 host=${settings.host || '未配置'}`)
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...values }
    return { ok: true }
  },

  async handle_message({ session }) {
    const text = (session.text || '').trim()
    if (!text) return { handled: false }

    const first = text.split(/\s+/)[0].toLowerCase()
    const isInfo = first === 'ts3info' || first === 'tsinfo' || first === 'ts信息'
    const isStatus = first === 'ts3' || first === 'ts' || first === '上号'
    if (!isInfo && !isStatus) return { handled: false }

    try {
      const data = await query()
      await host.reply(chatOf(session), isInfo ? infoText(data) : statusText(data))
    } catch (error) {
      host.log('error', `查询失败: ${error.message}`)
      await host.reply(chatOf(session), error.message)
    }
    return { handled: true }
  },

  async call_tool({ name }) {
    if (name !== 'ts3_status') return { ok: false, error: `未知工具 ${name}` }
    try {
      const data = await query()
      return { ok: true, data: { text: statusText(data), online: data.clients.length } }
    } catch (error) {
      return { ok: false, error: error.message, retryable: true }
    }
  },

  async run_task({ task }) {
    if (task !== 'poll') return { ok: true }

    // schedule 是固定 15 秒，实际间隔由 pollSeconds 控制
    const every = Math.max(15, Number(settings.pollSeconds) || 30) * 1000
    if (Date.now() - lastPollAt < every) return { ok: true }
    lastPollAt = Date.now()

    try {
      await poll()
    } catch (error) {
      host.log('debug', `轮询失败: ${error.message}`)
    }
    return { ok: true }
  },
})
