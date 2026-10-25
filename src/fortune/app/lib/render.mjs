// 运势卡片渲染：算好绘制指令，交给 canvas 服务画。
// 原来这里直接 require('@napi-rs/canvas')，现在走能力，跨平台时不用改这个插件。
import fs from 'node:fs'
import path from 'node:path'
import { renderOps } from '../../_sdk/canvas-kit.mjs'
import { decrement, loadCopywriting, pickCopywriting } from './fortune.cjs'

const CANVAS_SIZE = 480
const TITLE = { x: 140, y: 99, size: 45, color: '#F5F5F5', font: 'Mamelon' }
const BODY = { x: 140, y: 297, size: 25, gap: 4, color: '#323232', font: 'sakura' }

let copywriting

function ensureCopywriting(assetsDir) {
  if (!copywriting) copywriting = loadCopywriting(path.join(assetsDir, 'fortune', 'copywriting.json'))
  return copywriting
}

/** 算一张运势卡的绘制指令 */
function buildOps({ theme, assetsDir }) {
  const dir = path.join(assetsDir, 'img', theme)
  const images = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f))
  if (!images.length) throw new Error(`主题 ${theme} 没有图片`)

  const base = images[Math.floor(Math.random() * images.length)]
  const { title, text } = pickCopywriting(ensureCopywriting(assetsDir))
  const [columns, lines] = decrement(text)

  const ops = [
    // 底图铺满
    { type: 'image', src: path.join(dir, base), x: 0, y: 0, w: CANVAS_SIZE, h: CANVAS_SIZE },
    // 等级
    {
      type: 'text',
      text: title,
      x: TITLE.x, y: TITLE.y,
      size: TITLE.size,
      font: TITLE.font,
      color: TITLE.color,
      align: 'center',
      baseline: 'middle',
    },
  ]

  // 正文：多列竖排，从右往左
  for (let column = 0; column < columns; column += 1) {
    const chars = lines[column].replace(/ /g, '')
    if (!chars) continue
    const height = chars.length * (BODY.size + BODY.gap)
    const x = BODY.x + ((columns - 2) * BODY.size) / 2 + (columns - 1) * BODY.gap - column * (BODY.size + BODY.gap)
    const y = BODY.y - height / 2
    ops.push({
      type: 'text',
      text: chars,
      x, y,
      size: BODY.size,
      gap: BODY.gap,
      font: BODY.font,
      color: BODY.color,
      baseline: 'top',
      vertical: true,
    })
  }

  return { ops, title, text }
}

/** 渲染一张，返回 base64 PNG */
export async function renderCard({ theme, assetsDir }) {
  const { ops, title, text } = buildOps({ theme, assetsDir })

  const buffer = await renderOps({
    width: CANVAS_SIZE,
    height: CANVAS_SIZE,
    ops,
  })

  return { image: buffer.toString('base64'), title, text, theme }
}
