// LLM 服务插件：统一封装 OpenAI 兼容接口。
// 其他插件通过 host.capability('llm.chat', { messages }) 调用，不用各自配 key。
import { serve, host } from '../_sdk/qixin.mjs'

let settings = {}

serve({
  async initialize({ settings: initial }) {
    settings = initial || {}
    host.log('info', `LLM 服务就绪，模型 ${settings.model || '(未设置)'}`)
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...values }
    host.log('info', 'LLM 设置已更新')
    return { ok: true }
  },

  async call_tool({ name, args }) {
    if (name !== 'llm.chat') {
      return { ok: false, error: `未知能力 ${name}` }
    }
    return chat(args || {})
  },
})

async function chat({ messages, model, temperature, tools }) {
  const apiKey = (settings.api_key || '').trim()
  if (!apiKey) {
    return { ok: false, error: 'LLM 未配置 API Key，请在插件设置里填写' }
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: 'messages 不能为空' }
  }

  const base = (settings.base_url || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const timeoutMs = Math.max(1, Number(settings.timeout) || 30) * 1000

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || settings.model || 'gpt-4o-mini',
        messages,
        temperature: typeof temperature === 'number' ? temperature : 0.7,
        // 传了 tools 就一起带上，让模型决定要不要调
        ...(Array.isArray(tools) && tools.length ? { tools, tool_choice: 'auto' } : {}),
      }),
      signal: controller.signal,
    })

    const text = await resp.text()
    if (!resp.ok) {
      return { ok: false, error: `上游返回 ${resp.status}: ${text.slice(0, 200)}` }
    }

    let data
    try {
      data = JSON.parse(text)
    } catch {
      return { ok: false, error: '上游返回的不是 JSON' }
    }

    const message = data?.choices?.[0]?.message
    const content = message?.content
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []

    // 有工具调用时 content 可能是空的，这不算错误
    if ((typeof content !== 'string' || content === '') && toolCalls.length === 0) {
      return { ok: false, error: '上游响应里没有 content' }
    }

    return {
      ok: true,
      data: {
        text: typeof content === 'string' ? content : '',
        tool_calls: toolCalls,
        model: data.model || model || settings.model,
        usage: data.usage || null,
      },
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { ok: false, error: `请求超时（${timeoutMs / 1000}s）`, retryable: true }
    }
    return { ok: false, error: `请求失败: ${err.message}`, retryable: true }
  } finally {
    clearTimeout(timer)
  }
}
