/**
 * 生成角色卡：根据整理好的资料写卡的各个字段。两种卡：
 * - character：单角色卡，选书中一个人物当 {{char}}，其他人物和地点进世界书；
 * - world：世界卡，{{char}} 是叙述者，扮演书中所有人物，人物全部进世界书。
 * 输出结构和“一句话生成整卡草稿”一样（DraftCard），另外多一段前情提要，放进世界书常驻条目。
 */
import { extractJson } from '../ai/json'
import type { DraftCard } from '../ai/tasks/draftCard'
import type { GeneratedEntry } from '../ai/tasks/lorebookGen'
import { AiError, type AiMessage } from '../ai/types'

export type NovelCardMode = 'character' | 'world'

export interface NovelCardInput {
  mode: NovelCardMode
  bookTitle: string
  author?: string
  /** 单角色卡的主角：名字、别名、各块资料（formatEntityNotes 的结果，含原话） */
  main?: { name: string; aliases: string[]; notes: string }
  /** 世界卡的名字（默认书名） */
  worldName?: string
  /** 书中其他人物一览，一行一个“名字：一句话身份” */
  cast: string
  /** 世界观条目，一行一条 */
  world: string
  /** 截至时间点的各段剧情概要（按顺序） */
  story: string
  /** 时间点的说明，如“第 30 章之后” */
  timePoint: string
  /** {{user}} 的身份 */
  userRole: string
  /** 描述的写法，如“YAML”；skeleton 是骨架示例 */
  style: { label: string; skeleton?: string }
  /** 开场白总数（含主开场白），1～5 */
  greetings: number
  instruction?: string
}

export interface NovelCardDraft extends Omit<DraftCard, 'lorebook'> {
  /** 截至时间点的前情提要 */
  story_so_far: string
}

const COMMON_RULES = `- 没有特别要求时用简体中文写。
- 只输出一个 JSON 对象，不要任何解释，不要用代码块包裹。`

const CHARACTER_SYSTEM = `你是 SillyTavern（酒馆）角色卡的作者，根据整理好的小说资料，把书中的一个人物做成可以直接聊天的角色卡。

写作要求：
- 用 {{char}} 指代这个角色，{{user}} 指代用户扮演的人；不要写死用户的名字和性别。
- 忠于原著：身份、性格、说话方式、经历、人际关系都要和资料一致；可以合理补全细节，但不要和资料冲突，也不要编造重大设定。
- 时间点：{{char}} 的状态、知道的事、人际关系都以“当前时间点”为准，不要写进之后的剧情。
- 描述（description）按指定写法组织，写清身份、外貌、性格、背景经历、能力、说话方式、重要人际关系，以及和 {{user}} 的关系；具体、可演，不写空话。书中其他人物、地点、组织另有世界书条目，描述里只写和 {{char}} 直接相关的部分。
- 开场白：在当前时间点的情境里展开，{{user}} 以指定身份出场；用叙述加对话呈现 {{char}} 的言行，模仿原著的文风；不要替 {{user}} 说话、做决定或描写 {{user}} 的心理；每条开场白给出不同的开局情境。
- 示例对话（mes_example）用酒馆格式：每段以 <START> 开头，下面是 “{{user}}: ……” 和 “{{char}}: ……” 交替的几轮，语气参考资料里的原话。
- personality 一两句话；scenario 写当前所处的情境；creator_notes 给使用者看，说明出自哪本书、时间点和玩法建议；story_so_far 写截至当前时间点的前情提要（300～600 字），会放进世界书的常驻条目。
${COMMON_RULES}`

const WORLD_SYSTEM = `你是 SillyTavern（酒馆）角色卡的作者，根据整理好的小说资料，把这本书的世界做成一张“世界卡”：{{char}} 不是书中某个人，而是这个世界的叙述者，负责描写环境、扮演书中的所有人物、推进剧情；{{user}} 以指定身份进入这个世界。

写作要求：
- 用 {{user}} 指代用户扮演的人，不要写死用户的名字和性别。
- 描述（description）按指定写法组织，写清：世界观总述、时代背景、主要势力格局、当前时间点的局势、叙述规则（{{char}} 用第三人称叙述，扮演除 {{user}} 以外的所有人物，人物言行忠于原著；不替 {{user}} 说话、做决定或描写 {{user}} 的心理；剧情可以偏离原著，但人物性格和世界规则保持一致）。书中人物、地点、组织另有世界书条目，描述里只写概览。
- 时间点：局势、人物状态都以“当前时间点”为准，不要写进之后的剧情。
- 开场白：在当前时间点的情境里展开，{{user}} 以指定身份出场，模仿原著的文风；每条开场白给出不同的开局情境（不同地点或不同人物）。
- 示例对话（mes_example）用酒馆格式：每段以 <START> 开头，下面是 “{{user}}: ……” 和 “{{char}}: ……” 交替的几轮，展示叙述者如何描写场景、扮演书中人物。
- name 用世界或书的名字；personality 写叙述风格；scenario 写当前局势；creator_notes 给使用者看，说明出自哪本书、时间点和玩法建议；story_so_far 写截至当前时间点的前情提要（300～600 字），会放进世界书的常驻条目。
${COMMON_RULES}`

/** 各部分资料的上限（字），防止整本长书把请求撑爆 */
const LIMITS = { main: 30000, cast: 6000, world: 6000, story: 16000 }

