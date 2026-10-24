// 发语音：文字 → 微软 Edge 神经网络语音 → 语音消息。
//
// 为什么用本地 Python：Node 的几个 edge-tts 包都连不上（握手/超时），
// 而 Python 官方的 edge-tts 一直维护、能用。远端装了个便携 Python。

import { serve, host, chatOf } from '../_sdk/qixin.mjs'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(__dirname, '..')
const OUT_DIR = path.join(PLUGIN_DIR, 'data', 'voice')

let settings = {}

const VOICES = [
  ['zh-CN-XiaoxiaoNeural', '晓晓 · 温柔女声（默认）'],
  ['zh-CN-XiaoyiNeural', '晓伊 · 活泼女声'],
  ['zh-CN-YunxiNeural', '云希 · 年轻男声'],
  ['zh-CN-YunjianNeural', '云健 · 沉稳男声'],
  ['zh-CN-liaoning-XiaobeiNeural', '晓北 · 东北话'],
  ['zh-CN-shaanxi-XiaoniNeural', '晓妮 · 陕西话'],
]

function python() {
  return String(settings.python_path || 'C:\\qqbot\\tools\\py\\python.exe')
}

function run(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(python(), args, { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      resolve({ ok: false, error: '合成超时' })
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, out, err })
    })
  })
}

// 文本清洗：去掉 markdown/表情，读出来才顺
function cleanForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function synth(text, override = {}) {
  const clean = cleanForSpeech(text)
  if (!clean) return { ok: false, error: '没有可读的文字' }

  const limit = Number(settings.max_chars) || 300
  const say = clean.length > limit ? clean.slice(0, limit) : clean

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const file = path.join(OUT_DIR, `v-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.mp3`)

  const r = await run([
    '-m', 'edge_tts',
    '--text', say,
    '--voice', String(override.voice || settings.voice || 'zh-CN-XiaoxiaoNeural'),
    '--rate=' + String(override.rate || settings.rate || '+0%'),
    '--write-media', file,
  ])

  if (!r.ok || !fs.existsSync(file) || fs.statSync(file).size < 500) {
    host.log('warn', `语音合成失败 code=${r.code} ${String(r.err || r.error || '').slice(0, 160)}`)
    return { ok: false, error: r.error || r.err || '合成失败' }
  }
  return { ok: true, file, size: fs.statSync(file).size }
}

async function say(chat, text) {
  const r = await synth(text)
  if (!r.ok) return r
  try {
    await host.sendMessage(chat, [{ type: 'record', data: { file: r.file } }])
    return { ok: true, file: r.file, size: r.size }
  } catch (e) {
    host.log('warn', '语音发送失败: ' + e.message)
    return { ok: false, error: e.message }
  }
}

// 清掉过期的合成文件（默认留 1 天）
function cleanup() {
  try {
    const days = Math.max(0, Number(settings.keep_days ?? 1))
    if (!fs.existsSync(OUT_DIR)) return
    const cutoff = Date.now() - days * 86400_000
    for (const f of fs.readdirSync(OUT_DIR)) {
      const p = path.join(OUT_DIR, f)
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p)
    }
  } catch (e) {
    host.log('debug', '清理语音缓存失败: ' + e.message)
  }
}

serve({
  async initialize({ settings: s }) {
    settings = s || {}
    host.log('info', `发语音已加载（音色 ${settings.voice || 'zh-CN-XiaoxiaoNeural'}）`)
    cleanup()
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...values }
    return { ok: true }
  },

  async call_tool({ name, args }) {
    if (name === 'voice.preview') {
      const r = await synth(args?.text, { voice: args?.voice, rate: args?.rate })
      if (!r.ok) return r
      const b64 = fs.readFileSync(r.file).toString('base64')
      try { fs.unlinkSync(r.file) } catch {}
      return { ok: true, data: { audio: b64, mime: 'audio/mpeg', bytes: r.size } }
    }

    if (name === 'voice.cache') {
      const action = String(args?.action || 'stats')
      let files = []
      try { files = fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR) : [] } catch {}
      const bytes = files.reduce((a, f) => {
        try { return a + fs.statSync(path.join(OUT_DIR, f)).size } catch { return a }
      }, 0)
      if (action === 'clear') {
        for (const f of files) { try { fs.unlinkSync(path.join(OUT_DIR, f)) } catch {} }
        return { ok: true, data: { cleared: files.length } }
      }
      return { ok: true, data: { files: files.length, bytes } }
    }

    if (name !== 'voice.say') return { ok: false, error: '未知能力: ' + name }
    const chat = {
      account: String(args?.account || ''),
      chat_type: String(args?.chat_type || 'private'),
      chat_id: Number(args?.chat_id || 0),
    }
    if (!chat.chat_id) return { ok: false, error: '需要 chat_id' }
    const r = await say(chat, args?.text)
    if (!r.ok) return r
    return { ok: true, data: { file: r.file, bytes: r.size } }
  },

  async handle_message({ session }) {
    const text = (session.text || '').trim()
    if (!/^语音(\s|$)/.test(text)) return { handled: false }

    const rest = text.replace(/^语音\s*/, '').trim()
    const sub = rest.split(/\s+/)[0].toLowerCase()

    if (sub === '声音' || sub === '音色' || sub === 'list') {
      const lines = ['可选音色（设置里填 id）：']
      for (const [id, name] of VOICES) lines.push(`· ${id}　${name}`)
      await host.reply(chatOf(session), lines.join('\n'))
      return { handled: true }
    }

    const body = sub === '测试' ? rest.slice(2).trim() : rest
    const sayText = body || '这是一条测试语音，能听见吗'
    const r = await say(chatOf(session), sayText)
    if (!r.ok) await host.reply(chatOf(session), `语音没发出去：${r.error}`)
    return { handled: true }
  },
})
