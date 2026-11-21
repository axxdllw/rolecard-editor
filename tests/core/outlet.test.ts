import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createEmptyCard, createWrapperEntries } from '../../src/core/card/create'
import { parseCardJson, parseCardPng, serializeCardJson, writeCardPng } from '../../src/core/card/io'
import type { CharacterCardV3, Lorebook, LorebookEntry } from '../../src/core/card/types'
import { assemblePrompt } from '../../src/core/lorebook/assemble'
import {
  collectOutletNames,
  createEntry,
  getOutletName,
  getPosition,
  POSITION,
  POSITION_OPTIONS,
  setOutletName,
  setPosition,
  type NewEntryInit,
} from '../../src/core/lorebook/entry'
import { lintLorebook } from '../../src/core/lorebook/lint'
import { lorebookToWorld, parseLorebookJson } from '../../src/core/lorebook/world'
import { findOutletRefs } from '../../src/core/macros'

const macros = { char: '弗洛洛', user: '漂泊者' }

function makeBook(inits: NewEntryInit[]): Lorebook {
  const entries: LorebookEntry[] = []
  for (const init of inits) entries.push(createEntry(entries, init))
  return { name: '锚点测试', entries, extensions: {} }
}

function outletBook(): Lorebook {
  return makeBook([
    { comment: '成就·初遇', content: '成就：初次相遇', constant: true, position: 7, outletName: 'achievements', order: 100 },
    { comment: '成就·挚友', content: '成就：成为挚友', constant: true, position: 7, outletName: 'achievements', order: 200 },
    { comment: '天气', content: '今天下雨', constant: true, position: 7, outletName: 'weather', order: 100 },
    { comment: '无名锚点', content: '不会出现', constant: true, position: 7, order: 100 },
    { comment: '普通', content: '角色定义前的内容', constant: true, position: 0 },
  ])
}

function outletCard(): CharacterCardV3 {
  const card = createEmptyCard('锚点测试')
  card.data.description = '角色描述'
  card.data.character_book = outletBook()
  return card
}

/** 按酒馆 1.16 世界书文件的格式手写的条目（字段对照 newWorldInfoEntryDefinition） */
function stEntry(uid: number, fields: Record<string, unknown>) {
  return {
    uid,
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: true,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: true,
    order: 100,
    position: 0,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: 4,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    triggers: [],
    displayIndex: uid,
    ...fields,
  }
}

describe('锚点条目读写', () => {
  it('位置选项里有锚点（7）', () => {
    expect(POSITION.OUTLET).toBe(7)
    expect(POSITION_OPTIONS.find((p) => p.value === 7)?.label).toContain('锚点')
  })

  it('改成锚点时规范 position 按 ST 导出规则写 after_char', () => {
    const e = createEntry([])
    setPosition(e, 7)
    expect(getPosition(e)).toBe(7)
    expect(e.position).toBe('after_char')
    setOutletName(e, '成就')
    expect(getOutletName(e)).toBe('成就')
    expect(e.extensions.outlet_name).toBe('成就')
  })

  it('新条目带 outlet_name 默认值，和 ST 导出的字段一致', () => {
    expect(createEntry([]).extensions.outlet_name).toBe('')
  })

  it('自动补全只收集位置是锚点、且有名字的条目', () => {
    const book = outletBook()
    setOutletName(book.entries[4], '不是锚点')
    expect(collectOutletNames(book.entries)).toEqual(['achievements', 'weather'])
  })
})

describe('锚点条目往返', () => {
  it('角色卡 JSON 原样往返', () => {
    const card = outletCard()
    const back = parseCardJson(serializeCardJson(card)).card
    expect(back.data.character_book).toStrictEqual(card.data.character_book)
  })

  it('角色卡 PNG 原样往返', () => {
    const sample = parseCardPng(new Uint8Array(readFileSync(resolve(import.meta.dirname, '../../samples/弗洛洛2.png'))))
    const card = outletCard()
    const back = parseCardPng(writeCardPng(sample.image, card)).card
    expect(back.data.character_book).toStrictEqual(card.data.character_book)
  })

  it('内嵌世界书 → ST 世界书：outlet_name 写到 outletName', () => {
    const world = lorebookToWorld(outletBook())
    const first = world.entries['0']
    expect(first.position).toBe(7)
    expect(first.outletName).toBe('achievements')
    expect(world.entries['3'].outletName).toBe('')
    expect(world.entries['4'].outletName).toBe('')
  })

  it('内嵌世界书 → ST 世界书 → 内嵌世界书，锚点字段不变', () => {
    const book = outletBook()
    const { book: back, format } = parseLorebookJson(JSON.stringify(lorebookToWorld(book)))
    expect(format).toBe('st-world')
    back.entries.forEach((entry, i) => {
      expect(entry.extensions.position).toBe(book.entries[i].extensions.position)
      expect(entry.extensions.outlet_name).toBe(book.entries[i].extensions.outlet_name)
      expect(entry.position).toBe(book.entries[i].position)
    })
  })

  it('导入酒馆 1.16 的世界书 JSON：outletName → extensions.outlet_name，再导出不变', () => {
    const stWorld = {
      entries: {
        0: stEntry(0, { comment: '成就', content: '成就：初次相遇', position: 7, outletName: 'achievements' }),
        1: stEntry(1, { comment: '普通', content: '普通内容', position: 1 }),
      },
    }
    const { book, format } = parseLorebookJson(JSON.stringify(stWorld))
    expect(format).toBe('st-world')
    expect(book.entries[0].extensions.outlet_name).toBe('achievements')
    expect(book.entries[0].extensions.position).toBe(7)
    expect(book.entries[0].position).toBe('after_char')
    expect(book.entries[1].extensions.outlet_name).toBe('')

    const again = lorebookToWorld(book)
    expect(again.entries['0'].outletName).toBe('achievements')
    expect(again.entries['0'].position).toBe(7)
  })

  it('世界书 JSON 只有 extensions.outlet_name、没有 outletName 时也不丢', () => {
    const world = { entries: { 0: { uid: 0, key: [], content: 'x', position: 7, extensions: { outlet_name: '旧字段' } } } }
    const { book } = parseLorebookJson(JSON.stringify(world))
    expect(book.entries[0].extensions.outlet_name).toBe('旧字段')
  })
})

