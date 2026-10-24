// 国 G 周报
//
// 从 QixinBot 的 cngal 插件移植。
// 原版用 setInterval(60s) 检查是否到点，这里换成 [[schedule]] + run_task。
// 绘制交给 canvas 服务插件（见 lib/render.mjs），本插件不再自带 canvas 原生模块。
import { createRequire } from 'node:module'
import { serve, host, chatOf } from '../_sdk/qixin.mjs'
import { renderWeekly } from './lib/render.mjs'

const require = createRequire(import.meta.url)
const { fetchAll, recentNews } = require('./lib/cngal.cjs')

let settings = {}
let busy = false

// ---------------------------------------------------------------- 工具

function parseIds(value) {
  return String(value ?? '')
    .split(/[|｜,，\s]+/)
    .map((x) => x.trim())
    .filter((x) => /^\d+$/.test(x))
    .map(Number)
}

// ISO 周，以周一为一周开始
function weekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function rangeLabel(date) {
  const end = new Date(date)
  const start = new Date(date.getTime() - 6 * 86400000)
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`
  return `${fmt(start)} - ${fmt(end)}`
}

// ---------------------------------------------------------------- 生成

async function buildImage(days) {
  const data = await fetchAll(host.logger || console)
  data.news = recentNews(data.news, days)

  // renderWeekly 现在返回 base64（绘制由 canvas 服务完成）
  const shot = await renderWeekly(data, {
    maxNews: Number(settings.maxNews) || 8,
    maxUpcoming: Number(settings.maxUpcoming) || 9,
    maxDiscount: Number(settings.maxDiscount) || 9,
    rangeLabel: rangeLabel(new Date()),
  })
  return { image: shot.image, data, width: shot.width, height: shot.height }
}

function textFallback(data) {
  const lines = ['【国 G 周报】']
  if (data.news?.length) {
    lines.push('', '动态：')
    data.news.slice(0, 4).forEach((item) => lines.push(`· ${item.group}：${item.text}`))
  }
  if (data.upcoming?.length) {
    lines.push('', '即将发售：')
    data.upcoming.slice(0, 4).forEach((item) => lines.push(`· ${item.name}（${item.date || '未定'}）`))
  }
  return lines.join('\n')
}

async function sendWeekly(targets, payload) {
  let sent = 0
  for (const group of targets) {
    try {
      await host.sendMessage(
        { chat_type: 'group', chat_id: group },
        [{ type: 'image', data: { file: `base64://${payload.image}` } }],
      )
      sent += 1
    } catch (err) {
      host.log('warn', `cngal: 群 ${group} 发图失败：${err.message}`)
      try {
        await host.sendMessage({ chat_type: 'group', chat_id: group }, [
          { type: 'text', data: { text: textFallback(payload.data) } },
        ])
        sent += 1
      } catch (err2) {
        host.log('error', `cngal: 群 ${group} 兜底文本也失败：${err2.message}`)
      }
    }
  }
  return sent
}

// ---------------------------------------------------------------- 定时

async function tick() {
  if (busy || settings.enabled === false) return

  const now = new Date()
  const weekday = Number(settings.weekday ?? 1)
  if (now.getDay() !== weekday) return

  const hour = Number(settings.hour ?? 9)
  const minute = Number(settings.minute ?? 0)
  if (now.getHours() !== hour || now.getMinutes() < minute || now.getMinutes() > minute + 9) return

  const state = (await host.storage.get('state')) || {}
  const key = weekKey(now)
  if (state.lastWeek === key) return

  const targets = parseIds(settings.groupIds)
  if (!targets.length) {
    host.log('warn', 'cngal: 没有配置群号，跳过本周推送')
    return
  }

  busy = true
  try {
    const payload = await buildImage(Number(settings.days) || 7)
    const sent = await sendWeekly(targets, payload)
    if (sent > 0) {
      await host.storage.set('state', { ...state, lastWeek: key, lastSentAt: now.toISOString(), lastGroups: targets })
      host.log('info', `cngal: 周报已推送 ${sent}/${targets.length} 个群`)
    }
  } catch (err) {
    host.log('error', `cngal: 周报生成失败：${err.message}`)
  } finally {
    busy = false
  }
}

// ---------------------------------------------------------------- 服务

serve({
  async initialize({ settings: initial }) {
    settings = initial || {}
    host.log('info', '国 G 周报启动')
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...values }
    return { ok: true }
  },

  async handle_message({ session }) {
    const text = (session.text || '').trim()
    const m = /^(?:国\s*g|cngal|gal周报)(?:\s*(周报|推送|预览))?$/i.exec(text)
    if (!m) return { handled: false }

    const action = (m[1] || '周报').toLowerCase()

    if (action === '推送') {
      const targets = parseIds(settings.groupIds)
      if (!targets.length) {
        await host.reply(chatOf(session), '还没配置群号，先去插件设置里填。')
        return { handled: true }
      }
      await host.reply(chatOf(session), `开始生成并推送到 ${targets.length} 个群…`)
      try {
        const payload = await buildImage(Number(settings.days) || 7)
        const sent = await sendWeekly(targets, payload)
        await host.storage.set('state', { ...((await host.storage.get('state')) || {}), lastWeek: weekKey(new Date()), lastSentAt: new Date().toISOString() })
        await host.reply(chatOf(session), `推送完成：${sent}/${targets.length}`)
      } catch (err) {
        host.log('error', `cngal: 推送失败 ${err.message}`)
        await host.reply(chatOf(session), `推送失败：${err.message}`)
      }
      return { handled: true }
    }

    await host.reply(chatOf(session), '正在生成国 G 周报…')
    try {
      const payload = await buildImage(Number(settings.days) || 7)
      await host.reply(chatOf(session), [
        { type: 'image', data: { file: `base64://${payload.image}` } },
      ])
    } catch (err) {
      host.log('error', `cngal: 预览生成失败 ${err.message}`)
      await host.reply(chatOf(session), `生成失败：${err.message}`)
    }
    return { handled: true }
  },

  async call_tool({ name }) {
    // 预览：给 WebUI / 测试用，返回 base64 长图
    if (name === 'cngal.preview') {
      try {
        const payload = await buildImage(Number(settings.days) || 7)
        return { ok: true, data: { image: payload.image, width: payload.width, height: payload.height } }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    }

    if (name !== 'get_cngal_weekly') return { ok: false, error: `未知工具 ${name}` }
    try {
      const data = await fetchAll(console)
      const news = recentNews(data.news, 7)
      const lines = ['最近一周国 G：']
      news.slice(0, 6).forEach((item) => lines.push(`· ${item.group}：${item.text}`))
      data.upcoming.slice(0, 5).forEach((item) => lines.push(`· 待发售 ${item.name}（${item.date || '未定'}）`))
      return { ok: true, data: { text: lines.join('\n') } }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  },

  async run_task({ task }) {
    if (task !== 'tick') return { ok: true }
    try {
      await tick()
    } catch (err) {
      host.log('debug', `cngal: tick 异常 ${err.message}`)
    }
    return { ok: true }
  },
})
