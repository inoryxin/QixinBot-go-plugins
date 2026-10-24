// 画布服务
//
// 把 @napi-rs/canvas 封装成一个服务插件。别的插件通过 canvas.render 能力
// 传一串绘制指令，拿回 base64 图片，就不用各自打包 27MB 的原生模块了。
//
// 换平台只需换这个包的 app/node_modules，其他插件一行不用改。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { serve, host } from '../_sdk/qixin.mjs'

const require = createRequire(import.meta.url)
const { createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 字体不归画布服务所有：扫所有插件的 fonts/ 目录，
// 谁要画中文谁自己带字体，canvas 只负责注册成全局字体
const RUNTIME_DIR = path.resolve(__dirname, '..', '..')

let settings = {}
let fontsLoaded = false
const imageCache = new Map()

// ---------------------------------------------------------------- 字体

// 可能的字体目录：<插件>/app/fonts、<插件>/fonts、<插件>/assets/font
const FONT_SUBDIRS = ['assets/fonts', 'assets/font', 'app/fonts', 'fonts']

function ensureFonts() {
  if (fontsLoaded) return
  try {
    if (!fs.existsSync(RUNTIME_DIR)) return
    for (const pluginDir of fs.readdirSync(RUNTIME_DIR, { withFileTypes: true })) {
      if (!pluginDir.isDirectory() || pluginDir.name.startsWith('.')) continue
      for (const sub of FONT_SUBDIRS) {
        const dir = path.join(RUNTIME_DIR, pluginDir.name, sub)
        if (!fs.existsSync(dir)) continue
        for (const file of fs.readdirSync(dir)) {
          if (!/\.(ttf|otf|ttc)$/i.test(file)) continue
          const alias = path.basename(file, path.extname(file))
          try {
            GlobalFonts.registerFromPath(path.join(dir, file), alias)
            host.log('debug', `画布：注册字体 ${alias}（来自 ${pluginDir.name}/${sub}）`)
          } catch (err) {
            host.log('warn', `画布：字体 ${file} 注册失败 ${err.message}`)
          }
        }
      }
    }
    fontsLoaded = true
  } catch (err) {
    host.log('warn', `画布：扫描字体失败 ${err.message}`)
  }
}

// ---------------------------------------------------------------- 图片

async function loadImageCached(src) {
  if (imageCache.has(src)) return imageCache.get(src)
  let buffer
  if (String(src).startsWith('data:')) {
    buffer = Buffer.from(String(src).split(',')[1] || '', 'base64')
  } else if (String(src).startsWith('base64://')) {
    buffer = Buffer.from(String(src).slice(9), 'base64')
  } else if (String(src).startsWith('http')) {
    const resp = await fetch(src, { signal: AbortSignal.timeout(15000) })
    if (!resp.ok) throw new Error(`下载图片失败 HTTP ${resp.status}`)
    buffer = Buffer.from(await resp.arrayBuffer())
  } else {
    buffer = fs.readFileSync(src)
  }
  const img = await loadImage(buffer)
  // 只缓存小图，避免内存涨太快
  if (buffer.length < 2 * 1024 * 1024) imageCache.set(src, img)
  return img
}

// ---------------------------------------------------------------- 绘制

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

// 框架兜底字体：插件不指定 font 时用它，保证中文不会变方块
const DEFAULT_FONT = 'LXGWWenKai'

function fontOf(op) {
  const size = Number(op.size) || 16
  const weight = op.bold ? 'bold ' : ''
  // 插件可以传自己的字体名，没有就用框架带的开源字体
  const family = op.font || `"${DEFAULT_FONT}"`
  return `${weight}${size}px ${family}`
}

// 按宽度折行（中文按字切）
function wrapText(ctx, text, maxWidth, maxLines) {
  const lines = []
  let current = ''
  for (const ch of String(text)) {
    if (ctx.measureText(current + ch).width > maxWidth && current) {
      lines.push(current)
      current = ch
      if (maxLines && lines.length >= maxLines) return lines
    } else {
      current += ch
    }
  }
  if (current) lines.push(current)
  return maxLines ? lines.slice(0, maxLines) : lines
}

async function renderOps({ width = 800, height = 600, background, ops = [], format, quality }) {
  ensureFonts()

  const canvas = createCanvas(Number(width) || 800, Number(height) || 600)
  const ctx = canvas.getContext('2d')

  if (background) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }

  for (const op of ops) {
    switch (op.type) {
      case 'image': {
        const img = await loadImageCached(op.src)
        const x = Number(op.x) || 0
        const y = Number(op.y) || 0
        const w = Number(op.w) || img.width
        const h = Number(op.h) || img.height
        if (op.round) {
          ctx.save()
          roundRect(ctx, x, y, w, h, Number(op.round))
          ctx.clip()
          ctx.drawImage(img, x, y, w, h)
          ctx.restore()
        } else {
          ctx.drawImage(img, x, y, w, h)
        }
        break
      }

      case 'rect': {
        ctx.beginPath()
        const x = Number(op.x) || 0
        const y = Number(op.y) || 0
        const w = Number(op.w) || 0
        const h = Number(op.h) || 0
        if (op.radius) roundRect(ctx, x, y, w, h, Number(op.radius))
        else ctx.rect(x, y, w, h)
        if (op.fill) {
          ctx.fillStyle = op.fill
          ctx.fill()
        }
        if (op.stroke) {
          ctx.strokeStyle = op.stroke
          ctx.lineWidth = Number(op.lineWidth) || 1
          ctx.stroke()
        }
        break
      }

      case 'text': {
        ctx.font = fontOf(op)
        ctx.fillStyle = op.color || '#1d1d1f'
        ctx.textBaseline = op.baseline || 'alphabetic'
        ctx.textAlign = op.align || 'left'

        const text = String(op.text ?? '')
        if (op.vertical) {
          // 竖排：逐字往下画
          const size = Number(op.size) || 16
          const step = size + (Number(op.gap) || 4)
          const chars = [...text]
          for (let i = 0; i < chars.length; i++) {
            ctx.fillText(chars[i], Number(op.x) || 0, (Number(op.y) || 0) + i * step)
          }
        } else if (op.wrap) {
          const lines = wrapText(ctx, text, Number(op.wrap), Number(op.maxLines) || 0)
          const lineHeight = Number(op.lineHeight) || (Number(op.size) || 16) * 1.5
          for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], Number(op.x) || 0, (Number(op.y) || 0) + i * lineHeight)
          }
        } else {
          ctx.fillText(text, Number(op.x) || 0, Number(op.y) || 0)
        }
        break
      }

      case 'ellipsis': {
        ctx.font = fontOf(op)
        ctx.fillStyle = op.color || '#1d1d1f'
        ctx.textBaseline = op.baseline || 'alphabetic'
        const maxWidth = Number(op.wrap) || 200
        let text = String(op.text ?? '')
        if (ctx.measureText(text).width > maxWidth) {
          while (text.length > 1 && ctx.measureText(text + '…').width > maxWidth) {
            text = text.slice(0, -1)
          }
          text += '…'
        }
        ctx.fillText(text, Number(op.x) || 0, Number(op.y) || 0)
        break
      }

      case 'measure': {
        // 给调用方量文字宽度用（返回结果在 measures 里）
        ctx.font = fontOf(op)
        const m = ctx.measureText(String(op.text ?? ''))
        op.__result = m.width
        break
      }

      default:
        break
    }
  }

  // 调用方能按次指定格式：周报这种大图用 JPEG 省 4 倍体积
  const fmt = format || settings.format || 'image/png'
  const q = Number(quality) || Number(settings.quality) || 88
  return canvas.toBuffer(fmt, fmt === 'image/jpeg' ? q : undefined)
}

