// 国 G 周报的排版与绘制指令
//
// 原来 render.cjs 里直接 require('@napi-rs/canvas') 自己画，现在改成两段式：
//   1. 这里只算坐标、产出 ops（纯计算，不碰画布）
//   2. 「真正画」交给 canvas 服务插件：canvas.probe 量图、canvas.render 出图
//
// 好处：换平台时只换 canvas 那个包，这个插件一行不用改；
// 包体积也不用再扛 27MB 的 skia 原生模块。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { host } from '../../_sdk/qixin.mjs'
import { probe, renderOps } from '../../_sdk/canvas-kit.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const WIDTH = 1080
const PAD = 40
const GAP = 16
const COLS = 3
const COL_W = Math.floor((WIDTH - PAD * 2 - GAP * (COLS - 1)) / COLS)
const CARD_TEXT_H = 68
const FALLBACK_RATIO = 16 / 9
const THUMB_H = 90

const COLORS = {
  bg: '#f6f5f2',
  card: '#ffffff',
  ink: '#1d1d1f',
  mute: '#6b6b70',
  line: '#e3e0d8',
  accent: '#b4453a',
  green: '#2f6f5e',
  chip: '#efece4',
}

// canvas 服务扫描各插件的 assets/fonts，把字体注册成全局的。
// 这里给一个字体栈：有 simhei 就用，没有退回 sakura（fortune 带的那套），
// 再没有就是系统默认——真到那一步中文会变方块，往 assets/fonts 丢个中文字体即可。
const FONT = '"LXGWWenKai", sans-serif'   // 框架 canvas 服务自带这个字体

// 右上角水印
// 素材统一放包根 assets/，app/lib 往上两级
const LOGO_FILE = path.join(__dirname, '..', '..', 'assets', 'logo.png')

// ---------------------------------------------------------------- 文字宽度估算
//
// pill、小标题的计数、页脚时间戳这几处需要「先知道宽度才能摆位置」。
// simhei 这类中文字体里：中日韩字符正好 1em，ASCII 正好 0.5em，
// 所以按 em 累加就够准了；换字体时略微偏宽一点也无所谓（留白稍多，不会挤压）。

const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd],
]

function charEm(ch) {
  const code = ch.codePointAt(0)
  if (code === 0xa5) return 1 // ¥ 在中文字体里是全角
  for (const [lo, hi] of WIDE_RANGES) {
    if (code >= lo && code <= hi) return 1
  }
  return 0.5
}

/** 估算一段文字在给定字号下的宽度（像素） */
export function textWidth(text, size) {
  let em = 0
  for (const ch of String(text ?? '')) em += charEm(ch)
  return Math.ceil(em * size)
}

// ---------------------------------------------------------------- ops 小工具

function textOp(text, x, y, { size = 15, bold = false, color = COLORS.ink, baseline, wrap, maxLines, lineHeight } = {}) {
  const op = { type: 'text', text: String(text), x, y, size, font: FONT, color }
  if (bold) op.bold = true
  if (baseline) op.baseline = baseline
  if (wrap) {
    op.wrap = wrap
    if (maxLines) op.maxLines = maxLines
    if (lineHeight) op.lineHeight = lineHeight
  }
  // 故意不用 align:'center'：canvas 服务里 ellipsis 不重置 textAlign，
  // 居中会「漏」到后面的省略号操作上。居中位置用 textWidth 自己算。
  return op
}

function ellipsisOp(text, x, y, maxWidth, { size = 15, bold = false, color = COLORS.ink } = {}) {
  const op = { type: 'ellipsis', text: String(text), x, y, size, font: FONT, color, wrap: maxWidth }
  if (bold) op.bold = true
  return op
}

function rectOp(x, y, w, h, { fill, stroke, radius, lineWidth } = {}) {
  const op = { type: 'rect', x, y, w, h }
  if (fill) op.fill = fill
  if (stroke) {
    op.stroke = stroke
    op.lineWidth = lineWidth ?? 1
  }
  if (radius) op.radius = radius
  return op
}

