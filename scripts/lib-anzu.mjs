/** .anzu 包解析与 manifest 提取（零依赖），供 upload / review 工具共用 */
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

/** 从 zip Buffer 中读取指定文件，返回 Buffer 或 null */
export function readZipEntry(buf, want) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是合法的 zip（找不到 EOCD），确认是 .anzu 包')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip 中央目录损坏')
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const lho = buf.readUInt32LE(off + 42)
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8')
    if (name === want) {
      const lnLen = buf.readUInt16LE(lho + 26)
      const leLen = buf.readUInt16LE(lho + 28)
      const dataStart = lho + 30 + lnLen + leLen
      const data = buf.slice(dataStart, dataStart + csize)
      return method === 8 ? inflateRawSync(data) : data
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  return null
}

/** 解析 manifest.toml 的顶层简单键（id/name/version/description 等）。
 *  只取每个键的首次匹配：manifest 顶层身份键在最前，避免被 [capability] 等表内同名键覆盖 */
export function parseManifest(text) {
  const out = {}
  for (const m of text.matchAll(/^(\w[\w-]*)\s*=\s*"([^"]*)"/gm)) {
    if (!(m[1] in out)) out[m[1]] = m[2]
  }
  return out
}

/** 列出 zip 内全部条目：[{ name, data }] */
export function listZipEntries(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是合法的 zip（找不到 EOCD）')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const out = []
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip 中央目录损坏')
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const lho = buf.readUInt32LE(off + 42)
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8')
    const lnLen = buf.readUInt16LE(lho + 26)
    const leLen = buf.readUInt16LE(lho + 28)
    const dataStart = lho + 30 + lnLen + leLen
    const data = buf.slice(dataStart, dataStart + csize)
    out.push({ name, data: method === 8 ? inflateRawSync(data) : data })
    off += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** 读 .anzu 的 manifest，返回 { manifest, manifestText, raw }；manifest 缺失时抛错 */
export function openAnzu(file) {
  const raw = readFileSync(file)
  const mText = readZipEntry(raw, 'manifest.toml')?.toString('utf8') ?? ''
  if (!mText) throw new Error('包里没有 manifest.toml——确认这是 qixinpack pack 出来的 .anzu')
  return { manifest: parseManifest(mText), manifestText: mText, raw }
}
