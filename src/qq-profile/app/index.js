import { serve, host } from '../_sdk/qixin.mjs'

const DEFAULT_STYLE =
  '写一条只给好友看的 QQ 空间说说，第一人称，1~2 句，短一点；有点丧、想念或深夜感，但不卖惨、不说教；不用 emoji、不用标题、不解释，也不要提 AI。'

let settings = {}
let timer

function owner() {
  return String(settings.ownerQQ || process.env.QIXIN_OWNER || '').trim()
}

function isOwner(session) {
  return session.role === 'owner' || !owner() || String(session.user_id) === owner()
}

function chatOf(session) {
  return { account: session.account, chat_type: session.chat_type, chat_id: session.chat_id }
}

function cleanText(value) {
  return String(value ?? '').trim()
}

function fileSource(data) {
  const raw = String(data?.url || data?.file || '').trim()
  if (!raw) return ''
  if (/^https?:/i.test(raw) || raw.startsWith('base64://') || raw.startsWith('data:')) return raw
  if (raw.startsWith('file://')) return raw
  const abs = raw.replace(/\\/g, '/')
  return /^[A-Za-z]:/.test(abs) ? `file:///${abs}` : `file://${abs}`
}

function imagesOf(session) {
  return (session.segments || [])
    .filter((s) => s?.type === 'image')
    .map((s) => fileSource(s.data))
    .filter(Boolean)
    .slice(0, 9)
}

async function setNickname(name) {
  const n = cleanText(name)
  if (!n) throw new Error('昵称不能为空')
  if (n.length > 24) throw new Error('昵称太长')
  await host.callOnebot('set_qq_profile', { nickname: n })
  return `昵称改成「${n}」了`
}

async function setSignature(text) {
  const note = cleanText(text)
  if (note.length > 100) throw new Error('签名太长')
  await host.callOnebot('set_qq_profile', { personal_note: note })
  return `签名改成「${note}」了`
}

async function setAvatar(source) {
  const file = cleanText(source)
  if (!file) throw new Error('没有拿到图片')
  await host.callOnebot('set_qq_avatar', { file })
  return '头像换好了'
}

async function postQzone(text, images = []) {
  const content = cleanText(text)
  if (!content) throw new Error('说说内容不能为空')
  if (content.length > 1000) throw new Error('说说太长')
  const params = { content, ugc_right: Number(settings.ugcRight) || 1 }
  const pics = images.filter(Boolean).slice(0, 9)
  if (pics.length) params.images = pics
  await host.callOnebot('send_qzone_msg', params)
  return pics.length ? '图文说说发出去了' : '说说发出去了'
}

function randomGapMs() {
  const min = Math.max(1, Number(settings.minDays) || 2)
  const max = Math.max(min, Number(settings.maxDays) || 4)
  const days = min + Math.random() * (max - min)
  return Math.round(days * 24 * 60 * 60 * 1000)
}

async function readState() {
  try { return (await host.storage.get('state')) || {} } catch { return {} }
}

async function saveState(state) {
  try { await host.storage.set('state', state) } catch (e) { host.log('warn', `qq-profile 状态保存失败: ${e.message}`) }
}