function imageOp(src, x, y, w, h, radius) {
  const op = { type: 'image', src, x, y, w, h }
  if (radius) op.round = radius
  return op
}

/**
 * 画一张图；没图或宽高为 0 时画「无图」占位。
 * 对应原来的 picture()，但不再做「纯白图当无图」的像素采样
 * （那个要读画布像素，跨进程做不到）。
 */
function pictureOps(src, size, x, y, w, h, radius = 12) {
  const ok = size && size.width > 0 && size.height > 0
  if (!ok) {
    const cx = x + w / 2
    return [
      rectOp(x, y, w, h, { fill: '#e6e2d8', radius }),
      textOp('无图', cx - textWidth('无图', 12) / 2, y + h / 2 + 4, { size: 12, color: '#8d8779' }),
    ]
  }
  return [
    imageOp(src, x, y, w, h, radius),
    // 细边框，和底图区分开
    rectOp(x + 0.5, y + 0.5, w - 1, h - 1, { stroke: 'rgba(0,0,0,.08)', radius }),
  ]
}

/** 小标签（胶囊）：右边界对齐 x，背景宽度按文字估出来 */
function pillOps(value, x, y, { color = COLORS.ink, bg = 'rgba(255,255,255,.94)', border = 'rgba(0,0,0,.06)' } = {}) {
  const text = String(value)
  const w = textWidth(text, 11) + 18
  const h = 22
  return [
    rectOp(x - w, y, w, h, { fill: bg, stroke: border, radius: 7 }),
    textOp(text, x - w + 9, y + h / 2 + 0.5, { size: 11, color, baseline: 'middle' }),
  ]
}

function sectionTitleOps(label, count, y) {
  // 三个小标题都是 4 个汉字（本周动态/即将发售/折扣中）
  const labelW = textWidth(label, 22)
  return [
    textOp(label, PAD, y, { size: 22, bold: true }),
    textOp(String(count), PAD + labelW + 12, y, { size: 13, color: COLORS.mute }),
  ]
}

// ---------------------------------------------------------------- 排版

function ratioOf(size) {
  return size && size.width > 0 && size.height > 0 ? size.width / size.height : FALLBACK_RATIO
}

/** 图片在固定宽度下的高度；没图按 16:9 占位 */
function heightFor(size, w) {
  return Math.max(60, Math.round(w / ratioOf(size)))
}

/** 卡片瀑布流：依次放进当前最矮的列，避免固定行高留空洞 */
function flowCards(items, sizes, top) {
  const columns = Array.from({ length: COLS }, () => ({ height: 0, items: [] }))
  for (const item of items) {
    const size = sizes.get(item.image)
    const imgH = heightFor(size, COL_W)
    let target = columns[0]
    for (const column of columns) {
      if (column.height < target.height) target = column
    }
    target.items.push({ item, y: target.height, imgH })
    target.height += imgH + CARD_TEXT_H + GAP
  }
  const height = Math.max(...columns.map((column) => column.height)) - GAP
  return { columns, top, height: Math.max(0, height) }
}

function cardOps(plan, sizes, drawCard) {
  const ops = []
  plan.columns.forEach((column, index) => {
    const x = PAD + index * (COL_W + GAP)
    for (const cell of column.items) {
      const top = plan.top + cell.y
      ops.push(rectOp(x, top, COL_W, cell.imgH + CARD_TEXT_H, {
        fill: COLORS.card,
        stroke: COLORS.line,
        radius: 14,
      }))
      ops.push(...pictureOps(cell.item.image, sizes.get(cell.item.image), x, top, COL_W, cell.imgH, 14))
      ops.push(...drawCard(cell.item, x, top, cell.imgH))
    }
  })
  return ops
}

