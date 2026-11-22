import { beforeAll, describe, expect, it } from 'vitest'
import {
  CardParseError,
  normalizeToV3,
  parseCardJson,
  parseCardPng,
  serializeCardJson,
  stripCardPng,
  writeCardPng,
  type ParsedPngCard,
} from '../../src/core/card/io'
import { encodeChunks, getTextEntries, readChunks, replaceTextEntries } from '../../src/core/png/png'
import { base64ToUtf8 } from '../../src/core/util/base64'
import { describeWithSample, itWithSample, plainPng, sampleBytes } from '../sample'

/** 直接从 PNG 里取出某个文本块的原始 JSON，不经过我们的解析逻辑 */
function rawCardJson(png: Uint8Array, keyword: string): Record<string, unknown> {
  const entry = getTextEntries(readChunks(png)).find((e) => e.keyword === keyword)
  if (!entry) throw new Error(`没有 ${keyword} 块`)
  return JSON.parse(base64ToUtf8(entry.text))
}

describeWithSample('样本卡：弗洛洛2.png', () => {
  let parsed: ParsedPngCard
  beforeAll(() => {
    parsed = parseCardPng(sampleBytes)
  })

  it('读出 V3 数据', () => {
    expect(parsed.chunkKey).toBe('ccv3')
    expect(parsed.sourceSpec).toBe('v3')
    expect(parsed.warnings).toEqual([])
    expect(parsed.card.data.name).toBe('弗洛洛')
    expect(parsed.card.data.alternate_greetings).toHaveLength(2)
    expect(parsed.card.data.character_book?.entries).toHaveLength(121)
  })

  it('导入后原样导出，ccv3 的 JSON 与原卡完全一致', () => {
    const exported = writeCardPng(parsed.image, parsed.card)
    expect(rawCardJson(exported, 'ccv3')).toStrictEqual(rawCardJson(sampleBytes, 'ccv3'))
  })

  it('chara 块写成 V2 标识，其余字段与原卡一致', () => {
    const exported = writeCardPng(parsed.image, parsed.card)
    const { spec, spec_version, ...rest } = rawCardJson(exported, 'chara')
    expect(spec).toBe('chara_card_v2')
    expect(spec_version).toBe('2.0')

    const { spec: _s, spec_version: _v, ...original } = rawCardJson(sampleBytes, 'ccv3')
    expect(rest).toStrictEqual(original)
  })

  it('图像数据块逐字节保留，文本块只有 chara 和 ccv3 各一个', () => {
    const exported = writeCardPng(parsed.image, parsed.card)
    const nonText = (png: Uint8Array) => readChunks(png).filter((c) => c.type !== 'tEXt')
    expect(nonText(exported)).toEqual(nonText(sampleBytes))
    expect(getTextEntries(readChunks(exported)).map((e) => e.keyword)).toEqual(['chara', 'ccv3'])
  })

  it('重复导出结果逐字节相同', () => {
    const once = writeCardPng(parsed.image, parsed.card)
    const twice = writeCardPng(once, parseCardPng(once).card)
    expect(twice).toEqual(once)
  })

  it('头像去掉卡片文本后变小，再导出与直接导出逐字节相同', () => {
    const stripped = stripCardPng(sampleBytes)
    expect(getTextEntries(readChunks(stripped))).toEqual([])
    expect(stripped.length).toBeLessThan(sampleBytes.length / 2)
    expect(writeCardPng(stripped, parsed.card)).toEqual(writeCardPng(parsed.image, parsed.card))
  })

  it('修改字段后导出再导入，改动保留且其他字段不受影响', () => {
    const card = structuredClone(parsed.card)
    card.data.name = '弗洛洛（改）'
    card.data.character_book!.entries[0].enabled = false

    const reparsed = parseCardPng(writeCardPng(parsed.image, card)).card
    expect(reparsed.data.name).toBe('弗洛洛（改）')
    expect(reparsed.data.character_book!.entries[0].enabled).toBe(false)
    expect(reparsed.data.description).toBe(parsed.card.data.description)
    expect(reparsed.data.extensions).toStrictEqual(parsed.card.data.extensions)
  })

  it('导出 JSON 再导入，与原卡一致', () => {
    const again = parseCardJson(serializeCardJson(parsed.card))
    expect(again.card).toStrictEqual(parsed.card)
  })

  it('不修改传入的对象', () => {
    const raw = rawCardJson(sampleBytes, 'ccv3')
    const snapshot = structuredClone(raw)
    normalizeToV3(raw)
    expect(raw).toStrictEqual(snapshot)
  })
})

