import { describe, expect, it } from 'vitest'
import { createEmptyCard } from '../../src/core/card/create'
import type { LorebookEntry } from '../../src/core/card/types'
import { createEntry, getDisplayIndex } from '../../src/core/lorebook/entry'
import { makeCardDoc, updateCardBook, useCardDoc } from '../../src/features/editor/cardDoc'
import { createDocStore } from '../../src/features/editor/docStore'
import { appendEntries, duplicateEntry, removeEntries, reorderDisplay } from '../../src/features/worldbook/ops'

describe('撤销/重做', () => {
  it('同一字段的连续修改合并成一步，撤销后完全还原', () => {
    const store = createDocStore<{ text: string; other: number }>()
    store.getState().load({ text: '', other: 0 })
    store.getState().update((d) => void (d.text = 'a'), { key: 'text', label: '打字' })
    store.getState().update((d) => void (d.text = 'ab'), { key: 'text', label: '打字' })
    store.getState().update((d) => void (d.text = 'abc'), { key: 'text', label: '打字' })
    expect(store.getState().past).toHaveLength(1)

    store.getState().update((d) => void (d.other = 1), { key: 'other' })
    expect(store.getState().past).toHaveLength(2)

    expect(store.getState().undo()).toBeNull()
    expect(store.getState().doc).toEqual({ text: 'abc', other: 0 })
    expect(store.getState().undo()).toBe('打字')
    expect(store.getState().doc).toEqual({ text: '', other: 0 })
    store.getState().redo()
    expect(store.getState().doc).toEqual({ text: 'abc', other: 0 })
  })

  it('没有变化的修改不记入历史；新修改清空重做栈', () => {
    const store = createDocStore<{ n: number }>()
    store.getState().load({ n: 1 })
    store.getState().update((d) => void (d.n = 1))
    expect(store.getState().past).toHaveLength(0)
    store.getState().update((d) => void (d.n = 2))
    store.getState().undo()
    expect(store.getState().future).toHaveLength(1)
    store.getState().update((d) => void (d.n = 3))
    expect(store.getState().future).toHaveLength(0)
  })

  it('卡片文档：改 data 后顶层镜像字段自动同步，撤销一起还原', () => {
    useCardDoc.getState().load(makeCardDoc(createEmptyCard('甲')))
    useCardDoc.getState().update((d) => void (d.card.data.name = '乙'))
    expect(useCardDoc.getState().doc!.card.name).toBe('乙')
    useCardDoc.getState().undo()
    expect(useCardDoc.getState().doc!.card.name).toBe('甲')
  })

  it('卡里没有世界书时，新建条目会自动创建世界书，keys 与条目对齐', () => {
    useCardDoc.getState().load(makeCardDoc(createEmptyCard('甲')))
    updateCardBook((d) => void appendEntries(d, [createEntry([], { comment: 'x' })]))
    const doc = useCardDoc.getState().doc!
    expect(doc.card.data.character_book?.entries).toHaveLength(1)
    expect(doc.entryKeys).toHaveLength(1)
  })
})

describe('世界书草稿操作', () => {
  const make = () => {
    const entries: LorebookEntry[] = []
    for (let i = 0; i < 3; i++) entries.push(createEntry(entries, { comment: `e${i}` }))
    return { book: { entries, extensions: {} }, keys: ['k0', 'k1', 'k2'] }
  }

  it('追加条目会换新 id，keys 同步增加', () => {
    const d = make()
    const added = appendEntries(d, [d.book.entries[0]])
    expect(d.book.entries).toHaveLength(4)
    expect(d.keys).toHaveLength(4)
    expect(d.keys[3]).toBe(added[0])
    expect(d.book.entries[3].id).toBe(3)
    expect(d.book.entries[3]).not.toBe(d.book.entries[0])
  })

  it('删除和复制保持 keys 对齐', () => {
    const d = make()
    removeEntries(d, ['k1'])
    expect(d.keys).toEqual(['k0', 'k2'])
    expect(d.book.entries.map((e) => e.comment)).toEqual(['e0', 'e2'])
    const newKey = duplicateEntry(d, 'k0')
    expect(d.keys[1]).toBe(newKey)
    expect(d.book.entries[1].comment).toBe('e0（副本）')
  })

  it('拖拽排序只改显示顺序，不改数组顺序', () => {
    const d = make()
    reorderDisplay(d, ['k2', 'k0', 'k1'])
    expect(d.book.entries.map((e) => e.comment)).toEqual(['e0', 'e1', 'e2'])
    expect(d.book.entries.map((e, i) => getDisplayIndex(e, i))).toEqual([1, 2, 0])
  })
})
