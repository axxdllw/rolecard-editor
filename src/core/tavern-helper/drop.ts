/**
 * 脚本树拖动排序：树按显示顺序摊平成一列（展开的文件夹后面跟着它的脚本），
 * 拖完后看被拖项的新邻居，算出它在树里的新位置。
 *
 * 规则：
 * - 文件夹只能在顶层，落在别的文件夹内部时放到那个文件夹后面；
 * - 脚本紧跟在展开的文件夹或文件夹里的脚本后面时，进入那个文件夹；否则放在顶层。
 */
import type { HelperNode, InsertTarget, NodePos } from './scripts'

export interface FlatRow {
  key: string
  type: 'script' | 'folder'
  pos: NodePos
  /** 文件夹是否展开 */
  expanded?: boolean
}

/** 按显示顺序摊平；collapsed 里的文件夹不显示子项，hideChildrenOf 用于拖动文件夹时隐藏它的子项 */
export function flattenTree(nodes: HelperNode[], collapsed: ReadonlySet<string>, hideChildrenOf?: string | null): FlatRow[] {
  const rows: FlatRow[] = []
  for (const node of nodes) {
    if (node.type === 'script') {
      rows.push({ key: node.key, type: 'script', pos: node.pos })
      continue
    }
    const expanded = !collapsed.has(node.key) && node.key !== hideChildrenOf
    rows.push({ key: node.key, type: 'folder', pos: node.pos, expanded })
    if (expanded) for (const s of node.scripts) rows.push({ key: s.key, type: 'script', pos: s.pos })
  }
  return rows
}

function arrayMove<T>(list: T[], from: number, to: number): T[] {
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/** 把第 from 行拖到第 to 行之后，返回 moveNode 需要的参数（to 是删掉原节点之后的位置） */
export function computeDrop(rows: FlatRow[], from: number, to: number): { from: NodePos; to: InsertTarget } | null {
  if (from === to || !rows[from] || !rows[to]) return null
  const moved = arrayMove(rows, from, to)
  const item = moved[to]
  /** end 之前（不含被拖项）有多少个顶层项 */
  const topBefore = (end: number) => moved.slice(0, end).filter((r) => r !== item && r.pos.child === undefined).length

  const above = moved[to - 1]
  if (item.type === 'script' && above) {
    if (above.type === 'folder' && above.expanded) {
      return { from: item.pos, to: { folder: topBefore(to - 1), index: 0 } }
    }
    if (above.pos.child !== undefined) {
      let folderRow = to - 1
      while (folderRow >= 0 && moved[folderRow].pos.child !== undefined) folderRow--
      return { from: item.pos, to: { folder: topBefore(folderRow), index: to - 1 - folderRow } }
    }
  }
  return { from: item.pos, to: { index: topBefore(to) } }
}
