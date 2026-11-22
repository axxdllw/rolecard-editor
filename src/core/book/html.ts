/**
 * HTML/XML 纯文本抽取、实体解码、行规范化与标题/编码辅助函数。
 * 全程纯字符串处理，不依赖 DOMParser。
 */

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: '\u00a0',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  hellip: '…',
  mdash: '—',
  ndash: '–',
  minus: '−',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  sect: '§',
  para: '¶',
  emsp: '\u2003',
  ensp: '\u2002',
  thinsp: '\u2009',
  zwnj: '\u200c',
  zwj: '\u200d',
  shy: '',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  divide: '÷',
  plusmn: '±',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  iexcl: '¡',
  iquest: '¿',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
}

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'tr',
  'blockquote',
  'section',
  'article',
  'hr',
  'pre',
  'dd',
  'dt',
  'figcaption',
  'header',
  'footer',
  'nav',
  'aside',
  'main',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'ul',
  'ol',
  'dl',
  'figure',
  'address',
])

const EDGE_WS_RE =
  /^[ \t\f\v\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+|[ \t\f\v\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+$/g

const ANY_WS_RE = /[\s\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+/g

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]+);/g

const COMMENT_RE = /<!--[\s\S]*?-->/g

/** 去掉不需要出现在正文里的块：script/style/head/rt/rp（保留 header 等其他标签） */
const IGNORED_BLOCKS_RE = /<(script|style|head|rt|rp)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi

const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)(?:\s(?:"[^"]*"|'[^']*'|[^>"'])*)?\/?>/g

const XML_DECL_OR_DOCTYPE_RE = /<(?:!DOCTYPE|\?xml)[^>]*>/gi

/** 解码 HTML/XML 实体（十进制、十六进制数字实体 + 常用命名实体） */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(ENTITY_RE, (full, body: string) => {
    if (body.charCodeAt(0) === 35 /* '#' */) {
      const code =
        body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)) {
        return String.fromCodePoint(code)
      }
      return full
    }
    const mapped = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()]
    return mapped !== undefined ? mapped : full
  })
}

/** 去掉单行首尾空白（含全角空格 U+3000、不换行空格 U+00A0 等） */
export function trimBookLine(line: string): string {
  return line.replace(EDGE_WS_RE, '')
}

/** 把任意连续空白合并为单个普通空格，并去掉首尾空白 */
export function collapseInlineSpace(text: string): string {
  return text.replace(ANY_WS_RE, ' ').trim()
}

/** 规范化正文：统一换行符、每行去首尾空白（含全角/不换行空格）、去掉空行 */
export function normalizeLines(text: string): string {
  if (!text) return ''
  // 行内的不换行空格换成普通空格（标题识别、显示都按普通空格处理）
  const lines = text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const cleaned = trimBookLine(lines[i])
    if (cleaned.length > 0) {
      out.push(cleaned)
    }
  }
  return out.join('\n')
}

/** 将 HTML 片段转为规范化纯文本（一段一行，不含空行） */
export function htmlToText(html: string): string {
  if (!html) return ''
  const stripped = html
    .replace(COMMENT_RE, '')
    .replace(IGNORED_BLOCKS_RE, '')
    .replace(XML_DECL_OR_DOCTYPE_RE, '')
    .replace(TAG_RE, (_full, rawTag: string) => {
      const colon = rawTag.lastIndexOf(':')
      const tag = (colon >= 0 ? rawTag.slice(colon + 1) : rawTag).toLowerCase()
      return BLOCK_TAGS.has(tag) ? '\n' : ''
    })

  return normalizeLines(decodeEntities(stripped))
}

/** 去掉内联标签、解码实体并合并空白，用于提取标题类单行文本 */
function cleanInlineHtml(fragment: string): string {
  const withoutRuby = fragment
    .replace(COMMENT_RE, '')
    .replace(/<(rt|rp)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(TAG_RE, ' ')
  return collapseInlineSpace(decodeEntities(withoutRuby))
}

/** 提取 HTML 里第一个非空 h1～h3 的纯文本 */
export function firstHeading(html: string): string {
  if (!html) return ''
  const cleaned = html.replace(COMMENT_RE, '').replace(IGNORED_BLOCKS_RE, '')
  const re = /<h([1-3])(?:\s[^>]*)?>([\s\S]*?)<\/h\1\s*>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(cleaned)) !== null) {
    const text = cleanInlineHtml(match[2])
    if (text) return text
  }
  return ''
}

/** 提取 HTML 里 `<title>` 的纯文本 */
export function htmlTitle(html: string): string {
  if (!html) return ''
  const match = html.replace(COMMENT_RE, '').match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i)
  if (!match) return ''
  return cleanInlineHtml(match[1])
}

/** 从 XML 声明或 HTML `<meta charset>` 嗅探声明的字符编码 */
export function detectHtmlCharset(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return undefined
  const limit = Math.min(bytes.length, 4096)
  // 头部声明本身是 ASCII，用 latin1 逐字节映射不会抛错
  let head = ''
  for (let i = 0; i < limit; i++) {
    const b = bytes[i]
    if (b !== 0) head += String.fromCharCode(b)
  }

  const xmlMatch = head.match(/<\?xml\b[^>]*\bencoding\s*=\s*["']([^"']+)["']/i)
  if (xmlMatch) return xmlMatch[1].trim()

  const metaCharset = head.match(/<meta\b[^>]*\bcharset\s*=\s*["']?\s*([a-zA-Z0-9._-]+)/i)
  if (metaCharset) return metaCharset[1].trim()

  return undefined
}
