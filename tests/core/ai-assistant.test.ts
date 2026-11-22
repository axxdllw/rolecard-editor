import { describe, expect, it } from 'vitest'
import {
  ASSISTANT_FIELD_LABELS,
  AssistantEditError,
  applyEdit,
  buildAssistantRequest,
  parseAssistantReply,
  previewEdit,
  type AssistantEdit,
  type AssistantTurn,
} from '../../src/core/ai/tasks/assistant'
import type { CharacterCardV3, LorebookEntry } from '../../src/core/card/types'
import { createEntry, createLorebook, entryTitle } from '../../src/core/lorebook/entry'

function makeTestCard(options: { withLorebook?: boolean } = {}): CharacterCardV3 {
  const { withLorebook = true } = options
  const entry1 = createEntry([], {
    comment: '艾琳',
    keys: ['艾琳', 'Irene'],
    content: '身份：北境白银城的前任骑士长。\n特征：右颊有一道浅疤。',
    constant: false,
  })
  const entry2 = createEntry([entry1], {
    comment: '世界观总述',
    keys: [],
    content: '北境终年积雪，魔力潮汐每十年涨落一次。',
    constant: true,
  })
  const entry3 = createEntry([entry1, entry2], {
    comment: '废弃草稿',
    keys: ['草稿'],
    content: '一段暂时禁用的旧设定。',
    constant: false,
  })
  entry3.enabled = false
  // 模拟缺失 id 和字符串 id 的真实卡片数据
  delete entry1.id
  entry2.id = 'str-id-2'

  const book = createLorebook('北境世界书')
  book.entries.push(entry1, entry2, entry3)

  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: '塞拉',
      description: '姓名：{{char}}\n职业：边境药师\n性格冷静，不善言辞，但对伤者极其耐心。',
      personality: '外冷内热，务实谨慎',
      scenario: '暴雪夜，{{user}} 推开了边境药铺的木门。',
      first_mes: '“门关紧点，风会把药草吹潮。”{{char}} 头也没抬地碾着草药。',
      mes_example: '<START>\n{{user}}: 这伤能治吗？\n{{char}}: 坐下，别乱动。',
      system_prompt: '保持克制、写实的叙事风格。',
      post_history_instructions: '不要替 {{user}} 决定行动。',
      creator_notes: '适合慢热冒险向开局。',
      alternate_greetings: [
        '清晨的集市上，{{char}} 正在挑拣刚采来的雪莲。',
        '火堆旁，{{char}} 递过来一碗热汤。',
      ],
      tags: ['奇幻', '药师', '北境'],
      creator: 'test',
      character_version: '1.0',
      extensions: {},
      group_only_greetings: [],
      ...(withLorebook ? { character_book: book } : {}),
    },
  }
}

function expectEditError(fn: () => unknown, messageFragment?: string): void {
  try {
    fn()
    expect.unreachable('预期应抛出 AssistantEditError')
  } catch (err) {
    expect(err).toBeInstanceOf(AssistantEditError)
    if (err instanceof AssistantEditError) {
      expect(err.name).toBe('AssistantEditError')
      if (messageFragment) {
        expect(err.message).toContain(messageFragment)
      }
    }
  }
}

