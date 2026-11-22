/**
 * 普通 ZIP 压缩包探测与单条目解压（处理非 epub/docx 的 zip，包括 .fb2.zip）。
 */
import { unzipSync } from 'fflate'
import { detectBookFormatByExtension } from './detect'
import { decodeText } from './encoding'
import { BookError, type BookArchive } from './types'

interface ZipDirEntry {
  /** fflate 用的文件名（没有 UTF-8 标志时按 latin1 解码），解压时用它对应 */
  rawName: string
  /** 给人看的文件名（没有 UTF-8 标志时按 GBK/Big5/UTF-8 猜编码） */
  displayName: string
  encrypted: boolean
}

function u16(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8)
}

function u32(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000
}

/**
 * 读 zip 的中央目录：文件名和是否加密（fflate 不支持加密条目，解压会报“损坏”）。
 * 中文压缩包常常没设 UTF-8 标志、文件名是 GBK，这里猜编码给出正常的显示名。读不出来时返回 null。
 */
function readZipDirectory(bytes: Uint8Array): ZipDirEntry[] | null {
  // 从末尾找“中央目录结束”记录（后面最多跟 64KB 注释）
  const min = Math.max(0, bytes.length - 22 - 0xffff)
  let eocd = -1
  for (let i = bytes.length - 22; i >= min; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
  const count = u16(bytes, eocd + 10)
  let p = u32(bytes, eocd + 16)
  const out: ZipDirEntry[] = []
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || u32(bytes, p) !== 0x02014b50) return out.length ? out : null
    const flags = u16(bytes, p + 8)
    const method = u16(bytes, p + 10)
    const nameLen = u16(bytes, p + 28)
    const extraLen = u16(bytes, p + 30)
    const commentLen = u16(bytes, p + 32)
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen)
    const utf8 = (flags & 0x800) !== 0
    const rawName = utf8 ? new TextDecoder().decode(nameBytes) : String.fromCharCode(...nameBytes)
    const displayName = utf8 ? rawName : decodeText(nameBytes).text
    // 第 0 位是加密标志；压缩方式 99 是 WinZip 的 AES 加密
    out.push({ rawName, displayName, encrypted: (flags & 1) !== 0 || method === 99 })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

const ENCRYPTED_MESSAGE = '压缩包设了密码，请先解压，再导入里面的电子书'

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.avif',
  '.svg',
])

function shouldSkipArchivePath(rawPath: string): boolean {
  if (!rawPath || rawPath.endsWith('/')) return true
  const segments = rawPath.replace(/\\/g, '/').split('/')
  for (const seg of segments) {
    if (!seg) continue
    if (seg === '__MACOSX') return true
    if (seg.startsWith('.')) return true
  }
  return false
}

function isImagePath(path: string): boolean {
  const lower = path.replace(/\\/g, '/').toLowerCase()
  const slash = lower.lastIndexOf('/')
  const dot = lower.lastIndexOf('.')
  if (dot <= slash) return false
  return IMAGE_EXTENSIONS.has(lower.slice(dot))
}

/** 扫描 ZIP 内的电子书候选条目（不解压文件内容）；无电子书时抛出 BookError */
export function inspectBookArchive(zipBytes: Uint8Array): BookArchive['entries'] {
  const entries: BookArchive['entries'] = []
  let totalFiles = 0
  let imageFiles = 0
  const dir = readZipDirectory(zipBytes)
  const dirByName = new Map((dir ?? []).map((d) => [d.rawName, d]))
  let encryptedBooks = 0

  try {
    unzipSync(zipBytes, {
      filter(info) {
        if (shouldSkipArchivePath(info.name)) return false
        totalFiles++
        if (isImagePath(info.name)) {
          imageFiles++
          return false
        }
        const fmt = detectBookFormatByExtension(info.name)
        if (fmt) {
          const d = dirByName.get(info.name)
          if (d?.encrypted) {
            encryptedBooks++
            return false
          }
          entries.push({
            path: info.name,
            name: d?.displayName ?? info.name,
            size: info.originalSize,
            format: fmt,
          })
        }
        return false
      },
    })
  } catch {
    if (dir?.some((d) => d.encrypted)) throw new BookError('encrypted', ENCRYPTED_MESSAGE)
    throw new BookError('corrupt', '压缩包已损坏，无法解压')
  }

  if (entries.length === 0) {
    if (encryptedBooks > 0) throw new BookError('encrypted', ENCRYPTED_MESSAGE)
    if (totalFiles > 0 && imageFiles * 2 >= totalFiles) {
      throw new BookError('unsupported', '压缩包里没有电子书，只有图片（可能是漫画）')
    }
    throw new BookError('unsupported', '压缩包里没有能识别的电子书')
  }

  entries.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }))
  return entries
}

/** 只解压 ZIP 中指定路径的单个文件 */
export function extractZipEntry(zipBytes: Uint8Array, entryPath: string): Uint8Array {
  if (readZipDirectory(zipBytes)?.find((d) => d.rawName === entryPath)?.encrypted) {
    throw new BookError('encrypted', ENCRYPTED_MESSAGE)
  }
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(zipBytes, {
      filter: (info) => info.name === entryPath,
    })
  } catch {
    throw new BookError('corrupt', '压缩包已损坏，无法解压')
  }

  const data = files[entryPath]
  if (!data) {
    throw new BookError('corrupt', `压缩包里找不到文件：${entryPath}`)
  }
  return data
}
