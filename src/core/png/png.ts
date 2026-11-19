/**
 * PNG 块（chunk）读写。
 *
 * 角色卡把 JSON 存在 tEXt 块里，导出时只替换文本块，图像数据块原样保留。
 * 结构：8 字节签名 + 若干块；每块 = 4 字节长度 + 4 字节类型 + 数据 + 4 字节 CRC32。
 */
import { latin1Decode, latin1Encode } from '../util/base64'

export interface PngChunk {
  /** 块类型，如 IHDR、IDAT、tEXt、IEND */
  type: string
  data: Uint8Array
}

export interface PngTextEntry {
  keyword: string
  text: string
}

export class PngError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PngError'
  }
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

/** 计算 CRC32，可传多段数据（PNG 的 CRC 覆盖“类型 + 数据”） */
export function crc32(...parts: Uint8Array[]): number {
  let crc = 0xffffffff
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      crc = CRC_TABLE[(crc ^ part[i]) & 0xff] ^ (crc >>> 8)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

export interface ReadChunksOptions {
  /** 是否校验 CRC，默认校验 */
  checkCrc?: boolean
}

export function readChunks(bytes: Uint8Array, options: ReadChunksOptions = {}): PngChunk[] {
  const { checkCrc = true } = options
  if (!isPng(bytes)) {
    throw new PngError('不是有效的 PNG 文件')
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunks: PngChunk[] = []
  let pos = PNG_SIGNATURE.length
  let ended = false

  while (pos < bytes.length) {
    if (pos + 8 > bytes.length) {
      throw new PngError('PNG 数据被截断')
    }
    const length = view.getUint32(pos)
    const typeBytes = bytes.subarray(pos + 4, pos + 8)
    const dataStart = pos + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) {
      throw new PngError('PNG 数据被截断')
    }

    const type = latin1Decode(typeBytes)
    const data = bytes.slice(dataStart, dataEnd)
    if (checkCrc) {
      const expected = view.getUint32(dataEnd)
      if (crc32(typeBytes, data) !== expected) {
        throw new PngError(`PNG 块 ${type} 的 CRC 校验失败`)
      }
    }

    chunks.push({ type, data })
    pos = dataEnd + 4
    if (type === 'IEND') {
      ended = true
      break
    }
  }

  if (!ended) {
    throw new PngError('PNG 缺少 IEND 结束块')
  }
  return chunks
}

export function encodeChunks(chunks: PngChunk[]): Uint8Array<ArrayBuffer> {
  const total = PNG_SIGNATURE.length + chunks.reduce((sum, c) => sum + 12 + c.data.length, 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  out.set(PNG_SIGNATURE, 0)

  let pos = PNG_SIGNATURE.length
  for (const chunk of chunks) {
    if (chunk.type.length !== 4) {
      throw new PngError(`PNG 块类型必须是 4 个字符：${chunk.type}`)
    }
    const typeBytes = latin1Encode(chunk.type)
    view.setUint32(pos, chunk.data.length)
    out.set(typeBytes, pos + 4)
    out.set(chunk.data, pos + 8)
    view.setUint32(pos + 8 + chunk.data.length, crc32(typeBytes, chunk.data))
    pos += 12 + chunk.data.length
  }
  return out
}

export function decodeTextChunk(data: Uint8Array): PngTextEntry {
  const sep = data.indexOf(0)
  if (sep <= 0) {
    throw new PngError('tEXt 块格式错误：缺少关键字')
  }
  return {
    keyword: latin1Decode(data.subarray(0, sep)),
    text: latin1Decode(data.subarray(sep + 1)),
  }
}

export function encodeTextChunk(entry: PngTextEntry): PngChunk {
  const { keyword, text } = entry
  if (keyword.length < 1 || keyword.length > 79) {
    throw new PngError('tEXt 关键字长度必须在 1 到 79 之间')
  }
  const keywordBytes = latin1Encode(keyword)
  const textBytes = latin1Encode(text)
  const data = new Uint8Array(keywordBytes.length + 1 + textBytes.length)
  data.set(keywordBytes, 0)
  data.set(textBytes, keywordBytes.length + 1)
  return { type: 'tEXt', data }
}

/** 读出所有 tEXt 块（保持原顺序） */
export function getTextEntries(chunks: PngChunk[]): PngTextEntry[] {
  return chunks.filter((c) => c.type === 'tEXt').map((c) => decodeTextChunk(c.data))
}

/**
 * 删除指定关键字的 tEXt 块（不区分大小写），再把新的文本块按顺序插到 IEND 之前。
 * 其他块（包括别的 tEXt 块）保持不变。
 */
export function replaceTextEntries(
  chunks: PngChunk[],
  removeKeywords: string[],
  insert: PngTextEntry[],
): PngChunk[] {
  const remove = new Set(removeKeywords.map((k) => k.toLowerCase()))
  const kept = chunks.filter((c) => {
    if (c.type !== 'tEXt') return true
    return !remove.has(decodeTextChunk(c.data).keyword.toLowerCase())
  })

  const iendIndex = kept.findIndex((c) => c.type === 'IEND')
  if (iendIndex === -1) {
    throw new PngError('PNG 缺少 IEND 结束块')
  }
  return [...kept.slice(0, iendIndex), ...insert.map(encodeTextChunk), ...kept.slice(iendIndex)]
}
