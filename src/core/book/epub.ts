/**
 * EPUB（EPUB2 / EPUB3）电子书解析。
 * - 使用 fflate filter 跳过图片/字体/音视频，节省大书内存
 * - 检测 META-INF/encryption.xml，区分字体混淆与正文 DRM
 * - 优先解析 EPUB3 nav，其次 EPUB2 NCX；支持 #片段 切分、分卷、超大章二次细分
 */
import { unzipSync } from 'fflate'
import { isChapterHeading, splitTextIntoChapters } from './chapters'
import { decodeText } from './encoding'
import { collapseInlineSpace, decodeEntities, detectHtmlCharset, htmlTitle, htmlToText } from './html'
import { chaptersFromHtmlParts } from './parts'
import { BookError, fileBaseName, finalizeBook, type BookChapter, type ParsedBook } from './types'
import { dirnameOf, escapeRegExp, normalizeZipPath, parseXmlAttrs, resolveRelativePath, splitHref } from './xml'

const SKIP_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.tif',
  '.tiff',
  '.avif',
  '.psd',
  '.svg',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  '.mp3',
  '.mp4',
  '.m4a',
  '.m4v',
  '.ogg',
  '.oga',
  '.ogv',
  '.wav',
  '.flac',
  '.webm',
  '.mov',
  '.avi',
  '.mkv',
  '.aac',
  '.css',
  '.js',
  '.map',
  '.swf',
  '.pdf',
])

const NON_CONTENT_ENCRYPT_EXTS = new Set([
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.ico',
  '.mp3',
  '.mp4',
  '.ogg',
  '.wav',
  '.css',
  '.js',
])

const ALLOWED_OBFUSCATION_ALGORITHMS = new Set([
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#rc',
])

interface ManifestItem {
  id: string
  path: string
  mediaType: string
  properties: string
}

interface SpineDoc {
  path: string
  html: string
}

interface TocTreeNode {
  title: string
  path: string
  fragment?: string
  children: TocTreeNode[]
}

interface FlatTocItem {
  title: string
  path: string
  fragment?: string
  level: number
  hasChildren: boolean
  anchor?: { spineIdx: number; charOffset: number }
}

function getExtLower(path: string): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  if (dot <= slash) return ''
  return path.slice(dot).toLowerCase()
}

function shouldExtractEpubFile(name: string): boolean {
  if (!name || name.endsWith('/')) return false
  const ext = getExtLower(name.replace(/\\/g, '/'))
  if (ext && SKIP_EXTENSIONS.has(ext)) return false
  return true
}

function stripTagsToLine(raw: string): string {
  const noComments = raw.replace(/<!--[\s\S]*?-->/g, '')
  const noTags = noComments.replace(/<[^>]+>/g, ' ')
  return collapseInlineSpace(decodeEntities(noTags))
}

function isHtmlManifestItem(item: ManifestItem): boolean {
  const mt = item.mediaType.toLowerCase()
  if (mt === 'application/xhtml+xml' || mt === 'text/html' || mt === 'application/x-dtbook+xml') {
    return true
  }
  if (mt.startsWith('image/') || mt.startsWith('audio/') || mt.startsWith('video/') || mt.includes('svg')) {
    return false
  }
  if (!mt) {
    const ext = getExtLower(item.path)
    return ext === '.xhtml' || ext === '.html' || ext === '.htm' || ext === '.xhtm'
  }
  return false
}

/** 构造区分精确与小写兜底的 zip 文件查找器 */
function createZipLookup(files: Record<string, Uint8Array>) {
  const exact = new Map<string, Uint8Array>()
  const lower = new Map<string, Uint8Array>()
  const allPaths: string[] = []

  for (const [rawPath, data] of Object.entries(files)) {
    const norm = normalizeZipPath(rawPath)
    if (!norm) continue
    exact.set(norm, data)
    const low = norm.toLowerCase()
    if (!lower.has(low)) lower.set(low, data)
    allPaths.push(norm)
  }

  return {
    get(path: string): Uint8Array | undefined {
      const norm = normalizeZipPath(path)
      return exact.get(norm) ?? lower.get(norm.toLowerCase())
    },
    allPaths,
  }
}

