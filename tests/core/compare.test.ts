import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { compareCards, isRestorable, restoreChange } from '../../src/core/card/compare'
import { createEmptyCard } from '../../src/core/card/create'
import type { CharacterCardV3 } from '../../src/core/card/types'
import { createEntry, createLorebook } from '../../src/core/lorebook/entry'

function baseCard(): CharacterCardV3 {
  const card = createEmptyCard('艾琳')
  card.data.description = '第一行\n第二行'
  card.data.alternate_greetings = ['你好', '早上好']
  const book = createLorebook('设定')
  book.entries.push(createEntry(book.entries, { comment: '城堡', keys: ['城堡'], content: '古老的城堡' }))
  book.entries.push(createEntry(book.entries, { comment: '森林', keys: ['森林'], content: '幽暗的森林' }))
  card.data.character_book = book
  card.data.extensions = {
    ...card.data.extensions,
    regex_scripts: [
      { id: 'r1', scriptName: '隐藏思考', findRegex: '/<think>.*?<\\/think>/s', replaceString: '' },
      { id: 'r2', scriptName: '状态栏', findRegex: '/<status>/', replaceString: '<div>' },
    ],
    unknown_plugin: { a: 1 },
  }
  // ST 导出的卡顶层带 V1 镜像字段
  card.name = card.data.name
  card.description = card.data.description
  return card
}

describe('与原件对比', () => {
  it('没改动时没有差异', () => {
    const card = baseCard()
    expect(compareCards(card, structuredClone(card))).toEqual([])
  })

  it('字段改动带显示名和前后值；顶层镜像字段不重复列出', () => {
    const original = baseCard()
    const current = produce(original, (d) => {
      d.data.description = '第一行\n改过的第二行'
      d.description = d.data.description
      d.data.alternate_greetings[1] = '晚上好'
    })
    const changes = compareCards(original, current)
    expect(changes.map((c) => [c.kind, c.label, c.group])).toEqual([
      ['changed', '角色描述', '角色字段'],
      ['changed', '备选开场白 2', '开场白'],
    ])
    expect(changes[0]).toMatchObject({ path: ['data', 'description'], before: '第一行\n第二行', after: '第一行\n改过的第二行' })
  })

  it('世界书条目按 id 配对：删掉前面的条目，后面条目的改动仍然对得上', () => {
    const original = baseCard()
    const current = produce(original, (d) => {
      d.data.character_book!.entries.splice(0, 1)
      d.data.character_book!.entries[0].content = '明亮的森林'
      d.data.character_book!.entries[0].keys.push('树林')
    })
    const changes = compareCards(original, current)
    expect(changes.map((c) => [c.kind, c.label])).toEqual([
      ['removed', '世界书 · 城堡'],
      ['changed', '世界书 · 森林 · 关键词'],
      ['changed', '世界书 · 森林 · 内容'],
    ])
    const content = changes[2]
    expect(content.path).toEqual(['data', 'character_book', 'entries', 0, 'content'])
    expect(content.originalPath).toEqual(['data', 'character_book', 'entries', 1, 'content'])
    // 关键词数组整体算一处
    expect(changes[1]).toMatchObject({ before: ['森林'], after: ['森林', '树林'] })
  })

  it('正则顺序变化和新增条目单独列出，不能单独还原', () => {
    const original = baseCard()
    const current = produce(original, (d) => {
      const scripts = d.data.extensions.regex_scripts as Array<{ id: string; scriptName: string }>
      scripts.reverse()
      scripts.push({ id: 'r3', scriptName: '新正则' })
    })
    const changes = compareCards(original, current)
    expect(changes.map((c) => [c.kind, c.label])).toEqual([
      ['added', '正则 · 新正则'],
      ['reordered', '正则 · 执行顺序'],
    ])
    expect(changes[1]).toMatchObject({ before: ['隐藏思考', '状态栏'], after: ['状态栏', '隐藏思考'] })
    expect(changes.some(isRestorable)).toBe(false)
  })

  it('未知扩展字段和顶层字段的增删也能看到', () => {
    const original = baseCard()
    const current = produce(original, (d) => {
      delete (d.data.extensions as Record<string, unknown>).unknown_plugin
      d.extra_top = true
    })
    expect(compareCards(original, current).map((c) => [c.kind, c.label, c.group])).toEqual([
      ['removed', '扩展数据 · unknown_plugin', '扩展数据'],
      ['added', '顶层字段 · extra_top', '其他'],
    ])
  })

  it('单独还原一处改动，其他改动保留', () => {
    const original = baseCard()
    const current = produce(original, (d) => {
      d.data.description = '新描述'
      d.data.character_book!.entries[1].content = '明亮的森林'
    })
    const [desc, entry] = compareCards(original, current)
    const restored = produce(current, (d) => void restoreChange(d, entry))
    expect(restored.data.character_book!.entries[1].content).toBe('幽暗的森林')
    expect(restored.data.description).toBe('新描述')
    expect(compareCards(original, restored)).toEqual([desc])
  })
})
