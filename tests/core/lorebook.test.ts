import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCardPng } from '../../src/core/card/io'
import { createWrapperEntries } from '../../src/core/card/create'
import type { Lorebook } from '../../src/core/card/types'
import { assemblePrompt, entryMatchesText } from '../../src/core/lorebook/assemble'
import { createEntry, getPosition, nextEntryId, setPosition, setStrategy, getStrategy } from '../../src/core/lorebook/entry'
import { lintLorebook } from '../../src/core/lorebook/lint'
import { lorebookToWorld, parseLorebookJson, worldToLorebook } from '../../src/core/lorebook/world'

const sample = parseCardPng(new Uint8Array(readFileSync(resolve(import.meta.dirname, '../../samples/弗洛洛2.png'))))
const book = sample.card.data.character_book as Lorebook
const macros = { char: '弗洛洛', user: '漂泊者' }
const byComment = (comment: string) => book.entries.findIndex((e) => e.comment === comment)

describe('条目读写', () => {
  it('改位置时同步规范里的 position 字符串', () => {
    const e = createEntry([])
    setPosition(e, 4)
    expect(getPosition(e)).toBe(4)
    expect(e.position).toBe('after_char')
    setPosition(e, 0)
    expect(e.position).toBe('before_char')
  })

  it('策略切换', () => {
    const e = createEntry([])
    setStrategy(e, 'constant')
    expect(getStrategy(e)).toBe('constant')
    setStrategy(e, 'vectorized')
    expect(getStrategy(e)).toBe('vectorized')
    setStrategy(e, 'keyword')
    expect(getStrategy(e)).toBe('keyword')
  })

  it('新条目 id 接在最大 id 后面', () => {
    expect(nextEntryId(book.entries)).toBe(121)
  })
})

describe('ST 世界书格式转换', () => {
  it('内嵌世界书 → ST 世界书 → 内嵌世界书，关键字段不变', () => {
    const world = lorebookToWorld(book)
    expect(Object.keys(world.entries)).toHaveLength(121)
    const back = worldToLorebook(JSON.parse(JSON.stringify(world)), book.name)
    expect(back.entries).toHaveLength(121)
    back.entries.forEach((entry, i) => {
      const orig = book.entries.find((e) => e.id === entry.id)!
      expect(entry.keys, `条目 ${i}`).toEqual(orig.keys)
      expect(entry.content).toBe(orig.content)
      expect(entry.constant).toBe(orig.constant)
      expect(entry.enabled).toBe(orig.enabled)
      expect(entry.insertion_order).toBe(orig.insertion_order)
      expect(entry.extensions.position).toBe(orig.extensions.position)
      expect(entry.extensions.depth).toBe(orig.extensions.depth)
      expect(entry.extensions.prevent_recursion).toBe(orig.extensions.prevent_recursion)
    })
  })

  it('识别三种来源格式', () => {
    expect(parseLorebookJson(JSON.stringify(lorebookToWorld(book))).format).toBe('st-world')
    expect(parseLorebookJson(JSON.stringify(book)).format).toBe('character-book')
    const fromCard = parseLorebookJson(JSON.stringify(sample.card))
    expect(fromCard.format).toBe('card')
    expect(fromCard.book.entries).toHaveLength(121)
  })
})

describe('提示词组装预览', () => {
  it('只看常驻时，角色定义前按顺序排列，包裹标签在首尾', () => {
    const sections = assemblePrompt(sample.card, { mode: 'constant', macros })
    const before = sections.find((s) => s.id === 'wi-before')!
    expect(before.blocks.map((b) => b.content)).toEqual([
      '<Glossary>',
      '</Glossary>',
      expect.stringContaining('漂泊者'),
      '<secondary character>',
      '</secondary character>',
    ])
    const chat = sections.find((s) => s.id === 'chat')!
    const titles = chat.blocks.map((b) => b.title)
    expect(titles[0]).toBe('深度 4 · system')
    expect(chat.blocks[1].content).toBe('<弗洛洛>')
    expect(titles).toContain('深度 1 · system')
  })

  it('关键词匹配：提到“秧秧”时触发秧秧条目', () => {
    const sections = assemblePrompt(sample.card, { mode: 'match', chatText: '今天遇到了秧秧', macros })
    const before = sections.find((s) => s.id === 'wi-before')!
    expect(before.blocks.some((b) => b.title === '秧秧' && b.kind === 'triggered')).toBe(true)
  })

  it('次要关键词逻辑：广场 + 拉古那', () => {
    const plaza = book.entries[byComment('广场区')]
    expect(entryMatchesText(plaza, '去广场', macros)).toBe(false)
    expect(entryMatchesText(plaza, '去拉古那的广场', macros)).toBe(true)
  })
})

describe('自动检查', () => {
  const issues = lintLorebook(book)

  it('发现放错位置的条目（菲比、泰缇斯系统）', () => {
    const misplaced = issues.filter((i) => i.code === 'wrapper-misplaced')
    const flagged = misplaced.map((i) => book.entries[i.entryIndexes[0]].comment)
    expect(flagged).toEqual(expect.arrayContaining(['菲比', '泰缇斯系统']))
    expect(flagged).not.toContain('弗洛洛行为模式刻画')
  })

  it('发现主次关键词完全相同的条目（广场区与自由广场）', () => {
    const same = issues.filter((i) => i.code === 'same-trigger')
    expect(same.some((i) => i.entryIndexes.includes(byComment('广场区')) && i.entryIndexes.includes(byComment('自由广场')))).toBe(true)
  })

  it('发现一词多触发和过短关键词', () => {
    expect(issues.some((i) => i.code === 'duplicate-key' && i.message.includes('广场'))).toBe(true)
    expect(issues.some((i) => i.code === 'short-key' && i.message.includes('椿'))).toBe(true)
  })

  it('包裹标签都成对，没有误报', () => {
    expect(issues.filter((i) => i.code === 'wrapper-unclosed')).toEqual([])
  })

  it('常驻超预算', () => {
    const over = lintLorebook(book, { constantTokenBudget: 100, tokenCount: (t) => t.length })
    expect(over.some((i) => i.code === 'constant-budget')).toBe(true)
  })

  it('包裹标签助手生成的条目能通过检查', () => {
    const [open, close] = createWrapperEntries([], 'world', { position: 0 })
    const inner = createEntry([open, close], { constant: true, content: 'x', order: 100 })
    const result = lintLorebook({ entries: [open, inner, close], extensions: {} })
    expect(result.filter((i) => i.code.startsWith('wrapper'))).toEqual([])
  })
})