/** 从 META-INF/container.xml 找出 OPF 路径；缺失时兜底找 .opf 文件 */
function findOpfPath(lookup: ReturnType<typeof createZipLookup>): string {
  const containerBytes = lookup.get('META-INF/container.xml')
  if (containerBytes) {
    const xml = decodeText(containerBytes, detectHtmlCharset(containerBytes)).text
    const rootfileRe = /<(?:[a-zA-Z0-9_-]+:)?rootfile\b([^>]*?)\/?>/gi
    let match: RegExpExecArray | null
    while ((match = rootfileRe.exec(xml)) !== null) {
      const attrs = parseXmlAttrs(match[1])
      const fullPath = attrs['full-path']
      if (fullPath) {
        return resolveRelativePath('', fullPath)
      }
    }
  }

  const fallback = lookup.allPaths.find((p) => p.toLowerCase().endsWith('.opf'))
  if (!fallback) {
    throw new BookError('corrupt', 'EPUB 里找不到内容清单（OPF）')
  }
  return fallback
}

/** 检查 META-INF/encryption.xml，正文被 DRM 加密时抛出 BookError('encrypted') */
function checkEpubEncryption(
  lookup: ReturnType<typeof createZipLookup>,
  htmlPathsLower: Set<string>,
): void {
  const encBytes = lookup.get('META-INF/encryption.xml')
  if (!encBytes) return

  const xml = decodeText(encBytes, detectHtmlCharset(encBytes)).text
  const blockRe =
    /<(?:[a-zA-Z0-9_-]+:)?EncryptedData\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?EncryptedData\s*>/gi
  let match: RegExpExecArray | null

  while ((match = blockRe.exec(xml)) !== null) {
    const block = match[1]
    const methodMatch = block.match(/<(?:[a-zA-Z0-9_-]+:)?EncryptionMethod\b([^>]*?)\/?>/i)
    const algorithm = methodMatch ? (parseXmlAttrs(methodMatch[1])['algorithm'] ?? '').trim().toLowerCase() : ''

    if (algorithm && ALLOWED_OBFUSCATION_ALGORITHMS.has(algorithm)) {
      continue
    }

    const refRe = /<(?:[a-zA-Z0-9_-]+:)?CipherReference\b([^>]*?)\/?>/gi
    let refMatch: RegExpExecArray | null
    while ((refMatch = refRe.exec(block)) !== null) {
      const uri = parseXmlAttrs(refMatch[1])['uri']
      if (!uri) continue
      const target = resolveRelativePath('', uri).toLowerCase()
      const ext = getExtLower(target)

      if (htmlPathsLower.has(target)) {
        throw new BookError('encrypted', '这本书有 DRM 加密，无法读取')
      }
      if (!NON_CONTENT_ENCRYPT_EXTS.has(ext) && (ext === '.xhtml' || ext === '.html' || ext === '.htm' || ext === '.xhtm')) {
        throw new BookError('encrypted', '这本书有 DRM 加密，无法读取')
      }
    }
  }
}

