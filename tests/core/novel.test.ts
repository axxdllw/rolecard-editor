import { describe, expect, it } from 'vitest'
import { chunkOrder, chunkText, estimateExtraction, planChunks, snapOffset } from '../../src/core/novel/chunk'
import {
  batchItems,
  buildConsolidateRequest,
  dropSharedKeys,
  parseConsolidated,
  toGeneratedEntries,
  worldToItem,
  type ConsolidateItem,
} from '../../src/core/novel/consolidate'
import type { AiError, AiFinishReason } from '../../src/core/ai/types'
import { buildExtractRequest, failureOutput, formatRoster, parseExtraction } from '../../src/core/novel/extract'
import { buildNovelCardRequest, parseNovelCard, toDraftCard } from '../../src/core/novel/generate'
import { prepareGeneration } from '../../src/core/novel/prepare'
import {
  aliasesUpTo,
  collectSummaries,
  collectWorld,
  entityNames,
  formatEntityNotes,
  isGenericAlias,
  isHidden,
  isSelected,
  mergeEntities,
  mergeOverride,
  nameKey,
  renameOverride,
  setHidden,
  setSelected,
  splitOverride,
} from '../../src/core/novel/merge'
import {
  EMPTY_OVERRIDES,
  type ChunkExtraction,
  type ChunkResult,
  type ExtractedCharacter,
  type NovelChapter,
} from '../../src/core/novel/types'
import { runPool } from '../../src/core/util/pool'

function para(n: number, seed = 'x'): string {
  // n 个字，每 100 字一段
  const lines: string[] = []
  let left = n
  while (left > 0) {
    const len = Math.min(99, left)
    lines.push(seed.repeat(len))
    left -= len + 1
  }
  return lines.join('\n').slice(0, n)
}

describe('planChunks', () => {
  it('优先在章节边界切块，块不超过上限太多', () => {
    const lengths = [3000, 3000, 3000, 3000, 3000, 3000]
    const plans = planChunks(lengths, [0, 1, 2, 3, 4, 5], { chunkChars: 10000, sampleCount: 0 })
    expect(plans.map((p) => [p.chapterStart, p.chapterEnd])).toEqual([
      [0, 2],
      [3, 5],
    ])
    expect(plans.every((p) => p.startOffset === 0)).toBe(true)
    expect(plans[0].label).toBe('第 1～3 章')
    expect(plans.reduce((s, p) => s + p.chars, 0)).toBe(18000)
  })

  it('单章太长时切成几段，剩下不多就并进最后一段', () => {
    const plans = planChunks([21000], [0], { chunkChars: 10000, sampleCount: 0 })
    expect(plans.map((p) => [p.startOffset, p.endOffset])).toEqual([
      [0, 10000],
      [10000, 21000],
    ])
    expect(plans.map((p) => p.label)).toEqual(['第 1 章（1）', '第 1 章（2）'])
    const three = planChunks([25000], [0], { chunkChars: 10000, sampleCount: 0 })
    expect(three.map((p) => p.endOffset)).toEqual([10000, 20000, 25000])
  })

  it('不连续的选择分别切块；往后追加章节时前面的块 id 不变', () => {
    const lengths = Array.from({ length: 10 }, () => 4000)
    const a = planChunks(lengths, [0, 1, 2, 3, 7, 8], { chunkChars: 8000, sampleCount: 0 })
    expect(a.some((p) => p.chapterStart <= 3 && p.chapterEnd >= 7)).toBe(false)
    const b = planChunks(lengths, [0, 1, 2, 3, 4, 5, 7, 8], { chunkChars: 8000, sampleCount: 0 })
    const idsB = new Set(b.map((p) => p.id))
    for (const p of a.filter((p) => p.chapterEnd <= 3)) expect(idsB.has(p.id)).toBe(true)
  })

  it('抽样只取没选中的章节，块之间不重叠，按书中顺序排', () => {
    const lengths = Array.from({ length: 100 }, () => 2000)
    const plans = planChunks(lengths, [0, 1, 2], { chunkChars: 6000, sampleCount: 5 })
    const sampled = plans.filter((p) => p.sampled)
    expect(sampled.length).toBe(5)
    const used = new Set<number>()
    for (const p of sampled) {
      for (let c = p.chapterStart; c <= p.chapterEnd; c++) {
        expect(c).toBeGreaterThan(2)
        expect(used.has(c)).toBe(false)
        used.add(c)
      }
    }
    const orders = plans.map(chunkOrder)
    expect([...orders].sort((x, y) => x - y)).toEqual(orders)
  })

  it('有标题时用书里的章名起名，带卷名', () => {
    const titles = [
      { title: '楔子' },
      { title: '第一章 风起', volume: '第一卷 长安' },
      { title: '第二章 云涌', volume: '第一卷 长安' },
      { title: '第一章 归来', volume: '第二卷 洛阳' },
    ]
    const plans = planChunks([3000, 3000, 3000, 25000], [0, 1, 2, 3], { chunkChars: 10000, sampleCount: 0 }, titles)
    expect(plans.map((p) => p.label)).toEqual(['楔子～第一卷·第二章', '第二卷·第一章（1）', '第二卷·第一章（2）', '第二卷·第一章（3）'])
    const same = planChunks([3000, 3000, 3000], [1, 2], { chunkChars: 10000, sampleCount: 0 }, titles)
    expect(same[0].label).toBe('第一卷·第一章～第二章')
  })

  it('跳过空章节和越界下标', () => {
    const plans = planChunks([0, 500, 0], [0, 1, 2, 9, -1], { chunkChars: 5000, sampleCount: 0 })
    expect(plans.length).toBe(1)
    expect(plans[0].chars).toBe(500)
  })

  it('估算请求数和 token', () => {
    const est = estimateExtraction([{ chars: 20000 }, { chars: 10000 }])
    expect(est.requests).toBe(2)
    expect(est.chars).toBe(30000)
    expect(est.inputTokens).toBeGreaterThan(22000)
  })
})

