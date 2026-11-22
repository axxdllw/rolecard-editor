import { describe, expect, it } from 'vitest'
import { extractJson } from '../../src/core/ai/json'
import {
  GENERATED_TYPE_LABELS,
  buildLorebookGenRequest,
  generatedToEntries,
  parseGeneratedEntries,
  type GeneratedEntry,
} from '../../src/core/ai/tasks/lorebookGen'
import { AiError } from '../../src/core/ai/types'
import { ENTRY_TEMPLATES } from '../../src/core/card/create'
import { createEntry, getDisplayIndex, getOrder, getPosition } from '../../src/core/lorebook/entry'

function expectBadOutput(fn: () => unknown): void {
  try {
    fn()
    expect.unreachable('预期应抛出 bad_output 错误')
  } catch (err) {
    expect(err).toBeInstanceOf(AiError)
    if (err instanceof AiError) {
      expect(err.kind).toBe('bad_output')
    }
  }
}

describe('extractJson', () => {
  it('提取代码块包裹的 JSON', () => {
    const raw = '```json\n{"entries":[{"comment":"艾琳"}]}\n```'
    expect(extractJson(raw)).toEqual({ entries: [{ comment: '艾琳' }] })
  })

  it('去掉前后的说明文字', () => {
    const raw = '好的，以下是提取结果：\n{"entries": [{"comment": "白银城"}]}\n如需补充请告诉我。'
    expect(extractJson(raw)).toEqual({ entries: [{ comment: '白银城' }] })

    const arrayRaw = '结果如下：[1, 2, 3] 以上就是全部内容。'
    expect(extractJson(arrayRaw)).toEqual([1, 2, 3])
  })

  it('容忍对象和数组末尾多余的逗号', () => {
    expect(extractJson('[1, 2,]')).toEqual([1, 2])
    expect(extractJson('{"a": 1, "b": [1, 2,],}')).toEqual({ a: 1, b: [1, 2] })
    expect(extractJson('{\n  "a": 1,\n  "b": {\n    "c": 2,\n  },\n}')).toEqual({ a: 1, b: { c: 2 } })
  })

  it('不误改字符串内部的逗号、括号和转义引号', () => {
    const raw = '说明如下：\n{"text": "含,逗号和{花括号}[中括号]以及\\",}]\\"", "arr": ["a,]", "b,}",],}\n完毕。'
    expect(extractJson(raw)).toEqual({
      text: '含,逗号和{花括号}[中括号]以及",}]"',
      arr: ['a,]', 'b,}'],
    })
  })

  it('说明文字含方括号且 JSON 在代码块里时也能正确提取', () => {
    const raw = '[提示] 下面是结果：\n```json\n{"ok": true,}\n```\n说明里还有 } 符号。'
    expect(extractJson(raw)).toEqual({ ok: true })
  })

  it('无法解析为 JSON 时抛出 bad_output 错误', () => {
    expectBadOutput(() => extractJson(''))
    expectBadOutput(() => extractJson('抱歉，我无法提取任何内容。'))
    expectBadOutput(() => extractJson('{"entries": [{"comment": "被截断'))
  })
})

describe('buildLorebookGenRequest', () => {
  it('开启 json 模式，并带上已有条目、上下文、额外要求和数量上限', () => {
    const req = buildLorebookGenRequest({
      source: '白银城是北境的要塞，由圣盾骑士团驻守。{{char}}曾在此服役。',
      instruction: '只要地点和组织，每条 200 字以内',
      existingTitles: ['圣盾骑士团', '  ', '北境'],
      context: {
        name: '艾琳',
        fields: [
          { label: '角色描述', text: '{{char}}是前骑士。' },
          { label: '场景', text: '   ' },
        ],
      },
      maxEntries: 8,
    })

    expect(req.json).toBe(true)
    expect(req.system).toContain('JSON')
    expect(req.system).toContain('{"entries":')
    expect(req.system).toContain('{{char}}')
    expect(req.system).toContain('{{user}}')
    expect(req.messages).toHaveLength(1)
    expect(req.messages[0].role).toBe('user')

    const prompt = req.messages[0].content
    expect(prompt).toContain('角色名：艾琳')
    expect(prompt).toContain('<角色描述>\n{{char}}是前骑士。\n</角色描述>')
    expect(prompt).not.toContain('<场景>')
    expect(prompt).toContain('圣盾骑士团')
    expect(prompt).toContain('北境')
    expect(prompt).toContain('最多生成 8 条')
    expect(prompt).toContain('只要地点和组织，每条 200 字以内')
    expect(prompt).toContain('白银城是北境的要塞')
  })

  it('默认最多生成 20 条', () => {
    const req = buildLorebookGenRequest({ source: '简短设定' })
    expect(req.messages[0].content).toContain('最多生成 20 条')
  })

  it('参考资料超过 30000 字时截断并注明省略字数', () => {
    const longSource = '字'.repeat(32500)
    const req = buildLorebookGenRequest({ source: longSource })
    expect(req.messages[0].content).toContain('后面省略 2500 字')
  })

  it('导出所有条目类型的中文标签', () => {
    expect(GENERATED_TYPE_LABELS).toEqual({
      character: '人物',
      place: '地点',
      organization: '组织',
      term: '名词',
      other: '其他',
    })
  })
})