/** 提取 EPUB3 nav 文件中 epub:type="toc" 的 <nav> 区块内容 */
function extractTocNavBlock(html: string): string {
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, '')
  const navTagRe = /<(\/?)(?:[a-zA-Z0-9_-]+:)?nav\b([^>]*)>/gi
  let match: RegExpExecArray | null
  let firstNav = ''

  while ((match = navTagRe.exec(cleaned)) !== null) {
    if (match[1] === '/') continue
    const attrs = parseXmlAttrs(match[2])
    const typeVal = `${attrs['epub:type'] ?? ''} ${attrs['type'] ?? ''}`.toLowerCase()
    const isToc = /\btoc\b/.test(typeVal)

    // 扫描配对的 </nav>
    const innerStart = navTagRe.lastIndex
    let depth = 1
    let innerEnd = cleaned.length
    let innerMatch: RegExpExecArray | null
    while (depth > 0 && (innerMatch = navTagRe.exec(cleaned)) !== null) {
      if (innerMatch[1] === '/') {
        depth--
        if (depth === 0) innerEnd = innerMatch.index
      } else {
        depth++
      }
    }

    const block = cleaned.slice(innerStart, innerEnd)
    if (isToc) return block
    if (!firstNav) firstNav = block
  }

  return firstNav
}

/** 解析 EPUB3 nav 里的嵌套 <ol>/<li> 目录树 */
function parseEpub3Nav(html: string, navDir: string): TocTreeNode[] {
  const navBlock = extractTocNavBlock(html)
  if (!navBlock) return []

  const roots: TocTreeNode[] = []
  const stack: TocTreeNode[] = []
  const tokenRe =
    /<(\/?)(?:[a-zA-Z0-9_-]+:)?(li|a|span)\b([^>]*?)(\/?)>/gi

  let match: RegExpExecArray | null
  let inAnchor = false
  let anchorHref = ''
  let anchorTextStart = 0
  let inSpan = false
  let spanTextStart = 0

  while ((match = tokenRe.exec(navBlock)) !== null) {
    const isClose = match[1] === '/'
    const tag = match[2].toLowerCase()
    const attrStr = match[3]
    const isSelfClose = match[4] === '/'

    if (tag === 'li') {
      if (!isClose) {
        const node: TocTreeNode = { title: '', path: '', children: [] }
        const parent = stack[stack.length - 1]
        if (parent) {
          parent.children.push(node)
        } else {
          roots.push(node)
        }
        if (!isSelfClose) stack.push(node)
      } else {
        stack.pop()
        inAnchor = false
        inSpan = false
      }
      continue
    }

    const current = stack[stack.length - 1]
    if (!current) continue

    if (tag === 'a') {
      if (!isClose && !isSelfClose) {
        if (!current.path) {
          const attrs = parseXmlAttrs(attrStr)
          inAnchor = true
          anchorHref = attrs['href'] ?? ''
          anchorTextStart = tokenRe.lastIndex
        }
      } else if (isClose && inAnchor) {
        inAnchor = false
        const title = stripTagsToLine(navBlock.slice(anchorTextStart, match.index))
        if (anchorHref) {
          const { path, fragment } = splitHref(anchorHref)
          current.path = path ? resolveRelativePath(navDir, path) : ''
          current.fragment = fragment
        }
        if (title) current.title = title
      }
    } else if (tag === 'span') {
      if (!isClose && !isSelfClose) {
        if (!current.title && !inAnchor) {
          inSpan = true
          spanTextStart = tokenRe.lastIndex
        }
      } else if (isClose && inSpan) {
        inSpan = false
        const title = stripTagsToLine(navBlock.slice(spanTextStart, match.index))
        if (title && !current.title) current.title = title
      }
    }
  }

  return roots
}

