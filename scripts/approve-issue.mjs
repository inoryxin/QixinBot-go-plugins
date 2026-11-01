#!/usr/bin/env node
/**
 * 审核通过 → 自动上架（在插件仓库 checkout 内运行，写本仓库的 registry.json）
 *
 * 环境变量（Actions 自动提供）：
 *   GITHUB_TOKEN       自动 token，需 workflow 声明 permissions: contents=write, issues=write
 *   GITHUB_REPOSITORY  inoryxin/QixinBot-go-plugins
 *   ISSUE_NUM          要上架的 Issue 编号
 *   NETLIFY_HOOK       官网 Netlify build hook URL（触发官网重建）
 *
 * 手动模式：node scripts/approve-issue.mjs --issue <编号>   （不写 --auto 只预览）
 */
import { execSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listZipEntries, parseManifest } from './lib-anzu.mjs'
import process from 'node:process'

const num = process.env.ISSUE_NUM ?? (process.argv.find(a => /^\d+$/.test(a)) ?? '')
const auto = process.argv.includes('--auto') || !!process.env.ISSUE_NUM
const token = process.env.GITHUB_TOKEN
const repo = process.env.GITHUB_REPOSITORY ?? 'inoryxin/QixinBot-go-plugins'
const hook = process.env.NETLIFY_HOOK
if (!num) { console.error('✗ 缺 ISSUE_NUM'); process.exit(1) }

const API = `https://api.github.com/repos/${repo}`
function api(method, path, body) {
  const bf = body ? join(tmpdir(), 'gh-body.json') : null
  if (body) writeFileSync(bf, JSON.stringify(body))
  const out = execSync(
    `curl -s -m 60 -H "Authorization: Bearer ${token}" -H "Accept: application/vnd.github+json" ` +
    `-X ${method} "${API}${path}"${bf ? ` --data-binary @${bf}` : ''}`,
    { maxBuffer: 64 * 1024 * 1024 })
  try { return JSON.parse(out.toString('utf8')) } catch { return null }
}

console.log(`拉取 issue #${num}…`)
const issue = api('GET', `/issues/${num}`)
if (!issue?.title) { console.error('✗ issue 拉取失败'); process.exit(1) }
console.log(`标题：${issue.title}｜提交者：${issue.user?.login}`)

const fields = {}
let m
const re = /### ([^\n]+)\n([\s\S]*?)(?=\n+### |\n*$)/g
while ((m = re.exec(issue.body ?? ''))) fields[m[1].trim()] = m[2].trim()
const F = {
  name: fields['插件中文名'] ?? '', id: fields['插件 ID'] ?? '',
  summary: fields['一句话简介'] ?? '', language: fields['语言'] ?? 'Node.js',
  deps: (fields['运行依赖'] ?? '').split(/[、,，\s]+/).filter(Boolean),
  repo: fields['源码仓库地址'] ?? '', download: fields['.anzu 下载直链'] ?? '',
  pubkey: (fields['签名公钥或指纹'] ?? '').split('\n')[0] ?? '',
  category: fields['分类'] ?? '其他',
}
if (!F.id || !F.download) { console.error('✗ 申请缺插件 ID 或下载直链'); process.exit(1) }

console.log('下载 .anzu…')
const tmp = mkdtempSync(join(tmpdir(), 'approve-'))
const pkgPath = join(tmp, 'pkg.anzu')
writeFileSync(pkgPath, execSync(`curl -sL -m 300 -o - "${F.download}"`, { maxBuffer: 256 * 1024 * 1024 }))

const raw = readFileSync(pkgPath)
const entries = listZipEntries(raw)
const mEntry = entries.find(e => e.name === 'manifest.toml')
const man = parseManifest(mEntry.data.toString('utf8'))
console.log(`包内 manifest: id=${man.id} name=${man.name} version=${man.version} kind=${man.kind ?? 'plugin'}`)

const problems = []
if (man.id !== F.id) problems.push(`ID 不一致：issue=${F.id} 包=${man.id}`)

