/**
 * MOBI / AZW / AZW3 (KF8) / PRC / PalmDOC (.pdb) 解析。
 * 全程基于 DataView 和可增长 Uint8Array，只解压正文记录（不碰后面的图片记录）。
 */
import { splitTextIntoChapters } from './chapters'
import { decodeText } from './encoding'
import { htmlTitle } from './html'
import { chaptersFromHtmlParts } from './parts'
import { BookError, fileBaseName, finalizeBook, type ParsedBook } from './types'

const COMPRESSION_NONE = 1
const COMPRESSION_PALMDOC = 2
const COMPRESSION_HUFFCDIC = 17480

function readAscii(bytes: Uint8Array, start: number, len: number): string {
  if (start < 0 || start + len > bytes.length) return ''
  let out = ''
  for (let i = 0; i < len; i++) {
    out += String.fromCharCode(bytes[start + i])
  }
  return out
}

/** 快速探测 PalmDB 文件的具体格式（供 detectBookFormat 复用） */
export function peekPalmDbFormat(bytes: Uint8Array): 'azw3' | 'mobi' | 'pdb' | null {
  if (bytes.length < 78) return null
  const ident = readAscii(bytes, 60, 8)
  if (ident === 'TEXtREAd') return 'pdb'
  if (ident !== 'BOOKMOBI') return null

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const numRecords = view.getUint16(76, false)
  if (numRecords === 0 || 78 + numRecords * 8 > bytes.length) return 'mobi'

  const rec0Start = view.getUint32(78, false)
  const rec0End = numRecords > 1 ? view.getUint32(86, false) : bytes.length
  if (rec0Start + 40 <= Math.min(rec0End, bytes.length) && readAscii(bytes, rec0Start + 16, 4) === 'MOBI') {
    const fileVersion = view.getUint32(rec0Start + 36, false)
    return fileVersion >= 8 ? 'azw3' : 'mobi'
  }
  return 'mobi'
}

/**
 * PalmDOC LZ77 解压算法，使用倍增 Uint8Array 缓冲避免大文本 O(n²) 开销。
 */
export function palmDocDecompress(data: Uint8Array): Uint8Array {
  let out = new Uint8Array(Math.max(256, data.length * 2))
  let outPos = 0

  const ensureCapacity = (extra: number) => {
    const needed = outPos + extra
    if (needed <= out.length) return
    let nextCap = out.length
    while (nextCap < needed) {
      nextCap *= 2
    }
    const next = new Uint8Array(nextCap)
    next.set(out.subarray(0, outPos))
    out = next
  }

  let i = 0
  const len = data.length
  while (i < len) {
    const c = data[i++]
    if (c === 0 || (c >= 0x09 && c <= 0x7f)) {
      ensureCapacity(1)
      out[outPos++] = c
    } else if (c >= 1 && c <= 8) {
      const count = Math.min(c, len - i)
      ensureCapacity(count)
      for (let k = 0; k < count; k++) {
        out[outPos++] = data[i++]
      }
    } else if (c >= 0xc0) {
      ensureCapacity(2)
      out[outPos++] = 0x20
      out[outPos++] = c ^ 0x80
    } else {
      // 0x80..0xbf：回溯拷贝（允许重叠，必须逐字节拷贝）
      if (i >= len) break
      const x = (c << 8) | data[i++]
      const distance = (x >> 3) & 0x7ff
      const copyLen = (x & 7) + 3
      if (distance > 0 && distance <= outPos) {
        ensureCapacity(copyLen)
        for (let k = 0; k < copyLen; k++) {
          out[outPos] = out[outPos - distance]
          outPos++
        }
      }
    }
  }

  return out.subarray(0, outPos)
}

