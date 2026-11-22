/**
 * Word DOCX (.docx) 解析。
 * - 只解压 word/document.xml、word/styles.xml、docProps/core.xml
 * - 识别 heading 1～3 / 标题 1～3 段落样式分章（heading 1 下有 heading 2 时作卷）
 * - 无标题样式时回退到 splitTextIntoChapters
 */
import { unzipSync } from 'fflate'
import { splitTextIntoChapters } from './chapters'
import { decodeText } from './encoding'
import { collapseInlineSpace, decodeEntities, detectHtmlCharset, normalizeLines } from './html'
import { BookError, fileBaseName, finalizeBook, type BookChapter, type ParsedBook } from './types'
import { normalizeZipPath, parseXmlAttrs } from './xml'

interface DocxParagraph {
  text: string
  headingLevel?: number
}

const NEEDED_DOCX_FILES = new Set(['word/document.xml', 'word/styles.xml', 'docprops/core.xml'])

/** 识别样式名或 styleId 对应的标题级别（1～3） */
function parseHeadingLevel(value: string): number | undefined {
  const s = value.trim()
  if (!s) return undefined
  const en = s.match(/^heading\s*([1-3])$/i)
  if (en) return Number(en[1])
  const cn = s.match(/^(?:标题|標題)\s*([1-3])$/)
  if (cn) return Number(cn[1])
  return undefined
}

/** 解析 word/styles.xml，得到 styleId（小写）→ 标题级别 映射 */
function parseStyleHeadings(stylesXml: string): Map<string, number> {
  const map = new Map<string, number>()
  const styleRe = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style\s*>/gi
  let match: RegExpExecArray | null

  while ((match = styleRe.exec(stylesXml)) !== null) {
    const attrs = parseXmlAttrs(match[1])
    const styleId = attrs['w:styleid'] ?? attrs['styleid']
    if (!styleId) continue

    const nameMatch = match[2].match(/<w:name\b([^>]*?)\/?>/i)
    const styleName = nameMatch ? (parseXmlAttrs(nameMatch[1])['w:val'] ?? parseXmlAttrs(nameMatch[1])['val'] ?? '') : ''
    const level = parseHeadingLevel(styleName) ?? parseHeadingLevel(styleId)
    if (level !== undefined) {
      map.set(styleId.toLowerCase(), level)
    }
  }
  return map
}

/** 单遍扫描 word/document.xml 提取所有段落及其标题级别 */
function parseDocumentParagraphs(docXml: string, styleHeadings: Map<string, number>): DocxParagraph[] {
  const paragraphs: DocxParagraph[] = []
  const stack: Array<{ styleId: string; parts: string[] }> = []

  const tokenRe = /<(\/?)w:(p|pStyle|t|tab|br|cr)\b([^>]*?)(\/?)>/g
  let match: RegExpExecArray | null
  let inText = false
  let textStart = 0

  while ((match = tokenRe.exec(docXml)) !== null) {
    const isClose = match[1] === '/'
    const tag = match[2]
    const attrStr = match[3]
    const isSelfClose = match[4] === '/'

    if (tag === 'p') {
      if (!isClose) {
        if (!isSelfClose) {
          stack.push({ styleId: '', parts: [] })
        }
      } else {
        const done = stack.pop()
        inText = false
        if (done) {
          const text = normalizeLines(done.parts.join(''))
          if (text) {
            const level = done.styleId
              ? (styleHeadings.get(done.styleId.toLowerCase()) ?? parseHeadingLevel(done.styleId))
              : undefined
            paragraphs.push({ text, headingLevel: level })
          }
        }
      }
      continue
    }

    const current = stack[stack.length - 1]
    if (!current) continue

    if (tag === 'pStyle' && !isClose) {
      const attrs = parseXmlAttrs(attrStr)
      const val = attrs['w:val'] ?? attrs['val'] ?? ''
      if (val) current.styleId = val
    } else if (tag === 't') {
      if (!isClose && !isSelfClose) {
        inText = true
        textStart = tokenRe.lastIndex
      } else if (isClose && inText) {
        inText = false
        const chunk = decodeEntities(docXml.slice(textStart, match.index))
        if (chunk) current.parts.push(chunk)
      }
    } else if (tag === 'tab' && !isClose) {
      current.parts.push(' ')
    } else if ((tag === 'br' || tag === 'cr') && !isClose) {
      current.parts.push('\n')
    }
  }

  return paragraphs
}

