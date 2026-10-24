// 服务器状态：CPU / 内存 / 磁盘 / 运行时长。
//
// 移植自旧版 status（当时依赖旧框架的 system-info + 模板引擎）。
// 新版只用 Node 内置模块，不再依赖框架内部实现：
//   os.cpus() / os.totalmem() / os.freemem() / os.uptime()
//   fs.statfsSync()  ← Node 18+，跨平台拿磁盘容量
//
// 用法：/status 或 /状态

import os from 'node:os'
import fs from 'node:fs'
import { serve, host, chatOf } from '../_sdk/qixin.mjs'

let settings = {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// CPU 使用率要采样两次：单次 os.cpus() 只是累计值，算不出瞬时占用。
// 只统计 active/total 的差值，和 top 的口径接近。
function cpuSnapshot() {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v
    idle += c.times.idle
  }
  return { idle, total }
}

async function cpuUsage(sampleMs) {
  const a = cpuSnapshot()
  await sleep(Math.max(100, Math.min(2000, sampleMs | 0 || 400)))
  const b = cpuSnapshot()
  const totalDiff = b.total - a.total
  const idleDiff = b.idle - a.idle
  if (totalDiff <= 0) return 0
  return Math.max(0, Math.min(100, (1 - idleDiff / totalDiff) * 100))
}

function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`
}

// 磁盘：Windows 从 C: 开始试（系统盘一定在），其它平台用 /
function diskUsage() {
  const candidates = process.platform === 'win32' ? ['C:', 'D:', 'E:', 'F:'] : ['/']
  const out = []
  for (const p of candidates) {
    try {
      const st = fs.statfsSync(p)
      const total = st.blocks * st.bsize
      const free = st.bfree * st.bsize
      if (total <= 0) continue
      out.push({
        path: p,
        total,
        free,
        used: total - free,
        percent: ((total - free) / total) * 100,
      })
    } catch {
      // 盘不存在/无权限：跳过
    }
  }
  return out
}

function bar(percent) {
  const n = Math.round(Math.max(0, Math.min(100, percent)) / 10)
  return '█'.repeat(n) + '░'.repeat(10 - n)
}

function duration(sec) {
  const s = Math.max(0, Math.floor(sec))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}天${h}小时`
  if (h > 0) return `${h}小时${m}分`
  return `${m}分`
}

function trim(text) {
  const t = (text ?? '').trim()
  // 兼容 "/状态" 和 "@机器人 /status"
  return t.replace(/^\/+/, '')
}

serve({
  async initialize({ settings: s }) {
    settings = s || {}
    host.log('debug', '服务器状态插件已加载')
    return { api_version: '1.0' }
  },

  async handle_message({ session }) {
    const cmd = trim(session.text)
    if (!/^(status|状态)$/i.test(cmd)) return { handled: false }

    const sampleMs = Number(settings.sample_ms ?? 400)
    const cpu = await cpuUsage(sampleMs)

    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const usedMem = totalMem - freeMem
    const memPercent = (usedMem / totalMem) * 100

    const lines = [
      `🖥 ${os.hostname()}  ${os.type()} ${os.release()} / ${process.arch}`,
      '',
      `CPU  ${bar(cpu)} ${cpu.toFixed(0)}%`,
      `     ${os.cpus().length} 核 · 负载 ${os.loadavg()[0].toFixed(2)}`,
      `内存 ${bar(memPercent)} ${memPercent.toFixed(0)}%`,
      `     ${bytes(usedMem)} / ${bytes(totalMem)}`,
      `运行 ${duration(os.uptime())}`,
    ]

    if (settings.show_disk !== false) {
      const disks = diskUsage()
      if (disks.length) {
        lines.push('磁盘')
        for (const d of disks) {
          lines.push(`  ${d.path} ${bar(d.percent)} ${d.percent.toFixed(0)}%  ${bytes(d.used)}/${bytes(d.total)}`)
        }
      }
    }

    await host.reply(chatOf(session), lines.join('\n'))
    return { handled: true }
  },
})
