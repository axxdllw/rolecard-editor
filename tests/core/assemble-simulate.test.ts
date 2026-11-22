import { describe, expect, it } from 'vitest'
import type { CharacterCardV3, LorebookEntry } from '../../src/core/card/types'
import { assemblePrompt, activeEntries } from '../../src/core/lorebook/assemble'
import { createEntry, POSITION, setExt } from '../../src/core/lorebook/entry'

function makeCard(entries: LorebookEntry[]): CharacterCardV3 {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: '弗洛洛',
      description: '角色描述',
      personality: '',
      scenario: '',
      first_mes: '',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '',
      extensions: {},
      group_only_greetings: [],
      character_book: {
        name: '测试书',
        extensions: {},
        entries,
      },
    },
  }
}

function addEntry(
  entries: LorebookEntry[],
  init: Parameters<typeof createEntry>[1] = {},
  ext: Record<string, unknown> = {},
): LorebookEntry {
  const entry = createEntry(entries, init)
  for (const [k, v] of Object.entries(ext)) {
    setExt(entry, k, v)
  }
  entries.push(entry)
  return entry
}

describe('提示词组装 · simulate 模式', () => {
  const macros = { char: '弗洛洛', user: '漂泊者' }

  it('只放入 simulated.activated 里给定的条目，且保留常驻/触发区分与不额外过滤未启用条目', () => {
    const entries: LorebookEntry[] = []
    addEntry(entries, { comment: '常驻条目', content: '常驻内容', constant: true, position: POSITION.BEFORE_CHAR })
    addEntry(entries, { comment: '未选中的常驻', content: '不该出现', constant: true, position: POSITION.BEFORE_CHAR })
    addEntry(entries, { comment: '关键词条目', keys: ['测试'], content: '关键词内容', position: POSITION.AFTER_CHAR })
    const disabled = addEntry(entries, { comment: '未启用但模拟给出', content: '仍应保留', position: POSITION.AFTER_CHAR })
    disabled.enabled = false

    const card = makeCard(entries)
    const active = activeEntries(card.data.character_book, {
      mode: 'simulate',
      simulated: { activated: [0, 2, 3] },
      macros,
    })

    expect(active.map((a) => ({ index: a.index, source: a.source }))).toEqual([
      { index: 0, source: 'constant' },
      { index: 2, source: 'triggered' },
      { index: 3, source: 'triggered' },
    ])

    const sections = assemblePrompt(card, {
      mode: 'simulate',
      simulated: { activated: [0, 2] },
      macros,
    })
    const titles = sections.flatMap((s) => s.blocks).map((b) => b.title)
    expect(titles).toContain('常驻条目')
    expect(titles).toContain('关键词条目')
    expect(titles).not.toContain('未选中的常驻')
  })

  it('按位置分组与顺序排序正确（普通位置升序，锚点降序）', () => {
    const entries: LorebookEntry[] = []
    addEntry(entries, { comment: '角色前-后', content: 'B', position: POSITION.BEFORE_CHAR, order: 200 })
    addEntry(entries, { comment: '角色前-先', content: 'A', position: POSITION.BEFORE_CHAR, order: 50 })
    addEntry(entries, { comment: '深度2', content: 'D2', position: POSITION.AT_DEPTH, depth: 2, order: 100 })
    addEntry(entries, { comment: '深度0', content: 'D0', position: POSITION.AT_DEPTH, depth: 0, order: 100 })
    addEntry(entries, { comment: '锚点-小', content: 'O1', position: POSITION.OUTLET, outletName: 'lore', order: 10 })
    addEntry(entries, { comment: '锚点-大', content: 'O2', position: POSITION.OUTLET, outletName: 'lore', order: 90 })

    const card = makeCard(entries)
    const sections = assemblePrompt(card, {
      mode: 'simulate',
      simulated: { activated: [0, 1, 2, 3, 4, 5] },
      macros,
    })

    const before = sections.find((s) => s.id === 'wi-before')
    expect(before?.blocks.map((b) => b.title)).toEqual(['角色前-先', '角色前-后'])

    const chat = sections.find((s) => s.id === 'chat')
    expect(chat?.blocks.filter((b) => b.kind !== 'note').map((b) => b.title)).toEqual(['深度2', '深度0'])

    const outlet = sections.find((s) => s.id === 'wi-outlet')
    expect(outlet?.blocks.filter((b) => b.kind !== 'note').map((b) => b.title)).toEqual(['锚点-大', '锚点-小'])
  })

  it('simulate 模式下剥掉开头的装饰器再做宏替换，其他模式保持原样', () => {
    const entries: LorebookEntry[] = []
    addEntry(entries, {
      comment: '带装饰器',
      content: '@@activate\n@@@dont_activate\n{{char}} 向 {{user}} 点头。',
      constant: true,
      position: POSITION.BEFORE_CHAR,
    })
    const card = makeCard(entries)

    const simulated = assemblePrompt(card, {
      mode: 'simulate',
      simulated: { activated: [0] },
      macros,
    })
    const simBlock = simulated.find((s) => s.id === 'wi-before')?.blocks[0]
    expect(simBlock?.content).toBe('弗洛洛 向 漂泊者 点头。')

    const constantMode = assemblePrompt(card, {
      mode: 'constant',
      macros,
    })
    const constBlock = constantMode.find((s) => s.id === 'wi-before')?.blocks[0]
    expect(constBlock?.content).toBe('@@activate\n@@@dont_activate\n弗洛洛 向 漂泊者 点头。')
  })

  it('simulated 未传或为空时不放入任何世界书条目', () => {
    const entries: LorebookEntry[] = []
    addEntry(entries, { comment: '常驻', content: '常驻内容', constant: true, position: POSITION.BEFORE_CHAR })
    const card = makeCard(entries)

    const sections = assemblePrompt(card, { mode: 'simulate', macros })
    expect(sections.find((s) => s.id === 'wi-before')).toBeUndefined()
    expect(sections.find((s) => s.id === 'char')).toBeDefined()
  })
})
