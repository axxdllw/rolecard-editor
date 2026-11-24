import { describe, expect, it } from 'vitest'
import { createEmptyCard } from '../../src/core/card/create'
import type { CharacterCardV3, LorebookEntry } from '../../src/core/card/types'
import { indexCard, makeSnippet, parseTerms, searchIndexedCards, slotTarget, splitHighlights } from '../../src/core/search/fullText'

function entry(patch: Partial<LorebookEntry>): LorebookEntry {
  return { keys: [], content: '', extensions: {}, enabled: true, insertion_order: 100, ...patch }
}

function makeCard(name: string, patch: Partial<CharacterCardV3['data']> = {}, entries?: LorebookEntry[]): CharacterCardV3 {
  const card = createEmptyCard(name)
  card.data.description = ''
  card.data.first_mes = ''
  Object.assign(card.data, patch)
  if (entries) card.data.character_book = { name: '书', extensions: {}, entries }
  return card
}

describe('全文搜索', () => {
  const a = indexCard(
    'a',
    '秧秧',
    makeCard('秧秧', { description: '今州的少女，擅长使用 Sword。', alternate_greetings: ['你好', '她拔出了剑'] }, [
      entry({ comment: '今州', keys: ['今州'], content: '今州是一座城市。今州城外有山。' }),
      entry({ comment: '武器', keys: ['剑'], content: '一把细剑' }),
    ]),
  )
  const b = indexCard('b', '路人', makeCard('路人', { description: '普通人，住在今州。', mes_example: '<START>\n{{char}}: 嗯。' }))
  const c = indexCard('c', '无关', makeCard('无关', { description: '什么都没有' }))

  it('关键词按空白拆分、去重、转小写', () => {
    expect(parseTerms('  今州  Sword 今州\n剑 ')).toEqual(['今州', 'sword', '剑'])
    expect(parseTerms('   ')).toEqual([])
  })

  it('按卡分组，记录命中位置和次数，按命中次数排序', () => {
    const result = searchIndexedCards([c, b, a], '今州')
    expect(result.map((r) => r.id)).toEqual(['a', 'b'])
    const [first] = result
    expect(first.total).toBe(5)
    expect(first.slots.map((s) => [s.label, s.count])).toEqual([
      ['角色描述', 1],
      ['世界书 · 今州 · 备注名', 1],
      ['世界书 · 今州 · 关键词', 1],
      ['世界书 · 今州 · 内容', 2],
    ])
    expect(first.slots[3].path).toEqual(['data', 'character_book', 'entries', 0, 'content'])
  })

  it('不区分大小写，片段保留原文', () => {
    const [hit] = searchIndexedCards([a, b, c], 'sword')
    expect(hit.id).toBe('a')
    expect(hit.slots[0].snippet).toEqual({ before: '今州的少女，擅长使用 ', match: 'Sword', after: '。' })
  })

  it('多个关键词要求同一张卡里都出现', () => {
    expect(searchIndexedCards([a, b, c], '今州 剑').map((r) => r.id)).toEqual(['a'])
    expect(searchIndexedCards([a, b, c], '今州 不存在')).toEqual([])
    const [hit] = searchIndexedCards([a], '今州 剑')
    expect(hit.slots.find((s) => s.label === '备选开场白 2')?.count).toBe(1)
  })

  it('同一槽里重叠的关键词只算一次', () => {
    const d = indexCard('d', 'd', makeCard('d', { description: 'abcabc' }))
    const [hit] = searchIndexedCards([d], 'abc bc')
    expect(hit.slots[0].count).toBe(2)
  })

  it('空查询或没有命中时返回空', () => {
    expect(searchIndexedCards([a, b], '')).toEqual([])
    expect(searchIndexedCards([a, b], '火星')).toEqual([])
  })

  it('小写后长度变化的文字也能搜到', () => {
    const d = indexCard('d', 'd', makeCard('d', { description: 'İstanbul 的 cafe' }))
    const [hit] = searchIndexedCards([d], 'cafe')
    expect(hit.slots[0].snippet.match).toBe('cafe')
    expect(hit.slots[0].snippet.before).toBe('İstanbul 的 ')
  })
})

describe('前后文片段', () => {
  it('超出范围时加省略号，换行压成空格', () => {
    const text = '0123456789\n\nabcdefghij关键词klmnopqrst\n0123456789'
    const start = text.indexOf('关键词')
    expect(makeSnippet(text, start, start + 3, 5)).toEqual({ before: '…fghij', match: '关键词', after: 'klmno…' })
    expect(makeSnippet('a\n\nb', 0, 1, 10)).toEqual({ before: '', match: 'a', after: ' b' })
  })
})

describe('命中位置跳转', () => {
  it('把路径换成编辑页落点', () => {
    expect(slotTarget(['data', 'description'])).toEqual({ tab: 'character', anchor: 'field-data-description' })
    expect(slotTarget(['data', 'alternate_greetings', 2])).toEqual({ tab: 'character', anchor: 'greeting-2' })
    expect(slotTarget(['data', 'group_only_greetings', 0])).toEqual({ tab: 'character', anchor: 'group-greeting-0' })
    expect(slotTarget(['data', 'extensions', 'depth_prompt', 'prompt'])).toEqual({
      tab: 'character',
      anchor: 'field-data-extensions-depth_prompt-prompt',
    })
    expect(slotTarget(['data', 'character_book', 'entries', 4, 'keys', 0])).toEqual({ tab: 'worldbook', entry: 4 })
    expect(slotTarget(['data', 'character_book', 'name'])).toEqual({ tab: 'worldbook' })
    expect(slotTarget(['data', 'extensions', 'regex_scripts', 1, 'findRegex'])).toEqual({ tab: 'regex', regex: 1 })
  })
})

describe('性能', () => {
  it('100 张卡、每张 200 条世界书能很快搜完', () => {
    const filler = '这是一段用来填充的世界书内容，描写城市、人物和历史。'.repeat(20)
    const cards = Array.from({ length: 100 }, (_, i) =>
      indexCard(
        String(i),
        `卡${i}`,
        makeCard(
          `卡${i}`,
          { description: filler },
          Array.from({ length: 200 }, (_, j) => entry({ comment: `条目${j}`, keys: [`关键${j}`], content: j === 99 && i === 42 ? `${filler}隐藏设定${filler}` : filler })),
        ),
      ),
    )
    const t0 = performance.now()
    const result = searchIndexedCards(cards, '隐藏设定')
    const elapsed = performance.now() - t0
    expect(result.map((r) => r.id)).toEqual(['42'])
    expect(result[0].slots[0].label).toBe('世界书 · 条目99 · 内容')
    expect(elapsed).toBeLessThan(500)
  })
})

describe('高亮切分', () => {
  it('按关键词切开，不区分大小写', () => {
    expect(splitHighlights('Abc 和 abc 以及 xyz', ['abc', 'xyz'])).toEqual([
      { text: 'Abc', hit: true },
      { text: ' 和 ', hit: false },
      { text: 'abc', hit: true },
      { text: ' 以及 ', hit: false },
      { text: 'xyz', hit: true },
    ])
    expect(splitHighlights('无命中', ['abc'])).toEqual([{ text: '无命中', hit: false }])
  })
})
