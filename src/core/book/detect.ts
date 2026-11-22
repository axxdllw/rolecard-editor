/**
 * 电子书格式探测（魔数优先，其次扩展名，最后默认 txt）。
 */
import { strFromU8, unzipSync } from 'fflate'
import { peekPalmDbFormat } from './mobi'
import type { BookFormat } from './types'

/** 文件选择框的 accept */
export const BOOK_ACCEPT = '.epub,.txt,.mobi,.azw,.azw3,.prc,.pdb,.fb2,.docx,.html,.htm,.xhtml,.zip'

export type DetectedBookFormat = BookFormat | 'zip' | 'kfx' | 'pdf' | 'doc' | 'unknown'

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

/** 判断是否为带 DRMION 加密头的 KFX */
export function isDrmionKfx(bytes: Uint8Array): boolean {
  return matchesAscii(bytes, 1, 'DRMION')
}

/** 根据文件名扩展名判断支持的电子书格式（不含 zip/kfx/pdf/doc） */
export function detectBookFormatByExtension(fileName: string): BookFormat | null {
  const lower = fileName.replace(/\\/g, '/').toLowerCase()
  const slash = lower.lastIndexOf('/')
  const dot = lower.lastIndexOf('.')
  if (dot <= slash) return null
  const ext = lower.slice(dot)

  switch (ext) {
    case '.epub':
      return 'epub'
    case '.txt':
      return 'txt'
    case '.mobi':
    case '.azw':
    case '.prc':
      return 'mobi'
    case '.azw3':
      return 'azw3'
    case '.pdb':
      return 'pdb'
    case '.fb2':
      return 'fb2'
    case '.docx':
      return 'docx'
    case '.html':
    case '.htm':
    case '.xhtml':
      return 'html'
    default:
      return null
  }
}

function detectAllByExtension(fileName: string): DetectedBookFormat | null {
  const bookFmt = detectBookFormatByExtension(fileName)
  if (bookFmt) return bookFmt

  const lower = fileName.replace(/\\/g, '/').toLowerCase()
  const slash = lower.lastIndexOf('/')
  const dot = lower.lastIndexOf('.')
  if (dot <= slash) return null
  const ext = lower.slice(dot)

  switch (ext) {
    case '.zip':
      return 'zip'
    case '.kfx':
      return 'kfx'
    case '.pdf':
      return 'pdf'
    case '.doc':
      return 'doc'
    default:
      return null
  }
}

/** 对以 PK\x03\x04 开头的 ZIP 容器细分 epub / docx / zip（零解压探测目录，只解压 mimetype） */
function inspectZipContainer(bytes: Uint8Array, fileName: string): 'epub' | 'docx' | 'zip' {
  let hasContainer = false
  let hasWordDoc = false
  let mimetypeKey = ''
  let files: Record<string, Uint8Array>

  try {
    files = unzipSync(bytes, {
      filter(info) {
        const lower = info.name.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
        if (lower === 'meta-inf/container.xml') hasContainer = true
        if (lower === 'word/document.xml') hasWordDoc = true
        if (lower === 'mimetype') {
          mimetypeKey = info.name
          return true
        }
        return false
      },
    })
  } catch {
    // 压缩包损坏，尽量按扩展名归类，让后续解析器给出具体 corrupt 提示
    const extFmt = detectAllByExtension(fileName)
    if (extFmt === 'epub' || extFmt === 'docx' || extFmt === 'zip') return extFmt
    return 'zip'
  }

  if (mimetypeKey && files[mimetypeKey]) {
    if (strFromU8(files[mimetypeKey]).trim() === 'application/epub+zip') {
      return 'epub'
    }
  }
  if (hasContainer) return 'epub'
  if (hasWordDoc) return 'docx'
  return 'zip'
}

/** 读取文本开头（最多 4KB，跳过 BOM）用于识别 FB2 和 HTML */
function readTextPrefix(bytes: Uint8Array): string {
  const limit = Math.min(bytes.length, 4096)
  if (limit === 0) return ''

  if (limit >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3, limit))
  }
  if (limit >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2, limit))
  }
  if (limit >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2, limit))
  }

  // ASCII 兼容前缀扫描（跳过 0 字节兼容无 BOM UTF-16）
  let out = ''
  for (let i = 0; i < limit; i++) {
    const b = bytes[i]
    if (b !== 0) out += String.fromCharCode(b)
  }
  return out
}

/** 按魔数（优先）和扩展名判断电子书格式 */
export function detectBookFormat(bytes: Uint8Array, fileName: string): DetectedBookFormat {
  // 1. ZIP 容器：PK\x03\x04
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    return inspectZipContainer(bytes, fileName)
  }

  // 2. PalmDB（MOBI / AZW3 / PDB）
  const palm = peekPalmDbFormat(bytes)
  if (palm) return palm

  // 3. KFX（CONT 或 DRMION）
  if (matchesAscii(bytes, 0, 'CONT') || isDrmionKfx(bytes)) {
    return 'kfx'
  }

  // 4. PDF（%PDF）
  if (matchesAscii(bytes, 0, '%PDF')) {
    return 'pdf'
  }

  // 5. 老版 Word .doc（OLE 魔数 D0 CF 11 E0）
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  ) {
    return 'doc'
  }

  // 6. 文本开头特征：FB2 / HTML
  const prefix = readTextPrefix(bytes).trimStart()
  if (prefix) {
    if (/^<\?xml\b/i.test(prefix) && /<FictionBook\b/i.test(prefix)) {
      return 'fb2'
    }
    if (/^<!DOCTYPE\s+html\b/i.test(prefix) || /<html(?:\s|>)/i.test(prefix.slice(0, 2048))) {
      return 'html'
    }
  }

  // 7. 扩展名兜底，最后默认 txt
  return detectAllByExtension(fileName) ?? 'txt'
}