function extractCoreField(coreXml: string, localName: string): string {
  const re = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?${localName}\\s*>`, 'i')
  const match = coreXml.match(re)
  if (!match) return ''
  return collapseInlineSpace(decodeEntities(match[1].replace(/<[^>]+>/g, ' ')))
}

/** 解析 DOCX 字节流 */
export function parseDocx(bytes: Uint8Array, fileName: string): ParsedBook {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, {
      filter: (info) => NEEDED_DOCX_FILES.has(normalizeZipPath(info.name).toLowerCase()),
    })
  } catch {
    throw new BookError('corrupt', 'DOCX 文件已损坏，无法解压')
  }

  const byLower = new Map<string, Uint8Array>()
  for (const [k, v] of Object.entries(files)) {
    byLower.set(normalizeZipPath(k).toLowerCase(), v)
  }

  const docBytes = byLower.get('word/document.xml')
  if (!docBytes) {
    throw new BookError('corrupt', 'DOCX 里找不到正文文件（word/document.xml）')
  }

  let title = ''
  let author = ''
  const coreBytes = byLower.get('docprops/core.xml')
  if (coreBytes) {
    const coreXml = decodeText(coreBytes, detectHtmlCharset(coreBytes)).text
    title = extractCoreField(coreXml, 'title')
    author = extractCoreField(coreXml, 'creator')
  }

  const stylesBytes = byLower.get('word/styles.xml')
  const styleHeadings = stylesBytes
    ? parseStyleHeadings(decodeText(stylesBytes, detectHtmlCharset(stylesBytes)).text)
    : new Map<string, number>()

  const docXml = decodeText(docBytes, detectHtmlCharset(docBytes)).text
  const paragraphs = parseDocumentParagraphs(docXml, styleHeadings)

  if (paragraphs.length === 0) {
    throw new BookError('empty', '没有读到正文')
  }

  // 检查是否使用了标题样式
  const headingIndices: number[] = []
  let hasLevel1WithChildLevel2 = false
  let seenLevel1 = false

  for (let i = 0; i < paragraphs.length; i++) {
    const lv = paragraphs[i].headingLevel
    if (lv !== undefined) {
      headingIndices.push(i)
      if (lv === 1) seenLevel1 = true
      else if (lv === 2 && seenLevel1) hasLevel1WithChildLevel2 = true
    }
  }

  let chapters: BookChapter[] = []

  if (headingIndices.length > 0) {
    // 第一个标题之前的内容作为“（开头）”
    if (headingIndices[0] > 0) {
      const preface = paragraphs
        .slice(0, headingIndices[0])
        .map((p) => p.text)
        .join('\n')
      if (preface) {
        chapters.push({ title: '（开头）', text: preface })
      }
    }

    let currentVolume: string | undefined

    for (let i = 0; i < headingIndices.length; i++) {
      const idx = headingIndices[i]
      const nextIdx = i + 1 < headingIndices.length ? headingIndices[i + 1] : paragraphs.length
      const headingPara = paragraphs[idx]
      const headingTitle = collapseInlineSpace(headingPara.text.replace(/\n+/g, ' '))
      const body = paragraphs
        .slice(idx + 1, nextIdx)
        .map((p) => p.text)
        .join('\n')

      if (hasLevel1WithChildLevel2 && headingPara.headingLevel === 1) {
        currentVolume = headingTitle
        if (body.length >= 200) {
          chapters.push({ title: headingTitle, text: body, volume: currentVolume })
        }
      } else if (body.length > 0) {
        const ch: BookChapter = { title: headingTitle, text: body }
        if (currentVolume) ch.volume = currentVolume
        chapters.push(ch)
      }
    }
  }

  // 无标题样式，或标题样式下没有切出带正文的章节：回退到纯文本分章
  if (chapters.length === 0) {
    const fullText = paragraphs.map((p) => p.text).join('\n')
    chapters = splitTextIntoChapters(fullText)
  }

  return finalizeBook({
    format: 'docx',
    title: title || fileBaseName(fileName),
    author,
    chapters,
    warnings: [],
  })
}
