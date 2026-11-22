/**
 * 一句话生成整卡草稿：根据设定概要生成描述、性格、场景、开场白、示例对话、标签，可选顺带生成世界书条目。
 * 输出 JSON，解析后由用户逐项勾选，再写进新卡。
 */
import type { CharacterCardV3 } from '../../card/types'
import { createLorebook } from '../../lorebook/entry'
import { extractJson } from '../json'
import { AiError, type AiMessage } from '../types'
import { generatedToEntries, parseGeneratedEntries, type GeneratedEntry } from './lorebookGen'

export interface DraftCardInput {
  /** 设定概要：一句话或一段话 */
  concept: string
  /** 指定的角色名；不填时由模型起名 */
  name?: string
  /** 描述的写法，如“YAML”；skeleton 是该写法的骨架示例 */
  style: { label: string; skeleton?: string }
  /** 开场白总数（含主开场白），1～5 */
  greetings: number
  /** 是否顺带生成世界书条目 */
  withLorebook: boolean
  /** 其他要求：文风、篇幅、语言等 */
  instruction?: string
}

export interface DraftCard {
  name: string
  description: string
  personality: string
  scenario: string
  first_mes: string
  alternate_greetings: string[]
  mes_example: string
  tags: string[]
  creator_notes: string
  lorebook: GeneratedEntry[]
}

export type DraftFieldKey = Exclude<keyof DraftCard, 'name'>

export const DRAFT_FIELDS: Array<{ key: DraftFieldKey; label: string }> = [
  { key: 'description', label: '角色描述' },
  { key: 'personality', label: '性格摘要' },
  { key: 'scenario', label: '场景' },
  { key: 'first_mes', label: '主开场白' },
  { key: 'alternate_greetings', label: '备选开场白' },
  { key: 'mes_example', label: '示例对话' },
  { key: 'tags', label: '标签' },
  { key: 'creator_notes', label: '创作者备注' },
  { key: 'lorebook', label: '世界书条目' },
]

const SYSTEM_PROMPT = `你是 SillyTavern（酒馆）角色卡的作者，根据用户给的设定概要写一张完整、可直接使用的角色卡。

写作要求：
1. 角色卡里用 {{char}} 指代角色本人、{{user}} 指代用户扮演的人，不要写死用户的名字和性别。
2. 描述（description）按用户指定的写法组织，写清身份、外貌、性格、背景、说话方式、与 {{user}} 的关系等；具体、可演，不写空话。
3. 开场白是角色在聊天开头说的第一段话：交代场景，用叙述加对话呈现 {{char}} 的言行；不要替 {{user}} 说话、做决定或描写 {{user}} 的心理；每条开场白给出不同的开局情境。
4. 示例对话（mes_example）用酒馆格式：每段以 <START> 开头，下面是 “{{user}}: ……” 和 “{{char}}: ……” 交替的几轮，体现角色的语气。
5. 性格摘要（personality）一两句话；场景（scenario）写当前所处的情境；创作者备注（creator_notes）给使用者看，简述角色和玩法建议。
6. 没有特别要求时用简体中文写。
7. 只输出一个 JSON 对象，不要任何解释，不要用代码块包裹。`

function schemaText(input: DraftCardInput): string {
  const alt = Math.max(0, Math.min(4, input.greetings - 1))
  const lines = [
    '{',
    '  "name": "角色名",',
    '  "description": "角色描述，按指定写法",',
    '  "personality": "性格摘要",',
    '  "scenario": "场景",',
    '  "first_mes": "主开场白",',
    `  "alternate_greetings": [${Array.from({ length: alt }, (_, i) => `"备选开场白 ${i + 1}"`).join(', ')}],`,
    '  "mes_example": "<START>\\n{{user}}: ……\\n{{char}}: ……",',
    '  "tags": ["3～6 个标签"],',
    `  "creator_notes": "创作者备注"${input.withLorebook ? ',' : ''}`,
  ]
  if (input.withLorebook) {
    lines.push(
      '  "lorebook": [{"type": "character|place|organization|term|other", "comment": "条目名", "keys": ["触发关键词"], "content": "条目内容", "constant": false}]',
    )
  }
  lines.push('}')
  return lines.join('\n')
}