async function generateMood() {
  const style = cleanText(settings.autoStyle) || DEFAULT_STYLE
  try {
    const r = await host.capability('ai.chat', { text: style })
    if (!r?.ok) return ''
    const text = String(r.data?.text || '')
      .replace(/^[\s"'“”]+|[\s"'“”]+$/g, '')
      .split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ')
      .slice(0, 120).trim()
    return text.length >= 4 ? text : ''
  } catch {
    return ''
  }
}

async function maybeAutoPost() {
  if (!settings.autoEnabled || settings.autoEnabled === 'false') return
  const state = await readState()
  if (!state.nextAt) {
    await saveState({ ...state, nextAt: Date.now() + randomGapMs() })
    return
  }
  if (Date.now() < state.nextAt) return
  const hour = new Date().getHours()
  const start = Number(settings.activeStart) || 9
  const end = Number(settings.activeEnd) || 23
  if (hour < start || hour > end) return

  const text = await generateMood()
  if (!text) return
  await postQzone(text, [])
  await saveState({ nextAt: Date.now() + randomGapMs(), lastAutoAt: Date.now(), lastText: text })
  host.log('info', `qq-profile 自动说说：${text.slice(0, 40)}`)
}

function startTimer() {
  if (timer) clearInterval(timer)
  timer = setInterval(() => {
    maybeAutoPost().catch((e) => host.log('warn', `qq-profile 自动说说失败: ${e.message}`))
  }, 5 * 60 * 1000)
  timer.unref?.()
}

serve({
  async initialize({ settings: s }) {
    settings = s || {}
    startTimer()
    maybeAutoPost().catch(() => {})
    host.log('info', 'QQ 资料插件启动')
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...(values || {}) }
    maybeAutoPost().catch(() => {})
    return { ok: true }
  },

  async shutdown() {
    if (timer) clearInterval(timer)
    return {}
  },

  async handle_message({ session }) {
    const raw = cleanText(session.text).replace(/^[\/!]\s*/, '')
    if (!/^(改昵称|改名|改签名|签名|改头像|换头像|发说说|说说)/.test(raw)) return { handled: false }
    if (!isOwner(session)) {
      await host.reply(chatOf(session), '这个只有主人能用哦')
      return { handled: true }
    }
    try {
      let m
      if ((m = raw.match(/^改(?:昵称|名)\s*([\s\S]*)$/))) {
        await host.reply(chatOf(session), await setNickname(m[1]))
      } else if ((m = raw.match(/^改签名\s*([\s\S]*)$/)) || (m = raw.match(/^签名\s*([\s\S]*)$/))) {
        await host.reply(chatOf(session), await setSignature(m[1]))
      } else if (/^改头像$/.test(raw) || /^换头像$/.test(raw)) {
        const source = imagesOf(session)[0] || ''
        if (!source) {
          await host.reply(chatOf(session), '发一张图片再配「改头像」')
        } else {
          await host.reply(chatOf(session), await setAvatar(source))
        }
      } else if ((m = raw.match(/^发说说\s*([\s\S]*)$/)) || (m = raw.match(/^说说\s*([\s\S]*)$/))) {
        await host.reply(chatOf(session), await postQzone(m[1], imagesOf(session)))
      } else {
        await host.reply(chatOf(session), '用法：改昵称 xxx / 改签名 xxx / 改头像（附图片）/ 发说说 [文字]（可附图）')
      }
    } catch (e) {
      host.log('error', `qq-profile: ${e.message}`)
      await host.reply(chatOf(session), `没改成：${e.message}`)
    }
    return { handled: true }
  },

  async call_tool({ name, args }) {
    try {
      if (name === 'set_qq_nickname') return { ok: true, data: { text: await setNickname(args?.name) } }
      if (name === 'set_qq_signature') return { ok: true, data: { text: await setSignature(args?.text) } }
      if (name === 'set_qq_avatar') {
        const url = String(args?.url || '')
        if (!/^https?:/i.test(url)) return { ok: false, error: '需要一个图片 URL' }
        return { ok: true, data: { text: await setAvatar(url) } }
      }
      if (name === 'post_qzone') {
        return { ok: true, data: { text: await postQzone(args?.text, args?.image_url ? [String(args.image_url)] : []) } }
      }
      if (name === 'qzone_auto_status') {
        if (!settings.autoEnabled) return { ok: true, data: { text: '自动说说没开' } }
        const s = await readState()
        const next = s.nextAt ? new Date(s.nextAt).toLocaleString('zh-CN', { hour12: false }) : '还没排期'
        return { ok: true, data: { text: `自动说说已开，下次 ${next}；上次：${s.lastText || '还没发过'}` } }
      }
      return { ok: false, error: `未知工具 ${name}` }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  },
})