function discountLabel(item) {
  if (typeof item.price !== 'number') return ''
  const value = item.price.toFixed(2).replace(/\.?0+$/, '')
  return `¥${value}`
}

function take(list, limit) {
  return limit > 0 ? list.slice(0, limit) : list
}

/**
 * 纯计算：拿到数据和图片尺寸，产出 { width, height, background, ops }。
 * 不碰网络、不碰画布，方便本地单独验证。
 */
export function buildPlan(data, options = {}, sizes = new Map()) {
  const opts = {
    maxNews: options.maxNews ?? 8,
    maxUpcoming: options.maxUpcoming ?? 9,
    maxDiscount: options.maxDiscount ?? 9,
    rangeLabel: options.rangeLabel ?? '',
    title: options.title ?? '国 G 周报',
  }

  const news = take(data.news ?? [], opts.maxNews)
  const upcoming = take(data.upcoming ?? [], opts.maxUpcoming)
  const discount = take(data.discount ?? [], opts.maxDiscount)

  // 动态缩略图：固定高度 90，宽度按原图比例；整列取最宽的那张对齐
  const newsThumbW = Math.max(
    120,
    ...news.map((item) => Math.round(THUMB_H * ratioOf(sizes.get(item.image)))),
  )
  const newsTextX = PAD + newsThumbW + 20
  const newsTextW = WIDTH - newsTextX - PAD

  // 先算高度，再决定画布
  let cursor = 166
  const newsPlan = []
  if (news.length) {
    cursor += 34
    for (const item of news) {
      newsPlan.push({ item, y: cursor })
      cursor += Math.max(THUMB_H, 96) + 12
    }
    cursor += 10
  }

  let upPlan = null
  if (upcoming.length) {
    cursor += 34
    upPlan = flowCards(upcoming, sizes, cursor)
    cursor += upPlan.height + 24
  }

  let discPlan = null
  if (discount.length) {
    cursor += 34
    discPlan = flowCards(discount, sizes, cursor)
    cursor += discPlan.height + 24
  }

  const height = cursor + 96

  // ---------------- 开始出指令 ----------------
  const ops = []

  // 头部
  ops.push(textOp(opts.title, PAD, 72, { size: 38, bold: true }))
  ops.push(textOp(`CnGal 资料站 · ${opts.rangeLabel}`, PAD, 104, { size: 16, color: COLORS.mute }))
  ops.push(rectOp(PAD, 120, 46, 3, { fill: COLORS.accent }))

  // 右上角水印：高度固定 66，宽度按原图比例
  const logoSize = sizes.get(LOGO_FILE)
  if (logoSize && logoSize.width > 0) {
    const logoH = 66
    const logoW = Math.round((logoSize.width * logoH) / logoSize.height)
    ops.push(imageOp(LOGO_FILE, WIDTH - PAD - logoW, 24, logoW, logoH))
  }

  // 本周动态
  if (news.length) {
    ops.push(...sectionTitleOps('本周动态', `${news.length} 条`, 166))
    for (const { item, y } of newsPlan) {
      const size = sizes.get(item.image)
      const thumbW = Math.min(newsThumbW, Math.round(THUMB_H * ratioOf(size)))
      ops.push(...pictureOps(item.image, size, PAD, y, thumbW, THUMB_H, 10))
      ops.push(ellipsisOp(`${item.group} · ${item.date}`, newsTextX, y + 20, newsTextW, {
        size: 13,
        color: COLORS.accent,
      }))
      ops.push(textOp(item.text, newsTextX, y + 48, {
        size: 16,
        wrap: newsTextW,
        maxLines: 2,
        lineHeight: 22,
      }))
    }
  }

  // 即将发售
  if (upPlan) {
    ops.push(...sectionTitleOps('即将发售', `${upcoming.length} 部`, upPlan.top - 34))
    ops.push(...cardOps(upPlan, sizes, (item, x, top, imgH) => {
      const out = []
      if (item.date) out.push(...pillOps(item.date, x + COL_W - 8, top + 8, { color: COLORS.green }))
      out.push(ellipsisOp(item.name, x + 12, top + imgH + 26, COL_W - 24, { size: 16, bold: true }))
      const sub = (item.tags ?? []).slice(0, 2).join(' · ') || item.brief || ''
      out.push(ellipsisOp(sub, x + 12, top + imgH + 48, COL_W - 24, { size: 12, color: COLORS.mute }))
      return out
    }))
  }

  // 折扣
  if (discPlan) {
    ops.push(...sectionTitleOps('折扣中', `${discount.length} 部`, discPlan.top - 34))
    ops.push(...cardOps(discPlan, sizes, (item, x, top, imgH) => {
      const out = []
      if (item.cut) out.push(...pillOps(`-${item.cut}%`, x + COL_W - 8, top + 8, { color: COLORS.accent }))
      out.push(ellipsisOp(item.name, x + 12, top + imgH + 26, COL_W - 24, { size: 16, bold: true }))
      const price = discountLabel(item)
      if (price) out.push(textOp(price, x + 12, top + imgH + 48, { size: 15, bold: true, color: COLORS.accent }))
      return out
    }))
  }

  // 页脚
  const footY = height - 44
  ops.push(rectOp(PAD, footY - 40, WIDTH - PAD * 2, 1, { fill: COLORS.line }))
  ops.push(textOp(
    `本期收录：动态 ${(data.news ?? []).length} 条 · 待售 ${(data.upcoming ?? []).length} 部 · 折扣 ${(data.discount ?? []).length} 部`,
    PAD,
    footY - 14,
    { size: 12.5 },
  ))
  ops.push(textOp('数据来源：CnGal 资料站 cngal.org · 公开接口', PAD, footY + 8, { size: 12, color: COLORS.mute }))
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
  ops.push(textOp(stamp, WIDTH - PAD - textWidth(stamp, 12), footY + 8, { size: 12, color: COLORS.mute }))

  return {
    width: WIDTH,
    height,
    background: COLORS.bg,
    ops,
    counts: { news: news.length, upcoming: upcoming.length, discount: discount.length },
  }
}

