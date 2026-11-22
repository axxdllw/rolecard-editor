import { describe, expect, it } from 'vitest'
import { BookError, parseBook, type ParsedBook } from '../../src/core/book'
import { palmDocDecompress } from '../../src/core/book/mobi'

function asBook(result: ReturnType<typeof parseBook>): ParsedBook {
  if ('kind' in result) {
    throw new Error('期望返回 ParsedBook，实际为 BookArchive')
  }
  return result
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

function buildPalmDb(ident: 'BOOKMOBI' | 'TEXtREAd', records: Uint8Array[]): Uint8Array {
  const headerLen = 78 + records.length * 8
  const bodyLen = records.reduce((sum, r) => sum + r.length, 0)
  const out = new Uint8Array(headerLen + bodyLen)
  const view = new DataView(out.buffer)

  for (let i = 0; i < 8; i++) {
    out[60 + i] = ident.charCodeAt(i)
  }
  view.setUint16(76, records.length, false)

  let offset = headerLen
  for (let i = 0; i < records.length; i++) {
    view.setUint32(78 + i * 8, offset, false)
    out.set(records[i], offset)
    offset += records[i].length
  }
  return out
}

interface MobiRec0Options {
  compression?: number
  textLength: number
  textRecordCount: number
  encryption?: number
  fileVersion?: number
  textEncoding?: number
  fullName?: string
  exthTitle?: string
  exthAuthor?: string
  extraFlags?: number
  fdstIndex?: number
}

function buildMobiRecord0(opts: MobiRec0Options): Uint8Array {
  const enc = new TextEncoder()
  const mobiHeaderLen = 0xe4 // 228，覆盖 extraFlags(0xf2) 和 fdstIndex(0xc0)
  const baseLen = 16 + mobiHeaderLen // 244 (0xf4)

  const exthRecords: Uint8Array[] = []
  const pushExth = (type: number, text: string) => {
    const data = enc.encode(text)
    const buf = new Uint8Array(8 + data.length)
    const v = new DataView(buf.buffer)
    v.setUint32(0, type, false)
    v.setUint32(4, buf.length, false)
    buf.set(data, 8)
    exthRecords.push(buf)
  }
  if (opts.exthAuthor) pushExth(100, opts.exthAuthor)
  if (opts.exthTitle) pushExth(503, opts.exthTitle)

  let exthBlock = new Uint8Array(0)
  if (exthRecords.length > 0) {
    const payload = concatBytes(...exthRecords)
    const rawLen = 12 + payload.length
    const paddedLen = (rawLen + 3) & ~3
    exthBlock = new Uint8Array(paddedLen)
    const ev = new DataView(exthBlock.buffer)
    exthBlock.set(enc.encode('EXTH'), 0)
    ev.setUint32(4, paddedLen, false)
    ev.setUint32(8, exthRecords.length, false)
    exthBlock.set(payload, 12)
  }

  const fullNameBytes = opts.fullName ? enc.encode(opts.fullName) : new Uint8Array(0)
  const fullNameOffset = baseLen + exthBlock.length

  const rec0 = new Uint8Array(fullNameOffset + fullNameBytes.length)
  const view = new DataView(rec0.buffer)

  view.setUint16(0, opts.compression ?? 1, false)
  view.setUint32(4, opts.textLength, false)
  view.setUint16(8, opts.textRecordCount, false)
  view.setUint16(10, 4096, false)
  view.setUint16(12, opts.encryption ?? 0, false)

  rec0.set(enc.encode('MOBI'), 16)
  view.setUint32(20, mobiHeaderLen, false)
  view.setUint32(28, opts.textEncoding ?? 65001, false)
  view.setUint32(36, opts.fileVersion ?? 6, false)

  if (fullNameBytes.length > 0) {
    view.setUint32(84, fullNameOffset, false)
    view.setUint32(88, fullNameBytes.length, false)
    rec0.set(fullNameBytes, fullNameOffset)
  }

  if (exthBlock.length > 0) {
    view.setUint32(128, 0x40, false)
    rec0.set(exthBlock, baseLen)
  }

  if (opts.fdstIndex !== undefined) {
    view.setUint32(0xc0, opts.fdstIndex, false)
  }
  if (opts.extraFlags !== undefined) {
    view.setUint16(0xf2, opts.extraFlags, false)
  }

  return rec0
}

function buildFdstRecord(flows: Array<[number, number]>): Uint8Array {
  const buf = new Uint8Array(12 + flows.length * 8)
  const view = new DataView(buf.buffer)
  buf.set(new TextEncoder().encode('FDST'), 0)
  view.setUint32(4, 12, false)
  view.setUint32(8, flows.length, false)
  for (let i = 0; i < flows.length; i++) {
    view.setUint32(12 + i * 8, flows[i][0], false)
    view.setUint32(16 + i * 8, flows[i][1], false)
  }
  return buf
}

describe('palmDocDecompress PalmDOC 解压', () => {
  it('能正确处理字面字节、1..8 拷贝、0xc0 空格+字符以及重叠回溯拷贝', () => {
    // 编码说明：
    // 'A'(0x41), 'B'(0x42), 'C'(0x43) -> "ABC"
    // 0xc0 | 0x61 (0xe1) -> " a"
    // 回溯拷贝 distance=3, len=3: x = 0x8000 | (3 << 3) | (3 - 3) = 0x8018 -> 拷贝 "C a"
    // 重叠回溯 distance=1, len=4: x = 0x8000 | (1 << 3) | (4 - 3) = 0x8009 -> 拷贝 "aaaa"
    // 长度前缀 2 字节字面：0x02, 0x81, 0x00 -> 原样字节 [0x81, 0x00]
    const compressed = new Uint8Array([
      0x41, 0x42, 0x43, 0xe1, 0x80, 0x18, 0x80, 0x09, 0x02, 0x81, 0x00,
    ])
    const decoded = palmDocDecompress(compressed)
    const textPart = new TextDecoder().decode(decoded.subarray(0, decoded.length - 2))
    expect(textPart).toBe('ABC aC aaaaa')
    expect(Array.from(decoded.subarray(decoded.length - 2))).toEqual([0x81, 0x00])
  })
})

describe('MOBI / AZW3 / PDB 解析', () => {
  it('能解析不压缩 MOBI7，并按 EXTH 与 mbp:pagebreak 切分章节', () => {
    const html =
      '<html><body><h1>第一章 开端</h1><p>清晨的薄雾。</p><mbp:pagebreak/><h1>第二章 启程</h1><p>马车缓缓驶出。</p></body></html>'
    const htmlBytes = new TextEncoder().encode(html)
    const rec0 = buildMobiRecord0({
      compression: 1,
      textLength: htmlBytes.length,
      textRecordCount: 1,
      fullName: '旧名字',
      exthTitle: '远行记',
      exthAuthor: '陈默',
    })
    const mobi = buildPalmDb('BOOKMOBI', [rec0, htmlBytes])

    const book = asBook(parseBook(mobi, 'test.mobi'))
    expect(book.format).toBe('mobi')
    expect(book.title).toBe('远行记')
    expect(book.author).toBe('陈默')
    expect(book.chapters).toEqual([
      { title: '第一章 开端', text: '清晨的薄雾。' },
      { title: '第二章 启程', text: '马车缓缓驶出。' },
    ])
  })

  it('能解析 PalmDOC 压缩且带尾部附加数据（flags=3）的 MOBI7', () => {
    // 解压后为 "<p>hello world world!</p>"
    // "<p>hello" (8 字节)
    // 0xc0 | 'w' (0xf7) -> " w"
    // "orld" (4 字节)
    // 回溯 distance=6, len=6 -> x = 0x8000 | (6 << 3) | (6 - 3) = 0x8033 -> 拷贝 " world"
    // "!</p>" (5 字节)
    const enc = new TextEncoder()
    const compressedPayload = concatBytes(
      enc.encode('<p>hello'),
      new Uint8Array([0xc0 | 'w'.charCodeAt(0)]),
      enc.encode('orld'),
      new Uint8Array([0x80, 0x33]),
      enc.encode('!</p>'),
    )
    const expectedText = '<p>hello world world!</p>'

    // flags = 3（bit 0 = 多字节重叠区，bit 1 = 1 个变长 trailer）
    // 剥离顺序：先去掉 trailer（3 字节：[0xaa, 0xbb, 0x83]），再去掉重叠区（2 字节：[0xcc, 0x01] -> (1 & 3) + 1 = 2）
    const rec1WithTrailers = concatBytes(
      compressedPayload,
      new Uint8Array([0xcc, 0x01]),
      new Uint8Array([0xaa, 0xbb, 0x83]),
    )

    const rec0 = buildMobiRecord0({
      compression: 2,
      textLength: expectedText.length,
      textRecordCount: 1,
      fullName: '压缩测试',
      extraFlags: 3,
    })
    const mobi = buildPalmDb('BOOKMOBI', [rec0, rec1WithTrailers])

    const book = asBook(parseBook(mobi, 'compressed.mobi'))
    expect(book.title).toBe('压缩测试')
    expect(book.chapters).toEqual([{ title: '第 1 部分', text: 'hello world world!' }])
  })

  it('能解析纯 KF8（AZW3，版本 8 + FDST + 两个 HTML 文档）', () => {
    const enc = new TextEncoder()
    const doc1 = '<html><head><title>卷一</title></head><body><h1>第一章 起点</h1><p>第一段正文。</p></body></html>'
    const doc2 = '<html><head><title>第二章 终点</title></head><body><p>第二段正文。</p></body></html>'
    const cssFlow = 'body { font-size: 14px; } /* 不应出现在正文里 */'

    const htmlFlowBytes = enc.encode(doc1 + doc2)
    const cssFlowBytes = enc.encode(cssFlow)
    const combinedFlow = concatBytes(htmlFlowBytes, cssFlowBytes)

    const fdst = buildFdstRecord([
      [0, htmlFlowBytes.length],
      [htmlFlowBytes.length, combinedFlow.length],
    ])

    const rec0 = buildMobiRecord0({
      compression: 1,
      textLength: combinedFlow.length,
      textRecordCount: 1,
      fileVersion: 8,
      exthTitle: 'KF8 测试书',
      exthAuthor: '林风',
      fdstIndex: 2,
    })

    const azw3 = buildPalmDb('BOOKMOBI', [rec0, combinedFlow, fdst])
    const book = asBook(parseBook(azw3, 'book.azw3'))

    expect(book.format).toBe('azw3')
    expect(book.title).toBe('KF8 测试书')
    expect(book.author).toBe('林风')
    expect(book.chapters).toEqual([
      { title: '第一章 起点', text: '第一段正文。' },
      { title: '第二章 终点', text: '第二段正文。' },
    ])
  })

  it('遇到加密标志报 encrypted，遇到 HUFF/CDIC 压缩报 unsupported', () => {
    const dummy = new TextEncoder().encode('<p>test</p>')

    const encryptedMobi = buildPalmDb('BOOKMOBI', [
      buildMobiRecord0({ textLength: dummy.length, textRecordCount: 1, encryption: 2 }),
      dummy,
    ])
    try {
      parseBook(encryptedMobi, 'drm.mobi')
      expect.fail('应当抛出 encrypted')
    } catch (err) {
      expect(err).toBeInstanceOf(BookError)
      expect((err as BookError).kind).toBe('encrypted')
    }

    const huffMobi = buildPalmDb('BOOKMOBI', [
      buildMobiRecord0({ compression: 17480, textLength: dummy.length, textRecordCount: 1 }),
      dummy,
    ])
    try {
      parseBook(huffMobi, 'huff.mobi')
      expect.fail('应当抛出 unsupported')
    } catch (err) {
      expect(err).toBeInstanceOf(BookError)
      expect((err as BookError).kind).toBe('unsupported')
    }
  })

  it('能解析 TEXtREAd (.pdb) 纯文本电子书', () => {
    const content = '第一章 荒原\n风沙吹过石碑。\n第二章 绿洲\n远处泛起水光。'
    const textBytes = new TextEncoder().encode(content)
    const rec0 = new Uint8Array(16)
    const view = new DataView(rec0.buffer)
    view.setUint16(0, 1, false) // 不压缩
    view.setUint32(4, textBytes.length, false)
    view.setUint16(8, 1, false)
    view.setUint16(10, 4096, false)
    view.setUint16(12, 0, false)

    const pdb = buildPalmDb('TEXtREAd', [rec0, textBytes])
    const book = asBook(parseBook(pdb, 'desert.pdb'))

    expect(book.format).toBe('pdb')
    expect(book.title).toBe('desert')
    expect(book.encoding).toBe('utf-8')
    expect(book.chapters).toEqual([
      { title: '第一章 荒原', text: '风沙吹过石碑。' },
      { title: '第二章 绿洲', text: '远处泛起水光。' },
    ])
  })
})