/** 解析 EPUB2 NCX 的嵌套 <navPoint> 目录树 */
function parseEpub2Ncx(xml: string, ncxDir: string): TocTreeNode[] {
  const cleaned = xml.replace(/<!--[\s\S]*?-->/g, '')
  const navMapMatch = cleaned.match(
    /<(?:[a-zA-Z0-9_-]+:)?navMap\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?navMap\s*>/i,
  )
  const source = navMapMatch ? navMapMatch[1] : cleaned

  const roots: TocTreeNode[] = []
  const stack: TocTreeNode[] = []
  const tokenRe =
    /<(\/?)(?:[a-zA-Z0-9_-]+:)?(navPoint|text|content)\b([^>]*?)(\/?)>/gi

  let match: RegExpExecArray | null
  let inText = false
  let textStart = 0

  while ((match = tokenRe.exec(source)) !== null) {
    const isClose = match[1] === '/'
    const tag = match[2].toLowerCase()
    const attrStr = match[3]
    const isSelfClose = match[4] === '/'

    if (tag === 'navpoint') {
      if (!isClose) {
        const node: TocTreeNode = { title: '', path: '', children: [] }
        const parent = stack[stack.length - 1]
        if (parent) {
          parent.children.push(node)
        } else {
          roots.push(node)
        }
        if (!isSelfClose) stack.push(node)
      } else {
        stack.pop()
        inText = false
      }
      continue
    }

    const current = stack[stack.length - 1]
    if (!current) continue

    if (tag === 'text') {
      if (!isClose && !isSelfClose) {
        if (!current.title) {
          inText = true
          textStart = tokenRe.lastIndex
        }
      } else if (isClose && inText) {
        inText = false
        const title = stripTagsToLine(source.slice(textStart, match.index))
        if (title) current.title = title
      }
    } else if (tag === 'content' && !isClose && !current.path) {
      const src = parseXmlAttrs(attrStr)['src']
      if (src) {
        const { path, fragment } = splitHref(src)
        current.path = path ? resolveRelativePath(ncxDir, path) : ''
        current.fragment = fragment
      }
    }
  }

  return roots
}

/** 先序展平目录树，同时记录层级与是否有子条目 */
function flattenTocTree(nodes: TocTreeNode[], level = 0, out: FlatTocItem[] = []): FlatTocItem[] {
  for (const node of nodes) {
    const hasChildren = node.children.length > 0
    if (node.title || node.path || hasChildren) {
      out.push({
        title: node.title,
        path: node.path,
        fragment: node.fragment,
        level,
        hasChildren,
      })
    }
    if (hasChildren) {
      flattenTocTree(node.children, level + 1, out)
    }
  }
  return out
}

/** 查找 HTML 里 id="fragment"（或 name="fragment"）所在标签的起始位置 `<` */
function findFragmentOffset(html: string, fragment: string): number {
  const escaped = escapeRegExp(fragment)
  const re = new RegExp(
    `<[a-zA-Z][^>]*\\b(?:id|name)\\s*=\\s*(?:"${escaped}"|'${escaped}')`,
    'i',
  )
  const match = re.exec(html)
  return match ? match.index : 0
}

function compareAnchor(
  a: { spineIdx: number; charOffset: number },
  b: { spineIdx: number; charOffset: number },
): number {
  if (a.spineIdx !== b.spineIdx) return a.spineIdx - b.spineIdx
  return a.charOffset - b.charOffset
}

/** 提取 spine 序列中 [start, end) 范围的纯文本 */
function extractRangeText(
  spineDocs: SpineDoc[],
  start: { spineIdx: number; charOffset: number },
  end: { spineIdx: number; charOffset: number },
): string {
  if (compareAnchor(start, end) >= 0) return ''

  if (start.spineIdx === end.spineIdx) {
    return htmlToText(spineDocs[start.spineIdx].html.slice(start.charOffset, end.charOffset))
  }

  const chunks: string[] = []
  const firstText = htmlToText(spineDocs[start.spineIdx].html.slice(start.charOffset))
  if (firstText) chunks.push(firstText)

  const lastFull = Math.min(end.spineIdx, spineDocs.length)
  for (let i = start.spineIdx + 1; i < lastFull; i++) {
    const t = htmlToText(spineDocs[i].html)
    if (t) chunks.push(t)
  }

  if (end.spineIdx < spineDocs.length && end.charOffset > 0) {
    const tailText = htmlToText(spineDocs[end.spineIdx].html.slice(0, end.charOffset))
    if (tailText) chunks.push(tailText)
  }

  return chunks.join('\n')
}