export function buildDraftCardRequest(input: DraftCardInput): { system: string; messages: AiMessage[]; json: true } {
  const parts: string[] = [`# 设定概要\n${input.concept.trim()}`]
  if (input.name?.trim()) parts.push(`# 角色名\n${input.name.trim()}（必须使用这个名字）`)
  parts.push(
    `# 描述的写法：${input.style.label}${input.style.skeleton?.trim() ? `\n参考下面的骨架组织 description（可以增加小节）：\n${input.style.skeleton.trim()}` : ''}`,
  )
  parts.push(`# 开场白\n一共 ${input.greetings} 条：first_mes 一条，其余放进 alternate_greetings。`)
  if (input.withLorebook) {
    parts.push(
      '# 世界书\n另外为设定里重要的配角、地点、组织、名词各写一条世界书条目（3～10 条），放进 lorebook。每条一个主题；关键词用实际会出现的称呼，2～5 个；内容用简洁的设定式写法。角色本人的设定写在 description 里，不要再做成条目。',
    )
  }
  if (input.instruction?.trim()) parts.push(`# 其他要求\n${input.instruction.trim()}`)
  parts.push(`# 输出格式\n只输出下面结构的 JSON 对象：\n${schemaText(input)}`)
  return { system: SYSTEM_PROMPT, messages: [{ role: 'user', content: parts.join('\n\n') }], json: true }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function strList(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
}

export function parseDraftCard(text: string): DraftCard {
  const json = extractJson(text)
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new AiError('bad_output', '模型返回的不是角色卡格式，可以重新生成试试')
  }
  const o = json as Record<string, unknown>
  let lorebook: GeneratedEntry[] = []
  if (Array.isArray(o.lorebook) && o.lorebook.length > 0) {
    try {
      lorebook = parseGeneratedEntries(JSON.stringify({ entries: o.lorebook }))
    } catch {
      // 条目格式不对就当没生成，不影响其他字段
      lorebook = []
    }
  }
  const draft: DraftCard = {
    name: str(o.name),
    description: str(o.description),
    personality: str(o.personality),
    scenario: str(o.scenario),
    first_mes: str(o.first_mes),
    alternate_greetings: strList(o.alternate_greetings),
    mes_example: str(o.mes_example),
    tags: [...new Set(strList(o.tags))],
    creator_notes: str(o.creator_notes),
    lorebook,
  }
  if (!draft.description && !draft.first_mes) {
    throw new AiError('bad_output', '模型没有生成描述和开场白，可以重新生成试试')
  }
  return draft
}

/** 草稿里某一项是否有内容（没内容的项在界面上不勾选） */
export function draftFieldFilled(draft: DraftCard, key: DraftFieldKey): boolean {
  const value = draft[key]
  return Array.isArray(value) ? value.length > 0 : value.trim().length > 0
}

/**
 * 把选中的草稿项写进卡（直接修改传入的卡，可用在 Immer 草稿上）。
 * 写的是 data 下的字段；顶层 V1 镜像字段由调用方用 syncLegacyMirror 同步。
 */
export function applyDraftToCard(card: CharacterCardV3, draft: DraftCard, fields: ReadonlySet<DraftFieldKey>): void {
  const data = card.data
  for (const { key } of DRAFT_FIELDS) {
    if (!fields.has(key) || !draftFieldFilled(draft, key)) continue
    if (key === 'lorebook') {
      const book = data.character_book ?? createLorebook(`${data.name} 的世界书`)
      book.entries.push(...generatedToEntries(draft.lorebook, book.entries))
      data.character_book = book
    } else if (key === 'alternate_greetings' || key === 'tags') {
      data[key] = [...draft[key]]
    } else {
      data[key] = draft[key]
    }
  }
}
