/**
 * CharX（V3 规范的 zip 格式）读取：card.json + assets。
 * 目前只取出卡片数据和主头像；其他附加资源导出 PNG 时不会保留，会给出提示。
 */
import { strFromU8, unzipSync } from 'fflate'
import { CardParseError, parseCardJson, type ParsedCard } from './io'

export interface ParsedCharx extends ParsedCard {
  /** 主头像的原始字节（可能是 PNG/JPG/WebP，界面层负责转成 PNG） */
  avatar?: { bytes: Uint8Array; ext: string }
}

function resolveAsset(files: Record<string, Uint8Array>, uri: string): Uint8Array | undefined {
  const m = uri.match(/^embed+ed:\/\/(.+)$/i)
  if (!m) return undefined
  const path = m[1].replace(/^\/+/, '')
  return files[path]
}

export function parseCharx(bytes: Uint8Array): ParsedCharx {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch (error) {
    throw new CardParseError(`CharX 解压失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const cardPath = Object.keys(files).find((p) => p === 'card.json' || p.endsWith('/card.json'))
  if (!cardPath) {
    throw new CardParseError('CharX 里没有 card.json')
  }
  const parsed: ParsedCharx = parseCardJson(strFromU8(files[cardPath]))

  const assets = Array.isArray(parsed.card.data.assets) ? parsed.card.data.assets : []
  const icon = assets.find((a) => a.type === 'icon' && a.name === 'main') ?? assets.find((a) => a.type === 'icon')
  if (icon) {
    const data = resolveAsset(files, icon.uri)
    if (data) parsed.avatar = { bytes: data, ext: (icon.ext || 'png').toLowerCase() }
  }

  const embedded = assets.filter((a) => /^embed+ed:\/\//i.test(a.uri) && a !== icon).length
  if (embedded > 0) {
    parsed.warnings.push(`CharX 里有 ${embedded} 个附加资源（表情、背景等），导出为 PNG 时不会包含它们`)
  }
  return parsed
}
