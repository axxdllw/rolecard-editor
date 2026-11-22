/**
 * 轻量 XML/路径解析辅助函数（不依赖 DOMParser，供 epub / fb2 / docx 共用）。
 */
import { decodeEntities } from './html'

const ATTR_RE = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/** 解析标签属性串，返回键（同时保留原名和去命名空间前缀的小写名）到已解码值的映射 */
export function parseXmlAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ATTR_RE.exec(attrStr)) !== null) {
    const rawKey = match[1]
    const value = decodeEntities(match[2] ?? match[3] ?? '')
    attrs[rawKey] = value
    const lower = rawKey.toLowerCase()
    if (!(lower in attrs)) attrs[lower] = value
    const colon = lower.lastIndexOf(':')
    if (colon >= 0) {
      const local = lower.slice(colon + 1)
      if (!(local in attrs)) attrs[local] = value
    }
  }
  return attrs
}

/** 安全 URL 解码：遇到非法百分号序列时不抛错 */
export function safeDecodeUri(value: string): string {
  if (!value.includes('%')) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 分离 href 的路径部分和 #fragment 部分 */
export function splitHref(href: string): { path: string; fragment?: string } {
  const trimmed = href.trim()
  const hashIdx = trimmed.indexOf('#')
  let pathPart = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed
  const fragment = hashIdx >= 0 ? safeDecodeUri(trimmed.slice(hashIdx + 1)) : undefined

  const queryIdx = pathPart.indexOf('?')
  if (queryIdx >= 0) pathPart = pathPart.slice(0, queryIdx)

  return { path: pathPart, fragment: fragment || undefined }
}

/** 规范化压缩包内部路径（处理 `..`、`.`、反斜杠、多余斜杠） */
export function normalizeZipPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  const stack: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      stack.pop()
    } else {
      stack.push(part)
    }
  }
  return stack.join('/')
}

/** 相对 baseDir 解析 href（带 URL 解码与 `../` 归一化） */
export function resolveRelativePath(baseDir: string, href: string): string {
  const decoded = safeDecodeUri(href.replace(/\\/g, '/'))
  if (decoded.startsWith('/')) {
    return normalizeZipPath(decoded.slice(1))
  }
  const combined = baseDir ? `${baseDir}/${decoded}` : decoded
  return normalizeZipPath(combined)
}

/** 获取路径所在目录（不含尾随斜杠，根目录返回空串） */
export function dirnameOf(path: string): string {
  const normalized = normalizeZipPath(path)
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(0, idx) : ''
}

/** 转义正则特殊字符 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
