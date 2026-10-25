// 网抑云：随机一条网易云音乐热评。
//
// 移植自旧版 ncm-saying。旧版自己算"今天发过没有"，写状态文件、起定时器；
// 新版直接声明 [[schedule]]，由框架负责定时和持久化（重启不丢）。

import { serve, host, chatOf } from '../_sdk/qixin.mjs'

const DEFAULT_API = 'https://v.api.aa1.cn/api/api-wenan-wangyiyunreping/index.php?aa1=json'

// 接口挂了也不能让用户干等：留几句兜底，质量比随机抓的还稳
const FALLBACK = [
  '后来我才明白，很多事情说再多也没有用，就像你拿着一杯热水，虽然很渴，但觉得烫手还是会放下。——《后来》',
  '最怕你一生碌碌无为，还安慰自己平凡可贵。——《平凡之路》',
  '有些人一旦错过了，就是一辈子。——《后来》',
  '你那么擅长安慰他人，一定度过了很多自己安慰自己的日子吧。——《斑马斑马》',
  '愿你余生顺遂，万事胜意。——《起风了》',
]

let settings = {}
let cache = null // 最近一条，接口挂了先复用，别每次都返回同一句兜底

function apiURL() {
  const custom = String(settings.api_url ?? '').trim()
  return custom || DEFAULT_API
}

async function fetchSaying() {
  try {
    const resp = await fetch(apiURL(), { signal: AbortSignal.timeout(12_000) })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    const text = String(data?.[0]?.wangyiyunreping ?? '').trim()
    if (text.length < 4) throw new Error('返回是空的')
    cache = text
    return text
  } catch (e) {
    host.log('warn', `热评接口不可用：${e.message}`)
    if (cache) return cache
    return FALLBACK[Math.floor(Math.random() * FALLBACK.length)]
  }
}

const app = {
  async initialize({ settings: s }) {
    settings = s || {}
    return { api_version: '1.0' }
  },

  // 设置保存后框架会推过来：不接这个回调，改了群号也得重启才生效
  async set_settings({ values }) {
    settings = { ...settings, ...(values || {}) }
    if (typeof __scheduleNcmDaily === 'function') __scheduleNcmDaily()
    host.log('info', '设置已更新', { auto_groups: settings.auto_groups })
    return { ok: true }
  },

  async handle_message({ session }) {
    const text = (session.text ?? '').trim().replace(/^\/+/, '')
    if (!/^网抑云$/.test(text)) return { handled: false }

    await host.reply(chatOf(session), await fetchSaying())
    return { handled: true }
  },

  // 框架按 [[schedule]] 调用；群号从设置里读
  async run_task({ task }) {
    if (task !== 'daily') return {}

    const groups = String(settings.auto_groups ?? '')
      .split(/[,，\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)

    if (!groups.length) {
      host.log('debug', '没配自动发送的群，跳过')
      return {}
    }

    const text = await fetchSaying()
    let ok = 0
    for (const gid of [...new Set(groups)]) {
      try {
        await host.sendMessage({ chat_type: 'group', chat_id: gid }, [
          { type: 'text', data: { text } },
        ])
        ok++
      } catch (e) {
        host.log('warn', `发群 ${gid} 失败：${e.message}`)
      }
    }
    host.log('info', `每日热评已发送 ${ok}/${groups.length} 个群`)
    return { ok: ok > 0 }
  },
}
serve(app)

// ---- 插件自管定时（发行版）----
// 开发线（QIXIN_EXPERIMENTAL=1）由框架的 [[schedule]] 接管，这里不重复启动。
const __SELF_TIMER = !process.env.QIXIN_EXPERIMENTAL
function __runTask(task) {
  if (!__SELF_TIMER) return
  Promise.resolve(app.run_task({ task })).catch((e) => {
    host.log('warn', `定时 ${task} 执行失败: ${e && e.message ? e.message : e}`)
  })
}
let __ncmTimer = null
function __scheduleNcmDaily() {
  if (!__SELF_TIMER) return
  if (__ncmTimer) clearTimeout(__ncmTimer)
  const h = Number(settings.hour ?? 0), m = Number(settings.minute ?? 0)
  const now = new Date()
  const next = new Date(now)
  next.setHours(h, m, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  __ncmTimer = setTimeout(async () => {
    __runTask('daily')
    __scheduleNcmDaily()
  }, next.getTime() - now.getTime())
}
__scheduleNcmDaily()
if (__SELF_TIMER) host.log('info', '发行版自管定时已启动')