describe('chunkText', () => {
  it('切点对齐到段落开头，相邻块首尾相接、不重不漏', () => {
    const text = para(25000)
    const chapters: NovelChapter[] = [{ title: '第一章 开端', text }]
    const plans = planChunks([text.length], [0], { chunkChars: 10000, sampleCount: 0 })
    const bodies = plans.map((p) => chunkText(chapters, p).replace(/^【[^】]*】\n/, ''))
    expect(bodies.join('\n').replace(/\n/g, '')).toBe(text.replace(/\n/g, ''))
    expect(chunkText(chapters, plans[1]).startsWith('【第一章 开端（接上文）】')).toBe(true)
    expect(snapOffset(text, 150)).toBe(100)
  })

  it('跨章时每章加标题和卷名', () => {
    const chapters: NovelChapter[] = [
      { title: '第一章', text: '甲', volume: '第一卷' },
      { title: '第二章', text: '乙' },
    ]
    const [plan] = planChunks([1, 1], [0, 1], { chunkChars: 5000, sampleCount: 0 })
    expect(chunkText(chapters, plan)).toBe('【第一卷 第一章】\n甲\n\n【第二章】\n乙')
  })
})

function character(name: string, extra: Partial<ExtractedCharacter> = {}): ExtractedCharacter {
  return {
    name,
    aliases: [],
    gender: '',
    identity: '',
    appearance: '',
    personality: '',
    abilities: '',
    relations: [],
    facts: [],
    quotes: [],
    importance: 3,
    ...extra,
  }
}

function extraction(partial: Partial<ChunkExtraction>): ChunkExtraction {
  return { summary: '', characters: [], places: [], organizations: [], terms: [], events: [], world: [], ...partial }
}

function result(i: number, partial: Partial<ChunkExtraction>): ChunkResult {
  return { chunkId: `c${i}`, order: i, label: `第 ${i + 1} 章`, extraction: extraction(partial) }
}

