import { describe, expect, it } from 'vitest'
import { isChapterHeading, splitTextIntoChapters } from '../../src/core/book/chapters'
import { firstHeading, htmlTitle, htmlToText } from '../../src/core/book/html'

describe('isChapterHeading 标题行判定', () => {
  it('能识别中文、英文和特殊章节标题', () => {
    expect(isChapterHeading('第一章 开端')).toBe('chapter')
    expect(isChapterHeading('第123回 群雄聚首')).toBe('chapter')
    expect(isChapterHeading('第两节 雨夜')).toBe('chapter')
    expect(isChapterHeading('第3集：起航')).toBe('chapter')
    expect(isChapterHeading('第10话 终局')).toBe('chapter')
    expect(isChapterHeading('第四幕 落幕')).toBe('chapter')
    expect(isChapterHeading('Chapter 1 The Beginning')).toBe('chapter')
    expect(isChapterHeading('CHAPTER IV: Shadow')).toBe('chapter')
    expect(isChapterHeading('序章')).toBe('chapter')
    expect(isChapterHeading('序章 风起之前')).toBe('chapter')
    expect(isChapterHeading('楔子：旧梦')).toBe('chapter')
    expect(isChapterHeading('番外一 日常')).toBe('chapter')
    expect(isChapterHeading('尾声')).toBe('chapter')
    expect(isChapterHeading('后记')).toBe('chapter')
    expect(isChapterHeading('完本感言')).toBe('chapter')
  })

  it('能识别卷标题', () => {
    expect(isChapterHeading('第一卷 风起')).toBe('volume')
    expect(isChapterHeading('第二部 暗涌')).toBe('volume')
    expect(isChapterHeading('第三篇 归来')).toBe('volume')
    expect(isChapterHeading('卷一 初见')).toBe('volume')
    expect(isChapterHeading('卷2 远行')).toBe('volume')
  })

  it('拒绝超长行、句末标点结尾和“序言中他说”这类正文行', () => {
    expect(isChapterHeading(`第一章 ${'很长'.repeat(25)}`)).toBeNull()
    expect(isChapterHeading('第一章开始了。')).toBeNull()
    expect(isChapterHeading('第二章怎么可能！')).toBeNull()
    expect(isChapterHeading('第三章去哪儿了？')).toBeNull()
    expect(isChapterHeading('第四章未完……')).toBeNull()
    expect(isChapterHeading('序言中他说')).toBeNull()
    expect(isChapterHeading('序言中他说起了往事')).toBeNull()
    expect(isChapterHeading('前言部分提到过这件事')).toBeNull()
  })
})

describe('splitTextIntoChapters 章节切分', () => {
  it('能正确切分开头、分卷、序章、章节与卷正文', () => {
    const volumeIntro = '这是一段足够长的卷前导言，用来验证超过两百字时会单独成章。'.repeat(10)
    const text = [
      '本书谨献给所有热爱故事的人。',
      '楔子',
      '很久以前，长安城下过一场大雪。',
      '第一卷 风起',
      '第一章 开端',
      '他走进了长安城。',
      '序言中他说过这里很热闹。',
      '第二章 重逢',
      '故人站在桥头。',
      '第二卷 暗涌',
      volumeIntro,
      '第三章 变故',
      '夜色沉了下来。',
    ].join('\n')

    const chapters = splitTextIntoChapters(text)
    expect(chapters.map((c) => ({ title: c.title, volume: c.volume }))).toEqual([
      { title: '（开头）', volume: undefined },
      { title: '楔子', volume: undefined },
      { title: '第一章 开端', volume: '第一卷 风起' },
      { title: '第二章 重逢', volume: '第一卷 风起' },
      { title: '第二卷 暗涌', volume: '第二卷 暗涌' },
      { title: '第三章 变故', volume: '第二卷 暗涌' },
    ])
    expect(chapters[2].text).toContain('序言中他说过这里很热闹。')
    expect(chapters[4].text).toBe(volumeIntro)
  })

  it('无标题时按约 8000 字切分为“第 N 部分”', () => {
    const para = '这是一段普通的小说正文内容，没有任何章节标题标记。'.repeat(20) // 480 字/段
    const lines = Array.from({ length: 40 }, () => para) // 19200 字
    const chapters = splitTextIntoChapters(lines.join('\n'))

    expect(chapters.length).toBeGreaterThanOrEqual(2)
    expect(chapters[0].title).toBe('第 1 部分')
    expect(chapters[1].title).toBe('第 2 部分')
    expect(chapters[0].text.length).toBeGreaterThanOrEqual(8000)
  })

  it('全文超过 5 万字但只有 1 个标题时回退按 8000 字切分', () => {
    const para = '正文段落内容测试文本。'.repeat(50) // 500 字/段
    const lines = ['第一章 唯一标题', ...Array.from({ length: 110 }, () => para)] // > 55000 字
    const chapters = splitTextIntoChapters(lines.join('\n'))

    expect(chapters.length).toBeGreaterThanOrEqual(6)
    expect(chapters[0].title).toBe('第 1 部分')
  })
})

describe('htmlToText / firstHeading / htmlTitle 辅助函数', () => {
  it('能清除脚本样式注音、解码实体并去掉全角与不换行空格', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>  示例 &amp; 书名  </title>
          <style>body { color: red; }</style>
          <script>console.log("hidden")</script>
        </head>
        <body>
          <!-- 注释应被移除 -->
          <h1>　第一章&nbsp;开端　</h1>
          <p>\u3000\u3000他看见了<ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>&mdash;&mdash;&ldquo;你好&rdquo;&#33;&#x3f;</p>
          <p>   </p>
        </body>
      </html>
    `
    expect(htmlTitle(html)).toBe('示例 & 书名')
    expect(firstHeading(html)).toBe('第一章 开端')
    expect(htmlToText(html)).toBe('第一章 开端\n他看见了漢字——“你好”!?')
  })
})
