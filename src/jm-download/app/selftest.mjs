// 离线自检：不联网、不启动框架，只验证插件最容易被"搬坏"的部分。
//
//   node app/selftest.mjs
//
// 覆盖：ID 归一化 / 路径消毒 / 接口加解密 / 网页兜底解析 / 域名候选 /
//       竖切切块数（Python 用例）/ ZIP 加密与可解压 / 两张信息图渲染 /
//       PDF 合成（Pillow）
//
// 这些跑通不代表"线上一定好"，但能挡住移植时最常见的几类回归：
// 常量抄错、路径拼错、Python 桥接参数错、ZIP 头写错、字体/编码问题。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import * as engine from './engine.js'
import * as pdfBridge from './pdf.js'
import { createZip, buildZipName } from './zip.js'
import { configure as configureDaily, renderDigestImage, renderAlbumImage } from './daily_updates.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 临时目录放在工作目录下：有的环境（容器/沙箱）把 %TEMP% 设成只读，
// 子进程 Python 往系统临时目录写图会 Permission denied，白跑一遍自检。
const TMP = fs.mkdtempSync(path.join(process.cwd(), '.selftest-tmp-'))

let pass = 0
const failures = []

function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1
  } else {
    failures.push(`${name}${detail ? `：${detail}` : ''}`)
  }
}

function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

function run(name, fn) {
  try {
    fn()
  } catch (e) {
    failures.push(`${name} 抛异常：${e?.stack ?? e}`)
  }
}

function py(script, args = [], input = undefined) {
  const r = spawnSync(script, args, {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    input,
  })
  if (r.status !== 0 && process.env.JM_SELFTEST_DEBUG) {
    console.error('[py fail]', script, JSON.stringify(args.slice(0, 2)), '\n', String(r.stderr || '').slice(0, 3000))
  }
  return r
}

// ── 1. 纯函数 ──────────────────────────────────────────────────────────────

run('ID 归一化', () => {
  eq('jm123456', engine.normalizeAlbumId('jm123456'), '123456')
  eq('JM-123456', engine.normalizeAlbumId('JM-123456'), '123456')
  eq('链接', engine.normalizeAlbumId('https://18comic.vip/album/422444/xxx'), '422444')
  eq('超长数字不截断', engine.normalizeAlbumId('123456789012'), '')
  eq('纯文字', engine.normalizeAlbumId('你好'), '')
})

run('路径消毒', () => {
  eq('非法字符', engine.sanitizeSegment('a/b:c*d?', 'x'), 'a b c d')
  eq('空回退', engine.sanitizeSegment('   ', 'JM1'), 'JM1')
  eq('图片名', engine.imageFileName('00001.webp', 1), '00001.webp')
  eq('无扩展名', engine.imageFileName('abc', 7), 'abc.jpg')
  ok('isImageFileName 不误判 pdf', engine.isImageFileName('x.pdf') === false)
  ok('isImageFileName 认 webp', engine.isImageFileName('a.webp') === true)
})

run('接口加解密', () => {
  const ts = Math.floor(Date.now() / 1000)
  const key = Buffer.from(crypto.createHash('md5').update(`${ts}${engine.APP_DATA_SECRET}`).digest('hex'), 'utf8')
  const cipher = crypto.createCipheriv('aes-256-ecb', key, null)
  cipher.setAutoPadding(false)
  const plain = Buffer.from(JSON.stringify({ id: '422444', name: '测试本子' }), 'utf8')
  const pad = 16 - (plain.length % 16)
  const padded = Buffer.concat([plain, Buffer.alloc(pad, pad)])
  const data = Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64')
  const decoded = engine.decodeApiEnvelope(JSON.stringify({ code: 200, data }), ts)
  eq('解密结果', decoded, { id: '422444', name: '测试本子' })
  eq('code 非 200', engine.decodeApiEnvelope(JSON.stringify({ code: 401, data }), ts), null)
})

run('网页兜底解析', () => {
  const html = `<html><head><meta property="og:url" content="https://x/album/123456/abc">
    <meta property="og:image" content="https://img/1.jpg">
    <meta name="description" content="简介内容"></head>
    <body><title>某个本子| 禁漫</title>
    <script>var page_arr = ["00001.webp","00002.webp"]; var scramble_id = 220980;</script></body></html>`
  const got = engine.parseWebHtml(html)
  ok('解析出 ID', got?.id === '123456', JSON.stringify(got))
  ok('解析出图片', got?.images?.length === 2)
  ok('解析出 scramble', got?.scramble_id === '220980')
})

