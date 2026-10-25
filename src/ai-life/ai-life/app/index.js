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


// ---------------- 自动日程 ----------------
function pad(n) { return String(n).padStart(2, '0') }
function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function tomorrowDate() { return dateStr(new Date(Date.now() + 86400000)) }
function resolveDate(v) {
  const s = String(v || '').trim()
  if (s === 'tomorrow' || s === '明天') return tomorrowDate()
  if (!s || s === 'today' || s === '今天') return dateStr(new Date())
  return s
}
function isWorkday(dateStrValue) {
  const d = new Date(dateStrValue + 'T12:00:00')
  const wd = d.getDay() === 0 ? 7 : d.getDay() // 1-7, 7=周日
  const spec = String(settings.work_days || '1-5')
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map(Number)
    if (b ? wd >= a && wd <= b : wd === a) return true
  }
  return false
}
async function loadPlan(date) {
  const v = await host.storage.get(`life:plan:${date}`)
  return Array.isArray(v) ? v : []
}
async function clearAllPlans() {
  const keys = await host.storage.list('life:plan:')
  for (const k of keys) await host.storage.delete(k)
}
async function previousPlan(date) {
  // 找最近一个同类型（工作日/周末）计划，复用它的时间段保证规律
  const target = isWorkday(date)
  for (let i = 1; i <= 7; i++) {
    const d = new Date(date + 'T12:00:00')
    d.setDate(d.getDate() - i)
    const ds = dateStr(d)
    if (isWorkday(ds) !== target) continue
    const items = await loadPlan(ds)
    if (items.length) return items
  }
  return []
}
function summarizePlan(items) {
  return items
    .filter((it) => it.activity)
    .map((it) => `${it.start} ${it.activity}`)
    .slice(0, 5)
    .join('；')
}
async function generatePlan(date, force = false) {
  if (!force && (await loadPlan(date)).length) return
  const prev = await previousPlan(date)
  const work = isWorkday(date)
  const slots = prev.map((it) => `${it.start}-${it.end}`).join('、')
  const prompt = work
    ? `她的职业是「${settings.occupation || '上班族'}」。${date} 是工作日。作息：${settings.wake_hour ?? 7} 点起床，${settings.sleep_hour ?? 23} 点睡觉，${settings.work_start ?? 9}-${settings.work_end ?? 18} 上班。
请生成这一天的详细时间表，保持和平时一致：${slots ? '时间段固定为 ' + slots + '，只填每段在做什么、心情、精力。' : '从起床到睡觉，时间段连续。'}
只输出 JSON 数组：{"start":"HH:MM","end":"HH:MM","activity":"在做什么","mood":"心情","energy":0-100}，不要解释。`
    : `她的职业是「${settings.occupation || '上班族'}」。${date} 是休息日，不上班。
请生成这一天的详细时间表，安排休息、出门或娱乐：${slots ? '时间段固定为 ' + slots + '，只填每段在做什么、心情、精力。' : '从起床到睡觉，时间段连续。'}
只输出 JSON 数组：{"start":"HH:MM","end":"HH:MM","activity":"在做什么","mood":"心情","energy":0-100}，不要解释。`
  const r = await host.capability('llm.chat', {
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5,
  })
  const text = String(r?.data?.text || '')
  const m = /\[[\s\S]*\]/.exec(text)
  if (!m) throw new Error('模型没有返回时间表')
  const parsed = JSON.parse(m[0])
  let items = normalizePlan(parsed)
  if (prev.length) {
    // 同类型日期强制复用上一份的时间段，保证"每天同一个点做同一类事"
    items = prev.map((slot, i) => ({
      start: slot.start,
      end: slot.end,
      activity: items[i]?.activity || slot.activity || '休息',
      mood: items[i]?.mood || slot.mood || '平静',
      energy: typeof items[i]?.energy === 'number' ? items[i].energy : (slot.energy ?? 50),
    }))
  }
  if (!items.length) throw new Error('时间表为空')
  await host.storage.set(`life:plan:${date}`, items)
  host.log('info', `已生成 ${date} 的时间表（${items.length} 段，${work ? '工作日' : '休息日'}）`)
}
async function ensurePlans() {
  const base = new Date()
  for (let i = 0; i <= 2; i++) {
    const d = new Date(base)
    d.setDate(d.getDate() + i)
    const ds = dateStr(d)
    try { await generatePlan(ds) } catch (e) { host.log('warn', `生成 ${ds} 日程失败: ${e.message}`) }
  }
}
function scheduleMidnight() {
  const now = new Date()
  const next = new Date(now)
  next.setHours(24, 0, 5, 0)
  setTimeout(async () => {
    try { await ensurePlans() } catch (e) { host.log('warn', '零点日程失败: ' + e.message) }
    scheduleMidnight()
  }, Math.max(1000, next.getTime() - now.getTime()))
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

  // 当天有时间表就用时间表
  try {
    const key = `life:plan:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const plan = await host.storage.get(key)
    if (Array.isArray(plan)) {
      const mins = hour * 60 + minute
      const slot = plan.find((it) => {
        const [h1, m1] = String(it.start || '0:0').split(':').map(Number)
        const [h2, m2] = String(it.end || '24:0').split(':').map(Number)
        return mins >= h1 * 60 + (m1 || 0) && mins < h2 * 60 + (m2 || 0)
      })
      if (slot) {
        const asleep = /睡/.test(String(slot.activity || ''))
        return {
          activity: slot.activity || '发呆',
          mood: slot.mood || '说不上来',
          energy: typeof slot.energy === 'number' ? slot.energy : 60,
          awake: !asleep,
          sleep: asleep,
          phase: 'plan',
          local_time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
          next_change: slot.end || '',
        }
      }
    }
  } catch {}

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
    ensurePlans().catch((e) => host.log('warn', '初始化日程失败: ' + e.message))
    scheduleMidnight()
    return { api_version: '1.0' }
  },

  async set_settings({ values }) {
    const oldKey = settings.occupation + '|' + settings.work_days
    settings = { ...settings, ...values }
    const newKey = settings.occupation + '|' + settings.work_days
    if (oldKey !== newKey) {
      await clearAllPlans()
      ensurePlans().catch((e) => host.log('warn', '重排日程失败: ' + e.message))
    }
    return { ok: true }
  },

  async call_tool({ name, args }) {
    if (name === 'life_now') return callCapability('life.now', args)
    if (name === 'life_plan') {
      const date = resolveDate(args?.date)
      const items = await loadPlan(date)
      if (!items.length) return { ok: true, data: { text: `${date} 还没有安排` } }
      return { ok: true, data: { text: `${date}：` + summarizePlan(items) } }
    }
    return callCapability(name, args)
  },

  async __capability(name, args) {
    return callCapability(name, args)
  },
})

async function callCapability(name, args) {
  if (name === 'life.now') {
    const st = await currentState()
    const tomorrow = tomorrowDate()
    const tItems = await loadPlan(tomorrow)
    return {
      ok: true,
      data: {
        ...st,
        text: describe(st),
        tomorrow_date: tomorrow,
        tomorrow_summary: tItems.length ? summarizePlan(tItems) : '',
      },
    }
  }

  if (name === 'life.plan') {
    const action = String(args?.action || 'get')
    const date = String(args?.date || '').trim() || tomorrow()
    if (action === 'get') {
      const items = await host.storage.get(`life:plan:${date}`)
      return { ok: true, data: { date, items: Array.isArray(items) ? items : [] } }
    }
    if (action === 'clear') {
      await host.storage.delete(`life:plan:${date}`)
      return { ok: true, data: { date, items: [] } }
    }
    if (action === 'save') {
      const items = normalizePlan(args?.items)
      if (!items.length) return { ok: false, error: '时间表不能为空' }
      await host.storage.set(`life:plan:${date}`, items)
      return { ok: true, data: { date, items } }
    }
    if (action === 'generate') {
      const r = await host.capability('llm.chat', {
        messages: [{
          role: 'user',
          content: `她的作息：${settings.wake_hour ?? 7} 点起床，${settings.sleep_hour ?? 23} 点睡觉，${settings.work_start ?? 9}-${settings.work_end ?? 18} 上班。请为 ${date} 生成一份从起床到睡觉的详细时间表，只输出 JSON 数组，元素格式 {"start":"HH:MM","end":"HH:MM","activity":"在做什么","mood":"心情","energy":0-100}，覆盖全天、时间段连续、不要解释。`,
        }],
        temperature: 0.7,
      })
      const text = String(r?.data?.text || '')
      const m = /\[[\s\S]*\]/.exec(text)
      if (!m) return { ok: false, error: '模型没有返回时间表' }
      let parsed
      try { parsed = JSON.parse(m[0]) } catch { return { ok: false, error: '时间表 JSON 解析失败' } }
      const items = normalizePlan(parsed)
      if (!items.length) return { ok: false, error: '时间表为空' }
      await host.storage.set(`life:plan:${date}`, items)
      return { ok: true, data: { date, items } }
    }
    return { ok: false, error: '未知 action: ' + action }
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

function tomorrow() {
  const d = new Date(Date.now() + 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function normalizePlan(items) {
  if (!Array.isArray(items)) return []
  return items.map((it) => ({
    start: String(it?.start || '').slice(0, 5),
    end: String(it?.end || '').slice(0, 5),
    activity: String(it?.activity || '').trim(),
    mood: String(it?.mood || '').trim(),
    energy: Math.max(0, Math.min(100, Number(it?.energy) || 50)),
  })).filter((it) => it.start && it.end && it.activity)
}
