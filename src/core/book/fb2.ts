/**
 * FictionBook 2 (.fb2) 电子书解析。
 * - 按 XML 声明编码解码（常见 utf-8 / windows-1251）
 * - 忽略 <binary> 块
 * - 递归解析 <section>：有子 section 的作为卷，叶子 section 作为章
 */
import { splitTextIntoChapters } from './chapters'
import { decodeText } from './encoding'
import { collapseInlineSpace, decodeEntities, detectHtmlCharset, htmlToText, trimBookLine } from './html'
import { BookError, fileBaseName, finalizeBook, type BookChapter, type ParsedBook } from './types'
import { parseXmlAttrs } from './xml'

interface SectionNode {
  start: number
  innerStart: number
  innerEnd: number
  end: number
  children: SectionNode[]
}

function cleanInlineXml(raw: string): string {
  const noTags = raw.replace(/<[^>]+>/g, ' ')
  return collapseInlineSpace(decodeEntities(noTags))
}

function extractFirstTagText(xml: string, tagName: string): string {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}\\s*>`, 'i')
  const match = xml.match(re)
  return match ? cleanInlineXml(match[1]) : ''
}

/** 从一段 XML 里提取 <p> / <v> / <subtitle> / <text-author> 段落纯文本 */
function extractParagraphs(xml: string): string {
  const re = /<(p|v|subtitle|text-author)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi
  const lines: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(xml)) !== null) {
    const cleaned = trimBookLine(decodeEntities(match[2].replace(/<[^>]+>/g, '')))
    if (cleaned) lines.push(cleaned)
  }
  return lines.join('\n')
}

/** 从段内提取第一个 <title> 的纯文本（可能包含多个 <p>） */
function extractSectionTitle(directXml: string): { title: string; restXml: string } {
  const titleRe = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i
  const match = titleRe.exec(directXml)
  if (!match) return { title: '', restXml: directXml }

  const titleInner = match[1]
  const paras = extractParagraphs(titleInner)
  const title = paras ? collapseInlineSpace(paras.replace(/\n+/g, ' ')) : cleanInlineXml(titleInner)
  const restXml = directXml.slice(0, match.index) + directXml.slice(match.index + match[0].length)
  return { title, restXml }
}

/** 单遍栈扫描解析嵌套 <section> 树 */
function parseSectionTree(bodyXml: string): SectionNode[] {
  const roots: SectionNode[] = []
  const stack: SectionNode[] = []
  const re = /<(\/?)section\b([^>]*?)(\/?)>/gi
  let match: RegExpExecArray | null

  while ((match = re.exec(bodyXml)) !== null) {
    const isClose = match[1] === '/'
    const isSelfClose = match[3] === '/'

    if (!isClose) {
      const node: SectionNode = {
        start: match.index,
        innerStart: re.lastIndex,
        innerEnd: re.lastIndex,
        end: re.lastIndex,
        children: [],
      }
      const parent = stack[stack.length - 1]
      if (parent) {
        parent.children.push(node)
      } else {
        roots.push(node)
      }
      if (!isSelfClose) {
        stack.push(node)
      }
    } else {
      const top = stack.pop()
      if (top) {
        top.innerEnd = match.index
        top.end = re.lastIndex
      }
    }
  }

  // 容错：未闭合的 section 收到 body 末尾
  while (stack.length > 0) {
    const top = stack.pop()!
    top.innerEnd = bodyXml.length
    top.end = bodyXml.length
  }

  return roots
}

/** 收集 section 节点（排除其子 section 占据的区域）自身的直接 XML */
function getDirectXml(bodyXml: string, node: SectionNode): string {
  if (node.children.length === 0) {
    return bodyXml.slice(node.innerStart, node.innerEnd)
  }
  const chunks: string[] = []
  let cursor = node.innerStart
  for (const child of node.children) {
    if (child.start > cursor) {
      chunks.push(bodyXml.slice(cursor, child.start))
    }
    cursor = Math.max(cursor, child.end)
  }
  if (node.innerEnd > cursor) {
    chunks.push(bodyXml.slice(cursor, node.innerEnd))
  }
  return chunks.join('')
}

/** 解析 FB2 电子书 */
export function parseFb2(bytes: Uint8Array, fileName: string): ParsedBook {
  const declared = detectHtmlCharset(bytes)
  const { text: rawXml } = decodeText(bytes, declared)
  if (!rawXml.trim()) {
    throw new BookError('empty', '没有读到正文')
  }

  // 忽略 <binary> 块（通常在文件末尾，可能极大）
  const xml = rawXml.replace(/<binary\b[^>]*>[\s\S]*?<\/binary\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '')

  // 提取书名和作者（优先从 <title-info> 中读取）
  const titleInfoMatch = xml.match(/<title-info\b[^>]*>([\s\S]*?)<\/title-info\s*>/i)
  const descMatch = xml.match(/<description\b[^>]*>([\s\S]*?)<\/description\s*>/i)
  const metaXml = titleInfoMatch?.[1] ?? descMatch?.[1] ?? xml

  const bookTitle = extractFirstTagText(metaXml, 'book-title') || fileBaseName(fileName)

  let author = ''
  const authorMatch = metaXml.match(/<author\b[^>]*>([\s\S]*?)<\/author\s*>/i)
  if (authorMatch) {
    const authorXml = authorMatch[1]
    const parts = [
      extractFirstTagText(authorXml, 'first-name'),
      extractFirstTagText(authorXml, 'middle-name'),
      extractFirstTagText(authorXml, 'last-name'),
    ].filter(Boolean)
    author = parts.length > 0 ? parts.join(' ') : extractFirstTagText(authorXml, 'nickname')
  }

  // 选取第一个没有 name="notes" 的 <body>
  const bodyRe = /<body\b([^>]*)>([\s\S]*?)<\/body\s*>/gi
  let mainBody = ''
  let bodyMatch: RegExpExecArray | null
  while ((bodyMatch = bodyRe.exec(xml)) !== null) {
    const attrs = parseXmlAttrs(bodyMatch[1])
    const nameAttr = (attrs['name'] ?? '').trim().toLowerCase()
    if (nameAttr === 'notes') continue
    mainBody = bodyMatch[2]
    break
  }

  if (!mainBody) {
    throw new BookError('empty', '没有读到正文')
  }

  const sections = parseSectionTree(mainBody)
  const chapters: BookChapter[] = []

  if (sections.length === 0) {
    // 没有 section，整个 body 抽出正文后交给 splitTextIntoChapters
    const text = extractParagraphs(mainBody) || htmlToText(mainBody)
    chapters.push(...splitTextIntoChapters(text))
  } else {
    const walk = (nodes: SectionNode[], parentVolume?: string) => {
      for (const node of nodes) {
        const directXml = getDirectXml(mainBody, node)
        const { title, restXml } = extractSectionTitle(directXml)
        const ownText = extractParagraphs(restXml)

        if (node.children.length > 0) {
          const vol = title || parentVolume
          if (ownText) {
            const ch: BookChapter = {
              title: title || `第 ${chapters.length + 1} 部分`,
              text: ownText,
            }
            if (vol) ch.volume = vol
            chapters.push(ch)
          }
          walk(node.children, vol)
        } else if (ownText) {
          const ch: BookChapter = {
            title: title || `第 ${chapters.length + 1} 部分`,
            text: ownText,
          }
          if (parentVolume) ch.volume = parentVolume
          chapters.push(ch)
        }
      }
    }

    walk(sections)
  }

  return finalizeBook({
    format: 'fb2',
    title: bookTitle,
    author,
    chapters,
    warnings: [],
  })
}