describe('parseGeneratedEntries', () => {
  it('接受顶层 {entries:[...]} 和直接数组两种形态', () => {
    const wrapped = JSON.stringify({
      entries: [
        { type: 'character', comment: '艾琳', keys: ['艾琳', 'Irene'], content: '身份：骑士', constant: false },
      ],
    })
    const direct = JSON.stringify([
      { type: 'place', comment: '白银城', keys: ['白银城'], content: '位置：北境', constant: true },
    ])

    expect(parseGeneratedEntries(wrapped)).toEqual([
      { type: 'character', comment: '艾琳', keys: ['艾琳', 'Irene'], content: '身份：骑士', constant: false },
    ])
    expect(parseGeneratedEntries(direct)).toEqual([
      { type: 'place', comment: '白银城', keys: ['白银城'], content: '位置：北境', constant: true },
    ])
  })

  it('宽松处理 keys 字符串拆分、去重、未知 type、缺失 comment、非布尔 constant 和空内容过滤', () => {
    const raw = `\`\`\`json
{
  "entries": [
    {
      "type": "unknown_kind",
      "keys": " 黑曜塔，高塔、Obsidian Tower, 黑曜塔 , ",
      "content": "  一座古老的高塔。  ",
      "constant": "true"
    },
    {
      "type": "term",
      "comment": "魔力潮汐",
      "keys": [" 魔力潮汐 ", "", "魔力潮汐", "潮汐"],
      "content": "世界观现象",
      "constant": true
    },
    {
      "type": "place",
      "comment": "空内容应被过滤",
      "keys": ["空"],
      "content": "   "
    },
    "不是对象应被忽略"
  ],
}
\`\`\``

    expect(parseGeneratedEntries(raw)).toEqual([
      {
        type: 'other',
        comment: '黑曜塔',
        keys: ['黑曜塔', '高塔', 'Obsidian Tower'],
        content: '一座古老的高塔。',
        constant: false,
      },
      {
        type: 'term',
        comment: '魔力潮汐',
        keys: ['魔力潮汐', '潮汐'],
        content: '世界观现象',
        constant: true,
      },
    ])
  })

  it('缺少 entries 列表或全部条目无效时抛出 bad_output', () => {
    expectBadOutput(() => parseGeneratedEntries('{"items": []}'))
    expectBadOutput(() => parseGeneratedEntries('{"entries": []}'))
    expectBadOutput(() => parseGeneratedEntries('{"entries": [{"comment": "空", "keys": ["a"], "content": "  "}]}'))
  })
})

describe('generatedToEntries', () => {
  it('按类型套用模板的 position/order 和 constant，且 id 与 display_index 不冲突', () => {
    const existingEntry1 = createEntry([], { comment: '已有1', content: '内容1' })
    existingEntry1.id = 5
    existingEntry1.extensions.display_index = 10
    const existingEntry2 = createEntry([existingEntry1], { comment: '已有2', content: '内容2' })
    const existing = [existingEntry1, existingEntry2]
    const existingSnapshot = structuredClone(existing)

    const generated: GeneratedEntry[] = [
      { type: 'character', comment: '配角甲', keys: ['配角甲', '老甲'], content: '人物设定', constant: false },
      { type: 'place', comment: '白银城', keys: ['白银城'], content: '地点设定', constant: false },
      { type: 'organization', comment: '骑士团', keys: ['骑士团'], content: '组织设定', constant: false },
      { type: 'term', comment: '以太', keys: ['以太'], content: '名词设定', constant: false },
      { type: 'other', comment: '世界观总述', keys: [], content: '世界观概述', constant: true },
    ]

    const result = generatedToEntries(generated, existing)

    // 不修改传入的 existing
    expect(existing).toEqual(existingSnapshot)
    expect(result).toHaveLength(5)

    // 每种类型的 position 和 order 都与 ENTRY_TEMPLATES 一致
    const expectedTemplateIds = ['character', 'place', 'organization', 'term', 'blank']
    result.forEach((entry, idx) => {
      const tpl = ENTRY_TEMPLATES.find((t) => t.id === expectedTemplateIds[idx])
      expect(tpl).toBeDefined()
      if (!tpl) return
      expect(getPosition(entry)).toBe(tpl.init.position ?? 0)
      expect(getOrder(entry)).toBe(tpl.init.order ?? 100)
      expect(entry.comment).toBe(generated[idx].comment)
      expect(entry.keys).toEqual(generated[idx].keys)
      expect(entry.content).toBe(generated[idx].content)
      expect(entry.constant).toBe(generated[idx].constant)
    })

    // 特别核对 character 的 order 为 104，other 的 constant 为 true
    expect(getOrder(result[0])).toBe(104)
    expect(result[4].constant).toBe(true)

    // id 和 display_index 既不与 existing 冲突，也不彼此冲突
    const allEntries = [...existing, ...result]
    const ids = allEntries.map((e) => e.id)
    const displayIndices = allEntries.map((e, i) => getDisplayIndex(e, i))
    expect(new Set(ids).size).toBe(allEntries.length)
    expect(new Set(displayIndices).size).toBe(allEntries.length)
    expect(result.map((e) => e.id)).toEqual([7, 8, 9, 10, 11])
    expect(result.map((e, i) => getDisplayIndex(e, existing.length + i))).toEqual([12, 13, 14, 15, 16])
  })
})
