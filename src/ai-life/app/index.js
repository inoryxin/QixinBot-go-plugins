// 她的生活：模拟一个人一天在干什么。
//
// 这不是"随机回复"，而是给 AI 聊天一个**稳定的状态源**：
//   - 10 点在上班 → AI 回复短、说忙、可能过一会儿才回
//   - 12 点在吃饭 → AI 会提到吃了什么
//   - 凌晨 3 点     → AI 在睡，被叫醒会不耐煩（但会回）
//
// 为什么单独一个插件而不是塞进 ai-chat：
//   主动消息（ai-proactive）、语音（ai-voice）、表情（ai-sticker）
//   都要读同一个状态，放一个服务里大家都能用。

import os from 'node:os'
import { serve, host } from '../_sdk/qixin.mjs'

let settings = {}

// 一天的时间表。每段的活动有多个变体，按日期轮换，别每天一模一样。
// [起始小时, 结束小时, 阶段, 心情, 精力, [活动变体...]]
const WEEKDAY = [
  [0, 7, 'sleep', '困得不行', 15, ['在睡觉', '在睡觉，被窝里']],
  [7, 8, 'wake', '还没清醒', 40, ['刚醒，赖在床上', '在洗漱']],
  [8, 9, 'commute', '行吧', 55, ['在通勤路上', '在买早餐']],
  [9, 12, 'work', '有点忙', 65, ['在上班，对着电脑', '在开会', '在改表格']],
  [12, 13, 'lunch', '放松', 60, ['在吃午饭', '在点外卖']],
  [13, 14, 'rest', '犯困', 45, ['在午休', '在摸鱼刷手机']],
  [14, 18, 'work', '累', 45, ['在上班，想下班', '在处理一堆杂事', '在赶进度']],
  [18, 19, 'commute', '轻松', 50, ['在下班路上', '刚到家']],
  [19, 21, 'play', '开心', 60, ['在吃饭', '在打游戏', '在看番']],
  [21, 23, 'relax', '松弛', 45, ['在洗澡', '在刷手机', '在敷面膜']],
  [23, 24, 'sleep', '困了', 25, ['准备睡了', '在酝酿睡意']],
]

const WEEKEND = [
  [0, 9, 'sleep', '困', 20, ['在睡懒觉', '在睡觉']],
  [9, 10, 'wake', '迷糊', 45, ['刚醒，赖床', '在刷牙']],
  [10, 12, 'play', '悠闲', 70, ['在打游戏', '在看剧', '在收拾屋子']],
  [12, 13, 'lunch', '放松', 65, ['在吃午饭', '在点外卖']],
  [13, 15, 'rest', '犯困', 50, ['在午睡', '在沙发上躺着']],
  [15, 18, 'play', '开心', 70, ['在逛街', '在打游戏', '在看番']],
  [18, 19, 'play', '满足', 60, ['在吃饭', '在点外卖']],
  [19, 23, 'play', '兴奋', 65, ['在打游戏', '在追剧', '在跟朋友聊天']],
  [23, 24, 'sleep', '困', 25, ['准备睡了', '在刷最后一会儿手机']],
]

function dayIndex(d) {
  return Math.floor(d.getTime() / 86_400_000)
}

function pick(list, d) {
  return list[dayIndex(d) % list.length]
}

function phaseFor(hour, dayOfWeek) {
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6
  const table = isWeekend ? WEEKEND : WEEKDAY
  for (const row of table) {
    if (hour >= row[0] && hour < row[1]) return row
  }
  return table[table.length - 1]
}

// 精力在同阶段内缓慢下降，看起来像真的在消耗
function energyOf(base, row, minutesIn) {
  const span = Math.max(1, (row[1] - row[0]) * 60)
  const drop = Math.round((base - 15) * (minutesIn / span))
  return Math.max(10, Math.min(100, base - drop))
}

function nextChange(row) {
  return String(row[1]).padStart(2, '0') + ':00'
}

async function currentState() {
  const now = new Date()
  const hour = now.getHours()
  const minute = now.getMinutes()

  // 手动覆盖优先（加班/出门这种临时状态）
  try {
    const ov = await host.storage.get('life:override')
    if (ov && ov.until > Date.now()) {
      return {
        activity: ov.activity,
        mood: ov.mood || '说不上来',
        energy: typeof ov.energy === 'number' ? ov.energy : 50,
        awake: true,
        phase: 'override',
        local_time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        next_change: new Date(ov.until).toTimeString().slice(0, 5),
        sleep: false,
      }
    }
  } catch {
    // 存储读不到就当没有覆盖
  }

  const row = phaseFor(hour, now.getDay())
  const [start, , phase, mood, base, variants] = row
  const minutesIn = (hour - start) * 60 + minute
  const asleep = phase === 'sleep'

  return {
    activity: pick(variants, now),
    mood,
    energy: energyOf(base, row, minutesIn),
    awake: !asleep,
    sleep: asleep,
    phase,
    local_time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    next_change: nextChange(row),
  }
}

function describe(st) {
  const bits = [`现在是 ${st.local_time}`, `你${st.activity}`]
  bits.push(`心情${st.mood}`, `精力 ${st.energy}/100`)
  if (st.sleep) bits.push('这个点你本该在睡觉')
  return bits.join('，')
}

serve({
  async initialize({ settings: s }) {
    settings = s || {}
    host.log('info', '她的生活已启动')
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    settings = { ...settings, ...values }
    return { ok: true }
  },

  async call_tool({ name, args }) {
    return callCapability(name, args)
  },

  async __capability(name, args) {
    return callCapability(name, args)
  },
})

async function callCapability(name, args) {
  if (name === 'life.now') {
    const st = await currentState()
    return { ok: true, data: { ...st, text: describe(st) } }
  }

  if (name === 'life.set') {
    const activity = String(args?.activity ?? '').trim()
    if (!activity) return { ok: false, error: 'activity 不能为空' }
    const minutes = Math.max(1, Math.min(24 * 60, Number(args?.minutes) || 60))
    await host.storage.set('life:override', {
      activity,
      until: Date.now() + minutes * 60_000,
      mood: String(args?.mood ?? ''),
      energy: Number(args?.energy) || 50,
    })
    return {
      ok: true,
      data: { activity, minutes, until: new Date(Date.now() + minutes * 60_000).toISOString() },
    }
  }

  return { ok: false, error: `未知能力 ${name}` }
}
