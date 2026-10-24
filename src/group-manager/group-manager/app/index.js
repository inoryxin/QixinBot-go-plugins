// 群管理：欢迎、退群通知、违禁词撤回、禁言/踢人。
//
// 三块逻辑：
//   1. handle_event   —— 进群/退群发通知（不需要命令）
//   2. handle_message —— 违禁词检测（自动撤回）
//   3. 命令           —— /welcome /banword /mute /kick（管理员）

import { serve, host, chatOf } from '../_sdk/qixin.mjs'

// 每群的配置存在插件私有存储里：gm:<群号>:<key>
// 不塞进一个 JSON，避免两个群同时改时互相覆盖（虽然插件是串行的，
// 但拆开更清楚，也方便以后单独清某个群）。
async function getCfg(chatId, key, fallback) {
  const v = await host.storage.get(`gm:${chatId}:${key}`)
  return v === null || v === undefined ? fallback : v
}

async function setCfg(chatId, key, value) {
  await host.storage.set(`gm:${chatId}:${key}`, value)
}

function isAdmin(session) {
  const role = session.role || ''
  return role === 'owner' || role === 'admin'
}

// 从消息段里找被 @ 的人；没有就取发送者（配合"回复某人"用）
function targetOf(segments, session) {
  for (const seg of segments || []) {
    if (seg.type === 'at') {
      const qq = Number(seg.data?.qq || 0)
      if (qq > 0) return qq
    }
  }
  return session.user_id
}

serve({
  async initialize() {
    host.log('info', '群管理已加载')
    return { api_version: '1.0' }
  },

  // ---- 通知类事件 ----
  async handle_event({ event }) {
    const type = event?.notice_type || ''
    const sub = event?.sub_type || ''
    const groupId = event?.group_id || 0
    const userId = event?.user_id || 0

    if (!groupId) return {}

    // 有人进群
    if (type === 'group_increase') {
      const enabled = await getCfg(groupId, 'welcome_enabled', true)
      if (!enabled) return {}

      const raw = await getCfg(groupId, 'welcome_text', '欢迎 {at} 加入本群！')
      const text = String(raw).replaceAll('{at}', `@${userId}`)

      await host.send_message(
        { chat_type: 'group', chat_id: groupId },
        [
          { type: 'at', data: { qq: String(userId) } },
          { type: 'text', data: { text: ' ' + text.replace(`@${userId}`, '').trim() } },
        ],
      )
      return {}
    }

    // 有人退群
    if (type === 'group_decrease' && sub !== 'kick_me') {
      const enabled = await getCfg(groupId, 'leave_notice', true)
      if (!enabled) return {}
      await host.send_message(
        { chat_type: 'group', chat_id: groupId },
        [{ type: 'text', data: { text: `有人离开了本群（${userId}）` } }],
      )
      return {}
    }

    return {}
  },

  // ---- 消息：违禁词 ----
  async handle_message({ session }) {
    const text = (session.text ?? '').trim()

    // 违禁词检查（不带前缀也生效）
    if (text && session.chat_type === 'group') {
      const words = (await getCfg(session.chat_id, 'ban_words', [])) || []
      if (words.length) {
        const hit = words.find((w) => w && text.includes(w))
        if (hit) {
          // 撤回原消息
          try {
            await host.call_onebot('delete_msg', { message_id: session.message_id })
          } catch (e) {
            host.log('warn', `撤回失败（可能权限不够）：${e.message}`)
          }
          await host.reply(chatOf(session), `「${hit}」是违禁词，已撤回`)
          return { handled: true }
        }
      }
    }

    // ---- 命令 ----
    const parts = text.split(/\s+/)
    const cmd = (parts[0] || '').toLowerCase()

    if (cmd === 'welcome') {
      if (!isAdmin(session)) return { handled: false }
      const t = text.slice(7).trim()
      if (!t) {
        const cur = await getCfg(session.chat_id, 'welcome_text', '（未设置，用默认）')
        await host.reply(chatOf(session), `当前欢迎语：\n${cur}\n\n用 /welcome <文本> 修改，{at} 会替换成 @新人`)
        return { handled: true }
      }
      await setCfg(session.chat_id, 'welcome_text', t)
      await host.reply(chatOf(session), '欢迎语已更新')
      return { handled: true }
    }

    if (cmd === 'banword') {
      if (!isAdmin(session)) return { handled: false }
      const w = text.slice(7).trim()
      if (!w) {
        await host.reply(chatOf(session), '用法：/banword <词>')
        return { handled: true }
      }
      const words = (await getCfg(session.chat_id, 'ban_words', [])) || []
      if (!words.includes(w)) {
        words.push(w)
        await setCfg(session.chat_id, 'ban_words', words)
      }
      await host.reply(chatOf(session), `已添加违禁词「${w}」（共 ${words.length} 个）`)
      return { handled: true }
    }

    if (cmd === 'unbanword') {
      if (!isAdmin(session)) return { handled: false }
      const w = text.slice(9).trim()
      const words = (await getCfg(session.chat_id, 'ban_words', [])) || []
      const next = words.filter((x) => x !== w)
      if (next.length === words.length) {
        await host.reply(chatOf(session), `没有「${w}」这个词`)
      } else {
        await setCfg(session.chat_id, 'ban_words', next)
        await host.reply(chatOf(session), `已移除「${w}」（剩 ${next.length} 个）`)
      }
      return { handled: true }
    }

    if (cmd === 'gm') {
      if (!isAdmin(session)) return { handled: false }
      const words = (await getCfg(session.chat_id, 'ban_words', [])) || []
      const welcome = await getCfg(session.chat_id, 'welcome_text', '（默认）')
      const enabled = await getCfg(session.chat_id, 'welcome_enabled', true)
      await host.reply(chatOf(session), [
        `本群配置`,
        `欢迎语：${enabled ? '开' : '关'}`,
        `  内容：${welcome}`,
        `违禁词（${words.length}）：${words.join('、') || '（无）'}`,
      ].join('\n'))
      return { handled: true }
    }

    if (cmd === 'mute') {
      if (!isAdmin(session)) return { handled: false }
      const sec = parseInt(parts[1] || '60', 10) || 60
      const target = targetOf(session.segments, session)
      try {
        await host.call_onebot('set_group_ban', {
          group_id: session.chat_id,
          user_id: target,
          duration: sec,
        })
        await host.reply(chatOf(session), `已禁言 ${target} ${sec} 秒`)
      } catch (e) {
        await host.reply(chatOf(session), `禁言失败：${e.message}`)
      }
      return { handled: true }
    }

    if (cmd === 'kick') {
      if (!isAdmin(session)) return { handled: false }
      const target = targetOf(session.segments, session)
      try {
        await host.call_onebot('set_group_kick', {
          group_id: session.chat_id,
          user_id: target,
        })
        await host.reply(chatOf(session), `已踢出 ${target}`)
      } catch (e) {
        await host.reply(chatOf(session), `踢人失败：${e.message}`)
      }
      return { handled: true }
    }

    return { handled: false }
  },

  async run_task() {
    return {}
  },
})
