/**
 * 新建角色卡、描述模板、世界书条目模板。
 */
import type { CharacterCardV3, LorebookEntry } from './types'
import { createEntry, type NewEntryInit } from '../lorebook/entry'

export interface DescriptionTemplate {
  id: 'plain' | 'yaml' | 'wpp' | 'xml'
  label: string
  hint: string
  build: () => string
}

export const DESCRIPTION_TEMPLATES: DescriptionTemplate[] = [
  {
    id: 'plain',
    label: '纯文本',
    hint: '直接用自然语言描述，最自由',
    build: () => '{{char}} 是……\n\n外貌：\n\n性格：\n\n背景：\n',
  },
  {
    id: 'yaml',
    label: 'YAML',
    hint: '层级清楚，模型容易读懂，社区最常用',
    build: () =>
      [
        '{{char}}:',
        '  name: ',
        '  gender: ',
        '  age: ',
        '  identity: ',
        '  appearance:',
        '    - ',
        '  personality:',
        '    - ',
        '  background: ',
        '  relationship_with_{{user}}: ',
        '  speech_style:',
        '    - ',
        '  dialogue_examples:',
        '    - ""',
      ].join('\n') + '\n',
  },
  {
    id: 'wpp',
    label: 'W++',
    hint: '紧凑的属性写法，省 token',
    build: () =>
      [
        '[character("{{char}}")',
        '{',
        'Gender("")',
        'Age("")',
        'Appearance("" + "")',
        'Personality("" + "")',
        'Likes("" + "")',
        'Dislikes("" + "")',
        'Background("")',
        '}]',
      ].join('\n') + '\n',
  },
  {
    id: 'xml',
    label: 'XML 标签',
    hint: '用标签分段，便于模型区分不同部分',
    build: () =>
      [
        '<{{char}}>',
        '<basic_info>',
        '姓名：',
        '性别：',
        '年龄：',
        '身份：',
        '</basic_info>',
        '<appearance>',
        '</appearance>',
        '<personality>',
        '</personality>',
        '<background>',
        '</background>',
        '<relationship_with_{{user}}>',
        '</relationship_with_{{user}}>',
        '</{{char}}>',
      ].join('\n') + '\n',
  },
]

/** 新建一张空卡，结构与 ST 导出的卡一致（顶层保留 V1 镜像字段） */
export function createEmptyCard(name: string, templateId: DescriptionTemplate['id'] = 'plain', descriptionOverride?: string): CharacterCardV3 {
  const template = DESCRIPTION_TEMPLATES.find((t) => t.id === templateId) ?? DESCRIPTION_TEMPLATES[0]
  const description = descriptionOverride ?? template.build()
  const now = new Date()
  return {
    name,
    description,
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
    creatorcomment: '',
    avatar: 'none',
    talkativeness: '0.5',
    fav: false,
    tags: [],
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name,
      description,
      personality: '',
      scenario: '',
      first_mes: '',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      tags: [],
      creator: '',
      character_version: '',
      alternate_greetings: [],
      extensions: {
        talkativeness: '0.5',
        fav: false,
        world: '',
        depth_prompt: { prompt: '', depth: 4, role: 'system' },
      },
      group_only_greetings: [],
      creation_date: Math.floor(now.getTime() / 1000),
    },
    create_date: now.toISOString(),
  }
}

export interface EntryTemplate {
  id: string
  label: string
  hint: string
  init: NewEntryInit
}

export const ENTRY_TEMPLATES: EntryTemplate[] = [
  {
    id: 'blank',
    label: '空白条目',
    hint: '关键词触发，插在角色定义前',
    init: { position: 0, order: 100 },
  },
  {
    id: 'character',
    label: '人物',
    hint: '配角设定，提到名字时出现',
    init: {
      comment: '新人物',
      position: 0,
      order: 104,
      content: '人物名：\n  身份：\n  外貌：\n  性格：\n  与{{char}}的关系：\n  说话方式：\n',
    },
  },
  {
    id: 'place',
    label: '地点',
    hint: '场景地点，提到时出现',
    init: { comment: '新地点', position: 0, order: 100, content: '地点名：\n  位置：\n  环境与特征：\n  相关人物：\n' },
  },
  {
    id: 'organization',
    label: '组织',
    hint: '势力、团体、机构',
    init: { comment: '新组织', position: 0, order: 100, content: '组织名：\n  性质：\n  成员：\n  与{{char}}的关系：\n' },
  },
  {
    id: 'term',
    label: '名词',
    hint: '世界观术语解释',
    init: { comment: '新名词', position: 0, order: 100, content: '名词：\n  解释：\n' },
  },
  {
    id: 'rule',
    label: '写作规则（常驻）',
    hint: '每轮都发送，插在离最新消息很近的深度 1',
    init: { comment: '写作规则', constant: true, position: 4, depth: 1, order: 100, content: '<rules>\n- \n</rules>\n' },
  },
]

/**
 * 生成一对包裹标签条目：开标签（顺序 openOrder）和收标签（顺序 closeOrder），都是常驻。
 * 两者位置相同，夹在中间顺序、同一位置的条目会被包起来。
 */
export function createWrapperEntries(
  entries: LorebookEntry[],
  tag: string,
  options: { position: number; depth?: number; openOrder?: number; closeOrder?: number },
): [LorebookEntry, LorebookEntry] {
  const clean = tag.replace(/^<\/?|>$/g, '').trim()
  const open = createEntry(entries, {
    comment: `<${clean}> 开始`,
    content: `<${clean}>`,
    constant: true,
    position: options.position,
    depth: options.depth,
    order: options.openOrder ?? 0,
  })
  const close = createEntry([...entries, open], {
    comment: `</${clean}> 结束`,
    content: `</${clean}>`,
    constant: true,
    position: options.position,
    depth: options.depth,
    order: options.closeOrder ?? 999,
  })
  return [open, close]
}
