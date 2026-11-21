/**
 * MVU 的初始变量：世界书里注释带 [initvar] 的条目（通常是禁用状态），内容是 YAML 或 JSON。
 * 多个条目按顺序深度合并，作为预览里 stat_data 的默认值。
 */
import { parse } from 'yaml'
import type { Lorebook } from '../card/types'

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type JsonRecord = { [key: string]: JsonValue }

export interface InitVarResult {
  data: JsonRecord
  /** 参与合并的条目名 */
  sources: string[]
  errors: string[]
}

function isRecord(v: unknown): v is JsonRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMerge(target: JsonRecord, source: JsonRecord): JsonRecord {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key]
    target[key] = isRecord(current) && isRecord(value) ? deepMerge({ ...current }, value) : value
  }
  return target
}

export function initVariablesFromBook(book: Lorebook | undefined): InitVarResult {
  const result: InitVarResult = { data: {}, sources: [], errors: [] }
  for (const entry of book?.entries ?? []) {
    const title = typeof entry.comment === 'string' ? entry.comment : ''
    if (!/\[initvar\]/i.test(title)) continue
    const content = typeof entry.content === 'string' ? entry.content : ''
    if (!content.trim()) continue
    try {
      const parsed: unknown = parse(content)
      if (!isRecord(parsed)) {
        result.errors.push(`「${title}」的内容不是键值结构`)
        continue
      }
      deepMerge(result.data, parsed)
      result.sources.push(title)
    } catch (error) {
      result.errors.push(`「${title}」解析失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }
  return result
}
