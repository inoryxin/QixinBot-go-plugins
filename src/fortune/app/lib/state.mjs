// 运势状态：哪些群设了什么主题、谁今天抽过了。
// 原版读写 data/fortune.json，这里统一走 host.storage。
import { host } from '../../_sdk/qixin.mjs'

export async function readState() {
  const raw = (await host.storage.get('fortune')) || {}
  return {
    groups: raw.groups && typeof raw.groups === 'object' ? raw.groups : {},
    users: raw.users && typeof raw.users === 'object' ? raw.users : {},
  }
}

export async function writeState(state) {
  await host.storage.set('fortune', state)
}

export function todayStamp(now = new Date()) {
  const pad = (v) => String(v).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

// 群用群号，私聊用 private:QQ
export function scopeKey(session) {
  return session.chat_type === 'group' ? String(session.chat_id) : `private:${session.user_id}`
}

export function userKey(session) {
  return session.chat_type === 'group' ? String(session.user_id) : 'self'
}