describe('版本兼容', () => {
  it('V2 升级为 V3：只改规范标识、补 group_only_greetings，未知字段保留', () => {
    const v2 = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      name: 'Alice',
      unknown_top: { keep: true },
      data: {
        name: 'Alice',
        description: 'desc',
        personality: '',
        scenario: '',
        first_mes: 'hi',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['a'],
        creator: '',
        character_version: '',
        extensions: { regex_scripts: [{ maxDepth: 3 }], custom_tool: { x: 1 } },
        unknown_data_field: 42,
      },
    }
    const { card, sourceSpec, warnings } = normalizeToV3(v2)
    expect(sourceSpec).toBe('v2')
    expect(warnings).toEqual([])
    expect(card.spec).toBe('chara_card_v3')
    expect(card.spec_version).toBe('3.0')
    expect(card.data.group_only_greetings).toEqual([])
    expect(card.unknown_top).toEqual({ keep: true })
    expect(card.data.unknown_data_field).toBe(42)
    expect(card.data.extensions).toStrictEqual(v2.data.extensions)
  })

  it('V1 旧卡转换为 V3，顶层字段保留', () => {
    const v1 = { name: 'Bob', description: 'd', first_mes: 'yo', creatorcomment: 'note', talkativeness: '0.7' }
    const { card, sourceSpec, warnings } = normalizeToV3(v1)
    expect(sourceSpec).toBe('v1')
    expect(warnings).toHaveLength(1)
    expect(card.data.name).toBe('Bob')
    expect(card.data.creator_notes).toBe('note')
    expect(card.data.extensions).toEqual({ talkativeness: '0.7' })
    expect(card.creatorcomment).toBe('note')
  })

  it('V3 缺少必填字段时补全并提示，类型不对的字段不动', () => {
    const { card, warnings } = normalizeToV3({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: { name: 'C', tags: 'not-an-array' },
    })
    expect(card.data.description).toBe('')
    expect(card.data.tags).toBe('not-an-array')
    expect(warnings).toContain('补全了缺失的字段 description')
  })
})

describe('异常输入', () => {
  it('没有角色卡数据的 PNG', () => {
    const plain = encodeChunks(replaceTextEntries(readChunks(plainPng), ['chara', 'ccv3'], []))
    expect(() => parseCardPng(plain)).toThrow(CardParseError)
  })

  itWithSample('ccv3 损坏时退回读取 chara，并给出提示', () => {
    const chunks = readChunks(writeCardPng(sampleBytes, parseCardPng(sampleBytes).card))
    const broken = encodeChunks(replaceTextEntries(chunks, ['ccv3'], [{ keyword: 'ccv3', text: '@@@' }]))
    const parsed = parseCardPng(broken)
    expect(parsed.chunkKey).toBe('chara')
    expect(parsed.warnings[0]).toMatch(/ccv3 块解析失败/)
    expect(parsed.card.data.name).toBe('弗洛洛')
  })

  it('非法 JSON', () => {
    expect(() => parseCardJson('{not json')).toThrow(CardParseError)
  })

  it('无法识别的 JSON', () => {
    expect(() => parseCardJson('{"foo": 1}')).toThrow(/无法识别/)
  })
})
