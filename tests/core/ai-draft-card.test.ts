import { describe, expect, it } from 'vitest'
import { applyDraftToCard, buildDraftCardRequest, parseDraftCard, type DraftFieldKey } from '../../src/core/ai/tasks/draftCard'
import { createEmptyCard } from '../../src/core/card/create'
import { syncLegacyMirror } from '../../src/core/card/mirror'
import { AiError } from '../../src/core/ai/types'

const draftJson = {
  name: '艾琳',
  description: '{{char}}:\n  name: 艾琳',
  personality: '勇敢、嘴硬',
  scenario: '王都的骑士团驻地',
  first_mes: '“你来晚了。”{{char}}抱着手臂说。',
  alternate_greetings: ['雨夜，{{char}}敲响了你的门。', '  '],
  mes_example: '<START>\n{{user}}: 你好\n{{char}}: 哼。',
  tags: ['骑士', '傲娇', '骑士'],
  creator_notes: '适合日常向',
  lorebook: [{ type: 'place', comment: '王都', keys: '王都，首都', content: '王国的首都。' }],
}

describe('整卡草稿提示词', () => {
  it('包含设定、指定名字、写法骨架、开场白数量和世界书要求', () => {
    const { system, messages, json } = buildDraftCardRequest({
      concept: '傲娇的女骑士',
      name: '艾琳',
      style: { label: 'YAML', skeleton: '{{char}}:\n  name: ' },
      greetings: 3,
      withLorebook: true,
      instruction: '文风轻松',
    })
    expect(json).toBe(true)
    expect(system).toContain('{{user}}')
    const prompt = messages[0].content
    expect(prompt).toContain('傲娇的女骑士')
    expect(prompt).toContain('艾琳（必须使用这个名字）')
    expect(prompt).toContain('{{char}}:\n  name:')
    expect(prompt).toContain('一共 3 条')
    expect(prompt).toContain('"备选开场白 1", "备选开场白 2"')
    expect(prompt).toContain('"lorebook"')
    expect(prompt).toContain('文风轻松')
  })

  it('不要世界书时 JSON 结构里不出现 lorebook', () => {
    const { messages } = buildDraftCardRequest({ concept: 'x', style: { label: '纯文本' }, greetings: 1, withLorebook: false })
    expect(messages[0].content).not.toContain('"lorebook"')
    expect(messages[0].content).toContain('"alternate_greetings": []')
  })
})

describe('解析整卡草稿', () => {
  it('字段去空白、去空项、标签去重，世界书条目宽松解析', () => {
    const draft = parseDraftCard(`下面是角色卡：\n\`\`\`json\n${JSON.stringify(draftJson)}\n\`\`\``)
    expect(draft.name).toBe('艾琳')
    expect(draft.alternate_greetings).toEqual(['雨夜，{{char}}敲响了你的门。'])
    expect(draft.tags).toEqual(['骑士', '傲娇'])
    expect(draft.lorebook).toHaveLength(1)
    expect(draft.lorebook[0]).toMatchObject({ type: 'place', comment: '王都', keys: ['王都', '首都'] })
  })

  it('世界书格式不对时忽略，不影响其他字段', () => {
    const draft = parseDraftCard(JSON.stringify({ ...draftJson, lorebook: [{ type: 'place' }] }))
    expect(draft.lorebook).toEqual([])
    expect(draft.description).toContain('艾琳')
  })

  it('没有描述也没有开场白时报错', () => {
    expect(() => parseDraftCard('{"name":"A"}')).toThrow(AiError)
    expect(() => parseDraftCard('不是 JSON')).toThrow(AiError)
  })
})

describe('写入新卡', () => {
  it('只写勾选的项，世界书条目建成卡内世界书，镜像字段同步', () => {
    const draft = parseDraftCard(JSON.stringify(draftJson))
    const card = createEmptyCard('艾琳', 'yaml')
    const fields = new Set<DraftFieldKey>(['description', 'first_mes', 'alternate_greetings', 'tags', 'lorebook'])
    applyDraftToCard(card, draft, fields)
    syncLegacyMirror(card)
    expect(card.data.description).toBe(draft.description)
    expect(card.description).toBe(draft.description)
    expect(card.data.first_mes).toBe(draft.first_mes)
    expect(card.data.alternate_greetings).toEqual(draft.alternate_greetings)
    expect(card.data.tags).toEqual(['骑士', '傲娇'])
    expect(card.tags).toEqual(['骑士', '傲娇'])
    // 没勾选的不写
    expect(card.data.personality).toBe('')
    expect(card.data.character_book?.entries).toHaveLength(1)
    expect(card.data.character_book?.entries[0].keys).toEqual(['王都', '首都'])
  })
})
