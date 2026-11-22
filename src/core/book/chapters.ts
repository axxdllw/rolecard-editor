/**
 * 纯文本章节识别与切分（供 txt、mobi、docx 等无目录格式及超大章细分使用）。
 */
import { normalizeLines, trimBookLine } from './html'
import type { BookChapter } from './types'

const SENTENCE_END_RE = /(?:[。！？…?!]|\.{3})$/

const NUM_CHARS = '0-9０-９零〇一二两兩三四五六七八九十百千万萬'

/** 卷标题：第X卷/部/篇，或 卷X */
const VOLUME_RE_1 = new RegExp(`^第[${NUM_CHARS}]+[卷部篇]`)
const VOLUME_RE_2 = new RegExp(`^卷[${NUM_CHARS}]+`)

/** 章节标题：第X章/回/节/集/话/幕 */
const CHAPTER_RE_CN = new RegExp(`^第[${NUM_CHARS}]+[章回节節集话話幕]`)

/** 英文章节标题：Chapter 1 / CHAPTER IV */
const CHAPTER_RE_EN = /^(?:Chapter|CHAPTER)\s*[0-9IVXLC]+(?=$|[\s:：.\-—·,，(（【[])/

/** 特殊章节词：后跟行尾、分隔符，或数字/序号/篇（防止“序言中他说……”误判） */
const CHAPTER_RE_SPECIAL = new RegExp(
  `^(?:序章|序言|序幕|序|楔子|引子|引言|前言|尾声|尾聲|后记|後記|终章|終章|番外|外传|外傳|完本感言)(?=$|[\\s:：·—\\-、.，,(（【\\[《\\u3000]|[${NUM_CHARS}篇之])`,
)

/** 判断单行是否为章节标题或卷标题 */
export function isChapterHeading(line: string): 'chapter' | 'volume' | null {
  const s = trimBookLine(line)
  if (s.length === 0 || s.length > 40) return null
  if (SENTENCE_END_RE.test(s)) return null

  if (VOLUME_RE_1.test(s) || VOLUME_RE_2.test(s)) {
    return 'volume'
  }
  if (CHAPTER_RE_CN.test(s) || CHAPTER_RE_EN.test(s) || CHAPTER_RE_SPECIAL.test(s)) {
    return 'chapter'
  }
  return null
}

/** 无可用标题时，按段落累加，大约每 targetChars 字切为“第 N 部分” */
export function splitLinesByLength(lines: string[], targetChars = 8000): BookChapter[] {
  const chapters: BookChapter[] = []
  let buf: string[] = []
  let count = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    buf.push(line)
    count += line.length
    if (count >= targetChars) {
      chapters.push({
        title: `第 ${chapters.length + 1} 部分`,
        text: buf.join('\n'),
      })
      buf = []
      count = 0
    }
  }

  if (buf.length > 0) {
    chapters.push({
      title: `第 ${chapters.length + 1} 部分`,
      text: buf.join('\n'),
    })
  }
  return chapters
}

/** 将规范化纯文本按标题切分为章节列表 */
export function splitTextIntoChapters(text: string): BookChapter[] {
  const normalized = normalizeLines(text)
  if (!normalized) return []

  const lines = normalized.split('\n')
  const headings: Array<{ index: number; kind: 'chapter' | 'volume'; title: string }> = []

  for (let i = 0; i < lines.length; i++) {
    const kind = isChapterHeading(lines[i])
    if (kind) {
      headings.push({ index: i, kind, title: lines[i] })
    }
  }

  // 一个标题都没识别出，或者全文 > 5 万字但标题少于 2 个：按每约 8000 字切分
  if (headings.length === 0 || (normalized.length > 50_000 && headings.length < 2)) {
    return splitLinesByLength(lines, 8000)
  }

  const chapters: BookChapter[] = []

  // 第一个标题之前的内容作为“（开头）”
  if (headings[0].index > 0) {
    const preface = lines.slice(0, headings[0].index).join('\n')
    if (preface) {
      chapters.push({ title: '（开头）', text: preface })
    }
  }

  let currentVolume: string | undefined

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]
    const nextIdx = i + 1 < headings.length ? headings[i + 1].index : lines.length
    const body = lines.slice(h.index + 1, nextIdx).join('\n')

    if (h.kind === 'volume') {
      currentVolume = h.title
      // 卷标题与下一个标题之间有 ≥ 200 字正文时，这段也作为一章
      if (body.length >= 200) {
        chapters.push({ title: h.title, text: body, volume: currentVolume })
      }
    } else if (body.length > 0) {
      const ch: BookChapter = { title: h.title, text: body }
      if (currentVolume) ch.volume = currentVolume
      chapters.push(ch)
    }
  }

  // 兜底：若全是空章或不足 200 字的卷简介导致没有章，按长度切分保留正文
  if (chapters.length === 0) {
    return splitLinesByLength(lines, 8000)
  }

  return chapters
}