describe('parseAssistantReply', () => {
  it('按顺序切分文字与提案段，并支持多个提案代码块', () => {
    const reply = `先帮你调整一下性格描述，让语气更贴合人设。

\`\`\`card-edit
{
  "edits": [
    {"op": "set", "field": "personality", "value": "外冷内热，遇事冷静果断", "reason": "强化遇事果断的特点"}
  ]
}
\`\`\`

顺便再补充一条酒馆偶遇的备选开场白：

  \`\`\`CARD-EDIT
  {"edits": [{"op": "add_greeting", "value": "酒馆角落里，{{char}} 独自擦拭着药瓶。"}]}
  \`\`\`

你看这两处改得怎么样？`

    expect(parseAssistantReply(reply)).toEqual([
      { type: 'text', text: '先帮你调整一下性格描述，让语气更贴合人设。' },
      {
        type: 'edits',
        edits: [
          {
            op: 'set',
            target: { kind: 'field', field: 'personality' },
            value: '外冷内热，遇事冷静果断',
            reason: '强化遇事果断的特点',
          },
        ],
        dropped: 0,
      },
      { type: 'text', text: '顺便再补充一条酒馆偶遇的备选开场白：' },
      {
        type: 'edits',
        edits: [
          {
            op: 'add_greeting',
            value: '酒馆角落里，{{char}} 独自擦拭着药瓶。',
          },
        ],
        dropped: 0,
      },
      { type: 'text', text: '你看这两处改得怎么样？' },
    ])
  })

  it('未闭合的 card-edit 代码块会变成末尾的 pending 段', () => {
    const streaming = `我准备改一下场景：\n\n\`\`\`card-edit\n{"edits": [{"op": "set", "field": "scenario"`
    expect(parseAssistantReply(streaming)).toEqual([
      { type: 'text', text: '我准备改一下场景：' },
      { type: 'pending' },
    ])
  })

  it('JSON 损坏或顶层结构非法时返回 broken 段且不抛异常', () => {
    const reply = `尝试改一下：
\`\`\`card-edit
{"edits": [未闭合的字符串
\`\`\`
再来一个非提案对象：
\`\`\`card-edit
{"foo": "bar"}
\`\`\`
结束。`

    expect(parseAssistantReply(reply)).toEqual([
      { type: 'text', text: '尝试改一下：' },
      { type: 'broken' },
      { type: 'text', text: '再来一个非提案对象：' },
      { type: 'broken' },
      { type: 'text', text: '结束。' },
    ])
  })

  it('其他语言的代码块当作普通文字保留，不会被误切为提案', () => {
    const reply = `你可以参考这种 YAML 写法：

\`\`\`yaml
name: 塞拉
role: 药师
\`\`\`

下面是具体修改：

\`\`\`card-edit
{"edits": [{"op": "set", "field": "creator_notes", "value": "更新备注"}]}
\`\`\``

    expect(parseAssistantReply(reply)).toEqual([
      {
        type: 'text',
        text: '你可以参考这种 YAML 写法：\n\n```yaml\nname: 塞拉\nrole: 药师\n```\n\n下面是具体修改：',
      },
      {
        type: 'edits',
        edits: [
          {
            op: 'set',
            target: { kind: 'field', field: 'creator_notes' },
            value: '更新备注',
          },
        ],
        dropped: 0,
      },
    ])
  })

  it('正确处理 \\r\\n 换行并去掉首尾空行', () => {
    const reply =
      '\r\n\r\n第一行\r\n第二行\r\n\r\n  ```card-edit\r\n' +
      '{"edits":[{"op":"replace","field":"scenario","find":"暴雪夜","replace":"大雪夜"}]}\r\n' +
      '  ```  \r\n\r\n结尾说明\r\n\r\n'

    expect(parseAssistantReply(reply)).toEqual([
      { type: 'text', text: '第一行\r\n第二行' },
      {
        type: 'edits',
        edits: [
          {
            op: 'replace',
            target: { kind: 'field', field: 'scenario' },
            find: '暴雪夜',
            replace: '大雪夜',
          },
        ],
        dropped: 0,
      },
      { type: 'text', text: '结尾说明' },
    ])
  })

  it('接受三种顶层形态：{edits:[...]}、直接数组、单个提案对象', () => {
    const reply = `\`\`\`card-edit
{"edits": [{"op": "set", "field": "personality", "value": "A"}]}
\`\`\`
\`\`\`card-edit
[{"op": "set", "field": "scenario", "value": "B"}]
\`\`\`
\`\`\`card-edit
{"op": "add_greeting", "value": "C"}
\`\`\``

    expect(parseAssistantReply(reply)).toEqual([
      {
        type: 'edits',
        edits: [{ op: 'set', target: { kind: 'field', field: 'personality' }, value: 'A' }],
        dropped: 0,
      },
      {
        type: 'edits',
        edits: [{ op: 'set', target: { kind: 'field', field: 'scenario' }, value: 'B' }],
        dropped: 0,
      },
      {
        type: 'edits',
        edits: [{ op: 'add_greeting', value: 'C' }],
        dropped: 0,
      },
    ])
  })

  it('支持字段别名、数字字符串、keys 拆分、add_entry 宽松处理和允许空值清空/删除', () => {
    const reply = `\`\`\`card-edit
{
  "edits": [
    {"op": "set", "field": "first_message", "value": ""},
    {"op": "replace", "field": "alternate_greeting", "index": "1", "find": "热汤", "replace": ""},
    {"op": "set", "field": "greeting", "index": 0, "value": "新备选0"},
    {"op": "set", "field": "lorebook", "entry": "1", "title": " 艾琳 ", "value": "新条目内容"},
    {"op": "replace", "field": "world_info", "entry": 2, "title": "世界观总述", "find": "十年", "replace": "百年"},
    {
      "op": "add_entry",
      "type": "magic_system",
      "keys": " 霜花草，雪莲、霜花草 , ",
      "content": "  北境稀有药草。  ",
      "constant": "true"
    },
    {
      "op": "entry_meta",
      "entry": "1",
      "title": "艾琳",
      "comment": "  艾琳·温特  ",
      "keys": "艾琳、Irene, 骑士长"
    }
  ]
}
\`\`\``

    expect(parseAssistantReply(reply)).toEqual([
      {
        type: 'edits',
        edits: [
          { op: 'set', target: { kind: 'field', field: 'first_mes' }, value: '' },
          { op: 'replace', target: { kind: 'greeting', index: 1 }, find: '热汤', replace: '' },
          { op: 'set', target: { kind: 'greeting', index: 0 }, value: '新备选0' },
          { op: 'set', target: { kind: 'entry', entry: 1, title: '艾琳' }, value: '新条目内容' },
          {
            op: 'replace',
            target: { kind: 'entry', entry: 2, title: '世界观总述' },
            find: '十年',
            replace: '百年',
          },
          {
            op: 'add_entry',
            entry: {
              type: 'other',
              comment: '霜花草',
              keys: ['霜花草', '雪莲'],
              content: '北境稀有药草。',
              constant: false,
            },
          },
          {
            op: 'entry_meta',
            entry: 1,
            title: '艾琳',
            comment: '艾琳·温特',
            keys: ['艾琳', 'Irene', '骑士长'],
          },
        ],
        dropped: 0,
      },
    ])
  })

  it('丢弃不合法提案并计入 dropped，全部丢弃时仍返回 edits 段', () => {
    const reply = `\`\`\`card-edit
{
  "edits": [
    {"op": "set", "field": "unknown_field", "value": "x"},
    {"op": "set", "field": "description"},
    {"op": "replace", "field": "description", "find": "", "replace": "x"},
    {"op": "set", "field": "alternate_greetings", "index": -1, "value": "x"},
    {"op": "set", "field": "entry", "entry": 0, "title": "艾琳", "value": "x"},
    {"op": "add_entry", "type": "character", "comment": "空", "keys": ["空"], "content": "   "},
    {"op": "entry_meta", "entry": 1, "title": "艾琳"},
    "不是对象"
  ]
}
\`\`\``

    expect(parseAssistantReply(reply)).toEqual([
      {
        type: 'edits',
        edits: [],
        dropped: 8,
      },
    ])
  })
})

