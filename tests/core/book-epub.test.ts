import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { BookError, parseBook, type ParsedBook } from '../../src/core/book'

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function asBook(result: ReturnType<typeof parseBook>): ParsedBook {
  if ('kind' in result) {
    throw new Error('期望返回 ParsedBook，实际为 BookArchive')
  }
  return result
}

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

describe('EPUB 解析', () => {
  it('能解析 EPUB2 + NCX（含两级分卷目录与开头内容）', () => {
    const opf = `<?xml version="1.0" encoding="utf-8"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="2.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>长安行</dc:title>
          <dc:creator>李清</dc:creator>
        </metadata>
        <manifest>
          <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
          <item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>
          <item id="v1" href="Text/vol1.xhtml" media-type="application/xhtml+xml"/>
          <item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
          <item id="c2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
          <item id="img1" href="Images/cover.jpg" media-type="image/jpeg"/>
        </manifest>
        <spine toc="ncx">
          <itemref idref="cover"/>
          <itemref idref="img1"/>
          <itemref idref="v1"/>
          <itemref idref="c1"/>
          <itemref idref="c2"/>
        </spine>
      </package>`

    const ncx = `<?xml version="1.0" encoding="utf-8"?>
      <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
        <navMap>
          <navPoint id="np-v1">
            <navLabel><text>第一卷 风起</text></navLabel>
            <content src="Text/vol1.xhtml"/>
            <navPoint id="np-c1">
              <navLabel><text>第一章 入城</text></navLabel>
              <content src="Text/ch1.xhtml"/>
            </navPoint>
            <navPoint id="np-c2">
              <navLabel><text>第二章 夜雨</text></navLabel>
              <content src="Text/ch2.xhtml"/>
            </navPoint>
          </navPoint>
        </navMap>
      </ncx>`

    const epub = zipSync({
      mimetype: strToU8('application/epub+zip'),
      'META-INF/container.xml': strToU8(CONTAINER_XML),
      'OEBPS/content.opf': strToU8(opf),
      'OEBPS/toc.ncx': strToU8(ncx),
      'OEBPS/Text/cover.xhtml': strToU8('<html><body><p>版权页：第一版</p></body></html>'),
      'OEBPS/Text/vol1.xhtml': strToU8('<html><body><h1>第一卷 风起</h1></body></html>'),
      'OEBPS/Text/ch1.xhtml': strToU8('<html><body><h2>第一章 入城</h2><p>他推开了城门。</p></body></html>'),
      'OEBPS/Text/ch2.xhtml': strToU8('<html><body><h2>第二章 夜雨</h2><p>窗外下起了雨。</p></body></html>'),
      'OEBPS/Images/cover.jpg': new Uint8Array([0xff, 0xd8, 0xff]),
    })

    const book = asBook(parseBook(epub, 'changan.epub'))
    expect(book.format).toBe('epub')
    expect(book.title).toBe('长安行')
    expect(book.author).toBe('李清')
    expect(book.warnings).toEqual([])
    expect(book.chapters).toEqual([
      { title: '（开头）', text: '版权页：第一版' },
      { title: '第一章 入城', text: '他推开了城门。', volume: '第一卷 风起' },
      { title: '第二章 夜雨', text: '窗外下起了雨。', volume: '第一卷 风起' },
    ])
  })

  it('能解析 EPUB3 + nav 并按同一文件里的 #片段 切成多章', () => {
    const opf = `<?xml version="1.0" encoding="utf-8"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>合集</dc:title>
          <dc:creator>王明</dc:creator>
        </metadata>
        <manifest>
          <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
          <item id="all" href="chapters/all.xhtml" media-type="application/xhtml+xml"/>
        </manifest>
        <spine>
          <itemref idref="all"/>
        </spine>
      </package>`

    const nav = `<?xml version="1.0" encoding="utf-8"?>
      <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
        <body>
          <nav epub:type="toc">
            <ol>
              <li><a href="chapters/all.xhtml#sec1">第一节 初遇</a></li>
              <li><a href="chapters/all.xhtml#sec2">第二节 分别</a></li>
            </ol>
          </nav>
        </body>
      </html>`

    const allHtml = `<html><body>
      <p>扉页题词</p>
      <h2 id="sec1">第一节 初遇</h2>
      <p>春风十里。</p>
      <h2 id="sec2">第二节 分别</h2>
      <p>秋叶满地。</p>
    </body></html>`

    const epub = zipSync({
      'META-INF/container.xml': strToU8(CONTAINER_XML),
      'OEBPS/content.opf': strToU8(opf),
      'OEBPS/nav.xhtml': strToU8(nav),
      'OEBPS/chapters/all.xhtml': strToU8(allHtml),
    })

    const book = asBook(parseBook(epub, 'collection.epub'))
    expect(book.title).toBe('合集')
    expect(book.chapters).toEqual([
      { title: '（开头）', text: '扉页题词' },
      { title: '第一节 初遇', text: '春风十里。' },
      { title: '第二节 分别', text: '秋叶满地。' },
    ])
  })

  it('没有目录且没有 mimetype 时仍可读取，并按文件与 h1 建章（去重复首行）', () => {
    const opf = `<package version="2.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>无目录测试</dc:title>
      </metadata>
      <manifest>
        <item href="a.xhtml" id="a" media-type="application/xhtml+xml"/>
        <item href="b.xhtml" id="b" media-type="application/xhtml+xml"/>
      </manifest>
      <spine>
        <itemref idref="a"/>
        <itemref idref="b"/>
      </spine>
    </package>`

    const epub = zipSync({
      'OEBPS/a.xhtml': strToU8('<html><body><h1>序幕</h1><p>第一段内容。</p></body></html>'),
      'OEBPS/b.xhtml': strToU8('<html><head><title>后记标题</title></head><body><p>第二段内容。</p></body></html>'),
      'META-INF/container.xml': strToU8(CONTAINER_XML),
      'OEBPS/content.opf': strToU8(opf),
      // 故意把 mimetype 放在最后
      mimetype: strToU8('application/epub+zip'),
    })

    const book = asBook(parseBook(epub, 'notoc.epub'))
    expect(book.chapters).toEqual([
      { title: '序幕', text: '第一段内容。' },
      { title: '后记标题', text: '第二段内容。' },
    ])
  })

  it('支持正文声明 GBK 编码，缺少章节文件时汇总出 warning', () => {
    const opf = `<package version="2.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>GBK电子书</dc:title>
      </metadata>
      <manifest>
        <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="missing1.xhtml" media-type="application/xhtml+xml"/>
        <item id="c3" href="missing2.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine>
        <itemref idref="c1"/>
        <itemref idref="c2"/>
        <itemref idref="c3"/>
      </spine>
    </package>`

    // 拼接 XML GBK 声明 + GBK 字节（“第一章 开端\n他走进了长安城。”）
    const head = strToU8('<?xml version="1.0" encoding="gbk"?><html><body><p>')
    const bodyGbk = hexToBytes('b5dad2bbd5c220bfaab6cb0acbfbd7dfbdf8c1cbb3a4b0b2b3c7a1a3')
    const tail = strToU8('</p></body></html>')
    const gbkDoc = new Uint8Array(head.length + bodyGbk.length + tail.length)
    gbkDoc.set(head, 0)
    gbkDoc.set(bodyGbk, head.length)
    gbkDoc.set(tail, head.length + bodyGbk.length)

    const epub = zipSync({
      'META-INF/container.xml': strToU8(CONTAINER_XML),
      'OEBPS/content.opf': strToU8(opf),
      'OEBPS/c1.xhtml': gbkDoc,
    })

    const book = asBook(parseBook(epub, 'gbk.epub'))
    expect(book.chapters[0].text).toContain('他走进了长安城。')
    expect(book.warnings).toContain('有 2 个章节文件找不到，已跳过')
  })

  it('字体混淆可正常读取，正文被 DRM 加密时抛 BookError(encrypted)', () => {
    const opf = `<package version="2.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>加密测试</dc:title></metadata>
      <manifest>
        <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="c1"/></spine>
    </package>`

    const fontObfEnc = `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
      <enc:EncryptedData>
        <enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
        <enc:CipherData><enc:CipherReference URI="OEBPS/fonts/demo.otf"/></enc:CipherData>
      </enc:EncryptedData>
    </encryption>`

    const readable = zipSync({
      mimetype: strToU8('application/epub+zip'),
      'META-INF/container.xml': strToU8(CONTAINER_XML),
      'META-INF/encryption.xml': strToU8(fontObfEnc),
      'OEBPS/content.opf': strToU8(opf),
      'OEBPS/c1.xhtml': strToU8('<html><body><p>字体混淆不影响阅读正文。</p></body></html>'),
    })

    const okBook = asBook(parseBook(readable, 'obf.epub'))
    expect(okBook.chapters[0].text).toBe('字体混淆不影响阅读正文。')

    const drmEnc = `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
      <enc:EncryptedData>
        <enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
        <enc:CipherData><enc:CipherReference URI="OEBPS/c1.xhtml"/></enc:CipherData>
      </enc:EncryptedData>
    </encryption>`

    const locked = zipSync({
      mimetype: strToU8('application/epub+zip'),
      'META-INF/container.xml': strToU8(CONTAINER_XML),
      'META-INF/encryption.xml': strToU8(drmEnc),
      'OEBPS/content.opf': strToU8(opf),
      'OEBPS/c1.xhtml': strToU8('encrypted-gibberish'),
    })

    try {
      parseBook(locked, 'drm.epub')
      expect.fail('应当抛出加密错误')
    } catch (err) {
      expect(err).toBeInstanceOf(BookError)
      expect((err as BookError).kind).toBe('encrypted')
    }
  })
})
