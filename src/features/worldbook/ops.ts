/**
 * 世界书草稿操作：所有改变条目数组结构的操作都在这里，保证 keys 与条目一一对应。
 */
import { current, isDraft, type Draft } from 'immer'
import type { LorebookEntry } from '@/core/card/types'
import { cloneEntry, getDisplayIndex, nextEntryId, setExt } from '@/core/lorebook/entry'
import { uuid } from '@/core/util/id'
import type { BookDraft } from '@/features/editor/cardDoc'

function plain<T>(value: T): T {
  return isDraft(value) ? (current(value as Draft<T>) as T) : value
}

/** 追加条目（会重新分配 id 和显示顺序，避免与现有条目冲突） */
export function appendEntries(d: BookDraft, entries: LorebookEntry[]): string[] {
  const added: string[] = []
  for (const source of entries) {
    const entry = cloneEntry(d.book.entries as LorebookEntry[], plain(source))
    d.book.entries.push(entry)
    const key = uuid()
    d.keys.push(key)
    added.push(key)
  }
  return added
}

/** 插入新建好的条目（保留传入的 id） */
export function insertEntry(d: BookDraft, entry: LorebookEntry): string {
  d.book.entries.push(entry)
  const key = uuid()
  d.keys.push(key)
  return key
}

export function removeEntries(d: BookDraft, keys: Iterable<string>) {
  const set = new Set(keys)
  for (let i = d.keys.length - 1; i >= 0; i--) {
    if (set.has(d.keys[i])) {
      d.book.entries.splice(i, 1)
      d.keys.splice(i, 1)
    }
  }
}

export function duplicateEntry(d: BookDraft, key: string): string | null {
  const index = d.keys.indexOf(key)
  if (index < 0) return null
  const copy = cloneEntry(d.book.entries as LorebookEntry[], plain(d.book.entries[index]) as LorebookEntry)
  if (typeof copy.comment === 'string' && copy.comment) copy.comment = `${copy.comment}（副本）`
  d.book.entries.splice(index + 1, 0, copy)
  const newKey = uuid()
  d.keys.splice(index + 1, 0, newKey)
  return newKey
}

/** 按 key 修改条目 */
export function editEntries(d: BookDraft, keys: Iterable<string>, edit: (entry: LorebookEntry) => void) {
  for (const key of keys) {
    const index = d.keys.indexOf(key)
    if (index >= 0) edit(d.book.entries[index] as LorebookEntry)
  }
}

/** 拖拽排序：按新的显示顺序重写 display_index，不改变数组顺序和插入顺序 */
export function reorderDisplay(d: BookDraft, orderedKeys: string[]) {
  orderedKeys.forEach((key, position) => {
    const index = d.keys.indexOf(key)
    if (index >= 0) {
      const entry = d.book.entries[index] as LorebookEntry
      if (getDisplayIndex(entry, index) !== position) setExt(entry, 'display_index', position)
    }
  })
}

/** 保证 keys 与条目数量一致（加载异常数据时兜底） */
export function alignKeys(entries: LorebookEntry[], keys: string[]): string[] {
  if (keys.length === entries.length) return keys
  return entries.map((_, i) => keys[i] ?? uuid())
}

export { nextEntryId }
