import { describe, expect, it } from 'vitest'
import { decodeText } from '../../src/core/book/encoding'

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function encodeUtf16(text: string, littleEndian: boolean, withBom: boolean): Uint8Array {
  const out = new Uint8Array(text.length * 2 + (withBom ? 2 : 0))
  let pos = 0
  if (withBom) {
    out[pos++] = littleEndian ? 0xff : 0xfe
    out[pos++] = littleEndian ? 0xfe : 0xff
  }
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (littleEndian) {
      out[pos++] = code & 0xff
      out[pos++] = (code >> 8) & 0xff
    } else {
      out[pos++] = (code >> 8) & 0xff
      out[pos++] = code & 0xff
    }
  }
  return out
}

const GBK_HEX =
  'b5dad2bbd5c220bfaab6cb0acbfbd7dfbdf8c1cbb3a4b0b2b3c7a1a30ab5dab6fed5c220b7e7c6f00ad3eacfc2c1cbd2bbd2b9a1a30a'
const BIG5_HEX =
  'b2c4a440b3b920b67dbadd0aa54ca8abb669a446aaf8a677abb0a1430ab2c4a447b3b920adb7b05f0aab42a455a446a440a95da1430a'

const EXPECTED_SC = '第一章 开端\n他走进了长安城。\n第二章 风起\n雨下了一夜。\n'
const EXPECTED_TC = '第一章 開端\n他走進了長安城。\n第二章 風起\n雨下了一夜。\n'

describe('decodeText 编码识别与解码', () => {
  it('能分辨并解码 GBK 字节为 gb18030', () => {
    const res = decodeText(hexToBytes(GBK_HEX))
    expect(res.encoding).toBe('gb18030')
    expect(res.text).toBe(EXPECTED_SC)
  })

  it('能分辨并解码 Big5 字节为 big5', () => {
    const res = decodeText(hexToBytes(BIG5_HEX))
    expect(res.encoding).toBe('big5')
    expect(res.text).toBe(EXPECTED_TC)
  })

  it('能解码无 BOM 和有 BOM 的 UTF-8（并去掉 BOM）', () => {
    const content = '第一章 开端\n微风拂过长安城。'
    const raw = new TextEncoder().encode(content)

    const noBom = decodeText(raw)
    expect(noBom.encoding).toBe('utf-8')
    expect(noBom.text).toBe(content)

    const withBom = new Uint8Array(raw.length + 3)
    withBom.set([0xef, 0xbb, 0xbf], 0)
    withBom.set(raw, 3)

    const bomRes = decodeText(withBom)
    expect(bomRes.encoding).toBe('utf-8')
    expect(bomRes.text).toBe(content)
    expect(bomRes.text.charCodeAt(0)).not.toBe(0xfeff)
  })

  it('能解码有 BOM 的 UTF-16LE / UTF-16BE 及无 BOM UTF-16LE', () => {
    const sample = 'Chapter 1\nHello World!'
    const leBom = decodeText(encodeUtf16(sample, true, true))
    expect(leBom.encoding).toBe('utf-16le')
    expect(leBom.text).toBe(sample)

    const beBom = decodeText(encodeUtf16(sample, false, true))
    expect(beBom.encoding).toBe('utf-16be')
    expect(beBom.text).toBe(sample)

    const leNoBom = decodeText(encodeUtf16(sample, true, false))
    expect(leNoBom.encoding).toBe('utf-16le')
    expect(leNoBom.text).toBe(sample)
  })

  it('遵守声明编码，gbk/gb2312 统一按 gb18030，未知编码名回退自动识别', () => {
    const gbkBytes = hexToBytes(GBK_HEX)

    const byGbk = decodeText(gbkBytes, 'gbk')
    expect(byGbk.encoding).toBe('gb18030')
    expect(byGbk.text).toBe(EXPECTED_SC)

    const byGb2312 = decodeText(gbkBytes, 'GB2312')
    expect(byGb2312.encoding).toBe('gb18030')
    expect(byGb2312.text).toBe(EXPECTED_SC)

    const byUnknown = decodeText(gbkBytes, 'not-a-real-charset')
    expect(byUnknown.encoding).toBe('gb18030')
    expect(byUnknown.text).toBe(EXPECTED_SC)

    // windows-1252 中的 0xE9 是 é
    const win1252 = decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), 'windows-1252')
    expect(win1252.encoding).toBe('windows-1252')
    expect(win1252.text).toBe('café')
  })
})
