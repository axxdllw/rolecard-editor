/**
 * 按当前变量里的数值字段生成一段示例更新命令（MVU 的 <UpdateVariable><JSONPatch> 格式），方便在预览里快速试。
 */
import { jsonPointer } from './diff'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 数值字段的路径（深度优先，按出现顺序）。跳过 $、_ 开头的键：MVU 用它们存元数据，变量结构也不处理 _ 开头的路径 */
export function numericFields(stat: unknown, limit = Infinity): string[][] {
  const result: string[][] = []
  const walk = (value: unknown, path: string[]) => {
    if (result.length >= limit) return
    if (typeof value === 'number' && Number.isFinite(value)) {
      result.push(path)
      return
    }
    if (Array.isArray(value)) {
      // MVU 的 [值, 描述]：改第 0 项
      if (value.length === 2 && typeof value[1] === 'string' && typeof value[0] === 'number') result.push([...path, '0'])
      return
    }
    if (!isPlainObject(value)) return
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith('$') || key.startsWith('_')) continue
      walk(child, [...path, key])
      if (result.length >= limit) return
    }
  }
  walk(stat, [])
  return result
}

/** 生成示例：对前几个数值字段各加 delta；没有数值字段时返回 null */
export function buildSampleUpdate(stat: unknown, { limit = 3, delta = 1 }: { limit?: number; delta?: number } = {}): string | null {
  const fields = numericFields(stat, limit)
  if (!fields.length) return null
  const ops = fields.map((path) => `  ${JSON.stringify({ op: 'delta', path: jsonPointer(path), value: delta })}`)
  return ['<UpdateVariable>', '<JSONPatch>', '[', ops.join(',\n'), ']', '</JSONPatch>', '</UpdateVariable>'].join('\n')
}