describe('parseExtraction', () => {
  it('宽松解析：代码块包裹、空值、重要度、同名合并', () => {
    const raw = `好的：\n\`\`\`json\n${JSON.stringify({
      summary_of_chunk: '陈恭接头。',
      characters: [
        { name: '陈恭', aliases: ['文礼', '陈恭', '未知'], gender: '男', identity: '主记', appearance: '无', importance: 9, facts: ['接头'], quotes: [] },
        { name: '陈恭', aliases: ['黑帝'], identity: '天水太守府主记', importance: '4', facts: ['逃脱'] },
        { name: '', aliases: [] },
      ],
      places: [{ name: '上邽', aliases: '冀城，上邽城', description: '天水郡治所' }],
      terms: [{ name: '夜枭', category: '代称', description: '间谍的叫法' }],
      events: [{ title: '接头', summary: '在酒肆接头', characters: ['陈恭'], importance: 0 }],
      world: ['曹魏实行户籍管制', '曹魏实行户籍管制'],
    })}\n\`\`\``
    const r = parseExtraction(raw)
    expect(r.summary).toBe('陈恭接头。')
    expect(r.characters.length).toBe(1)
    const c = r.characters[0]
    expect(c.aliases).toEqual(['文礼', '黑帝'])
    expect(c.appearance).toBe('')
    expect(c.identity).toBe('天水太守府主记')
    expect(c.importance).toBe(5)
    expect(c.facts).toEqual(['接头', '逃脱'])
    expect(r.places[0].aliases).toEqual(['冀城', '上邽城'])
    expect(r.events[0].importance).toBe(1)
    expect(r.world).toEqual(['曹魏实行户籍管制'])
  })

  it('什么都没有时报错', () => {
    expect(() => parseExtraction('{"characters":[]}')).toThrow()
    expect(() => parseExtraction('不是 JSON')).toThrow()
  })

  it('解析失败时说清楚原因：截断、文字拒绝、没写 JSON、JSON 残缺', () => {
    const errorOf = (text: string, finishReason?: AiFinishReason) => {
      try {
        parseExtraction(text, finishReason)
      } catch (e) {
        return e as AiError
      }
      throw new Error('应该解析失败')
    }
    const truncated = errorOf('{"summary_of_chunk":"陈恭接头', 'length')
    expect(truncated.kind).toBe('bad_output')
    expect(truncated.message).toContain('截断')

    const refusal = errorOf('抱歉，这段内容涉及暴力描写，我无法协助处理。')
    expect(refusal.kind).toBe('refusal')
    expect(errorOf("I'm sorry, but I can't help with that.").kind).toBe('refusal')

    const plain = errorOf('这一段讲的是陈恭在酒肆接头的故事。')
    expect(plain.kind).toBe('bad_output')
    expect(plain.message).toContain('普通文字')

    const broken = errorOf('{"summary_of_chunk":"陈恭接头","characters":[{"name":"陈恭"')
    expect(broken.kind).toBe('bad_output')
    expect(broken.message).toContain('不完整')

    // 能解析但没内容：沿用原来的提示
    expect(errorOf('{"characters":[]}').message).toContain('没有整理出任何内容')
  })

  it('失败时留下的回复：短的原样保留，长的只留头尾', () => {
    expect(failureOutput('  抱歉  ', 'stop')).toEqual({ text: '抱歉', chars: 2, finishReason: 'stop' })
    expect(failureOutput('')).toEqual({ text: '', chars: 0 })
    const long = `${'甲'.repeat(400)}${'乙'.repeat(400)}`
    const out = failureOutput(long)
    expect(out.chars).toBe(800)
    expect(out.text.startsWith('甲'.repeat(300))).toBe(true)
    expect(out.text.endsWith('乙'.repeat(300))).toBe(true)
    expect(out.text).toContain('中间省略 200 字')
  })

  it('请求里带书名、已知人物和原文', () => {
    const req = buildExtractRequest({ bookTitle: '风起陇西', chunkLabel: '第 1～3 章', text: '正文', roster: '陈恭（文礼）' })
    expect(req.json).toBe(true)
    const content = req.messages[0].content
    expect(content).toContain('《风起陇西》')
    expect(content).toContain('陈恭（文礼）')
    expect(content).toContain('# 原文（第 1～3 章）')
  })
})

