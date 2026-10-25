import { serve, host, chatOf } from '../_sdk/qixin.mjs'

let settings = {}

function stamp() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

const app = {
  async initialize({ settings: s }) {
    settings = s || {}
    host.log('info', `定时测试启动，当前时间 ${stamp()}`)
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...(values || {}) }
    return { ok: true }
  },

  async handle_message({ session }) {
    const t = (session.text || '').trim()
    if (!/^定时测试$/.test(t)) return { handled: false }
    await host.reply(chatOf(session), `两条定时任务：每 30 分钟、每 45 分钟（现在是 ${stamp()}）`)
    return { handled: true }
  },

  async run_task({ task }) {
    const label = task === 'half' ? '每 30 分钟' : task === 'quarter' ? '每 45 分钟' : task
    host.log('info', `定时测试触发：${label}`, { at: stamp() })

    const target = String(settings.target ?? '').trim()
    if (!target) return {}
    const n = Number(target)
    if (!Number.isFinite(n) || n <= 0) {
      host.log('warn', `发送目标不合法: ${target}`)
      return {}
    }
    const text = `[定时测试] ${label} 触发 ${stamp()}`
    try {
      // 先用私聊；群号走群发，失败会记 warn
      if (String(n).length >= 9) {
        await host.sendMessage({ chat_type: 'group', chat_id: n }, [{ type: 'text', data: { text } }])
      } else {
        await host.sendMessage({ chat_type: 'private', chat_id: n }, [{ type: 'text', data: { text } }])
      }
      host.log('info', `定时测试已发送到 ${target}`)
    } catch (e) {
      host.log('warn', `定时测试发送失败: ${e.message}`)
    }
    return {}
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
__SELF_TIMER && setInterval(() => __runTask('half'), 30 * 60 * 1000)
__SELF_TIMER && setInterval(() => __runTask('quarter'), 45 * 60 * 1000)
if (__SELF_TIMER) host.log('info', '发行版自管定时已启动')
