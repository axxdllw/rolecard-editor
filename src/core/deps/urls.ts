/**
 * 从文本里找出外部地址，并按上下文判断用途（脚本、样式、图片……）。
 */

export type ResourceKind = 'script' | 'style' | 'font' | 'image' | 'media' | 'link' | 'other'

export const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
  script: '脚本',
  style: '样式',
  font: '字体',
  image: '图片',
  media: '音视频',
  link: '链接',
  other: '其他',
}

export interface FoundUrl {
  url: string
  /** 小写的主机名，不含端口 */
  host: string
  kind: ResourceKind
}

/**
 * 地址里不收空白、引号、尖括号、反斜杠和中文标点；允许 ${…} 和 {{…}} 占位。
 * 中文路径（如 /dist/鸣潮/index.js）是允许的。
 */
const URL_PATTERN = /\bhttps?:\/\/(?:\$\{[^}\s]*\}|\{\{[^}\s]*\}\}|[^\s"'`<>\\{}|^，。；：！？、（）【】「」『』《》“”‘’])+/gi

/** SVG/XML 命名空间之类，只是标识符，不会去加载 */
const IGNORED_HOSTS = /^(?:www\.w3\.org|(?:[\w-]+\.)*example\.(?:com|org|net))$/

/** 常见图床，地址常常不带扩展名 */
const IMAGE_HOSTS = /^(?:kappa\.lol|i\.postimg\.cc|i\.ibb\.co|i\.imgur\.com|i\.pinimg\.com|s\d+\.ax1x\.com|s\d+\.loli\.net)$/

const HOST_PATTERN =/^(?:\[[0-9a-f:]+\]|localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+)$/i

function count(text: string, ch: string): number {
  return text.split(ch).length - 1
}

/** 去掉粘在地址末尾的标点和 HTML 实体 */
function trimUrl(raw: string): string {
  let url = raw.split(/&(?:quot|#34|#39|apos|lt|gt);/i)[0].replaceAll('&amp;', '&')
  for (;;) {
    const last = url.at(-1)
    if (!last) break
    if ('.,;:!?*'.includes(last)) url = url.slice(0, -1)
    else if (last === ')' && count(url, '(') < count(url, ')')) url = url.slice(0, -1)
    else if (last === ']' && count(url, '[') < count(url, ']')) url = url.slice(0, -1)
    else break
  }
  return url
}

/** 主机名（小写、不含端口）；不像主机名时返回 null */
export function urlHost(url: string): string | null {
  const authority = url.replace(/^https?:\/\//i, '').split(/[/?#]/)[0]
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1)
  const host = (hostPort.startsWith('[') ? hostPort.slice(0, hostPort.indexOf(']') + 1) : hostPort.split(':')[0]).toLowerCase()
  return HOST_PATTERN.test(host) ? host : null
}

/** 协议 + 主机 + 端口，例如 http://127.0.0.1:5500 */
export function urlOrigin(url: string): string {
  const m = url.match(/^(https?:\/\/[^/?#]+)/i)
  return m ? m[1].toLowerCase() : url
}

/** 作者本机或局域网的地址，换一台电脑就访问不到 */
export function isLocalHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '0.0.0.0') return true
  const ip = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/)
  if (!ip) return false
  const [a, b] = [Number(ip[1]), Number(ip[2])]
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

/** 按扩展名或常见主机判断用途 */
function kindFromUrl(url: string, host: string): ResourceKind | null {
  const path = url.replace(/^https?:\/\/[^/?#]*/i, '').split(/[?#]/)[0].toLowerCase()
  if (/\.(?:m?js|cjs)$/.test(path)) return 'script'
  if (/\.css$/.test(path)) return 'style'
  if (/\.(?:woff2?|ttf|otf|eot)$/.test(path)) return 'font'
  if (/\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico|apng)$/.test(path)) return 'image'
  if (/\.(?:mp3|wav|ogg|oga|m4a|flac|aac|opus|mp4|webm|mov|m4v)$/.test(path)) return 'media'
  if (host === 'fonts.googleapis.com') return 'style'
  if (host === 'fonts.gstatic.com') return 'font'
  if (host === 'cdn.tailwindcss.com') return 'script'
  if (IMAGE_HOSTS.test(host)) return 'image'
  // jsDelivr 的 npm 包不写文件名时返回包的入口脚本
  if (host.endsWith('.jsdelivr.net') && path.startsWith('/npm/')) return 'script'
  return null
}

/** 按地址前面的代码判断用途；判断不了返回 null */
function kindFromContext(before: string, after: string, url: string, host: string): ResourceKind | null {
  if (/@import\s+(?:url\(\s*)?["']?\s*$/i.test(before)) return 'style'
  // import 'x'、import x from 'x'、import('x')、$.getScript('x')
  if (/(?<!@)\b(?:import|importScripts|getScript|loadScript)\b[^;'"`\n]*["'`]\s*$/.test(before)) return 'script'
  if (/\burl\(\s*["']?\s*$/i.test(before)) return kindFromUrl(url, host) === 'font' ? 'font' : 'image'
  if (/!\[[^\]\n]*\]\(\s*$/.test(before)) return 'image'
  if (/\]\(\s*$/.test(before)) return 'link'

  const tag = before.match(/<([a-z][\w:-]*)\b[^<>]*$/i)
  if (!tag) return null
  const end = after.indexOf('>')
  const tagText = tag[0] + (end >= 0 ? after.slice(0, end) : '')
  switch (tag[1].toLowerCase()) {
    case 'script':
      return 'script'
    case 'img':
    case 'image':
      return 'image'
    case 'audio':
    case 'video':
    case 'source':
    case 'track':
      return 'media'
    case 'a':
      return 'link'
    case 'iframe':
    case 'embed':
    case 'object':
      return 'other'
    case 'link': {
      const rel = tagText.match(/\brel\s*=\s*["']?([^"'>]+)/i)?.[1].toLowerCase() ?? ''
      if (rel.includes('stylesheet')) return 'style'
      if (rel.includes('icon')) return 'image'
      if (/preconnect|dns-prefetch/.test(rel)) return 'other'
      const as = tagText.match(/\bas\s*=\s*["']?(\w+)/i)?.[1].toLowerCase()
      if (as === 'font' || as === 'script' || as === 'style' || as === 'image') return as
      return null
    }
    default:
      return null
  }
}

/** 找出文本里的全部 http(s) 地址 */
export function findUrls(text: string): FoundUrl[] {
  if (!text || !/https?:\/\//i.test(text)) return []
  const out: FoundUrl[] = []
  for (const m of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(m[0])
    const host = urlHost(url)
    if (!host || IGNORED_HOSTS.test(host)) continue
    const index = m.index ?? 0
    const before = text.slice(Math.max(0, index - 300), index)
    const after = text.slice(index + m[0].length, index + m[0].length + 300)
    const kind = kindFromContext(before, after, url, host) ?? kindFromUrl(url, host) ?? 'other'
    out.push({ url, host, kind })
  }
  return out
}

export interface JsdelivrRef {
  host: string
  /** gh：GitHub 仓库；npm：npm 包 */
  source: 'gh' | 'npm'
  /** 仓库（用户/仓库）或包名 */
  name: string
  /** @ 后面的版本；没写时为 null */
  version: string | null
  /** 写死了具体版本（x.y.z 或提交哈希） */
  pinned: boolean
  /** 包里的文件路径；只写到包或仓库时为空 */
  file: string
}

const PINNED_VERSION = /^(?:v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?|[0-9a-f]{7,40})$/i

/** 解析 jsDelivr 的 /gh/ 和 /npm/ 地址；其他地址返回 null */
export function parseJsdelivr(url: string): JsdelivrRef | null {
  const m = url.match(/^https?:\/\/([a-z0-9-]+\.jsdelivr\.net)\/(gh|npm)\/(.+)$/i)
  if (!m) return null
  const source = m[2].toLowerCase() as 'gh' | 'npm'
  const pkg = source === 'gh' ? m[3].match(/^([^/@]+\/[^/@]+)(?:@([^/]*))?/) : m[3].match(/^((?:@[^/@]+\/)?[^/@]+)(?:@([^/]*))?/)
  if (!pkg) return null
  const version = pkg[2] ?? null
  const file = m[3].slice(pkg[0].length).replace(/^\/+/, '')
  return { host: m[1].toLowerCase(), source, name: pkg[1], version, pinned: version !== null && PINNED_VERSION.test(version), file }
}