/** 若正文第一行与章标题完全一致且后面还有内容，去掉重复首行 */
function stripDuplicateLeadingTitle(text: string, title: string): string {
  const normTitle = collapseInlineSpace(title)
  if (!normTitle) return text
  const nl = text.indexOf('\n')
  if (nl < 0) return text
  const firstLine = text.slice(0, nl)
  if (collapseInlineSpace(firstLine) === normTitle) {
    return text.slice(nl + 1)
  }
  return text
}

/** 对超大章（> 10 万字且含 ≥ 3 行章节标题）做二次细分 */
function maybeSubdivideLargeChapter(ch: BookChapter): BookChapter[] {
  if (ch.text.length <= 100_000) return [ch]

  const lines = ch.text.split('\n')
  let headingCount = 0
  for (let i = 0; i < lines.length; i++) {
    if (isChapterHeading(lines[i]) === 'chapter') {
      headingCount++
      if (headingCount >= 3) break
    }
  }
  if (headingCount < 3) return [ch]

  const sub = splitTextIntoChapters(ch.text)
  if (sub.length <= 1) return [ch]

  const inheritedVolume = ch.volume || ch.title
  return sub.map((item) => {
    const next: BookChapter = { title: item.title, text: item.text }
    if (item.volume) {
      next.volume = item.volume
    } else if (inheritedVolume) {
      next.volume = inheritedVolume
    }
    return next
  })
}

