import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  BookError,
  detectBookFormat,
  isBookArchive,
  parseBook,
  parseBookInArchive,
  type ParsedBook,
} from '../../src/core/book'

function asBook(result: ReturnType<typeof parseBook>): ParsedBook {
  if (isBookArchive(result)) {
    throw new Error('期望返回 ParsedBook，实际为 BookArchive')
  }
  return result
}

describe('FB2 解析', () => {
  it('能提取书名作者、递归分卷并忽略 notes 与 binary', () => {
    const fb2Xml = `<?xml version="1.0" encoding="utf-8"?>
      <FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
        <description>
          <title-info>
            <author>
              <first-name>列夫</first-name>
              <last-name>托尔斯泰</last-name>
            </author>
            <book-title>示例小说</book-title>
          </title-info>
        </description>
        <body>
          <section>
            <title><p>第一卷 序幕</p></title>
            <section>
              <title><p>第一章 黎明</p></title>
              <p>天边泛起鱼肚白。</p>
              <v>晨露沾湿青草。</v>
            </section>
            <section>
              <title><p>第二章 集市</p></title>
              <p>街道逐渐喧闹起来。</p>
            </section>
          </section>
        </body>
        <body name="notes">
          <section><p>这是注释正文，不该混入。</p></section>
        </body>
        <binary id="cover.jpg" content-type="image/jpeg">AAAAABBBBBCCCCC</binary>
      </FictionBook>`

    const book = asBook(parseBook(strToU8(fb2Xml), 'demo.fb2'))
    expect(book.format).toBe('fb2')
    expect(book.title).toBe('示例小说')
    expect(book.author).toBe('列夫 托尔斯泰')
    expect(book.chapters).toEqual([
      { title: '第一章 黎明', text: '天边泛起鱼肚白。\n晨露沾湿青草。', volume: '第一卷 序幕' },
      { title: '第二章 集市', text: '街道逐渐喧闹起来。', volume: '第一卷 序幕' },
    ])
  })
})

describe('DOCX 解析', () => {
  it('能按标题样式（含 heading 1 作卷、heading 2 作章）分章并读元数据', () => {
    const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:style w:type="paragraph" w:styleId="H1Custom"><w:name w:val="heading 1"/></w:style>
        <w:style w:type="paragraph" w:styleId="H2Custom"><w:name w:val="标题 2"/></w:style>
      </w:styles>`

    const docXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:pPr><w:pStyle w:val="H1Custom"/></w:pPr><w:r><w:t>第一卷 山海</w:t></w:r></w:p>
          <w:p><w:pPr><w:pStyle w:val="H2Custom"/></w:pPr><w:r><w:t>第一章 渡河</w:t></w:r></w:p>
          <w:p><w:r><w:t>木船</w:t><w:tab/><w:t>靠岸了。</w:t><w:br/><w:t>众人登岸。</w:t></w:r></w:p>
          <w:p><w:pPr><w:pStyle w:val="H2Custom"/></w:pPr><w:r><w:t>第二章 进山</w:t></w:r></w:p>
          <w:p><w:r><w:t>林间薄雾弥漫。</w:t></w:r></w:p>
        </w:body>
      </w:document>`

    const coreXml = `<?xml version="1.0" encoding="UTF-8"?>
      <cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>山海游记</dc:title>
        <dc:creator>周远</dc:creator>
      </cp:coreProperties>`

    const docx = zipSync({
      'word/document.xml': strToU8(docXml),
      'word/styles.xml': strToU8(stylesXml),
      'docProps/core.xml': strToU8(coreXml),
    })

    const book = asBook(parseBook(docx, 'travel.docx'))
    expect(book.format).toBe('docx')
    expect(book.title).toBe('山海游记')
    expect(book.author).toBe('周远')
    expect(book.chapters).toEqual([
      { title: '第一章 渡河', text: '木船 靠岸了。\n众人登岸。', volume: '第一卷 山海' },
      { title: '第二章 进山', text: '林间薄雾弥漫。', volume: '第一卷 山海' },
    ])
  })

  it('无标题样式时回退到纯文本章节切分', () => {
    const docXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>第一章 启程</w:t></w:r></w:p>
          <w:p><w:r><w:t>踏上旅途。</w:t></w:r></w:p>
          <w:p><w:r><w:t>第二章 归来</w:t></w:r></w:p>
          <w:p><w:r><w:t>回到故乡。</w:t></w:r></w:p>
        </w:body>
      </w:document>`

    const docx = zipSync({ 'word/document.xml': strToU8(docXml) })
    const book = asBook(parseBook(docx, 'plain.docx'))
    expect(book.chapters).toEqual([
      { title: '第一章 启程', text: '踏上旅途。' },
      { title: '第二章 归来', text: '回到故乡。' },
    ])
  })
})

describe('TXT 与 HTML 解析', () => {
  it('TXT 能识别前 30 行里的作者并规范化全角空格', () => {
    const txt = [
      '　　雪夜长歌',
      '作者：江南客',
      '',
      '第一章 飞雪',
      '　　大雪纷飞。',
      '第二章 炉火',
      '　　屋内温暖如春。',
    ].join('\r\n')

    const book = asBook(parseBook(strToU8(txt), '雪夜长歌.txt'))
    expect(book.format).toBe('txt')
    expect(book.title).toBe('雪夜长歌')
    expect(book.author).toBe('江南客')
    expect(book.encoding).toBe('utf-8')
    expect(book.chapters.map((c) => c.title)).toEqual(['（开头）', '第一章 飞雪', '第二章 炉火'])
    expect(book.chapters[1].text).toBe('大雪纷飞。')
  })

  it('独立 HTML 能取 title 并转正文分章', () => {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>网页小说</title></head>
      <body>
        <p>第一章 遇险</p>
        <p>狂风呼啸。</p>
        <p>第二章 脱困</p>
        <p>云开雾散。</p>
      </body></html>`

    const book = asBook(parseBook(strToU8(html), 'story.html'))
    expect(book.format).toBe('html')
    expect(book.title).toBe('网页小说')
    expect(book.encoding).toBe('utf-8')
    expect(book.chapters).toEqual([
      { title: '第一章 遇险', text: '狂风呼啸。' },
      { title: '第二章 脱困', text: '云开雾散。' },
    ])
  })
})