run('域名候选', () => {
  const list = engine.domainCandidates('https://a.com/x, b.com')
  ok('用户域名最先', list[0] === 'a.com' && list[1] === 'b.com', list.slice(0, 3).join(','))
  ok('去重', new Set(list).size === list.length)
  ok('包含内置', list.includes('www.cdnhjk.net') && list.includes('18comic.vip'))
})

// ── 2. Python 能力 ─────────────────────────────────────────────────────────

const pyInfo = pdfBridge.findPython('')
ok('找到 Python', pyInfo.ok, pyInfo.error || '')
const python = pyInfo.exe

if (python) {
  const selftest = py(python, [path.join(HERE, 'jm_worker.py'), '--selftest'])
  const line = String(selftest.stdout || '').trim().split(/\r?\n/).pop() || ''
  let parsed = null
  try {
    parsed = JSON.parse(line)
  } catch {
    /* 下面会报 */
  }
  ok('竖切切块数用例', parsed?.ok === true, line.slice(0, 200))

  const check = py(python, [path.join(HERE, 'jm_worker.py'), '--check'])
  const cline = String(check.stdout || '').trim().split(/\r?\n/).pop() || ''
  let cparsed = null
  try {
    cparsed = JSON.parse(cline)
  } catch {
    /* ignore */
  }
  ok('Pillow 可用', cparsed?.ok === true, cline.slice(0, 200))

  // ── 3. ZIP（加密 + 真实解压）────────────────────────────────────────────
  const zipCase = (() => {
    const src = path.join(TMP, 'hello.txt')
    fs.writeFileSync(src, 'hello 禁漫\n'.repeat(200), 'utf8')
    const out = path.join(TMP, 'test.zip')
    return { src, out }
  })()
  const zr = await createZip({
    outPath: zipCase.out,
    entries: [{ filePath: zipCase.src, entryName: 'hello.txt' }],
    password: 'abc123',
  })
  ok('ZIP 生成', zr.ok === true, zr.error || '')
  ok('ZIP 标记加密', zr.encrypted === true)
  ok('ZIP 大小合理', (zr.bytes || 0) > 100)

  const verify = py(
    python,
    ['-c', [
      'import sys, zipfile, json',
      'p = sys.argv[1]',
      'with zipfile.ZipFile(p) as z:',
      '    z.setpassword(b"abc123")',
      '    bad = z.testzip()',
      '    if bad: print(json.dumps({"ok": False, "bad": bad})); sys.exit(1)',
      '    data = z.read("hello.txt").decode("utf-8")',
      '    print(json.dumps({"ok": True, "len": len(data), "enc": z.infolist()[0].flag_bits & 1}))',
    ].join('\n'), zipCase.out],
  )
  let vjson = null
  try {
    vjson = JSON.parse(String(verify.stdout || '').trim())
  } catch {
    /* 下面会报 */
  }
  ok('Python 能解密解压', vjson?.ok === true, `stdout=${String(verify.stdout).slice(0, 200)} stderr=${String(verify.stderr).slice(0, 200)}`)
  ok('ZIP 加密标志位', vjson?.enc === 1)
  eq('ZIP 文件名（含密码）', buildZipName('123456', { password: 'abc123', includePassword: true }), 'JM123456-密码：abc123.zip')
  eq('ZIP 文件名（不含密码）', buildZipName('123456', { password: 'abc123', includePassword: false }), 'JM123456.zip')

  // ── 4. 信息图渲染 ───────────────────────────────────────────────────────
  const cover = path.join(TMP, 'cover.jpg')
  const coverGen = py(python, ['-c', [
    'import sys',
    'from PIL import Image',
    'img = Image.new("RGB", (600, 800), (90, 120, 160))',
    'img.save(sys.argv[1], "JPEG")',
  ].join('\n'), cover])
  ok('生成测试封面', coverGen.status === 0, String(coverGen.stderr).slice(0, 200))

  configureDaily({ dataRoot: () => TMP, pythonPath: () => '' })
  try {
    const digest = await renderDigestImage({
      payload: {
        title: '📥 今日禁漫更新 2 本',
        subtitle: '2026-10-26 · 截至 10:23',
        footnote: '共 2 本',
        items: [
          { id: '422444', title: '测试本子 A', kind: '同人', tags: ['中文', '剧情'], cover },
          { id: '518074', title: '测试本子 B', kind: '单本', tags: [], cover: '' },
        ],
      },
      outPath: path.join(TMP, 'digest.jpg'),
    })
    ok('信息图渲染', fs.existsSync(digest) && fs.statSync(digest).size > 1024, digest)
    const album = await renderAlbumImage({
      payload: { id: '422444', title: '测试本子 A', authors: ['作者甲'], tags: ['中文'], kind: '8 话 · 300 张', pdf: 'PDF 300 页（12 MB）', desc: '这是简介文本，用来测试换行。'.repeat(5), cover },
      outPath: path.join(TMP, 'album.jpg'),
    })
    ok('简介卡渲染', fs.existsSync(album) && fs.statSync(album).size > 1024, album)
  } catch (e) {
    failures.push(`信息图渲染抛异常：${e?.message ?? e}`)
  }

  // ── 5. PDF 合成（还原关掉，验证分卷/页数/大小）──────────────────────────
  const pages = []
  for (let i = 1; i <= 5; i += 1) {
    const p = path.join(TMP, `page-${i}.png`)
    const gen = py(python, ['-c', [
      'import sys',
      'from PIL import Image, ImageDraw',
      'n = int(sys.argv[2])',
      'img = Image.new("RGB", (400, 600), ((30*n) % 255, 80, 120))',
      'ImageDraw.Draw(img).text((20, 20), "PAGE %s" % n, fill=(255,255,255))',
      'img.save(sys.argv[1], "PNG")',
    ].join('\n'), p, String(i)])
    ok(`生成第 ${i} 页`, gen.status === 0, String(gen.stderr).slice(0, 120))
    pages.push(p)
  }
  const pdfOut = path.join(TMP, 'book.pdf')
  const coverOut = path.join(TMP, 'cover-out.jpg')
  const res = await pdfBridge.runTask({
    python,
    task: {
      album_id: '422444',
      title: '测试本子',
      scramble_id: 0,
      descramble: false,
      output: pdfOut,
      quality: 85,
      max_dim: 0,
      parts: 1,
      cover_output: coverOut,
      chapters: [{ name: '第1话', pages, aid: '422444' }],
    },
    timeoutMs: 120000,
  })
  ok('PDF 合成', res.ok === true, res.error || '')
  ok('PDF 页数', res.pages === 5, `pages=${res.pages}`)
  ok('封面缩略图', fs.existsSync(coverOut) && fs.statSync(coverOut).size > 1024, coverOut)
  if (fs.existsSync(pdfOut)) {
    const head = fs.readFileSync(pdfOut).subarray(0, 5).toString('latin1')
    ok('PDF 文件头', head === '%PDF-', head)
  }

  // 按页分卷：两卷都必须是独立的合法 PDF
  const partsOut = path.join(TMP, 'book2.pdf')
  const res2 = await pdfBridge.runTask({
    python,
    task: {
      album_id: '422444',
      title: '测试本子2',
      scramble_id: 0,
      descramble: false,
      output: partsOut,
      quality: 85,
      max_dim: 0,
      parts: 2,
      chapters: [{ name: '第1话', pages, aid: '422444' }],
    },
    timeoutMs: 120000,
  })
  ok('PDF 分卷成功', res2.ok === true, res2.error || '')
  ok('PDF 分卷两份', (res2.outputs || []).length === 2, JSON.stringify((res2.outputs || []).map((o) => o.output)))
  for (const o of res2.outputs || []) {
    const head = fs.readFileSync(o.output).subarray(0, 5).toString('latin1')
    ok(`分卷文件头 ${path.basename(o.output)}`, head === '%PDF-', head)
  }
}

// ── 汇总 ──────────────────────────────────────────────────────────────────

try {
  fs.rmSync(TMP, { recursive: true, force: true })
} catch {
  /* ignore */
}

console.log(`\n===== 通过 ${pass}，失败 ${failures.length} =====`)
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
