// Minimal ACP (Agent Client Protocol) client for driving a DSH agent.
// Framing is newline-delimited JSON-RPC 2.0.
//
// Two transports:
//   AcpClient     spawn a local process (stdio)
//   AcpTcpClient  connect to the ACP TCP bridge on the Windows PC

import net from 'node:net'
import { spawn } from 'node:child_process'

class Protocol {
  constructor(onUpdate) {
    this.onUpdate = onUpdate
    this.nextId = 1
    this.pending = new Map()
    this.chunks = new Map()
    this.buffer = ''
    this.lastPromptId = 0
  }

  handleLine(line) {
    const text = line.trim()
    if (!text) return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    this.dispatch(message)
  }

  dispatch(message) {
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)))
      else pending.resolve(message.result)
      return
    }

    if (message.method === 'session/update') {
      const sessionId = message.params?.sessionId
      const update = message.params?.update
      this.onUpdate?.(sessionId, update)
      if (update?.sessionUpdate === 'agent_message_chunk') {
        const chunk = update.content?.text ?? ''
        if (chunk) this.chunks.set(sessionId, (this.chunks.get(sessionId) ?? '') + chunk)
      }
      return
    }

    // Permissions: trusted controller auto-approves the first allow option.
    if (message.method === 'session/request_permission') {
      const options = message.params?.options ?? []
      const allow = options.find((option) => /allow/i.test(option.kind ?? '')) ?? options[0]
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        result: allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : { outcome: { outcome: 'cancelled' } },
      })
      return
    }

    if (message.id !== undefined) this.write({ jsonrpc: '2.0', id: message.id, result: {} })
  }

  request(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  initialize() {
    return this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })
  }

  async newSession(cwd) {
    const result = await this.request('session/new', { cwd, mcpServers: [] })
    return result.sessionId
  }

  listSessions(cwd) {
    return this.request('session/list', cwd ? { cwd } : {})
  }

  async resumeSession(sessionId, cwd) {
    await this.request('session/resume', { sessionId, cwd, mcpServers: [] })
    // ACP acknowledges without echoing the id; keep the requested one.
    return sessionId
  }

  async prompt(sessionId, text, timeoutMs = 180000) {
    this.chunks.set(sessionId, '')
    const id = this.nextId
    const timer = setTimeout(() => {
      const pending = this.pending.get(id)
      if (pending) {
        this.pending.delete(id)
        pending.reject(new Error('ACP 回复超时'))
      }
    }, timeoutMs)
    try {
      const result = await this.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: String(text) }],
      })
      return { text: (this.chunks.get(sessionId) ?? '').trim(), stopReason: result?.stopReason }
    } finally {
      clearTimeout(timer)
    }
  }
}

class AcpClient extends Protocol {
  constructor({ command, args = [], cwd, env, onUpdate } = {}) {
    super(onUpdate)
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.child = undefined
    this.exited = false
  }

  start() {
    if (this.child) return this
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...(this.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8')
      let index
      while ((index = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + 1)
        this.handleLine(line)
      }
    })
    this.child.on('exit', () => {
      this.exited = true
      for (const { reject } of this.pending.values()) reject(new Error('ACP 进程已退出'))
      this.pending.clear()
    })
    return this
  }

  write(message) {
    if (!this.child || this.exited) throw new Error('ACP 未连接')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  close() {
    this.exited = true
    try {
      this.child?.kill()
    } catch {
      // best effort
    }
    this.child = undefined
  }
}

class AcpTcpClient extends Protocol {
  constructor({ host = '10.0.0.99', port = 3099, token = '111111', onUpdate } = {}) {
    super(onUpdate)
    this.host = host
    this.port = port
    this.token = token
    this.socket = undefined
    this.connected = false
  }

  async connect(timeoutMs = 10000) {
    if (this.socket) return this
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port })
      this.socket = socket
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`连接 ACP 桥超时（${this.host}:${this.port}）`))
      }, timeoutMs)

      socket.setEncoding('utf8')
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.write(`${JSON.stringify({ token: this.token })}\n`)
        this.connected = true
        resolve()
      })
      socket.on('data', (chunk) => {
        this.buffer += chunk
        let index
        while ((index = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, index)
          this.buffer = this.buffer.slice(index + 1)
          this.handleLine(line)
        }
      })
      socket.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      socket.on('close', () => {
        this.connected = false
        for (const { reject: rejectPending } of this.pending.values()) rejectPending(new Error('ACP 连接已断开'))
        this.pending.clear()
      })
    })
    return this
  }

  write(message) {
    if (!this.socket || !this.connected) throw new Error('ACP 未连接')
    this.socket.write(`${JSON.stringify(message)}\n`)
  }

  close() {
    this.connected = false
    try {
      this.socket?.destroy()
    } catch {
      // best effort
    }
    this.socket = undefined
  }
}

export { AcpClient, AcpTcpClient }