describe('mergeEntities', () => {
  const results = [
    result(0, {
      characters: [
        character('陈恭', { aliases: ['文礼', '陈大人'], importance: 5, gender: '男', identity: '主记' }),
        character('陈芳', { aliases: ['陈大人'], importance: 2 }),
        character('谷正', { aliases: ['白帝'], importance: 4 }),
      ],
      places: [{ name: '上邽', aliases: ['冀城'], description: '治所', facts: [] }],
      world: ['曹魏实行户籍管制。'],
      summary: '第一段',
    }),
    result(1, {
      characters: [character('文礼', { importance: 4, identity: '蜀汉间谍' }), character('白帝', { aliases: ['谷大人'], importance: 3 })],
      places: [{ name: '冀城', aliases: [], description: '', facts: [] }],
      world: ['曹魏实行户籍管制'],
      summary: '第二段',
    }),
    result(2, { characters: [character('陈恭', { importance: 4 }), character('糜冲', { aliases: ['烛龙'], importance: 5 })] }),
  ]

  it('名字和别名把同一对象连起来，泛称不连', () => {
    const entities = mergeEntities(results, EMPTY_OVERRIDES)
    const people = entities.filter((e) => e.kind === 'character')
    const chen = people.find((e) => e.name === '陈恭')!
    expect(chen.mentions.length).toBe(3)
    expect(chen.aliases).toContain('文礼')
    expect(chen.importance).toBe(5)
    expect(chen.weight).toBe(5 + 4 + 4)
    expect(chen.gender).toBe('男')
    // “陈大人”是泛称，陈芳不会被并进来
    expect(people.find((e) => e.name === '陈芳')).toBeTruthy()
    const gu = people.find((e) => e.name === '谷正' || e.name === '白帝')!
    expect(gu.mentions.length).toBe(2)
    const place = entities.find((e) => e.kind === 'place')!
    expect(place.mentions.length).toBe(2)
    // 人物在前，按权重排
    expect(entities[0].name).toBe('陈恭')
  })

  it('同一个别名被两个名字用过、又不是谁的名字时不合并', () => {
    const r = [
      result(0, { characters: [character('张三', { aliases: ['阿福'] }), character('李四', { aliases: ['阿福'] })] }),
    ]
    expect(mergeEntities(r, EMPTY_OVERRIDES).length).toBe(2)
  })

  it('泛称判断', () => {
    expect(isGenericAlias('大人')).toBe(true)
    expect(isGenericAlias('陈大人')).toBe(true)
    expect(isGenericAlias('韩师兄')).toBe(true)
    expect(isGenericAlias('我')).toBe(true)
    expect(isGenericAlias('文礼')).toBe(false)
    expect(isGenericAlias('白帝')).toBe(false)
  })

  it('手动合并、拆出、改名、删除、勾选都记在名字键上', () => {
    let o = EMPTY_OVERRIDES
    let entities = mergeEntities(results, o)
    const chen = entities.find((e) => e.name === '陈恭')!
    const mi = entities.find((e) => e.name === '糜冲')!

    o = mergeOverride(o, [chen, mi])
    entities = mergeEntities(results, o)
    const merged = entities.find((e) => e.keys.includes(nameKey('character', '糜冲')))!
    expect(merged.name).toBe('陈恭')
    expect(merged.mentions.length).toBe(4)

    o = splitOverride(o, nameKey('character', '文礼'))
    entities = mergeEntities(results, o)
    const wenli = entities.find((e) => e.name === '文礼')!
    expect(wenli.mentions.length).toBe(1)
    expect(entityNames(entities.find((e) => e.name === '陈恭')!).map((n) => n.name)).toEqual(['陈恭', '糜冲'])

    o = renameOverride(o, wenli, '陈恭（化名）')
    entities = mergeEntities(results, o)
    expect(entities.some((e) => e.name === '陈恭（化名）')).toBe(true)

    const fang = entities.find((e) => e.name === '陈芳')!
    o = setHidden(o, [fang], true)
    entities = mergeEntities(results, o)
    expect(isHidden(entities.find((e) => e.name === '陈芳')!, o)).toBe(true)

    // 第一次勾选改动：先展开推荐勾选
    const gu = entities.find((e) => e.name === '谷正' || e.name === '白帝')!
    expect(isSelected(gu, o, 3)).toBe(true)
    o = setSelected(o, entities, [gu], false, 3)
    expect(o.selected).not.toBeNull()
    expect(isSelected(gu, o, 3)).toBe(false)
    expect(isSelected(entities.find((e) => e.name === '陈恭')!, o, 3)).toBe(true)
  })

  it('别名按时间点过滤，后面才揭晓的身份不提前出现', () => {
    const r = [
      result(0, { characters: [character('狐忠', { aliases: ['守义'] })] }),
      result(5, { characters: [character('狐忠', { aliases: ['烛龙'] })] }),
    ]
    const [hu] = mergeEntities(r, EMPTY_OVERRIDES)
    expect(hu.aliases).toContain('烛龙')
    expect(aliasesUpTo(hu, 0)).toEqual(['守义'])
    expect(aliasesUpTo(hu)).toEqual(hu.aliases)
  })

  it('有时间点时按时间点重新合并，后面揭晓的同一人不会提前并到一起', () => {
    const r = [
      result(0, { characters: [character('狐忠', { aliases: ['守义'], importance: 4 }), character('烛龙', { importance: 4, facts: ['神秘内奸'] })], world: ['三国'] }),
      result(5, { characters: [character('狐忠', { aliases: ['烛龙'], importance: 5 })], world: ['后来的设定'] }),
    ]
    const all = mergeEntities(r, EMPTY_OVERRIDES)
    expect(all.filter((e) => e.kind === 'character').length).toBe(1)
    const early = prepareGeneration({ mode: 'world', entities: all, overrides: EMPTY_OVERRIDES, results: r, maxOrder: 0, mainKey: null, worldEntry: true })
    expect(early.lorebook.map((e) => e.name).sort()).toEqual(['烛龙', '狐忠'])
    expect(early.items.find((i) => i.name === '狐忠')!.aliases).toEqual(['守义'])
    expect(early.world).not.toContain('后来的设定')
    const later = prepareGeneration({ mode: 'world', entities: all, overrides: EMPTY_OVERRIDES, results: r, mainKey: null, worldEntry: true })
    expect(later.lorebook.length).toBe(1)
  })

  it('世界观去重、剧情概要按时间点截取', () => {
    expect(collectWorld(results)).toEqual(['曹魏实行户籍管制。'])
    expect(collectSummaries(results, 0).map((s) => s.summary)).toEqual(['第一段'])
    expect(collectSummaries(results).length).toBe(2)
  })

  it('资料超长时保留第一段和最近的几段', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      result(i, { characters: [character('陈恭', { facts: [`第 ${i} 件事`.padEnd(200, '。')] })] }),
    )
    const [chen] = mergeEntities(many, EMPTY_OVERRIDES)
    const notes = formatEntityNotes(chen, { maxChars: 2000 })
    expect(notes.length).toBeLessThanOrEqual(2100)
    expect(notes).toContain('第 0 件事')
    expect(notes).toContain('第 29 件事')
    expect(notes).toContain('中间省略')
    expect(formatEntityNotes(chen, { maxOrder: 1 })).not.toContain('第 2 件事')
  })

  it('已知人物名单', () => {
    const entities = mergeEntities(results, EMPTY_OVERRIDES)
    const roster = formatRoster(entities)
    expect(roster.split('\n')[0]).toMatch(/^陈恭（/)
  })
})

