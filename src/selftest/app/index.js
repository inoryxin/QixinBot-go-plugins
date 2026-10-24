// 自检插件：覆盖框架的全部扩展能力，用来验证框架是否正常加载。
// 它不是业务插件，是"活体测试用例"。

import { serve, host, chatOf } from '../_sdk/qixin.mjs'

let config = {}
let dataDir = ''
let recentEvents = []

function show(key, value) {
  if (key === 'secret') return value ? '***（已设置）' : '（空）'
  return JSON.stringify(value)
}

serve({
  async initialize({ data_dir, settings }) {
    dataDir = data_dir
    config = settings || {}
    host.log('info', '自检插件初始化', { data_dir, settings: Object.keys(config) })
    return { api_version: '1.0' }
  },

  async run_task({ task }) {
    host.log('info', `定时任务执行: ${task}`)
    return { ok: true }
  },

  async handle_message({ session }) {
    const text = (session.text ?? '').trim()
    if (!text.startsWith('selftest')) return { handled: false }

    const parts = text.split(/\s+/)
    const sub = parts[1] || ''
    const reply = (msg) => host.reply(chatOf(session), msg)

    switch (sub) {
      case 'echo': {
        const arg = text.slice('selftest echo'.length).trim()
        await reply(arg ? `收到：${arg}` : '用法：/selftest echo <文本>')
        return { handled: true }
      }

      case 'settings': {
        const lines = Object.entries(config).map(([k, v]) => `  ${k} = ${show(k, v)}`)
        await reply(`当前设置（${Object.keys(config).length} 项）\n${lines.join('\n')}\n数据目录：${dataDir}`)
        return { handled: true }
      }

      case 'store': {
        const key = `runs:${session.user_id}`
        const n = ((await host.storage.get(key)) ?? 0) + 1
        await host.storage.set(key, n)
        const keys = await host.storage.list('')
        await reply(`这是你第 ${n} 次测试存储。当前共 ${keys.length} 个 key：${keys.join(', ')}`)
        return { handled: true }
      }

      case 'tool': {
        // 插件互调：通过宿主转发到天气插件的 weather_query
        try {
          const r = await host.capability('weather_query', { city: '北京' })
          const result = r?.result ?? r
          await reply(`weather_query 返回：\n${JSON.stringify(result, null, 2)}`)
        } catch (e) {
          await reply(`调用失败：${e.message}\n（weather 插件是否启用？）`)
        }
        return { handled: true }
      }

      case 'events': {
        if (!recentEvents.length) {
          await reply('还没收到过通知事件。拉个人进群、撤条消息、或者戳一下机器人试试。')
        } else {
          const list = recentEvents.map((e, i) =>
            `${i + 1}. ${e.post_type}/${e.notice_type || e.request_type || e.meta_event_type || '-'} sub=${e.sub_type || '-'} user=${e.user_id || '-'} group=${e.group_id || '-'}`)
          await reply(`最近 ${recentEvents.length} 条事件：\n${list.join('\n')}`)
        }
        return { handled: true }
      }

      case 'access': {
        const all = await host.listAccess()
        const canWeather = await host.checkPermission('weather', session)
        const lines = Object.entries(all).map(([id, a]) =>
          `  ${id}: prefix=${a.require_prefix} mention=${a.require_mention} users=[${(a.allow_users || []).join('|')}] groups=[${(a.allow_groups || []).join('|')}]`)
        const mine = await host.listTools(session)
        const every = await host.listTools(null)
        await reply(`权限表（${Object.keys(all).length} 个插件）：\n${lines.join('\n')}\n\n当前会话能用 weather：${canWeather}\n\n本会话可用工具（${mine.length}）：${mine.map(t => t.name).join(', ') || '无'}\n全部工具（${every.length}）：${every.map(t => t.name).join(', ')}`)
        return { handled: true }
      }

      case 'admin': {
        await reply('管理员命令执行成功。普通群员不应该看到这条回复。')
        return { handled: true }
      }

      case 'hidden': {
        await reply('隐藏命令也能执行，只是不出现在 /help 里。')
        return { handled: true }
      }

      default:
        await reply('用法：/selftest echo|settings|store|tool|events|admin|hidden')
        return { handled: true }
    }
  },

  async handle_event({ event }) {
    recentEvents.push(event)
    if (recentEvents.length > 10) recentEvents.shift()
    host.log('info', '收到事件', { post_type: event.post_type, notice: event.notice_type, sub: event.sub_type })
    return {}
  },

  async list_tools() {
    return {
      tools: [
        {
          name: 'selftest_echo',
          description: '把输入原样返回，用于验证工具调用链路',
          parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
        {
          name: 'selftest_calc',
          description: '四则运算，用于验证数字参数和枚举',
          parameters: {
            type: 'object',
            properties: {
              a: { type: 'number' },
              b: { type: 'number' },
              op: { type: 'string', enum: ['add', 'sub', 'mul', 'div'] },
            },
            required: ['a', 'b', 'op'],
          },
        },
      ],
    }
  },

  async call_tool({ name, args }) {
    if (name === 'selftest_echo') {
      return { ok: true, data: { echo: args?.text ?? '', at: new Date().toISOString() } }
    }
    if (name === 'selftest_calc') {
      const a = Number(args?.a)
      const b = Number(args?.b)
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        return { ok: false, error: 'a 和 b 必须是数字' }
      }
      let value
      switch (args?.op) {
        case 'add': value = a + b; break
        case 'sub': value = a - b; break
        case 'mul': value = a * b; break
        case 'div':
          if (b === 0) return { ok: false, error: '除数为 0' }
          value = a / b
          break
        default:
          return { ok: false, error: `不支持的运算 ${args?.op}` }
      }
      return { ok: true, data: { value } }
    }
    return { ok: false, error: `未知工具 ${name}` }
  },

  async get_settings() {
    return { values: config }
  },

  async set_settings({ values }) {
    config = { ...config, ...(values ?? {}) }
    host.log('info', '设置已热更新', { keys: Object.keys(values ?? {}) })
    return { ok: true }
  },

  async ping() {
    return { pong: true }
  },

  async shutdown() {
    host.log('info', '自检插件退出')
    return {}
  },
})
