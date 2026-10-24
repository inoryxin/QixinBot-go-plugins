// 示例插件：回声
// 这是最小可用骨架，新插件可以照抄。

import { serve, host, chatOf } from '../_sdk/qixin.mjs'

serve({
  async initialize({ data_dir }) {
    host.log('info', `echo 已加载，数据目录 ${data_dir}`)
    return { api_version: '1.0' }
  },

  async handle_message({ session }) {
    host.log('info', `收到消息: ${session.text}`)
    const text = (session.text ?? '').trim()
    if (!text) return { handled: false }

    if (text === 'ping' || text === 'ping?') {
      await host.reply(chatOf(session), 'pong')
      return { handled: true }
    }

    if (!text.startsWith('echo')) return { handled: false }

    const arg = text.slice(4).trim()
    if (!arg) {
      await host.reply(chatOf(session), '用法：/echo <文本>')
      return { handled: true }
    }

    // 演示私有存储：记录每个人 echo 过多少次
    const count = (await host.storage.get(`count:${session.user_id}`)) ?? 0
    await host.storage.set(`count:${session.user_id}`, count + 1)

    await host.reply(chatOf(session), `${arg}\n（你已 echo ${count + 1} 次）`)
    return { handled: true }
  },

  async handle_event() {
    return {}
  },

  async list_tools() {
    return { tools: [] }
  },

  async call_tool() {
    return { ok: false, error: 'echo 没有工具' }
  },

  async get_settings() {
    return { values: {} }
  },

  async set_settings() {
    return { ok: true }
  },

  async ping() {
    return { pong: true }
  },

  async shutdown() {
    host.log('info', 'echo 正在退出')
    return {}
  },
})