/** 去掉 MOBI 正文记录末尾的尾部附加数据（extra flags） */
function stripTrailingEntries(record: Uint8Array, extraFlags: number): Uint8Array {
  let end = record.length
  // trailers = flags >> 1 里为 1 的位数
  let flags = extraFlags >>> 1
  while (flags > 0 && end > 0) {
    if ((flags & 1) !== 0) {
      const start = Math.max(0, end - 4)
      let num = 0
      for (let i = start; i < end; i++) {
        const v = record[i]
        if ((v & 0x80) !== 0) num = 0
        num = (num << 7) | (v & 0x7f)
      }
      if (num <= 0 || num > end) break
      end -= num
    }
    flags >>>= 1
  }

  // flags & 1：去掉末尾多字节字符重叠区
  if ((extraFlags & 1) !== 0 && end > 0) {
    const drop = (record[end - 1] & 3) + 1
    end = Math.max(0, end - drop)
  }

  return record.subarray(0, end)
}

/** 按 `<?xml` 或 `<html` 把 KF8 合并的正文流切回多个原始 HTML 部分 */
function splitKf8HtmlDocuments(fullHtml: string): Array<{ html: string; titleHint?: string }> {
  const re = /(?:<\?xml\b|<html\b)/gi
  const starts: number[] = []
  let match: RegExpExecArray | null

  while ((match = re.exec(fullHtml)) !== null) {
    const pos = match.index
    const isHtmlTag = match[0].charCodeAt(1) !== 63 /* '?' */

    if (starts.length > 0 && isHtmlTag) {
      // 如果上一个切分点是 <?xml 且中间没有正文结束标签，说明这是同一个文档的 <html>
      const gap = fullHtml.slice(starts[starts.length - 1], pos)
      if (gap.length < 1024 && !/<\/html\b/i.test(gap) && !/<body\b/i.test(gap)) {
        continue
      }
    }
    starts.push(pos)
  }

  if (starts.length === 0) {
    return [{ html: fullHtml, titleHint: htmlTitle(fullHtml) || undefined }]
  }

  const parts: Array<{ html: string; titleHint?: string }> = []
  if (starts[0] > 0) {
    const lead = fullHtml.slice(0, starts[0])
    if (lead.trim()) {
      parts.push({ html: lead, titleHint: htmlTitle(lead) || undefined })
    }
  }

  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : fullHtml.length
    const html = fullHtml.slice(starts[i], end)
    parts.push({ html, titleHint: htmlTitle(html) || undefined })
  }

  return parts
}

function encodingFromMobiCode(code: number): string | undefined {
  if (code === 65001) return 'utf-8'
  if (code === 1252) return 'windows-1252'
  return undefined
}