describe('previewEdit 与 applyEdit', () => {
  it('覆盖全部 op 和 target，preview 不修改 card，且 apply 后的结果与 preview.after 一致', () => {
    const card = makeTestCard()
    const snapshot = structuredClone(card)

    // 1. set field
    const setField: AssistantEdit = {
      op: 'set',
      target: { kind: 'field', field: 'personality' },
      value: '外冷内热，极度守信',
    }
    const p1 = previewEdit(card, setField)
    expect(card).toEqual(snapshot)
    expect(p1).toEqual({
      label: ASSISTANT_FIELD_LABELS.personality,
      before: '外冷内热，务实谨慎',
      after: '外冷内热，极度守信',
      isNew: false,
    })
    applyEdit(card, setField)
    expect(card.data.personality).toBe(p1.after)

    // 2. replace field
    const replaceField: AssistantEdit = {
      op: 'replace',
      target: { kind: 'field', field: 'description' },
      find: '边境药师',
      replace: '隐居北境的炼金药师',
    }
    const p2 = previewEdit(card, replaceField)
    expect(p2.label).toBe('角色描述')
    expect(p2.isNew).toBe(false)
    applyEdit(card, replaceField)
    expect(card.data.description).toBe(p2.after)
    expect(card.data.description).toContain('隐居北境的炼金药师')

    // 3. set / replace greeting
    const setGreeting: AssistantEdit = {
      op: 'set',
      target: { kind: 'greeting', index: 1 },
      value: '篝火旁，{{char}} 正在烘干潮湿的斗篷。',
    }
    const p3 = previewEdit(card, setGreeting)
    expect(p3.label).toBe('备选开场白 2')
    applyEdit(card, setGreeting)
    expect(card.data.alternate_greetings[1]).toBe(p3.after)

    const replaceGreeting: AssistantEdit = {
      op: 'replace',
      target: { kind: 'greeting', index: 0 },
      find: '雪莲',
      replace: '霜花草',
    }
    const p4 = previewEdit(card, replaceGreeting)
    expect(p4.label).toBe('备选开场白 1')
    applyEdit(card, replaceGreeting)
    expect(card.data.alternate_greetings[0]).toBe(p4.after)

    // 4. set / replace entry
    const replaceEntry: AssistantEdit = {
      op: 'replace',
      target: { kind: 'entry', entry: 1, title: '艾琳' },
      find: '浅疤',
      replace: '旧剑疤',
    }
    const p5 = previewEdit(card, replaceEntry)
    expect(p5.label).toBe('世界书条目「艾琳」')
    applyEdit(card, replaceEntry)
    expect(card.data.character_book?.entries[0].content).toBe(p5.after)

    const setEntry: AssistantEdit = {
      op: 'set',
      target: { kind: 'entry', entry: 2, title: '世界观总述' },
      value: '北境常年被魔力暴风雪笼罩。',
    }
    const p6 = previewEdit(card, setEntry)
    expect(p6.label).toBe('世界书条目「世界观总述」')
    applyEdit(card, setEntry)
    expect(card.data.character_book?.entries[1].content).toBe(p6.after)

    // 5. add_greeting
    const addGreeting: AssistantEdit = {
      op: 'add_greeting',
      value: '雨夜里，药铺门铃轻轻响了一声。',
    }
    const p7 = previewEdit(card, addGreeting)
    expect(p7).toEqual({
      label: '新备选开场白（第 3 条）',
      before: '',
      after: '雨夜里，药铺门铃轻轻响了一声。',
      isNew: true,
    })
    applyEdit(card, addGreeting)
    expect(card.data.alternate_greetings).toHaveLength(3)
    expect(card.data.alternate_greetings[2]).toBe(p7.after)
  })

  it('原文为 \\r\\n 时，set 和 replace 都会保留 \\r\\n 换行风格', () => {
    const card = makeTestCard()
    card.data.description = '第一行：旧设定\r\n第二行：保留内容\r\n第三行：末尾'

    const replaceEdit: AssistantEdit = {
      op: 'replace',
      target: { kind: 'field', field: 'description' },
      find: '第一行：旧设定\n第二行：保留内容',
      replace: '第一行：新设定\n第二行：已更新',
    }
    const previewReplace = previewEdit(card, replaceEdit)
    expect(previewReplace.after).toBe('第一行：新设定\r\n第二行：已更新\r\n第三行：末尾')
    applyEdit(card, replaceEdit)
    expect(card.data.description).toBe(previewReplace.after)

    const setEdit: AssistantEdit = {
      op: 'set',
      target: { kind: 'field', field: 'description' },
      value: '整段重写第一行\n整段重写第二行',
    }
    const previewSet = previewEdit(card, setEdit)
    expect(previewSet.after).toBe('整段重写第一行\r\n整段重写第二行')
    applyEdit(card, setEdit)
    expect(card.data.description).toBe(previewSet.after)
  })

  it('replace 匹配 0 次或多次时，previewEdit 和 applyEdit 都抛 AssistantEditError', () => {
    const card = makeTestCard()
    card.data.scenario = '风雪很大，风雪遮住了前路。'

    const notFound: AssistantEdit = {
      op: 'replace',
      target: { kind: 'field', field: 'scenario' },
      find: '晴空万里',
      replace: '阴雨绵绵',
    }
    expectEditError(() => previewEdit(card, notFound), '找不到要替换的内容')
    expectEditError(() => applyEdit(card, notFound), '找不到要替换的内容')

    const ambiguous: AssistantEdit = {
      op: 'replace',
      target: { kind: 'field', field: 'scenario' },
      find: '风雪',
      replace: '暴雪',
    }
    expectEditError(() => previewEdit(card, ambiguous), '出现了 2 次')
    expectEditError(() => applyEdit(card, ambiguous), '出现了 2 次')
  })

  it('世界书条目序号对不上但名字唯一时能兜底定位，找不到或重名时抛错', () => {
    const card = makeTestCard()
    // 艾琳实际在第 1 条，这里故意传 entry: 99
    const fallbackEdit: AssistantEdit = {
      op: 'replace',
      target: { kind: 'entry', entry: 99, title: '艾琳' },
      find: '骑士长',
      replace: '副团长',
    }
    const preview = previewEdit(card, fallbackEdit)
    expect(preview.label).toBe('世界书条目「艾琳」')
    applyEdit(card, fallbackEdit)
    expect(card.data.character_book?.entries[0].content).toBe(preview.after)

    // 找不到条目
    const missingEdit: AssistantEdit = {
      op: 'set',
      target: { kind: 'entry', entry: 1, title: '不存在的条目' },
      value: 'xxx',
    }
    expectEditError(() => previewEdit(card, missingEdit), '找不到世界书条目「不存在的条目」')
    expectEditError(() => applyEdit(card, missingEdit), '找不到世界书条目「不存在的条目」')

    // 重名且序号对不上时，无法唯一确定，应抛错
    const book = card.data.character_book
    expect(book).toBeDefined()
    if (!book) return
    const dup = createEntry(book.entries, {
      comment: '艾琳',
      keys: ['艾琳2'],
      content: '另一条同名设定',
    })
    book.entries.push(dup)
    const dupEdit: AssistantEdit = {
      op: 'set',
      target: { kind: 'entry', entry: 2, title: '艾琳' },
      value: '新内容',
    }
    expectEditError(() => previewEdit(card, dupEdit), '找不到世界书条目「艾琳」')
  })

  it('add_entry 在没有世界书的卡上会自动新建世界书，且 preview 不修改原卡', () => {
    const card = makeTestCard({ withLorebook: false })
    const snapshot = structuredClone(card)

    const edit: AssistantEdit = {
      op: 'add_entry',
      entry: {
        type: 'character',
        comment: '老莫',
        keys: ['老莫', '莫大叔', '老莫'],
        content: '身份：酒馆老板\n性格：豪爽健谈',
        constant: false,
      },
    }

    const preview = previewEdit(card, edit)
    expect(card).toEqual(snapshot)
    expect(card.data.character_book).toBeUndefined()
    expect(preview).toEqual({
      label: '新世界书条目「老莫」（人物）',
      before: '',
      after: '名称：老莫\n关键词：老莫、莫大叔\n\n身份：酒馆老板\n性格：豪爽健谈',
      isNew: true,
    })

    applyEdit(card, edit)
    const book = card.data.character_book
    expect(book).toBeDefined()
    if (!book) return
    expect(book.name).toBe('塞拉 的世界书')
    expect(book.entries).toHaveLength(1)
    const added = book.entries[0]
    expect(added.comment).toBe('老莫')
    expect(added.keys).toEqual(['老莫', '莫大叔'])
    expect(added.content).toBe('身份：酒馆老板\n性格：豪爽健谈')
  })

  it('entry_meta 支持改名称和/或关键词（去空白、去空、去重），preview 不修改 card', () => {
    const card = makeTestCard()
    const snapshot = structuredClone(card)

    const metaEdit: AssistantEdit = {
      op: 'entry_meta',
      entry: 1,
      title: '艾琳',
      comment: '  艾琳·温特  ',
      keys: [' 艾琳 ', '', 'Irene', '艾琳', '白银骑士'],
    }

    const preview = previewEdit(card, metaEdit)
    expect(card).toEqual(snapshot)
    expect(preview).toEqual({
      label: '世界书条目「艾琳」',
      before: '名称：艾琳\n关键词：艾琳、Irene',
      after: '名称：艾琳·温特\n关键词：艾琳、Irene、白银骑士',
      isNew: false,
    })

    applyEdit(card, metaEdit)
    const updated = card.data.character_book?.entries[0]
    expect(updated).toBeDefined()
    if (!updated) return
    expect(updated.comment).toBe('艾琳·温特')
    expect(updated.keys).toEqual(['艾琳', 'Irene', '白银骑士'])
    expect(entryTitle(updated, 0)).toBe('艾琳·温特')
  })

  it('备选开场白越界抛错；字段缺失按空字符串处理', () => {
    const card = makeTestCard()
    expectEditError(
      () =>
        previewEdit(card, {
          op: 'set',
          target: { kind: 'greeting', index: 5 },
          value: '越界',
        }),
      '备选开场白 6',
    )

    // 模拟缺失文本字段
    delete (card.data as Record<string, unknown>)['creator_notes']
    const setMissing: AssistantEdit = {
      op: 'set',
      target: { kind: 'field', field: 'creator_notes' },
      value: '补上的备注',
    }
    const preview = previewEdit(card, setMissing)
    expect(preview.before).toBe('')
    expect(preview.after).toBe('补上的备注')
    applyEdit(card, setMissing)
    expect(card.data.creator_notes).toBe('补上的备注')
  })
})

