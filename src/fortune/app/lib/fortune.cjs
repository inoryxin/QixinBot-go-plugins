'use strict'

const fs = require('node:fs')
const path = require('node:path')

// Ported from nonebot_plugin_fortune (resource/img + font + copywriting.json).
// The layout of the base images is fixed: 480×480 with a card panel on the
// left, so the upstream drawing coordinates are used unchanged.

const CANVAS_SIZE = 480
const TITLE = { x: 140, y: 99, size: 45, color: '#F5F5F5', font: 'Mamelon' }
const BODY = { x: 140, y: 297, size: 25, gap: 4, color: '#323232', font: 'Sakura' }
const CARDINALITY = 9

/** Theme keys and their aliases, copied from the upstream FortuneThemesDict. */
const THEME_ALIASES = {
  random: ['随机'],
  amazing_grace: ['奇异恩典'],
  arknights: ['明日方舟', '方舟', 'arknights', '鹰角', '舟游'],
  asoul: ['Asoul', 'asoul', 'a手', 'A手', 'as'],
  azure: ['碧蓝航线', '碧蓝', 'azure'],
  dc4: ['dc4'],
  einstein: ['爱因斯坦携爱敬上', '爱因斯坦', 'einstein'],
  genshin: ['原神', 'Genshin Impact', 'genshin', 'op', '原批'],
  granblue_fantasy: ['碧蓝幻想', 'Granblue Fantasy', 'granblue fantasy', '幻想'],
  hololive: ['Hololive', 'hololive', 'Vtb', 'vtb', '管人', 'Holo', 'holo', '管人痴'],
  hoshizora: ['星空列车与白的旅行', '星空列车'],
  liqingge: ['李清歌', '清歌'],
  onmyoji: ['阴阳师', 'yys', '痒痒鼠'],
  pcr: ['PCR', '公主链接', '公主连结', 'pcr'],
  pretty_derby: ['赛马娘', '马娘', '赛马'],
  punishing: ['战双', '战双帕弥什'],
  sakura: ['樱色之云绯色之恋', '樱云之恋', '樱云绯恋', '樱云'],
  summer_pockets: ['夏日口袋', '夏兜', 'sp'],
  sweet_illusion: ['灵感满溢的甜蜜创想', '甜蜜一家人', '富婆妹'],
  touhou: ['东方', 'touhou', '车万'],
  touhou_lostword: ['东方归言录', '东方lostword', 'touhou lostword'],
  touhou_old: ['旧东方', '旧版东方', '老东方', '老版东方', '经典东方'],
  warship_girls_r: ['战舰少女R', '舰r', 'wsgr', '战舰少女r'],
}

/** Human readable name for a theme key (first alias, except random). */
function themeLabel(theme) {
  if (theme === 'random') return '随机'
  return THEME_ALIASES[theme]?.[0] ?? theme
}

/**
 * Port of upstream decrement(): splits the copywriting into at most two
 * columns of 9 vertical characters, padding with spaces so both columns line up.
 */
function decrement(text) {
  const value = String(text ?? '')
  if (!value) return [1, ['']]
  if (value.length > 4 * CARDINALITY) throw new Error('fortune text too long')

  let length = value.length
  let colNum = 1
  while (length > CARDINALITY) {
    colNum += 1
    length -= CARDINALITY
  }

  const fill = (count) => ' '.repeat(Math.max(0, count))
  length = value.length

  if (colNum === 2) {
    if (length % 2 === 0) {
      const pad = fill(CARDINALITY - length / 2)
      return [2, [value.slice(0, length / 2) + pad, pad + value.slice(length / 2)]]
    }
    const pad = fill(CARDINALITY - (length + 1) / 2)
    return [2, [value.slice(0, (length + 1) / 2) + pad, pad + ' ' + value.slice((length + 1) / 2)]]
  }

  const columns = []
  for (let i = 0; i < colNum; i += 1) {
    columns.push(i === colNum - 1 ? value.slice(i * CARDINALITY) : value.slice(i * CARDINALITY, (i + 1) * CARDINALITY))
  }
  return [colNum, columns]
}

function loadCopywriting(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  const list = Array.isArray(raw.copywriting) ? raw.copywriting : []
  const entries = list
    .filter((item) => item && typeof item['good-luck'] === 'string' && Array.isArray(item.content))
    .map((item) => ({ title: item['good-luck'], texts: item.content.filter((text) => typeof text === 'string') }))
    .filter((item) => item.texts.length)
  if (!entries.length) throw new Error(`copywriting.json has no usable entries: ${file}`)
  return entries
}

function pickCopywriting(entries) {
  const entry = entries[Math.floor(Math.random() * entries.length)]
  return { title: entry.title, text: entry.texts[Math.floor(Math.random() * entry.texts.length)] }
}