/** 解析 MOBI / AZW / AZW3 / PRC / PalmDOC (.pdb) */
export function parseMobi(bytes: Uint8Array, fileName: string): ParsedBook {
  if (bytes.length < 78) {
    throw new BookError('corrupt', '文件太短，不是有效的 MOBI/PDB 文件')
  }

  const ident = readAscii(bytes, 60, 8)
  if (ident !== 'BOOKMOBI' && ident !== 'TEXtREAd') {
    throw new BookError('unsupported', '不支持的 PalmDB 文件格式')
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const numRecords = view.getUint16(76, false)
  if (numRecords === 0 || 78 + numRecords * 8 > bytes.length) {
    throw new BookError('corrupt', 'MOBI/PDB 记录表已损坏')
  }

  const offsets = new Uint32Array(numRecords)
  for (let i = 0; i < numRecords; i++) {
    offsets[i] = view.getUint32(78 + i * 8, false)
  }

  const getRecord = (index: number): Uint8Array => {
    if (index < 0 || index >= numRecords) return new Uint8Array(0)
    const start = offsets[index]
    const rawEnd = index + 1 < numRecords ? offsets[index + 1] : bytes.length
    const end = Math.min(rawEnd, bytes.length)
    if (start >= end || start >= bytes.length) return new Uint8Array(0)
    return bytes.subarray(start, end)
  }

  const rec0 = getRecord(0)
  if (rec0.length < 16) {
    throw new BookError('corrupt', 'MOBI/PDB 记录 0 头信息不完整')
  }
  const rec0View = new DataView(rec0.buffer, rec0.byteOffset, rec0.byteLength)

  const compression = rec0View.getUint16(0, false)
  const textLength = rec0View.getUint32(4, false)
  const textRecordCount = rec0View.getUint16(8, false)
  const encryption = rec0View.getUint16(12, false)

  if (encryption !== 0) {
    throw new BookError('encrypted', '这本书有 DRM 加密（通常是商店买的书），无法读取')
  }
  if (compression === COMPRESSION_HUFFCDIC) {
    throw new BookError(
      'unsupported',
      '这本 MOBI 用了 HUFF/CDIC 压缩，暂不支持，可以用 Calibre 转成 EPUB 再导入',
    )
  }
  if (compression !== COMPRESSION_NONE && compression !== COMPRESSION_PALMDOC) {
    throw new BookError('unsupported', `不支持的 MOBI/PDB 压缩方式（${compression}）`)
  }

  // 解析 MOBI 头与 EXTH（TEXtREAd 没有 MOBI 头）
  let hasMobiHeader = false
  let mobiHeaderLen = 0
  let declaredEncoding: string | undefined
  let fileVersion = 0
  let fullName = ''
  let exthTitle = ''
  let exthAuthor = ''
  let extraFlags = 0
  let fdstIndex = 0xffffffff

  if (ident === 'BOOKMOBI' && rec0.length >= 24 && readAscii(rec0, 16, 4) === 'MOBI') {
    hasMobiHeader = true
    mobiHeaderLen = rec0View.getUint32(20, false)
    if (rec0.length >= 32) {
      declaredEncoding = encodingFromMobiCode(rec0View.getUint32(28, false))
    }
    if (rec0.length >= 40) {
      fileVersion = rec0View.getUint32(36, false)
    }
    if (rec0.length >= 92) {
      const fullNameOffset = rec0View.getUint32(84, false)
      const fullNameLen = rec0View.getUint32(88, false)
      if (fullNameLen > 0 && fullNameOffset + fullNameLen <= rec0.length) {
        fullName = decodeText(rec0.subarray(fullNameOffset, fullNameOffset + fullNameLen), declaredEncoding)
          .text.trim()
      }
    }
    if (rec0.length >= 132 && mobiHeaderLen >= 116) {
      const exthFlags = rec0View.getUint32(128, false)
      if ((exthFlags & 0x40) !== 0) {
        const exthStart = 16 + mobiHeaderLen
        if (exthStart + 12 <= rec0.length && readAscii(rec0, exthStart, 4) === 'EXTH') {
          const exthCount = rec0View.getUint32(exthStart + 8, false)
          let pos = exthStart + 12
          for (let i = 0; i < exthCount; i++) {
            if (pos + 8 > rec0.length) break
            const recType = rec0View.getUint32(pos, false)
            const recLen = rec0View.getUint32(pos + 4, false)
            if (recLen < 8 || pos + recLen > rec0.length) break
            const valBytes = rec0.subarray(pos + 8, pos + recLen)
            if (recType === 100 && !exthAuthor) {
              exthAuthor = decodeText(valBytes, declaredEncoding).text.trim()
            } else if (recType === 503 && !exthTitle) {
              exthTitle = decodeText(valBytes, declaredEncoding).text.trim()
            }
            pos += recLen
          }
        }
      }
    }
    if (fileVersion >= 8 && mobiHeaderLen >= 0xb4 && rec0.length >= 0xc4) {
      fdstIndex = rec0View.getUint32(0xc0, false)
    }
    if (mobiHeaderLen >= 0xe4 && rec0.length >= 0xf4) {
      extraFlags = rec0View.getUint16(0xf2, false)
    }
  }

  // 解压并拼接正文记录 1..textRecordCount，截断到 textLength
  const maxRecord = Math.min(textRecordCount, numRecords - 1)
  if (maxRecord <= 0 || textLength === 0) {
    throw new BookError('empty', '没有读到正文')
  }

  // 预分配可增长输出缓冲（防范异常夸大的 textLength 导致内存爆掉）
  const reasonableCap = Math.min(textLength, Math.max(bytes.length * 8, 65536))
  let combined = new Uint8Array(reasonableCap)
  let written = 0

  const appendBytes = (chunk: Uint8Array) => {
    const remaining = textLength - written
    if (remaining <= 0) return
    const take = Math.min(chunk.length, remaining)
    const needed = written + take
    if (needed > combined.length) {
      let nextCap = Math.max(combined.length, 4096)
      while (nextCap < needed) nextCap *= 2
      const next = new Uint8Array(Math.min(nextCap, textLength))
      next.set(combined.subarray(0, written))
      combined = next
    }
    combined.set(chunk.subarray(0, take), written)
    written += take
  }

  for (let r = 1; r <= maxRecord && written < textLength; r++) {
    const rawRec = getRecord(r)
    if (rawRec.length === 0) continue
    const bodyRec = extraFlags !== 0 ? stripTrailingEntries(rawRec, extraFlags) : rawRec
    if (bodyRec.length === 0) continue
    const decodedRec = compression === COMPRESSION_PALMDOC ? palmDocDecompress(bodyRec) : bodyRec
    appendBytes(decodedRec)
  }

  const rawTextBytes = combined.subarray(0, written)
  if (rawTextBytes.length === 0) {
    throw new BookError('empty', '没有读到正文')
  }

  // 分支 1：TEXtREAd（.pdb 纯文本）
  if (ident === 'TEXtREAd' || !hasMobiHeader) {
    const { text, encoding } = decodeText(rawTextBytes)
    const chapters = splitTextIntoChapters(text)
    return finalizeBook({
      format: 'pdb',
      title: fileBaseName(fileName),
      author: '',
      chapters,
      warnings: [],
      encoding,
    })
  }

  const title = exthTitle || fullName || fileBaseName(fileName)
  const author = exthAuthor

  // 分支 2：纯 KF8（AZW3，文件版本 ≥ 8）
  if (fileVersion >= 8) {
    let htmlBytes = rawTextBytes
    let usedFdst = false

    if (fdstIndex > 0 && fdstIndex < numRecords) {
      const fdstRec = getRecord(fdstIndex)
      if (fdstRec.length >= 20 && readAscii(fdstRec, 0, 4) === 'FDST') {
        const fdstView = new DataView(fdstRec.buffer, fdstRec.byteOffset, fdstRec.byteLength)
        const numFlows = fdstView.getUint32(8, false)
        if (numFlows >= 1) {
          const flowStart = fdstView.getUint32(12, false)
          const flowEnd = fdstView.getUint32(16, false)
          if (flowStart < flowEnd && flowEnd <= rawTextBytes.length) {
            htmlBytes = rawTextBytes.subarray(flowStart, flowEnd)
            usedFdst = true
          }
        }
      }
    }

    let fullHtml = decodeText(htmlBytes, declaredEncoding).text
    if (!usedFdst) {
      fullHtml = fullHtml.replace(/<style(?:\s[^>]*)?>[\s\S]*?<\/style\s*>/gi, '')
    }

    const parts = splitKf8HtmlDocuments(fullHtml)
    const { chapters, warnings } = chaptersFromHtmlParts(parts)
    return finalizeBook({
      format: 'azw3',
      title,
      author,
      chapters,
      warnings,
    })
  }

  // 分支 3：MOBI7（包括 MOBI7+KF8 合并格式，直接读前面 MOBI7 正文）
  const fullHtml = decodeText(rawTextBytes, declaredEncoding).text
  const rawParts = fullHtml.split(/<mbp:pagebreak\b[^>]*\/?>/gi)
  const parts = rawParts.map((html) => ({ html }))
  const { chapters, warnings } = chaptersFromHtmlParts(parts)

  return finalizeBook({
    format: 'mobi',
    title,
    author,
    chapters,
    warnings,
  })
}
