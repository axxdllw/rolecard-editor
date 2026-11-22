/**
 * MVU 变量（stat_data）的差异：按路径列出新增、删除和改动的字段。
 */

export type ChangeKind = 'added' | 'removed' | 'changed'

export interface VarChange {
  /** 字段路径（对象键或数组下标，都用字符串） */
  path: string[]
  kind: ChangeKind
  before?: unknown
  after?: unknown
  /** 改动前后的值类型不同（如文本 "10" 变成数字 10） */
  typeChanged?: boolean
}

export interface DiffOptions {
  /** 忽略的顶层键，如 MVU 更新过程中临时放进 stat_data 的 $internal */
  ignoreTopKeys?: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 值的类型名：区分数组、null 和对象 */
export function valueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** 深比较两个 JSON 值 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]))
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
  }
  return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)
}

/**
 * 比较两份变量，返回叶子级的改动。
 * 对象逐键比较；长度相同的数组逐项比较（MVU 的 [值, 描述] 会显示成 …/0 的改动），长度不同的数组整体算一次改动。
 */
export function diffVariables(before: unknown, after: unknown, options: DiffOptions = {}): VarChange[] {
  const changes: VarChange[] = []
  const ignore = new Set(options.ignoreTopKeys ?? [])
  const walk = (a: unknown, b: unknown, path: string[]) => {
    if (isPlainObject(a) && isPlainObject(b)) {
      const keys = [...Object.keys(a), ...Object.keys(b).filter((k) => !Object.hasOwn(a, k))]
      for (const key of keys) {
        if (path.length === 0 && ignore.has(key)) continue
        const next = [...path, key]
        if (!Object.hasOwn(b, key)) changes.push({ path: next, kind: 'removed', before: a[key] })
        else if (!Object.hasOwn(a, key)) changes.push({ path: next, kind: 'added', after: b[key] })
        else walk(a[key], b[key], next)
      }
      return
    }
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      a.forEach((item, i) => walk(item, b[i], [...path, String(i)]))
      return
    }
    if (jsonEqual(a, b)) return
    if (a === undefined) changes.push({ path, kind: 'added', after: b })
    else if (b === undefined) changes.push({ path, kind: 'removed', before: a })
    else changes.push({ path, kind: 'changed', before: a, after: b, ...(valueType(a) !== valueType(b) ? { typeChanged: true } : {}) })
  }
  walk(before, after, [])
  return changes
}

/** 路径写成 JSON Pointer（与 JSONPatch 的 path 一致），如 /主角/修为/当前 */
export function jsonPointer(path: readonly string[]): string {
  return path.map((s) => `/${s.replace(/~/g, '~0').replace(/\//g, '~1')}`).join('')
}

/** 值的单行预览：JSON 文本，过长时截断 */
export function previewValue(value: unknown, max = 120): string {
  if (value === undefined) return '（无）'
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 按路径取值（路径段是对象键或数组下标） */
export function getAtPath(root: unknown, path: readonly string[]): unknown {
  let current = root
  for (const segment of path) {
    if (Array.isArray(current)) current = current[Number(segment)]
    else if (isPlainObject(current)) current = Object.hasOwn(current, segment) ? current[segment] : undefined
    else return undefined
  }
  return current
}