/** 解析 EPUB 字节流 */
export function parseEpub(bytes: Uint8Array, fileName: string): ParsedBook {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, {
      filter: (info) => shouldExtractEpubFile(info.name),
    })
  } catch {
    throw new BookError('corrupt', 'EPUB 压缩包已损坏，无法解压')
  }

  const lookup = createZipLookup(files)
  const opfPath = findOpfPath(lookup)
  const opfBytes = lookup.get(opfPath)
  if (!opfBytes) {
    throw new BookError('corrupt', 'EPUB 里找不到内容清单（OPF）')
  }

  const opfDir = dirnameOf(opfPath)
  const opfXml = decodeText(opfBytes, detectHtmlCharset(opfBytes)).text.replace(/<!--[\s\S]*?-->/g, '')

  // 提取书名和作者（优先在 <metadata> 中查找）
  const metaMatch = opfXml.match(
    /<(?:[a-zA-Z0-9_-]+:)?metadata\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?metadata\s*>/i,
  )
  const metaXml = metaMatch ? metaMatch[1] : opfXml
  const titleMatch = metaXml.match(
    /<(?:[a-zA-Z0-9_-]+:)?title\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?title\s*>/i,
  )
  const authorMatch = metaXml.match(
    /<(?:[a-zA-Z0-9_-]+:)?creator\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?creator\s*>/i,
  )
  const bookTitle = (titleMatch ? stripTagsToLine(titleMatch[1]) : '') || fileBaseName(fileName)
  const bookAuthor = authorMatch ? stripTagsToLine(authorMatch[1]) : ''

  // 解析 manifest
  const manifestById = new Map<string, ManifestItem>()
  const htmlPathsLower = new Set<string>()
  let navItem: ManifestItem | undefined
  let ncxItem: ManifestItem | undefined

  const itemRe = /<(?:[a-zA-Z0-9_-]+:)?item\b([^>]*?)\/?>/gi
  let match: RegExpExecArray | null
  while ((match = itemRe.exec(opfXml)) !== null) {
    const attrs = parseXmlAttrs(match[1])
    const id = attrs['id']
    const href = attrs['href']
    if (!id || !href) continue
    const { path } = splitHref(href)
    const resolvedPath = resolveRelativePath(opfDir, path)
    const item: ManifestItem = {
      id,
      path: resolvedPath,
      mediaType: attrs['media-type'] ?? '',
      properties: attrs['properties'] ?? '',
    }
    manifestById.set(id, item)
    if (isHtmlManifestItem(item)) {
      htmlPathsLower.add(resolvedPath.toLowerCase())
    }
    if (!navItem && /\bnav\b/i.test(item.properties)) {
      navItem = item
    }
    if (!ncxItem && item.mediaType.toLowerCase() === 'application/x-dtbncx+xml') {
      ncxItem = item
    }
  }

  // 解析 spine
  const spineMatch = opfXml.match(
    /<(?:[a-zA-Z0-9_-]+:)?spine\b([^>]*)>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?spine\s*>/i,
  )
  if (!spineMatch) {
    throw new BookError('corrupt', 'EPUB 的 OPF 里缺少阅读顺序（spine）')
  }
  const spineAttrs = parseXmlAttrs(spineMatch[1])
  if (!ncxItem && spineAttrs['toc']) {
    ncxItem = manifestById.get(spineAttrs['toc'])
  }
  if (!ncxItem) {
    for (const item of manifestById.values()) {
      if (item.path.toLowerCase().endsWith('.ncx')) {
        ncxItem = item
        break
      }
    }
  }

  const spineItems: ManifestItem[] = []
  const itemrefRe = /<(?:[a-zA-Z0-9_-]+:)?itemref\b([^>]*?)\/?>/gi
  while ((match = itemrefRe.exec(spineMatch[2])) !== null) {
    const idref = parseXmlAttrs(match[1])['idref']
    if (!idref) continue
    const item = manifestById.get(idref)
    if (!item || !isHtmlManifestItem(item)) continue
    spineItems.push(item)
    htmlPathsLower.add(item.path.toLowerCase())
  }

  // 检查加密（放在 manifest/spine 解析后，准确判断被加密文件是否是正文）
  checkEpubEncryption(lookup, htmlPathsLower)

  // 读取所有 spine 正文文件
  const spineDocs: SpineDoc[] = []
  const spineIndexByPath = new Map<string, number>()
  const spineIndexByLower = new Map<string, number>()
  let missingCount = 0

  for (const item of spineItems) {
    const fileBytes = lookup.get(item.path)
    if (!fileBytes) {
      missingCount++
      continue
    }
    const declared = detectHtmlCharset(fileBytes)
    const { text: html } = decodeText(fileBytes, declared)
    const idx = spineDocs.length
    spineDocs.push({ path: item.path, html })
    if (!spineIndexByPath.has(item.path)) spineIndexByPath.set(item.path, idx)
    const low = item.path.toLowerCase()
    if (!spineIndexByLower.has(low)) spineIndexByLower.set(low, idx)
  }

  const warnings: string[] = []
  if (missingCount > 0) {
    warnings.push(`有 ${missingCount} 个章节文件找不到，已跳过`)
  }

  if (spineDocs.length === 0) {
    throw new BookError('empty', '没有读到正文')
  }

  // 解析目录：EPUB3 nav 优先，否则 NCX
  let tocTree: TocTreeNode[] = []
  if (navItem) {
    const navBytes = lookup.get(navItem.path)
    if (navBytes) {
      const navHtml = decodeText(navBytes, detectHtmlCharset(navBytes)).text
      tocTree = parseEpub3Nav(navHtml, dirnameOf(navItem.path))
    }
  }
  if (tocTree.length === 0 && ncxItem) {
    const ncxBytes = lookup.get(ncxItem.path)
    if (ncxBytes) {
      const ncxXml = decodeText(ncxBytes, detectHtmlCharset(ncxBytes)).text
      tocTree = parseEpub2Ncx(ncxXml, dirnameOf(ncxItem.path))
    }
  }

  const flatToc = flattenTocTree(tocTree)
  let matchedCount = 0
  for (const item of flatToc) {
    if (!item.path) continue
    const idx = spineIndexByPath.get(item.path) ?? spineIndexByLower.get(item.path.toLowerCase())
    if (idx === undefined) continue
    const charOffset = item.fragment ? findFragmentOffset(spineDocs[idx].html, item.fragment) : 0
    item.anchor = { spineIdx: idx, charOffset }
    matchedCount++
  }

  let chapters: BookChapter[] = []

  if (matchedCount >= 2) {
    // 规范化锚点单调性，过滤掉指向前方的异常倒退条目
    let lastPos = { spineIdx: 0, charOffset: 0 }
    let firstValidAnchor: { spineIdx: number; charOffset: number } | undefined

    for (const item of flatToc) {
      if (!item.anchor) continue
      if (compareAnchor(item.anchor, lastPos) < 0) {
        item.anchor = undefined
        continue
      }
      lastPos = item.anchor
      if (!firstValidAnchor) firstValidAnchor = item.anchor
    }

    // 收集所有带有效锚点的条目下标，用于确定每条目录的结束位置
    const anchoredIndices: number[] = []
    for (let i = 0; i < flatToc.length; i++) {
      if (flatToc[i].anchor) anchoredIndices.push(i)
    }

    const endOfBook = { spineIdx: spineDocs.length, charOffset: 0 }

    // 目录第一个条目之前的 spine 内容作为“（开头）”
    if (firstValidAnchor && compareAnchor({ spineIdx: 0, charOffset: 0 }, firstValidAnchor) < 0) {
      const preface = extractRangeText(spineDocs, { spineIdx: 0, charOffset: 0 }, firstValidAnchor)
      if (preface) {
        chapters.push({ title: '（开头）', text: preface })
      }
    }

    // 为每个目录项查找它的下一个有效锚点
    let nextAnchoredPtr = 0
    const volumeStack: Array<{ level: number; title: string }> = []

    for (let i = 0; i < flatToc.length; i++) {
      const item = flatToc[i]
      while (volumeStack.length > 0 && volumeStack[volumeStack.length - 1].level >= item.level) {
        volumeStack.pop()
      }

      if (nextAnchoredPtr < anchoredIndices.length && anchoredIndices[nextAnchoredPtr] === i) {
        nextAnchoredPtr++
      }

      let ownText = ''
      if (item.anchor) {
        const nextIdx = nextAnchoredPtr < anchoredIndices.length ? anchoredIndices[nextAnchoredPtr] : -1
        const endAnchor = nextIdx >= 0 ? flatToc[nextIdx].anchor! : endOfBook
        ownText = extractRangeText(spineDocs, item.anchor, endAnchor)
      }

      // 有子条目且自身正文 < 100 字：不单独成章，标题作为子条目的 volume
      if (item.hasChildren && ownText.length < 100) {
        if (item.title) {
          volumeStack.push({ level: item.level, title: item.title })
        }
        continue
      }

      if (!ownText) continue

      const cleanedText = item.title ? stripDuplicateLeadingTitle(ownText, item.title) : ownText
      const currentVolume = volumeStack.length > 0 ? volumeStack[volumeStack.length - 1].title : undefined
      const baseChapter: BookChapter = {
        title: item.title || `第 ${chapters.length + 1} 部分`,
        text: cleanedText,
      }
      if (currentVolume) baseChapter.volume = currentVolume

      chapters.push(...maybeSubdivideLargeChapter(baseChapter))
    }
  }

  // 目录不可用或按目录未切出任何正文时，回退到按 spine 文件切分
  if (chapters.length === 0) {
    const parts = spineDocs.map((doc) => ({
      html: doc.html,
      titleHint: htmlTitle(doc.html) || undefined,
    }))
    const fallback = chaptersFromHtmlParts(parts)
    chapters = fallback.chapters
    warnings.push(...fallback.warnings)
  }

  return finalizeBook({
    format: 'epub',
    title: bookTitle,
    author: bookAuthor,
    chapters,
    warnings,
  })
}
