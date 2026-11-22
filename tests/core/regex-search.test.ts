import { zipSync, strToU8 } from 'fflate'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { parseCharx } from '../../src/core/card/charx'
import { createEmptyCard } from '../../src/core/card/create'
import { parseCardPng } from '../../src/core/card/io'
import { syncLegacyMirror } from '../../src/core/card/mirror'
import {
  createRegexScript,
  findRegexMatches,
  parseRegexJson,
  regexFromString,
  runRegexScript,
} from '../../src/core/regex/regex'
import {
  applyReplacements,
  collectTextSlots,
  compileQuery,
  detectNameCandidates,
  findInSlots,
  replacementFor,
} from '../../src/core/search/search'
import { hasSample, itWithSample, sampleBytes } from '../sample'

const ctx = { char: '弗洛洛', user: '漂泊者' }
const sample = hasSample ? parseCardPng(sampleBytes) : undefined

describe('正则脚本', () => {
  it('解析 /pattern/flags', () => {
    expect(regexFromString('/a+b/gi')?.flags).toBe('gi')
    expect(regexFromString('abc')?.source).toBe('abc')
    expect(regexFromString('/[/g')).toBeNull()
  })

  it('{{match}}、分组引用、修剪字符串（与 ST 一致：{{match}} 也会被修剪）', () => {
    const script = { ...createRegexScript(), findRegex: '/<(b)>(.*?)<\\/b>/g', replaceString: '[$2|{{match}}]', trimStrings: ['x'] }
    expect(runRegexScript(script, '1<b>axb</b>2', ctx)).toBe('1[ab|<b>ab</b>]2')
  })

  it('宏替换模式', () => {
    const script = { ...createRegexScript(), findRegex: '/{{char}}/g', replaceString: '{{user}}', substituteRegex: 1 }
    expect(runRegexScript(script, '弗洛洛说', ctx)).toBe('漂泊者说')
    expect(findRegexMatches(script, '弗洛洛和弗洛洛', ctx)).toHaveLength(2)
  })

  it('禁用的脚本不生效', () => {
    const script = { ...createRegexScript(), findRegex: '/a/g', replaceString: 'b', disabled: true }
    expect(runRegexScript(script, 'aaa', ctx)).toBe('aaa')
  })

  it('解析导出的正则 JSON，未知字段保留', () => {
    const [s] = parseRegexJson(JSON.stringify({ scriptName: 'x', findRegex: '/a/', replaceString: 'b', custom: 1 }))
    expect(s.id).toBeTruthy()
    expect(s.custom).toBe(1)
    expect(s.trimStrings).toEqual([])
    expect(() => parseRegexJson('{"foo":1}')).toThrow()
  })
})

describe('查找替换', () => {
  itWithSample('能在角色字段、开场白、世界书里找到名字', () => {
    const regex = compileQuery({ text: '弗洛洛', useRegex: false, caseSensitive: false })
    if (typeof regex === 'string') throw new Error(regex)
    const hits = findInSlots(collectTextSlots(sample!.card), regex)
    const groups = new Set(hits.map((h) => h.group))
    expect(groups).toEqual(new Set(['角色字段', '开场白', '世界书']))
  })

  itWithSample('选中部分命中替换，未选中的保持不变，且能撤销', () => {
    const regex = compileQuery({ text: '弗洛洛', useRegex: false, caseSensitive: false }) as RegExp
    const hits = findInSlots(collectTextSlots(sample!.card), regex)
    const descHits = hits.filter((h) => h.path.join('.') === 'data.description')
    const chosen = descHits.slice(0, 2)

    const next = produce(sample!.card, (draft) => {
      applyReplacements(draft, chosen.map((hit) => ({ hit, text: '{{char}}' })))
    })
    const before = (sample!.card.data.description.match(/弗洛洛/g) ?? []).length
    const after = (next.data.description.match(/弗洛洛/g) ?? []).length
    expect(before - after).toBe(2)
    expect(next.data.first_mes).toBe(sample!.card.data.first_mes)
  })

  it('关键词替换成空时从列表删除', () => {
    const card = createEmptyCard('A')
    card.data.character_book = {
      entries: [{ keys: ['甲', '乙'], content: '', extensions: {}, enabled: true, insertion_order: 100 }],
      extensions: {},
    }
    const regex = compileQuery({ text: '甲', useRegex: false, caseSensitive: true }) as RegExp
    const hits = findInSlots(collectTextSlots(card), regex)
    applyReplacements(card, hits.map((hit) => ({ hit, text: '' })))
    expect(card.data.character_book.entries[0].keys).toEqual(['乙'])
  })

  it('正则模式支持分组引用', () => {
    const query = { text: '(\\d+)岁', useRegex: true, caseSensitive: false }
    const card = createEmptyCard('A')
    card.data.description = '今年18岁'
    const hits = findInSlots(collectTextSlots(card), compileQuery(query) as RegExp)
    expect(replacementFor(hits[0], query, '$1 years')).toBe('18 years')
  })

  itWithSample('识别样本卡的各种名字', () => {
    const names = detectNameCandidates(sample!.card).map((c) => c.name)
    expect(names).toEqual(expect.arrayContaining(['弗洛洛', 'Phrolova', 'フロロ', '플로로']))
  })
})

describe('顶层镜像字段同步', () => {
  it('只同步顶层已有的字段', () => {
    const card = createEmptyCard('A')
    card.data.name = 'B'
    card.data.creator_notes = 'n'
    card.data.tags = ['t']
    syncLegacyMirror(card)
    expect(card.name).toBe('B')
    expect(card.creatorcomment).toBe('n')
    expect(card.tags).toEqual(['t'])
    expect('nickname' in card).toBe(false)
  })
})

describe('CharX', () => {
  it('读取 card.json 和主头像', () => {
    const card = createEmptyCard('X')
    card.data.assets = [
      { type: 'icon', uri: 'embeded://assets/icon/images/main.png', name: 'main', ext: 'png' },
      { type: 'emotion', uri: 'embeded://assets/emotion/happy.png', name: 'happy', ext: 'png' },
    ]
    const zip = zipSync({
      'card.json': strToU8(JSON.stringify(card)),
      'assets/icon/images/main.png': new Uint8Array([1, 2, 3]),
      'assets/emotion/happy.png': new Uint8Array([4]),
    })
    const parsed = parseCharx(zip)
    expect(parsed.card.data.name).toBe('X')
    expect(parsed.avatar?.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(parsed.warnings.some((w) => w.includes('1 个附加资源'))).toBe(true)
  })
})