const TEXT_RE = /\.(js|mjs|cjs|py|json|toml|css|html|md|sh)$/i
const urls = new Set()
const flags = []
const SUSPICIOUS = [
  [/eval\s*\(/, 'eval()'], [/new\s+Function/, 'new Function'],
  [/child_process|execSync|spawnSync|exec\(/, '子进程调用'],
  [/\.env\b|cookie|password|passwd|credential/i, '凭据关键词'],
  [/writeFileSync|rmSync|unlink/i, '文件写入/删除'],
  [/registry|startup|schtasks|crontab/i, '持久化线索'],
]
for (const e of entries) {
  if (!TEXT_RE.test(e.name) || e.data.length > 2 * 1024 * 1024) continue
  const text = e.data.toString('utf8')
  for (const u of text.matchAll(/https?:\/\/[\w.-]+(?:\/[\w./?%&=-]*)?/g)) urls.add(u[0])
  for (const [re2, label] of SUSPICIOUS) if (re2.test(text)) flags.push(`${label} ← ${e.name}`)
}
console.log(`安全扫描：外联 ${urls.size} 个，可疑 ${flags.length} 项`)
for (const f of [...new Set(flags)]) console.log('  ⚠', f)

const CAT = { 'AI 助手': 'ai', 娱乐互动: 'fun', 订阅推送: 'feed', 群聊管理: 'group', 工具查询: 'tool', 设备管家: 'device' }
const entry = {
  id: man.id ?? F.id,
  name: F.name || man.name || '',
  tier: 'third-party',
  kind: man.kind === 'theme' ? 'theme' : 'plugin',
  category: CAT[F.category] ?? 'tool',
  description: F.summary || man.description || '',
  language: F.language,
  deps: F.deps,
  permissions: String(man.permissions ?? '').split(/[[\]",\s]+/).filter(s => s.startsWith('onebot.')),
  observe: /observe\s*=\s*true/.test(mEntry.data.toString('utf8')),
  version: man.version ?? '?',
  author: issue.user?.login ?? '未知',
  repo: F.repo, package: F.download,
  fingerprint: F.pubkey || null, tags: [],
}

const regPath = join(process.cwd(), 'registry.json')
const list = JSON.parse(readFileSync(regPath, 'utf8'))
if (list.some(e => e.id === entry.id)) {
  console.log('ℹ 商店里已有该插件，只更新条目')
  const i = list.findIndex(e => e.id === entry.id)
  list[i] = entry
} else {
  list.push(entry)
}
writeFileSync(regPath, JSON.stringify(list, null, 2) + '\n')
console.log(`✓ registry.json 已更新（${list.length} 条）`)

if (!auto) { console.log('\n[dry-run] 未提交'); rmSync(tmp, { recursive: true, force: true }); process.exit(0) }
if (problems.length) { console.error('✗ 有未解决问题：' + problems.join('；')); rmSync(tmp, { recursive: true, force: true }); process.exit(1) }

const git = (cmd) => execSync(cmd, { stdio: 'pipe' })
git(`git config user.name "QixinBot 商店管理台"`)
git(`git config user.email "store@qixinbot.local"`)
git(`git add registry.json`)
git(`git commit -m "商店上架第三方插件 ${entry.name}(${entry.id})，审核 ${repo}#${num}"`)
git(`git push`)
console.log('✓ registry 已推送')

if (hook) {
  execSync(`curl -s -m 30 -X POST "${hook}"`, { stdio: 'pipe' })
  console.log('✓ 已触发官网重建')
} else {
  console.log('⚠ 未配置 NETLIFY_HOOK，官网未触发重建')
}

api('POST', `/issues/${num}/comments`, { body: `✅ 审核通过，已上架插件商店：${entry.name}（${entry.id}）。\n\n下架/更新请发新 Issue 或联系管理员。` })
api('PATCH', `/issues/${num}`, { state: 'closed' })
console.log('✓ Issue 已留言并关闭')
rmSync(tmp, { recursive: true, force: true })