describe('ZIP 压缩包、不支持格式与 detectBookFormat', () => {
  it('ZIP 单本直接解析（含 .fb2.zip），多本返回 BookArchive 并可按路径解析', () => {
    const fb2 = `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><book-title>压缩FB2</book-title></title-info></description><body><section><title><p>序章</p></title><p>内容在此。</p></section></body></FictionBook>`
    const singleZip = zipSync({
      '__MACOSX/._book.fb2': strToU8('junk'),
      '.DS_Store': strToU8('junk'),
      'book.fb2': strToU8(fb2),
    })

    const single = asBook(parseBook(singleZip, 'book.fb2.zip'))
    expect(single.format).toBe('fb2')
    expect(single.title).toBe('压缩FB2')

    const multiZip = zipSync({
      'vol10.txt': strToU8('第一章 第十本\n正文十。'),
      'vol2.txt': strToU8('第一章 第二本\n正文二。'),
      '__MACOSX/vol2.txt': strToU8('ignore'),
    })
    const res = parseBook(multiZip, 'bundle.zip')
    expect(isBookArchive(res)).toBe(true)
    if (isBookArchive(res)) {
      // 自然排序：vol2.txt 在 vol10.txt 之前
      expect(res.entries.map((e) => e.path)).toEqual(['vol2.txt', 'vol10.txt'])
      const chosen = parseBookInArchive(multiZip, res.entries[0].path)
      expect(chosen.title).toBe('vol2')
      expect(chosen.chapters[0].text).toBe('正文二。')
    }
  })

  it('ZIP 只有图片时报漫画提示，无电子书时报不支持', () => {
    const mangaZip = zipSync({
      '001.jpg': new Uint8Array([1, 2, 3]),
      '002.png': new Uint8Array([4, 5, 6]),
    })
    try {
      parseBook(mangaZip, 'manga.zip')
      expect.fail('应当抛出 unsupported')
    } catch (err) {
      expect(err).toBeInstanceOf(BookError)
      expect((err as BookError).kind).toBe('unsupported')
      expect((err as BookError).message).toContain('图片')
    }

    const emptyOtherZip = zipSync({ 'readme.md': strToU8('# hello') })
    try {
      parseBook(emptyOtherZip, 'misc.zip')
      expect.fail('应当抛出 unsupported')
    } catch (err) {
      expect(err).toBeInstanceOf(BookError)
      expect((err as BookError).kind).toBe('unsupported')
    }
  })

  it('detectBookFormat 和 parseBook 对 kfx / pdf / doc 给出准确结果与报错', () => {
    const contKfx = new Uint8Array([0x43, 0x4f, 0x4e, 0x54, 0x00, 0x01])
    const drmKfx = new Uint8Array([0xea, 0x44, 0x52, 0x4d, 0x49, 0x4f, 0x4e, 0xee])
    const pdfBytes = strToU8('%PDF-1.7\n...')
    const docBytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

    expect(detectBookFormat(contKfx, 'a.bin')).toBe('kfx')
    expect(detectBookFormat(drmKfx, 'b.bin')).toBe('kfx')
    expect(detectBookFormat(pdfBytes, 'c.bin')).toBe('pdf')
    expect(detectBookFormat(docBytes, 'd.bin')).toBe('doc')
    expect(detectBookFormat(strToU8('纯文本内容'), 'noext')).toBe('txt')

    const expectErrKind = (bytes: Uint8Array, name: string, kind: BookError['kind']) => {
      try {
        parseBook(bytes, name)
        expect.fail(`期望 ${name} 抛出 ${kind}`)
      } catch (err) {
        expect(err).toBeInstanceOf(BookError)
        expect((err as BookError).kind).toBe(kind)
      }
    }

    expectErrKind(contKfx, 'book.kfx', 'unsupported')
    expectErrKind(drmKfx, 'drm.kfx', 'encrypted')
    expectErrKind(pdfBytes, 'book.pdf', 'unsupported')
    expectErrKind(docBytes, 'legacy.doc', 'unsupported')
  })
})
