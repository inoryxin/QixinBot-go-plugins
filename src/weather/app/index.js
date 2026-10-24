// 示例插件：天气
// 演示三件事：命令处理、工具注册（给 AI 用）、设置读取。
// 数据是写死的，真正接入时替换 query() 即可。

import { serve, host, chatOf } from '../_sdk/qixin.mjs'

const FAKE = {
  北京: { temp: 22, text: '晴', humidity: 35 },
  上海: { temp: 26, text: '多云', humidity: 70 },
  广州: { temp: 30, text: '雷阵雨', humidity: 85 },
  深圳: { temp: 29, text: '阵雨', humidity: 80 },
}

let config = { unit: 'celsius' }

function format(city, data) {
  const temp = config.unit === 'fahrenheit' ? Math.round(data.temp * 1.8 + 32) : data.temp
  const unit = config.unit === 'fahrenheit' ? '°F' : '°C'
  return `${city}：${data.text}，${temp}${unit}，湿度 ${data.humidity}%`
}

function query(city) {
  const key = (city ?? '').trim()
  if (!FAKE[key]) {
    return { ok: false, error: `没有「${key}」的数据（示例只支持：${Object.keys(FAKE).join('、')}）` }
  }
  return { ok: true, data: { city: key, ...FAKE[key], text: format(key, FAKE[key]) } }
}

serve({
  async initialize() {
    return { api_version: '1.0' }
  },

  async handle_message({ session }) {
    const text = (session.text ?? '').trim()
    const m = /^(?:weather|天气)\s*(.*)$/i.exec(text)
    if (!m) return { handled: false }

    const city = m[1].trim()
    if (!city) {
      await host.reply(chatOf(session), '用法：/weather <城市>，例如 /weather 北京')
      return { handled: true }
    }

    const r = query(city)
    await host.reply(chatOf(session), r.ok ? r.data.text : r.error)
    return { handled: true }
  },

  async handle_event() {
    return {}
  },

  async list_tools() {
    return {
      tools: [
        {
          name: 'weather_query',
          description: '查询某个城市的当前天气。当用户问天气、气温、下不下雨时调用。',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string', description: '城市名，例如 北京' },
            },
            required: ['city'],
          },
        },
      ],
    }
  },

  // AI 插件通过宿主转过来的工具调用
  async call_tool({ name, args }) {
    if (name !== 'weather_query') {
      return { ok: false, error: `未知工具 ${name}` }
    }
    return query(args?.city)
  },

  async get_settings() {
    return { values: config }
  },

  async set_settings({ values }) {
    config = { ...config, ...(values ?? {}) }
    host.log('info', `天气设置已更新：${JSON.stringify(config)}`)
    return { ok: true }
  },

  async ping() {
    return { pong: true }
  },

  async shutdown() {
    return {}
  },
})
