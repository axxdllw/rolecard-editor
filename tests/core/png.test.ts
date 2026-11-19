import { describe, expect, it } from 'vitest'
import {
  crc32,
  decodeTextChunk,
  encodeChunks,
  encodeTextChunk,
  getTextEntries,
  PngError,
  readChunks,
  replaceTextEntries,
  type PngChunk,
} from '../../src/core/png/png'

const ascii = (s: string) => new TextEncoder().encode(s)

/** 拼一个只有块结构、没有真实图像的最小 PNG，用来测试读写 */
function tinyPng(extra: PngChunk[] = []): Uint8Array {
  return encodeChunks([
    { type: 'IHDR', data: new Uint8Array(13) },
    ...extra,
    { type: 'IDAT', data: new Uint8Array([1, 2, 3]) },
    { type: 'IEND', data: new Uint8Array(0) },
  ])
}

describe('crc32', () => {
  it('与标准测试向量一致', () => {
    expect(crc32(ascii('123456789'))).toBe(0xcbf43926)
  })

  it('分段计算与整段计算结果相同', () => {
    expect(crc32(ascii('IEND'))).toBe(crc32(ascii('IE'), ascii('ND')))
  })
})

describe('readChunks / encodeChunks', () => {
  it('编码后再读取，块内容不变', () => {
    const png = tinyPng([encodeTextChunk({ keyword: 'Comment', text: 'hello' })])
    const chunks = readChunks(png)
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'tEXt', 'IDAT', 'IEND'])
    expect(encodeChunks(chunks)).toEqual(png)
  })

  it('签名不对时报错', () => {
    expect(() => readChunks(ascii('not a png at all'))).toThrow(PngError)
  })

  it('CRC 被篡改时报错，关闭校验后可以读取', () => {
    const png = tinyPng()
    png[png.length - 1] ^= 0xff // 改坏 IEND 的 CRC
    expect(() => readChunks(png)).toThrow(/CRC/)
    expect(readChunks(png, { checkCrc: false }).at(-1)?.type).toBe('IEND')
  })

  it('数据被截断时报错', () => {
    const png = tinyPng()
    expect(() => readChunks(png.subarray(0, png.length - 6))).toThrow(PngError)
  })
})

describe('tEXt 块', () => {
  it('关键字和文本可以往返', () => {
    const chunk = encodeTextChunk({ keyword: 'chara', text: 'eyJhIjoxfQ==' })
    expect(decodeTextChunk(chunk.data)).toEqual({ keyword: 'chara', text: 'eyJhIjoxfQ==' })
  })

  it('非 Latin-1 文本拒绝写入', () => {
    expect(() => encodeTextChunk({ keyword: 'chara', text: '中文' })).toThrow(RangeError)
  })

  it('替换时只删指定关键字（不分大小写），其他文本块保留，新块插在 IEND 前', () => {
    const chunks = readChunks(
      tinyPng([
        encodeTextChunk({ keyword: 'Comment', text: 'keep me' }),
        encodeTextChunk({ keyword: 'CHARA', text: 'old' }),
      ]),
    )
    const next = replaceTextEntries(chunks, ['chara', 'ccv3'], [
      { keyword: 'chara', text: 'v2' },
      { keyword: 'ccv3', text: 'v3' },
    ])
    expect(next.map((c) => c.type)).toEqual(['IHDR', 'tEXt', 'IDAT', 'tEXt', 'tEXt', 'IEND'])
    expect(getTextEntries(next)).toEqual([
      { keyword: 'Comment', text: 'keep me' },
      { keyword: 'chara', text: 'v2' },
      { keyword: 'ccv3', text: 'v3' },
    ])
  })
})