function clip(text: string, limit: number): string {
  const t = text.trim()
  return t.length > limit ? `${t.slice(0, limit)}\n……（后面省略 ${t.length - limit} 字）` : t
}

/** 剧情概要太长时保留开头和最近的部分（最近的更重要） */
function clipStory(text: string, limit: number): string {
  const t = text.trim()
  if (t.length <= limit) return t
  const head = Math.floor(limit * 0.25)
  return `${t.slice(0, head)}\n……（中间省略）……\n${t.slice(t.length - (limit - head))}`
}

function schemaText(input: NovelCardInput): string {
  const alt = Math.max(0, Math.min(4, input.greetings - 1))
  return [
    '{',
    `  "name": "${input.mode === 'character' ? '角色名' : '世界卡的名字'}",`,
    '  "description": "描述，按指定写法",',
    '  "personality": "性格摘要",',
    '  "scenario": "场景",',
    '  "first_mes": "主开场白",',
    `  "alternate_greetings": [${Array.from({ length: alt }, (_, i) => `"备选开场白 ${i + 1}"`).join(', ')}],`,
    '  "mes_example": "<START>\\n{{user}}: ……\\n{{char}}: ……",',
    '  "tags": ["3～6 个标签"],',
    '  "creator_notes": "创作者备注",',
    '  "story_so_far": "前情提要"',
    '}',
  ].join('\n')
}

export function buildNovelCardRequest(input: NovelCardInput): { system: string; messages: AiMessage[]; json: true } {
  const parts: string[] = []
  parts.push(`# 书名：《${input.bookTitle.trim() || '未命名'}》${input.author?.trim() ? `（作者：${input.author.trim()}）` : ''}`)
  parts.push(`# 当前时间点\n${input.timePoint.trim() || '资料的最后一段之后'}`)
  parts.push(`# {{user}} 的身份\n${input.userRole.trim() || '由用户自己扮演的原创人物，身份在开场白里自然交代'}`)

  if (input.mode === 'character' && input.main) {
    const aliases = input.main.aliases.length ? `（别名：${input.main.aliases.join('、')}）` : ''
    parts.push(`# {{char}}：${input.main.name}${aliases}\n名字必须用“${input.main.name}”。下面是各章节整理出的资料（按故事顺序）：\n<资料>\n${clip(input.main.notes, LIMITS.main)}\n</资料>`)
  } else if (input.mode === 'world') {
    const name = input.worldName?.trim() || input.bookTitle.trim()
    if (name) parts.push(`# 世界卡的名字\n${name}（name 必须用这个）`)
  }
  if (input.cast.trim()) parts.push(`# 书中${input.mode === 'character' ? '其他' : '主要'}人物（世界书里有各自的条目）\n${clip(input.cast, LIMITS.cast)}`)
  if (input.world.trim()) parts.push(`# 世界观\n${clip(input.world, LIMITS.world)}`)
  if (input.story.trim()) parts.push(`# 前情（截至当前时间点的各段剧情概要）\n${clipStory(input.story, LIMITS.story)}`)

  parts.push(
    `# 描述的写法：${input.style.label}${input.style.skeleton?.trim() ? `\n参考下面的骨架组织 description（可以增加小节）：\n${input.style.skeleton.trim()}` : ''}`,
  )
  parts.push(`# 开场白\n一共 ${input.greetings} 条：first_mes 一条，其余放进 alternate_greetings。`)
  if (input.instruction?.trim()) parts.push(`# 其他要求\n${input.instruction.trim()}`)
  parts.push(`# 输出格式\n只输出下面结构的 JSON 对象：\n${schemaText(input)}`)

  return {
    system: input.mode === 'character' ? CHARACTER_SYSTEM : WORLD_SYSTEM,
    messages: [{ role: 'user', content: parts.join('\n\n') }],
    json: true,
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function strList(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
}

export function parseNovelCard(text: string): NovelCardDraft {
  const json = extractJson(text)
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new AiError('bad_output', '模型返回的不是角色卡格式，可以重新生成试试')
  }
  const o = json as Record<string, unknown>
  const draft: NovelCardDraft = {
    name: str(o.name),
    description: str(o.description),
    personality: str(o.personality),
    scenario: str(o.scenario),
    first_mes: str(o.first_mes),
    alternate_greetings: strList(o.alternate_greetings),
    mes_example: str(o.mes_example),
    tags: [...new Set(strList(o.tags))],
    creator_notes: str(o.creator_notes),
    story_so_far: str(o.story_so_far),
  }
  if (!draft.description && !draft.first_mes) {
    throw new AiError('bad_output', '模型没有生成描述和开场白，可以重新生成试试')
  }
  return draft
}

export const STORY_ENTRY_TITLE = '前情提要'

/**
 * 拼成通用的整卡草稿（可以直接交给 applyDraftToCard / createCardFromDraft）：
 * 世界书 = 合成好的条目 + 前情提要（常驻，可选）。
 */
export function toDraftCard(draft: NovelCardDraft, lorebook: GeneratedEntry[], options: { storyEntry: boolean }): DraftCard {
  const { story_so_far: story, ...fields } = draft
  const entries = [...lorebook]
  if (options.storyEntry && story) {
    entries.push({ type: 'other', comment: STORY_ENTRY_TITLE, keys: [], content: story, constant: true })
  }
  return { ...fields, lorebook: entries }
}