// ---------------------------------------------------------------- 能力调用

/** 让 canvas 服务量一批图片的尺寸（拿不到的记为 0） */
async function probeImages(urls) {
  const unique = [...new Set(urls.filter(Boolean))]
  const sizes = new Map()
  if (!unique.length) return sizes

  // 服务端一次最多处理 60 个
  for (let i = 0; i < unique.length; i += 60) {
    const chunk = unique.slice(i, i + 60)
    const list = await probe(chunk)
    for (const item of list) {
      sizes.set(item.url, { width: Number(item.width) || 0, height: Number(item.height) || 0 })
    }
  }
  return sizes
}

/**
 * 渲染一张周报，返回 base64 图片。
 * 原来是返回 Buffer，改成 base64 后调用方直接塞进 base64:// 段。
 */
export async function renderWeekly(data, options = {}) {
  const urls = [
    ...(data.news ?? []).map((item) => item.image),
    ...(data.upcoming ?? []).map((item) => item.image),
    ...(data.discount ?? []).map((item) => item.image),
    LOGO_FILE,
  ]
  const sizes = await probeImages(urls)
  const plan = buildPlan(data, options, sizes)

  const buffer = await renderOps({
    width: plan.width,
    height: plan.height,
    background: plan.background,
    ops: plan.ops,
    // 长图用 JPEG：PNG 要 2.5MB，JPEG 只要 0.6MB
    format: 'image/jpeg',
    quality: 88,
  })

  host.log('info', `cngal: 出图 ${plan.width}x${plan.height}，${plan.ops.length} 条指令`)
  return { image: buffer.toString('base64'), width: plan.width, height: plan.height, counts: plan.counts }
}

export { WIDTH }
