/**
 * 可撤销的文档状态：Zustand + Immer 补丁。
 * - 每次修改记录正反补丁，撤销/重做直接应用补丁。
 * - 同一个 key 的连续修改（如在同一字段里打字）1.5 秒内合并成一步。
 */
import { applyPatches, enablePatches, produceWithPatches, type Draft, type Patch } from 'immer'
import { create, type StoreApi, type UseBoundStore } from 'zustand'

enablePatches()

interface HistoryItem {
  patches: Patch[]
  inverse: Patch[]
  key?: string
  label?: string
  time: number
}

export interface UpdateOptions {
  /** 合并连续修改用的标识，例如字段路径 */
  key?: string
  /** 撤销提示里显示的操作名 */
  label?: string
}

export interface DocState<T> {
  doc: T | null
  past: HistoryItem[]
  future: HistoryItem[]
  /** 每次变化加一，自动保存据此判断 */
  version: number
  load: (doc: T) => void
  update: (recipe: (draft: Draft<T>) => void, options?: UpdateOptions) => void
  undo: () => string | null
  redo: () => string | null
}

const MERGE_WINDOW = 1500
const MAX_HISTORY = 300

function isPrefix(a: Patch['path'], b: Patch['path']): boolean {
  return a.length <= b.length && a.every((k, i) => k === b[i])
}

/**
 * 合并连续修改时压缩补丁：同一路径反复整值替换（例如在长文本里打字）只留最后一次的值。
 * 不压缩的话每次按键的整段文本都留在历史里，几十万字的脚本很快就占满内存。
 * 只处理最常见的情况：新补丁都是 replace、路径都在上一步里出现过、所有路径互不包含；
 * 这时上一步的反向补丁已经能还原这些路径，新的反向补丁可以丢掉。不满足时返回 null，按原样拼接。
 */
function compactPatches(prev: Patch[], next: Patch[]): Patch[] | null {
  if (!next.every((p) => p.op === 'replace')) return null
  // add 只接受对象键（数组下标是数字，插入会让后面的路径错位）
  if (!prev.every((p) => p.op === 'replace' || (p.op === 'add' && typeof p.path[p.path.length - 1] === 'string'))) return null
  const all = [...prev, ...next]
  for (const a of all) {
    for (const b of all) {
      if (a !== b && a.path.length !== b.path.length && isPrefix(a.path, b.path)) return null
    }
  }
  const result = [...prev]
  for (const p of next) {
    const i = result.findLastIndex((q) => q.path.length === p.path.length && isPrefix(q.path, p.path))
    if (i < 0) return null
    result[i] = { ...result[i], value: p.value }
  }
  return result
}

export type DocStore<T> = UseBoundStore<StoreApi<DocState<T>>>

export function createDocStore<T extends object>(postProcess?: (draft: Draft<T>) => void): DocStore<T> {
  return create<DocState<T>>((set, get) => ({
    doc: null,
    past: [],
    future: [],
    version: 0,

    load: (doc) => set({ doc, past: [], future: [], version: 0 }),

    update: (recipe, options = {}) => {
      const { doc, past, version } = get()
      if (!doc) return
      const [next, patches, inverse] = produceWithPatches(doc, (draft: Draft<T>) => {
        recipe(draft)
        postProcess?.(draft)
      })
      if (patches.length === 0) return

      const now = Date.now()
      const top = past[past.length - 1]
      let nextPast: HistoryItem[]
      if (options.key && top?.key === options.key && now - top.time < MERGE_WINDOW) {
        const compacted = compactPatches(top.patches, patches)
        nextPast = [
          ...past.slice(0, -1),
          compacted
            ? { ...top, patches: compacted, time: now }
            : { patches: [...top.patches, ...patches], inverse: [...inverse, ...top.inverse], key: top.key, label: top.label, time: now },
        ]
      } else {
        nextPast = [...past, { patches, inverse, key: options.key, label: options.label, time: now }].slice(-MAX_HISTORY)
      }
      set({ doc: next as T, past: nextPast, future: [], version: version + 1 })
    },

    undo: () => {
      const { doc, past, future, version } = get()
      const item = past[past.length - 1]
      if (!doc || !item) return null
      set({ doc: applyPatches(doc, item.inverse), past: past.slice(0, -1), future: [...future, item], version: version + 1 })
      return item.label ?? null
    },

    redo: () => {
      const { doc, past, future, version } = get()
      const item = future[future.length - 1]
      if (!doc || !item) return null
      set({ doc: applyPatches(doc, item.patches), past: [...past, item], future: future.slice(0, -1), version: version + 1 })
      return item.label ?? null
    },
  }))
}