describe('buildAssistantRequest', () => {
  it('system 包含提案说明、字段全文、备选开场白、世界书目录（含常驻与禁用标记）和 focusEntry 全文', () => {
    const card = makeTestCard()
    const req = buildAssistantRequest({
      card,
      history: [],
      message: '帮我看看艾琳的条目有没有需要补充的',
      focusEntry: 1,
    })

    expect(req.system).toContain('card-edit')
    expect(req.system).toContain('{{char}}')
    expect(req.system).toContain('{{user}}')
    expect(req.system).toContain('# 当前角色卡')
    expect(req.system).toContain('角色名：塞拉')
    expect(req.system).toContain('标签：奇幻、药师、北境')
    expect(req.system).toContain('边境药师')
    expect(req.system).toContain('外冷内热，务实谨慎')
    expect(req.system).toContain('备选开场白 index=0')
    expect(req.system).toContain('备选开场白 index=1')

    expect(req.system).toContain('# 世界书目录')
    const entries = card.data.character_book?.entries ?? []
    expect(entries).toHaveLength(3)
    expect(req.system).toContain(`[#1] 艾琳 | 关键词：艾琳、Irene | 约 ${entries[0].content.length} 字`)
    expect(req.system).toContain(`[#2] 世界观总述 | 关键词：（无） | 常驻 | 约 ${entries[1].content.length} 字`)
    expect(req.system).toContain(`[#3] 废弃草稿 | 关键词：草稿 | 已禁用 | 约 ${entries[2].content.length} 字`)

    expect(req.system).toContain('# 用户正在看的世界书条目')
    expect(req.system).toContain('[#1] 艾琳')
    expect(req.system).toContain('右颊有一道浅疤')
    expect(req.system).not.toContain('# 世界书全文')

    expect(req.messages).toEqual([{ role: 'user', content: '帮我看看艾琳的条目有没有需要补充的' }])
  })

  it('没有世界书时给出明确提示，且字段超长会被截断', () => {
    const card = makeTestCard({ withLorebook: false })
    card.data.description = '描'.repeat(13500)

    const req = buildAssistantRequest({
      card,
      history: [],
      message: '帮我精简描述',
      focusEntry: 1,
      fullLorebook: true,
    })

    expect(req.system).toContain('（这张卡没有世界书）')
    expect(req.system).toContain('后面省略 1500 字')
    expect(req.system).not.toContain('# 用户正在看的世界书条目')
    expect(req.system).not.toContain('# 世界书全文')
  })

  it('fullLorebook 为 true 时带上世界书全文，并在超过 60000 字时省略后续条目', () => {
    const card = makeTestCard({ withLorebook: false })
    const book = createLorebook('大世界书')
    const entries: LorebookEntry[] = []
    for (let i = 1; i <= 4; i++) {
      const e = createEntry(entries, {
        comment: `条目${i}`,
        keys: [`词${i}`],
        content: `第${i}条：` + '内'.repeat(24996),
      })
      entries.push(e)
    }
    book.entries = entries
    card.data.character_book = book

    const req = buildAssistantRequest({
      card,
      history: [],
      message: '检查世界书一致性',
      fullLorebook: true,
    })

    expect(req.system).toContain('# 世界书全文')
    expect(req.system).toContain('第1条：')
    expect(req.system).toContain('第2条：')
    expect(req.system).not.toContain('第3条：')
    expect(req.system).not.toContain('第4条：')
    expect(req.system).toContain('省略了 2 条')
  })

  it('历史总字数超过 40000 时从最早开始丢弃，丢弃后首条必须是 user，且本次消息永远保留在最后', () => {
    const card = makeTestCard()
    const history: AssistantTurn[] = [
      { role: 'user', content: '最早用户：' + 'a'.repeat(25000) },
      { role: 'assistant', content: '最早回复：' + 'b'.repeat(20000) },
      { role: 'user', content: '近期用户：' + 'c'.repeat(5000) },
      { role: 'assistant', content: '近期回复：' + 'd'.repeat(5000) },
    ]
    const currentMessage = '本次消息：' + 'e'.repeat(45000)

    const req = buildAssistantRequest({
      card,
      history,
      message: currentMessage,
    })

    // 丢掉最早用户后剩 30000+，首条变为最早回复（assistant），再丢一条使首条为 user
    expect(req.messages).toHaveLength(3)
    expect(req.messages[0].role).toBe('user')
    expect(req.messages[0].content).toBe(history[2].content)
    expect(req.messages[1]).toEqual(history[3])
    expect(req.messages[2]).toEqual({ role: 'user', content: currentMessage })
  })
})