describe('consolidate', () => {
  const items: ConsolidateItem[] = [
    { id: 'c0', kind: 'character', name: '陈恭', aliases: ['文礼'], notes: '资料'.repeat(10) },
    { id: 'p1', kind: 'place', name: '上邽', aliases: [], notes: '资料'.repeat(10) },
    worldToItem(['曹魏实行户籍管制', '蜀汉有新式弩机']),
  ]

  it('按字数分批', () => {
    expect(batchItems(items, 100000).length).toBe(1)
    expect(batchItems(items, 10).length).toBe(3)
  })

  it('请求里带 id 和类型', () => {
    const req = buildConsolidateRequest({ bookTitle: '风起陇西', items })
    expect(req.messages[0].content).toContain('## [id=c0] 人物：陈恭（别名：文礼）')
    expect(req.messages[0].content).toContain('## [id=w0] 世界观：世界观')
  })

  it('按 id 对应，清理关键词，世界观常驻', () => {
    const text = JSON.stringify({
      entries: [
        { id: 'p1', comment: '上邽', keys: ['冀城'], content: '名称：上邽' },
        { id: 'xx', comment: '陈恭', keys: ['文礼', '大人', '陈', '陈主记'], content: '姓名：陈恭' },
        { id: 'w0', comment: '世界观', keys: ['世界'], content: '时代：三国' },
        { id: 'c9', comment: '不存在', keys: [], content: '多余' },
      ],
    })
    const parsed = parseConsolidated(text, items)
    expect(parsed.map((p) => p.id)).toEqual(['c0', 'p1', 'w0'])
    expect(parsed[0].keys).toEqual(['陈恭', '文礼', '陈主记'])
    expect(parsed[1].keys).toEqual(['上邽', '冀城'])
    expect(parsed[2].keys).toEqual([])
    const generated = toGeneratedEntries(parsed, items)
    expect(generated.map((g) => [g.type, g.constant])).toEqual([
      ['character', false],
      ['place', false],
      ['other', true],
    ])
  })

  it('去掉姓加客套称呼的关键词，共用的关键词只留给同名条目', () => {
    const text = JSON.stringify({ entries: [{ id: 'c0', comment: '陈恭', keys: ['陈大人', '陈将军', '陈主记', '文礼'], content: 'x' }] })
    expect(parseConsolidated(text, items)[0].keys).toEqual(['陈恭', '陈主记', '文礼'])
    const out = dropSharedKeys([
      { comment: '马岱', keys: ['马岱', '平北将军', '马都督'] },
      { comment: '马信', keys: ['马信', '马都督'] },
      { comment: '陈恭', keys: ['陈恭', '黑帝'] },
      { comment: '黑帝', keys: ['黑帝'] },
    ])
    expect(out.map((e) => e.keys)).toEqual([['马岱', '平北将军'], ['马信'], ['陈恭'], ['黑帝']])
  })

  it('一条都对不上时报错', () => {
    expect(() => parseConsolidated('{"entries":[]}', items)).toThrow()
  })
})

