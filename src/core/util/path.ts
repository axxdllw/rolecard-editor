/** 按路径读写嵌套对象 */
export type Path = ReadonlyArray<string | number>

export function getPath(root: unknown, path: Path): unknown {
  let cur: unknown = root
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string | number, unknown>)[key]
  }
  return cur
}

/** 写入路径上的值，中间缺失的对象会自动创建 */
export function setPath(root: object, path: Path, value: unknown): void {
  let cur = root as Record<string | number, unknown>
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]
    const next = cur[key]
    if (next === null || typeof next !== 'object') {
      cur[key] = typeof path[i + 1] === 'number' ? [] : {}
    }
    cur = cur[key] as Record<string | number, unknown>
  }
  cur[path[path.length - 1]] = value
}
