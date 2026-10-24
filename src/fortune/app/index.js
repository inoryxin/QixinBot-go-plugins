// 运势抽签
//
// 从 QixinBot 的 fortune 插件移植（源自 nonebot_plugin_fortune 的素材）。
// lib/fortune.cjs 是 canvas 渲染（480×480 底图 + 竖排签文），原样保留。
//
// 改动：
//   - 状态从 fortune.json 换成 host.storage
//   - 图片走 base64 发送
//   - 每人每天一次的判断沿用（按群/私聊分别记）
import { createRequire } from 'node:module'
import { serve, host, chatOf } from '../_sdk/qixin.mjs'
import { readState, writeState, todayStamp, scopeKey, userKey } from './lib/state.mjs'
import { renderCard } from './lib/render.mjs'

const fortune = createRequire(import.meta.url)('./lib/fortune.cjs')

const {
  availableThemes,
  pickRandomTheme,
  resolveTheme,
  themeLabel,
  pickCopywriting,
  loadCopywriting,
} = fortune

let settings

const ASSETS = new URL('../assets/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function assetsDir() {
  // Windows 下 URL pathname 是 /C:/...，要去掉前导斜杠
  return decodeURIComponent(ASSETS).replace(/\/$/, '')
}

function parseThemes(value) {
  return String(value ?? '')
    .split(/[|｜,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------- 服务

serve({
  async initialize({ settings: initial }) {
    settings = initial || {}
    host.log('info', `运势抽签启动，素材 ${assetsDir()}`)
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...values }
    return { ok: true }
  },

  async handle_message({ session }) {
    const text = (session.text || '').trim()
    if (!text) return { handled: false }

    const available = availableThemes(assetsDir())
    if (!available.length) {
      await host.reply(chatOf(session), '运势素材缺失，请检查插件包的 assets/img')
      return { handled: true }
    }

    const isGroup = session.chat_type === 'group'
    const configured = parseThemes(settings.themes).filter((t) => available.includes(t))

    // ---- 主题管理 ----
    if (/^(?:设置.+签|重置(?:抽签)?主题)$/.test(text)) {
      if (!isGroup) {
        await host.reply(chatOf(session), '这个指令只能在群里用')
        return { handled: true }
      }
      if (session.role !== 'owner' && session.role !== 'admin') {
        await host.reply(chatOf(session), '只有群主或管理员能改抽签主题哦~')
        return { handled: true }
      }
      const state = await readState()
      if (/^重置(?:抽签)?主题$/.test(text)) {
        state.groups[scopeKey(session)] = 'random'
        await writeState(state)
        await host.reply(chatOf(session), '已重置当前群抽签主题为随机~')
        return { handled: true }
      }
      const wanted = text.slice(2, -1)
      const theme = resolveTheme(wanted, available)
      if (!theme) {
        await host.reply(chatOf(session), '还没有这种抽签主题哦~')
        return { handled: true }
      }
      state.groups[scopeKey(session)] = theme
      await writeState(state)
      await host.reply(chatOf(session), `已设置当前群抽签主题为${themeLabel(theme)}~`)
      return { handled: true }
    }

    if (text === '主题列表') {
      const list = configured.length ? configured : available
      const lines = list.length ? list.map((t) => `${themeLabel(t)}（${t}）`) : ['随机（全部主题）']
      const message = ['可选抽签主题', ...lines].join('\n')
      await host.reply(chatOf(session), message.length > 1500 ? `${message.slice(0, 1500)}…` : message)
      return { handled: true }
    }

    if (/^查看(?:抽签)?主题$/.test(text)) {
      const state = await readState()
      const current = state.groups[scopeKey(session)] ?? 'random'
      await host.reply(chatOf(session), `当前群抽签主题：${current === 'random' ? '随机' : themeLabel(current)}`)
      return { handled: true }
    }

    // ---- 抽签 ----
    const themed = text.endsWith('抽签') && text.length > 2
    let theme = themed ? text.slice(0, -2) : undefined
    if (themed) {
      const resolved = resolveTheme(theme, available)
      if (!resolved) {
        await host.reply(chatOf(session), '还没有这种抽签主题哦~')
        return { handled: true }
      }
      theme = resolved
    } else if (!/^(?:今日运势|运势|抽签|求签)$/.test(text)) {
      // 既不是抽签也不是主题管理：放手
      return { handled: false }
    }

    const scope = scopeKey(session)
    const slot = userKey(session)
    const state = await readState()
    const date = todayStamp()

    const drawnToday = state.users?.[scope]?.[slot] === date
    const outKey = `out:${scope}:${slot}`

    if (drawnToday) {
      const cached = await host.storage.get(outKey)
      if (cached) {
        await host.reply(chatOf(session), '你今天抽过签了，再给你看一次哦🤗')
        await sendCard(session, cached)
        return { handled: true }
      }
    }

    const chosen = theme ?? (state.groups[scope] && state.groups[scope] !== 'random'
      ? state.groups[scope]
      : pickRandomTheme(configured, available))

    try {
      const result = await renderCard({ theme: chosen, assetsDir: assetsDir() })
      const b64 = result.image

      state.users[scope] = state.users[scope] ?? {}
      state.users[scope][slot] = date
      await writeState(state)
      // 缓存当天那张，重复抽时直接复用（省一次渲染）
      await host.storage.set(outKey, b64)

      host.log('info', `fortune: ${scope}/${slot} 抽了 ${chosen} -> ${result.title}`)
      await host.reply(chatOf(session), '✨今日运势✨')
      await sendCard(session, b64)
    } catch (err) {
      host.log('error', `fortune: 渲染失败 ${err.message}`)
      await host.reply(chatOf(session), `抽签失败了：${err.message}`)
    }
    return { handled: true }
  },

  async call_tool({ name }) {
    // 渲染预览：给 WebUI 或测试用，返回 base64 图片
    if (name === 'fortune.preview') {
      try {
        const available = availableThemes(assetsDir())
        if (!available.length) return { ok: false, error: '素材缺失' }
        const configured = parseThemes(settings.themes).filter((t) => available.includes(t))
        const theme = pickRandomTheme(configured, available)
        const r = await renderCard({ theme, assetsDir: assetsDir() })
        return { ok: true, data: { image: r.image, title: r.title, text: r.text, theme: r.theme } }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    }

    if (name !== 'draw_fortune') return { ok: false, error: `未知工具 ${name}` }

    try {
      const dir = assetsDir()
      const available = availableThemes(dir)
      if (!available.length) return { ok: false, error: '运势素材缺失' }

      const theme = pickRandomTheme(parseThemes(settings.themes), available)
      const copywriting = loadCopywriting(`${dir}/fortune/copywriting.json`)
      const copy = pickCopywriting(copywriting)
      return { ok: true, data: { text: `今日签：${themeLabel(theme)} · ${copy.title}\n${copy.text}` } }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  },
})

// 发图：群里先 @ 对方再发图
async function sendCard(session, base64) {
  const segs = []
  if (settings.atUser !== false && session.chat_type === 'group') {
    segs.push({ type: 'at', data: { qq: String(session.user_id) } }, { type: 'text', data: { text: ' ' } })
  }
  segs.push({ type: 'image', data: { file: `base64://${base64}` } })
  await host.reply(chatOf(session), segs)
}
