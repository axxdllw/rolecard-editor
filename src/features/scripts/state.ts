/**
 * 脚本编辑区与卡片文档之间的桥：订阅酒馆助手相关的扩展字段，修改都走 updateCard（可撤销）。
 */
import { useMemo } from 'react'
import type { JsonObject } from '@/core/card/types'
import {
  HELPER_KEY,
  LEGACY_SCRIPTS_KEY,
  LEGACY_VARIABLES_KEY,
  readHelper,
  updateScript,
  type HelperNode,
  type HelperView,
  type NodePos,
  type ScriptPatch,
} from '@/core/tavern-helper/scripts'
import { updateCard, useCardDoc } from '@/features/editor/cardDoc'
import type { CardDoc } from '@/features/editor/cardDoc'

function extOf(s: { doc: CardDoc | null }): JsonObject | undefined {
  return s.doc?.card.data.extensions as JsonObject | undefined
}

/** 当前卡的脚本视图；只在酒馆助手相关字段变化时重新计算 */
export function useHelperView(): HelperView {
  const th = useCardDoc((s) => extOf(s)?.[HELPER_KEY])
  const scripts = useCardDoc((s) => extOf(s)?.[LEGACY_SCRIPTS_KEY])
  const variables = useCardDoc((s) => extOf(s)?.[LEGACY_VARIABLES_KEY])
  return useMemo(
    () => readHelper({ [HELPER_KEY]: th, [LEGACY_SCRIPTS_KEY]: scripts, [LEGACY_VARIABLES_KEY]: variables }),
    [th, scripts, variables],
  )
}

/** 在卡片的 extensions 上修改 */
export function editHelper(recipe: (ext: JsonObject) => void, label: string, key?: string) {
  updateCard(
    (d) => {
      if (!d.card.data.extensions) d.card.data.extensions = {}
      recipe(d.card.data.extensions as JsonObject)
    },
    { label, key },
  )
}

export function findByKey(nodes: HelperNode[], key: string | null): HelperNode | undefined {
  if (key === null) return undefined
  for (const node of nodes) {
    if (node.key === key) return node
    if (node.type === 'folder') {
      const child = node.scripts.find((s) => s.key === key)
      if (child) return child
    }
  }
  return undefined
}

/** 按 key 找节点当前的位置（拖动排序后位置会变，回调里不能缓存位置） */
export function currentPos(key: string): NodePos | undefined {
  const ext = extOf(useCardDoc.getState())
  return ext ? findByKey(readHelper(ext).nodes, key)?.pos : undefined
}

/** 当前卡里某个位置的节点 key（新建后用来选中） */
export function keyAt(pos: NodePos | null): string | null {
  const ext = extOf(useCardDoc.getState())
  if (!pos || !ext) return null
  const node = readHelper(ext).nodes[pos.index]
  if (pos.child === undefined) return node?.key ?? null
  return node?.type === 'folder' ? (node.scripts[pos.child]?.key ?? null) : null
}

/** 改某个脚本的字段；mergeKey 相同的连续修改合并成一步撤销 */
export function editScript(key: string, patch: ScriptPatch, label: string, mergeKey?: string) {
  const pos = currentPos(key)
  if (pos) editHelper((ext) => updateScript(ext, pos, patch), label, mergeKey)
}

/** 字数显示：一万以上用“万” */
export function formatChars(n: number): string {
  return n < 10000 ? `${n} 字` : `${(n / 10000).toFixed(1)} 万字`
}