/** Theme keys that actually have images on disk. */
function availableThemes(assetsDir) {
  const imgDir = path.join(assetsDir, 'img')
  if (!fs.existsSync(imgDir)) return []
  return fs
    .readdirSync(imgDir)
    .filter((name) => {
      const dir = path.join(imgDir, name)
      if (!fs.statSync(dir).isDirectory()) return false
      return fs.readdirSync(dir).some((file) => /\.(jpe?g|png)$/i.test(file))
    })
    .sort()
}

/** Resolves a user-typed theme name (alias or key) to an available theme key. */
function resolveTheme(input, available) {
  const wanted = String(input ?? '').trim().toLowerCase()
  if (!wanted) return undefined
  for (const [key, aliases] of Object.entries(THEME_ALIASES)) {
    if (key.toLowerCase() === wanted) return available.includes(key) ? key : undefined
    if (aliases.some((alias) => alias.toLowerCase() === wanted)) return available.includes(key) ? key : undefined
  }
  return undefined
}

/** Picks a random theme, honoring the configured whitelist and what is on disk. */
function pickRandomTheme(configured, available) {
  const pool = (configured?.length ? configured : available).filter((theme) => available.includes(theme))
  const list = pool.length ? pool : available
  if (!list.length) throw new Error('no fortune themes available on disk')
  return list[Math.floor(Math.random() * list.length)]
}

/**
 * Renders one fortune card with @napi-rs/canvas: base image + level title on the
 * card header + vertical copywriting on the card body.
 */
class FortuneRenderer {
  constructor({ assetsDir, logger }) {
    this.assetsDir = assetsDir
    this.logger = logger
    this.canvasLib = undefined
    this.copywriting = undefined
    this.fontsReady = false
  }

  async #load() {
    if (!this.canvasLib) {
      try {
        // eslint-disable-next-line global-require, import/no-unresolved
        this.canvasLib = require('@napi-rs/canvas')
      } catch (error) {
        throw new Error(`图片渲染组件未安装（@napi-rs/canvas）: ${error.message}`)
      }
    }
    if (!this.copywriting) {
      this.copywriting = loadCopywriting(path.join(this.assetsDir, 'fortune', 'copywriting.json'))
    }
    if (!this.fontsReady) {
      const { GlobalFonts } = this.canvasLib
      GlobalFonts.registerFromPath(path.join(this.assetsDir, 'font', 'Mamelon.otf'), TITLE.font)
      GlobalFonts.registerFromPath(path.join(this.assetsDir, 'font', 'sakura.ttf'), BODY.font)
      this.fontsReady = true
    }
    return this.canvasLib
  }

  /**
   * @param {{ theme: string }} options
   * @returns {Promise<{ buffer: Buffer, title: string, text: string, theme: string }>}
   */
  async render({ theme }) {
    const { createCanvas, loadImage } = await this.#load()
    const dir = path.join(this.assetsDir, 'img', theme)
    const images = fs.readdirSync(dir).filter((file) => /\.(jpe?g|png)$/i.test(file))
    if (!images.length) throw new Error(`theme ${theme} has no images`)

    const base = await loadImage(path.join(dir, images[Math.floor(Math.random() * images.length)]))
    const canvas = createCanvas(CANVAS_SIZE, CANVAS_SIZE)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(base, 0, 0, CANVAS_SIZE, CANVAS_SIZE)

    const { title, text } = pickCopywriting(this.copywriting)

    ctx.font = `${TITLE.size}px "${TITLE.font}"`
    ctx.fillStyle = TITLE.color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(title, TITLE.x, TITLE.y)

    const [columns, lines] = decrement(text)
    ctx.font = `${BODY.size}px "${BODY.font}"`
    ctx.fillStyle = BODY.color
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'

    for (let column = 0; column < columns; column += 1) {
      const chars = lines[column]
      const height = chars.length * (BODY.size + BODY.gap)
      const x = BODY.x + ((columns - 2) * BODY.size) / 2 + (columns - 1) * BODY.gap - column * (BODY.size + BODY.gap)
      const y = BODY.y - height / 2
      for (let row = 0; row < chars.length; row += 1) {
        if (chars[row] === ' ') continue
        ctx.fillText(chars[row], x, y + row * (BODY.size + BODY.gap))
      }
    }

    return { buffer: canvas.toBuffer('image/png'), title, text, theme }
  }
}

module.exports = {
  FortuneRenderer,
  decrement,
  loadCopywriting,
  pickCopywriting,
  availableThemes,
  resolveTheme,
  pickRandomTheme,
  themeLabel,
  THEME_ALIASES,
  CANVAS_SIZE,
  TITLE,
  BODY,
}


