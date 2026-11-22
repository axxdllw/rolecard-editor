/**
 * 电子书解析统一入口。
 * 把用户导入的电子书字节流解析为书名、作者、纯文本章节列表。
 */
import { extractZipEntry, inspectBookArchive } from './archive'
import { BOOK_ACCEPT, detectBookFormat, isDrmionKfx } from './detect'
import { parseDocx } from './docx'
import { parseEpub } from './epub'
import { parseFb2 } from './fb2'
import { parseMobi } from './mobi'
import { parseHtml, parseTxt } from './txt'
import {
  BookError,
  type BookArchive,
  type BookChapter,
  type BookErrorKind,
  type BookFormat,
  type ParsedBook,
} from './types'

export {
  BOOK_ACCEPT,
  BookError,
  detectBookFormat,
  type BookArchive,
  type BookChapter,
  type BookErrorKind,
  type BookFormat,
  type ParsedBook,
}

export function isBookArchive(value: ParsedBook | BookArchive): value is BookArchive {
  return 'kind' in value && value.kind === 'archive'
}

/** 解析非 zip 容器的单本电子书 */
function parseSingleBook(bytes: Uint8Array, fileName: string, allowZip: boolean): ParsedBook | BookArchive {
  const format = detectBookFormat(bytes, fileName)

  switch (format) {
    case 'epub':
      return parseEpub(bytes, fileName)
    case 'txt':
      return parseTxt(bytes, fileName)
    case 'mobi':
    case 'azw3':
    case 'pdb':
      try {
        return parseMobi(bytes, fileName)
      } catch (error) {
        // Kindle 漫画只有图片，没有文字
        if (error instanceof BookError && error.kind === 'empty') {
          throw new BookError('empty', '没有读到文字，可能是漫画（只有图片）')
        }
        throw error
      }
    case 'fb2':
      return parseFb2(bytes, fileName)
    case 'docx':
      return parseDocx(bytes, fileName)
    case 'html':
      return parseHtml(bytes, fileName)
    case 'zip': {
      if (!allowZip) {
        throw new BookError('unsupported', '不支持压缩包套压缩包（zip 里套 zip）')
      }
      const entries = inspectBookArchive(bytes)
      if (entries.length === 1) {
        return parseBookInArchive(bytes, entries[0].path)
      }
      return { kind: 'archive', entries }
    }
    case 'kfx':
      if (isDrmionKfx(bytes)) {
        throw new BookError('encrypted', '这本 KFX 有 DRM 加密，无法读取')
      }
      throw new BookError(
        'unsupported',
        'KFX 是亚马逊的私有格式，暂不支持，可以用 Calibre 转成 EPUB 或 AZW3 再导入',
      )
    case 'pdf':
      throw new BookError('unsupported', 'PDF 暂不支持，可以用 Calibre 转成 EPUB 或 TXT 再导入')
    case 'doc':
      throw new BookError('unsupported', '老版 Word（.doc）不支持，请另存为 .docx')
    case 'unknown':
      throw new BookError('unsupported', '不支持的电子书格式')
  }
}

/** 解析一本书；zip 里有多本书时返回 BookArchive；不支持/加密/损坏/没有正文时抛 BookError */
export function parseBook(bytes: Uint8Array, fileName: string): ParsedBook | BookArchive {
  return parseSingleBook(bytes, fileName, true)
}

/** 解析 zip 里的某一本（path 来自 BookArchive.entries） */
export function parseBookInArchive(zipBytes: Uint8Array, entryPath: string): ParsedBook {
  const entryBytes = extractZipEntry(zipBytes, entryPath)
  const result = parseSingleBook(entryBytes, entryPath, false)
  if (isBookArchive(result)) {
    throw new BookError('unsupported', '不支持压缩包套压缩包（zip 里套 zip）')
  }
  return result
}