describe('generate', () => {
  const base = {
    bookTitle: '风起陇西',
    author: '马伯庸',
    cast: '谷正：蜀汉间谍',
    world: '- 曹魏实行户籍管制',
    story: '【第 1 章】陈恭接头。',
    timePoint: '第 3 章之后',
    userRole: '新来的书佐',
    style: { label: 'YAML', skeleton: 'name:' },
    greetings: 3,
  }

  it('单角色卡：带主角资料和时间点', () => {
    const req = buildNovelCardRequest({ ...base, mode: 'character', main: { name: '陈恭', aliases: ['文礼'], notes: '身份：主记' } })
    const content = req.messages[0].content
    expect(req.system).toContain('书中的一个人物')
    expect(content).toContain('# {{char}}：陈恭（别名：文礼）')
    expect(content).toContain('第 3 章之后')
    expect(content).toContain('新来的书佐')
    expect(content).toContain('"备选开场白 2"')
  })

  it('世界卡：用世界名', () => {
    const req = buildNovelCardRequest({ ...base, mode: 'world', worldName: '陇西' })
    expect(req.system).toContain('世界卡')
    expect(req.messages[0].content).toContain('陇西（name 必须用这个）')
  })

  it('解析结果，前情提要做成常驻条目', () => {
    const draft = parseNovelCard(
      JSON.stringify({ name: '陈恭', description: '描述', first_mes: '开场', alternate_greetings: ['二'], tags: ['三国', '三国'], story_so_far: '前情' }),
    )
    expect(draft.tags).toEqual(['三国'])
    const card = toDraftCard(draft, [{ type: 'character', comment: '谷正', keys: ['谷正'], content: '间谍', constant: false }], { storyEntry: true })
    expect(card.lorebook.map((e) => e.comment)).toEqual(['谷正', '前情提要'])
    expect(card.lorebook[1].constant).toBe(true)
    expect('story_so_far' in card).toBe(false)
    expect(toDraftCard(draft, [], { storyEntry: false }).lorebook).toEqual([])
    expect(() => parseNovelCard('{"name":"x"}')).toThrow()
  })
})

describe('runPool', () => {
  it('限制并发、全部跑完；中止后不再开新任务', async () => {
    let running = 0
    let peak = 0
    const done: number[] = []
    await runPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      done.push(n)
      running--
    })
    expect(peak).toBe(2)
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6])

    const controller = new AbortController()
    const started: number[] = []
    await runPool(
      [1, 2, 3, 4],
      1,
      async (n) => {
        started.push(n)
        if (n === 2) controller.abort()
      },
      controller.signal,
    )
    expect(started).toEqual([1, 2])
  })
})
