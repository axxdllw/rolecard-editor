/**
 * TXT 纯文本与独立 HTML 电子书解析。
 */
import { splitTextIntoChapters } from './chapters'
import { decodeText } from './encoding'
import { detectHtmlCharset, htmlTitle, normalizeLines } from './html'
import { chaptersFromHtmlParts } from './parts'
import { BookError, fileBaseName, finalizeBook, type ParsedBook } from './types'

const AUTHOR_LINE_RE = /作者\s*[:：]\s*(.{1,20})/

/** 解析 TXT 文件：识别编码、规范化行、前 30 行找作者、按章节切分 */
export function parseTxt(bytes: Uint8Array, fileName: string): ParsedBook {
  const { text: raw, encoding } = decodeText(bytes)
  const normalized = normalizeLines(raw)
  if (!normalized) {
    throw new BookError('empty', '没有读到正文')
  }

  let author = ''
  const headLines = normalized.split('\n', 30)
  for (let i = 0; i < headLines.length; i++) {
    const match = headLines[i].match(AUTHOR_LINE_RE)
    if (match) {
      author = match[1].trim()
      break
    }
  }

  const chapters = splitTextIntoChapters(normalized)

  return finalizeBook({
    format: 'txt',
    title: fileBaseName(fileName),
    author,
    chapters,
    warnings: [],
    encoding,
  })
}

/** 解析独立 HTML 文件：按 meta charset / 自动检测解码，整页交给 chaptersFromHtmlParts */
export function parseHtml(bytes: Uint8Array, fileName: string): ParsedBook {
  const declared = detectHtmlCharset(bytes)
  const { text: html, encoding } = decodeText(bytes, declared)
  const pageTitle = htmlTitle(html)
  const { chapters, warnings } = chaptersFromHtmlParts([
    { html, titleHint: pageTitle || undefined },
  ])

  return finalizeBook({
    format: 'html',
    title: pageTitle || fileBaseName(fileName),
    author: '',
    chapters,
    warnings,
    encoding,
  })
}
