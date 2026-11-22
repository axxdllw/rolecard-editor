/**
 * 电子书解析核心的类型定义与通用收尾工具。
 */

export type BookFormat = 'epub' | 'txt' | 'mobi' | 'azw3' | 'pdb' | 'fb2' | 'docx' | 'html'

export interface BookChapter {
  /** 章节标题；识别不出时用“第 N 部分” */
  title: string
  /** 纯文本：一段一行（段落之间单个 \n），每行去掉首尾空白（含全角空格 U+3000、不换行空格），不含空行 */
  text: string
  /** 所属卷名（有分卷时），如“第一卷 风起” */
  volume?: string
}

export interface ParsedBook {
  format: BookFormat
  /** 书名：优先元数据，没有时用文件名去掉扩展名 */
  title: string
  /** 作者：没有时为空串 */
  author: string
  chapters: BookChapter[]
  /** 不致命的问题（中文），如“有 3 个章节文件找不到，已跳过” */
  warnings: string[]
  /** 识别出的正文编码（txt/html/pdb 等需要猜编码的格式才填），如 'utf-8' 'gb18030' 'big5' */
  encoding?: string
}

/** zip 里有多本书时返回候选，让用户选一本 */
export interface BookArchive {
  kind: 'archive'
  /** path 是解压用的路径；name 是给人看的路径（中文压缩包的 GBK 文件名已转成正常文字） */
  entries: Array<{ path: string; name: string; size: number; format: BookFormat }>
}

export type BookErrorKind = 'unsupported' | 'encrypted' | 'corrupt' | 'empty'

export class BookError extends Error {
  readonly kind: BookErrorKind

  constructor(kind: BookErrorKind, message: string) {
    super(message)
    this.name = 'BookError'
    this.kind = kind
  }
}

/** 从文件名或路径提取去掉扩展名的书名兜底 */
export function fileBaseName(fileName: string): string {
  const normalized = fileName.replace(/\\/g, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const name = dot > 0 ? base.slice(0, dot) : base
  return name.trim() || '未命名书籍'
}

/** 所有格式解析完后的统一收尾：去掉空章节，全书无正文时抛 BookError('empty') */
export function finalizeBook(book: ParsedBook): ParsedBook {
  const chapters: BookChapter[] = []
  for (const ch of book.chapters) {
    const text = ch.text.trim()
    if (!text) continue
    const title = ch.title.trim() || `第 ${chapters.length + 1} 部分`
    const item: BookChapter = { title, text }
    const vol = ch.volume?.trim()
    if (vol) item.volume = vol
    chapters.push(item)
  }

  if (chapters.length === 0) {
    throw new BookError('empty', '没有读到正文')
  }

  const result: ParsedBook = {
    format: book.format,
    title: book.title.trim() || '未命名书籍',
    author: book.author.trim(),
    chapters,
    warnings: book.warnings,
  }
  if (book.encoding) {
    result.encoding = book.encoding
  }
  return result
}