// ---------------------------------------------------------------- 服务

serve({
  async initialize({ settings: initial }) {
    settings = initial || {}
    // 启动时先扫一遍；之后每次渲染前再 ensure（新装插件能热生效）
    ensureFonts()
    host.log('info', '画布服务启动')
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...values }
    return { ok: true }
  },

  async call_tool({ name, args }) {
    return callCapability(name, args)
  },

  // 能力调用统一入口
  async __capability(name, args) {
    return callCapability(name, args)
  },
})

async function callCapability(name, args) {
  // 量图片尺寸：调用方算布局要用
  if (name === 'canvas.probe') {
    const urls = Array.isArray(args?.urls) ? args.urls : []
    const out = []
    for (const url of urls.slice(0, 60)) {
      try {
        const img = await loadImageCached(url)
        out.push({ url, width: img.width, height: img.height })
      } catch {
        out.push({ url, width: 0, height: 0 })
      }
    }
    return { ok: true, data: { sizes: out } }
  }

  if (name !== 'canvas.render') return { ok: false, error: `未知能力 ${name}` }
  try {
    const buffer = await renderOps(args || {})
    return { ok: true, data: { image: buffer.toString('base64'), format: args?.format || settings.format || 'image/png' } }
  } catch (err) {
    host.log('error', `画布渲染失败: ${err.message}`)
    return { ok: false, error: err.message }
  }
}