describe('锚点宏', () => {
  it('识别 {{outlet::名}}：宏名不分大小写，名字去掉两端空白', () => {
    expect(findOutletRefs('{{outlet:: a }} {{OUTLET::b}} {{outlet::a}} {{outlet::}} {{char}}')).toEqual(['a', 'b'])
  })
})

describe('提示词组装预览中的锚点', () => {
  it('锚点条目不进固定位置，按锚点名单独列出，同一锚点里顺序大的在前，没名字的跳过', () => {
    const sections = assemblePrompt(outletCard(), { mode: 'constant', macros })
    const fixed = sections.filter((s) => s.id !== 'wi-outlet').flatMap((s) => s.blocks.map((b) => b.content))
    expect(fixed.join('\n')).not.toMatch(/成就|今天下雨|不会出现/)
    expect(sections.find((s) => s.id === 'wi-before')!.blocks.map((b) => b.content)).toEqual(['角色定义前的内容'])

    const outlet = sections.find((s) => s.id === 'wi-outlet')!
    expect(outlet.blocks.map((b) => (b.kind === 'note' ? b.title : b.content))).toEqual([
      '{{outlet::achievements}}',
      '成就：成为挚友',
      '成就：初次相遇',
      '{{outlet::weather}}',
      '今天下雨',
    ])
  })

  it('卡片字段里的 {{outlet::名}} 保留原文，并提示拿不到锚点内容', () => {
    const card = outletCard()
    card.data.description = '角色描述\n{{outlet::achievements}}'
    const char = assemblePrompt(card, { mode: 'constant', macros }).find((s) => s.id === 'char')!
    expect(char.blocks[0].content).toContain('{{outlet::achievements}}')
    expect(char.blocks[1].kind).toBe('note')
    expect(char.blocks[1].title).toContain('拿不到本轮的锚点内容')
  })

  it('没有锚点条目时不出现锚点分区', () => {
    const card = outletCard()
    card.data.character_book = makeBook([{ content: 'x', constant: true }])
    expect(assemblePrompt(card, { mode: 'constant', macros }).some((s) => s.id === 'wi-outlet')).toBe(false)
  })
})

describe('锚点的自动检查', () => {
  it('没填锚点名、名字首尾有空格、条目内容里引用锚点', () => {
    const book = makeBook([
      { comment: '无名', content: 'a', constant: true, position: 7 },
      { comment: '带空格', content: 'b', constant: true, position: 7, outletName: ' weather ' },
      { comment: '引用', content: '前文 {{outlet::weather}}', constant: true, position: 0 },
    ])
    const codes = (code: string) => lintLorebook(book).filter((i) => i.code === code).map((i) => i.entryIndexes)
    expect(codes('outlet-no-name')).toEqual([[0]])
    expect(codes('outlet-name-space')).toEqual([[1]])
    expect(codes('outlet-in-entry')).toEqual([[2]])
  })

  it('每个锚点提示一次要在预设里引用', () => {
    const usage = lintLorebook(outletBook()).filter((i) => i.code === 'outlet-usage')
    expect(usage.map((i) => [i.severity, i.entryIndexes])).toEqual([
      ['info', [0, 1]],
      ['info', [2]],
    ])
    expect(usage[0].message).toContain('{{outlet::achievements}}')
  })

  it('锚点里的包裹标签：开标签顺序大才算成对', () => {
    const wrap = (openOrder: number, closeOrder: number) => {
      const [open, close] = createWrapperEntries([], 'ach', { position: 7, outletName: 'a', openOrder, closeOrder })
      const inner = createEntry([open, close], { constant: true, content: 'x', order: 100, position: 7, outletName: 'a' })
      return lintLorebook({ entries: [open, inner, close], extensions: {} }).filter((i) => i.code.startsWith('wrapper'))
    }
    expect(wrap(999, 0)).toEqual([])
    expect(wrap(0, 999).map((i) => i.code)).toEqual(['wrapper-unclosed'])
  })

  it('不同锚点里的开收标签不会配成一对', () => {
    const [open] = createWrapperEntries([], 'ach', { position: 7, outletName: 'a', openOrder: 999, closeOrder: 0 })
    const [, close] = createWrapperEntries([open], 'ach', { position: 7, outletName: 'b', openOrder: 999, closeOrder: 0 })
    const issues = lintLorebook({ entries: [open, close], extensions: {} })
    expect(issues.find((i) => i.code === 'wrapper-unclosed')?.message).toContain('锚点「a」')
  })
})
