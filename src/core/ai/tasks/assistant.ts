/**
 * 侧栏对话助手：构造带角色卡上下文的多轮对话请求、解析回复中的修改提案、预览与安全应用提案。
 * 只负责纯逻辑与数据变换，界面展示和流式调用由上层完成。
 */
import type { CharacterCardV3, LorebookEntry } from '../../card/types'
import { createLorebook, entryTitle } from '../../lorebook/entry'
import { extractJson } from '../json'
import type { AiMessage } from '../types'
import {
  GENERATED_TYPE_LABELS,
  generatedToEntries,
  type GeneratedEntry,
  type GeneratedEntryType,
} from './lorebookGen'
import { matchLineEndings } from './rewrite'

/** 助手能改的文本字段（card.data 下的键） */
export type AssistantField =
  | 'description'
  | 'personality'
  | 'scenario'
  | 'first_mes'
  | 'mes_example'
  | 'system_prompt'
  | 'post_history_instructions'
  | 'creator_notes'

export const ASSISTANT_FIELD_LABELS: Record<AssistantField, string> = {
  description: '角色描述',
  personality: '性格',
  scenario: '场景',
  first_mes: '主开场白',
  mes_example: '示例对话',
  system_prompt: '系统提示词',
  post_history_instructions: '历史后指令',
  creator_notes: '创作者备注',
}

/** 提案作用的位置 */
export type EditTarget =
  | { kind: 'field'; field: AssistantField }
  /** 备选开场白，index 从 0 开始 */
  | { kind: 'greeting'; index: number }
  /** 世界书条目的内容。entry 是上下文目录里的序号（从 1 开始），title 是目录里显示的条目名，用来核对 */
  | { kind: 'entry'; entry: number; title: string }

export type AssistantEdit =
  /** 整段替换为 value */
  | { op: 'set'; target: EditTarget; value: string; reason?: string }
  /** 局部替换：find 必须在原文里恰好出现一次 */
  | { op: 'replace'; target: EditTarget; find: string; replace: string; reason?: string }
  /** 追加一条备选开场白 */
  | { op: 'add_greeting'; value: string; reason?: string }
  /** 新增世界书条目 */
  | { op: 'add_entry'; entry: GeneratedEntry; reason?: string }
  /** 改世界书条目的名字和/或关键词（至少有一项） */
  | { op: 'entry_meta'; entry: number; title: string; comment?: string; keys?: string[]; reason?: string }

/** 回复分段：文字、提案、还在生成中的提案、解析失败的提案块 */
export type AssistantSegment =
  | { type: 'text'; text: string }
  | { type: 'edits'; edits: AssistantEdit[]; dropped: number }
  | { type: 'pending' }
  | { type: 'broken' }

export interface AssistantTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface AssistantRequestInput {
  card: CharacterCardV3
  /** 之前的对话（不含本次用户消息），按时间顺序 */
  history: AssistantTurn[]
  /** 本次用户消息 */
  message: string
  /** 用户正在看的世界书条目（目录序号，从 1 开始），给全文 */
  focusEntry?: number
  /** 带上整本世界书全文 */
  fullLorebook?: boolean
}

export class AssistantEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssistantEditError'
  }
}

export interface EditPreview {
  /** 显示给用户的位置名，如“角色描述”“备选开场白 2”“世界书条目「艾琳」”“新世界书条目「艾琳」（人物）” */
  label: string
  before: string
  after: string
  /** 新增（add_greeting / add_entry）时为 true，before 为空字符串 */
  isNew: boolean
}

/** 展示给模型的字段顺序 */
const ASSISTANT_FIELDS: readonly AssistantField[] = [
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
  'creator_notes',
]

const ASSISTANT_FIELD_SET = new Set<string>(ASSISTANT_FIELDS)
const VALID_ENTRY_TYPES = new Set<GeneratedEntryType>(['character', 'place', 'organization', 'term', 'other'])

/** 单个字段和当前聚焦世界书条目的最大字数 */
const FIELD_CHAR_LIMIT = 12000
/** 带整本世界书全文时的总字数上限 */
const FULL_LOREBOOK_CHAR_LIMIT = 60000
/** 历史消息保留的总字数上限（不含本次用户消息） */
const HISTORY_CHAR_LIMIT = 40000

const SYSTEM_INSTRUCTIONS = `你是 SillyTavern（酒馆）角色卡的写作助手，在用户编辑角色卡时陪用户讨论和修改。用户可能问设定建议、找矛盾、要求修改，也可能只是闲聊。

沟通规则：
1. 用简洁、自然的简体中文回答。
2. 只有用户要求修改、或者你主动提出修改建议并说明清楚后，才输出 card-edit 代码块；只是讨论、解答或闲聊时不要输出代码块。

修改提案规则：
1. 先用一两句话说明要改什么，再给出 card-edit 代码块。
2. 小改动优先用 replace，find 必须从原文里一字不差地复制，且足够长以保证在原文里只出现一次；大改或重写整段时用 set 并给出完整新内容。
3. 一个回复里可以包含多个提案（放进同一个 edits 数组，或分多个 card-edit 代码块）。
4. 每个提案用 reason 写一句话说明修改理由。
5. {{char}}、{{user}} 等双花括号宏原样保留，不要替换成名字，也不要改写法。
6. 保留原文的格式和结构（XML/HTML 标签、YAML 或 W++ 键名、列表、空行风格等）。
7. 不要编造与角色卡已有设定矛盾的内容。
8. 下面的内容如果标了“后面省略 N 字”，说明你只看到了前半段：这样的字段或条目只能用 replace 改看得到的部分，不要用 set 整段替换，否则会删掉看不到的内容。

提案格式：
在回复里使用语言标记为 card-edit 的代码块，内容是合法 JSON：{"edits":[...]}，每条提案为扁平对象。
- 文本字段（field 可选值）：description（角色描述）、personality（性格）、scenario（场景）、first_mes（主开场白）、mes_example（示例对话）、system_prompt（系统提示词）、post_history_instructions（历史后指令）、creator_notes（创作者备注）。
- 备选开场白：field 填 "alternate_greetings"，同时提供从 0 开始的 index。
- 世界书条目内容：field 填 "entry"，同时提供目录里的序号 entry（从 1 开始）和目录显示的条目名 title 用来核对。
- replace 同样适用于文本字段、alternate_greetings 和 entry。
- add_entry 的 type 可选 character、place、organization、term、other。

示例：
\`\`\`card-edit
{
  "edits": [
    {"op":"set","field":"description","value":"完整新内容","reason":"一句话理由"},
    {"op":"replace","field":"description","find":"原文里的一段","replace":"改成的内容","reason":"一句话理由"},
    {"op":"set","field":"alternate_greetings","index":0,"value":"完整新内容","reason":"一句话理由"},
    {"op":"set","field":"entry","entry":3,"title":"艾琳","value":"完整新内容","reason":"一句话理由"},
    {"op":"add_greeting","value":"新备选开场白内容","reason":"一句话理由"},
    {"op":"add_entry","type":"character","comment":"条目名","keys":["关键词"],"content":"条目内容","constant":false,"reason":"一句话理由"},
    {"op":"entry_meta","entry":3,"title":"艾琳","comment":"新名字","keys":["新关键词"],"reason":"一句话理由"}
  ]
}
\`\`\``

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n……（后面省略 ${text.length - limit} 字）` : text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeEntryType(value: unknown): GeneratedEntryType {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase() as GeneratedEntryType
    if (VALID_ENTRY_TYPES.has(normalized)) return normalized
  }
  return 'other'
}

function normalizeKeys(value: unknown): string[] {
  const rawList: string[] = []
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') rawList.push(item)
    }
  } else if (typeof value === 'string') {
    rawList.push(...value.split(/[,，、]+/))
  }

  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of rawList) {
    const key = raw.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(key)
  }
  return result
}

function parseIntStrict(value: unknown, min: number): number | null {
  let n: number
  if (typeof value === 'number') {
    n = value
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^\d+$/.test(trimmed)) return null
    n = Number(trimmed)
  } else {
    return null
  }
  if (!Number.isSafeInteger(n) || n < min) return null
  return n
}

function formatCatalogLine(entry: LorebookEntry, index: number): string {
  const title = entryTitle(entry, index)
  const keys = normalizeKeys(entry.keys)
  const parts = [`[#${index + 1}] ${title}`, `关键词：${keys.length > 0 ? keys.join('、') : '（无）'}`]
  if (entry.constant === true) parts.push('常驻')
  if (entry.enabled === false) parts.push('已禁用')
  const contentLen = typeof entry.content === 'string' ? entry.content.length : 0
  parts.push(`约 ${contentLen} 字`)
  return parts.join(' | ')
}

function buildCardContext(input: AssistantRequestInput): string {
  const { data } = input.card
  const sections: string[] = []

  // 当前角色卡主体
  const cardLines: string[] = []
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : '（未命名）'
  cardLines.push(`角色名：${name}`)

  const tags = Array.isArray(data.tags)
    ? data.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean)
    : []
  cardLines.push(`标签：${tags.length > 0 ? tags.join('、') : '（无）'}`)

  for (const field of ASSISTANT_FIELDS) {
    const raw = data[field]
    if (typeof raw === 'string' && raw.trim()) {
      cardLines.push(`\n## ${ASSISTANT_FIELD_LABELS[field]}（${field}）\n${truncate(raw, FIELD_CHAR_LIMIT)}`)
    }
  }

  if (Array.isArray(data.alternate_greetings) && data.alternate_greetings.length > 0) {
    const greetingBlocks = data.alternate_greetings.map((item, idx) => {
      const text = typeof item === 'string' ? item : ''
      const body = text.trim() ? truncate(text, FIELD_CHAR_LIMIT) : '（空）'
      return `### 备选开场白 index=${idx}\n${body}`
    })
    cardLines.push(`\n## 备选开场白（alternate_greetings）\n${greetingBlocks.join('\n\n')}`)
  }

  sections.push(`# 当前角色卡\n${cardLines.join('\n')}`)

  // 世界书目录
  const book = data.character_book
  const entries = Array.isArray(book?.entries) ? book.entries : null
  if (!book || !entries) {
    sections.push('# 世界书目录\n（这张卡没有世界书）')
  } else if (entries.length === 0) {
    sections.push('# 世界书目录\n（世界书目前为空，还没有条目）')
  } else {
    const catalogLines = entries.map((entry, idx) => formatCatalogLine(entry, idx))
    sections.push(`# 世界书目录\n${catalogLines.join('\n')}`)
  }

  // 用户正在看的世界书条目
  if (
    entries &&
    typeof input.focusEntry === 'number' &&
    Number.isInteger(input.focusEntry) &&
    input.focusEntry >= 1 &&
    input.focusEntry <= entries.length
  ) {
    const idx = input.focusEntry - 1
    const entry = entries[idx]
    const content = typeof entry.content === 'string' ? entry.content : ''
    const body = content.trim() ? truncate(content, FIELD_CHAR_LIMIT) : '（空）'
    sections.push(`# 用户正在看的世界书条目\n[#${input.focusEntry}] ${entryTitle(entry, idx)}\n${body}`)
  }

  // 整本世界书全文
  if (input.fullLorebook && entries && entries.length > 0) {
    const fullBlocks: string[] = []
    let used = 0
    let omitted = 0

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const content = typeof entry.content === 'string' ? entry.content : ''
      if (used + content.length > FULL_LOREBOOK_CHAR_LIMIT) {
        omitted = entries.length - i
        break
      }
      used += content.length
      fullBlocks.push(`[#${i + 1}] ${entryTitle(entry, i)}\n${content.trim() ? content : '（空）'}`)
    }

    if (omitted > 0) {
      fullBlocks.push(`……（已达到字数上限，后面省略了 ${omitted} 条世界书全文）`)
    }
    sections.push(`# 世界书全文\n${fullBlocks.join('\n\n')}`)
  }

  return sections.join('\n\n')
}

function trimHistory(history: AssistantTurn[]): AiMessage[] {
  const kept: AiMessage[] = history.map((turn) => ({
    role: turn.role,
    content: turn.content,
  }))

  let total = 0
  for (const msg of kept) {
    total += msg.content.length
  }

  let start = 0
  while (start < kept.length && total > HISTORY_CHAR_LIMIT) {
    total -= kept[start].content.length
    start++
  }

  // 丢弃后保证第一条消息是 user
  while (start < kept.length && kept[start].role !== 'user') {
    start++
  }

  return kept.slice(start)
}

/** 构造侧栏对话助手的请求参数：卡片当前状态放在 system 里，历史超长时从最早的开始裁剪 */
export function buildAssistantRequest(input: AssistantRequestInput): { system: string; messages: AiMessage[] } {
  const system = `${SYSTEM_INSTRUCTIONS}\n\n${buildCardContext(input)}`
  const messages: AiMessage[] = [...trimHistory(input.history), { role: 'user', content: input.message }]
  return { system, messages }
}

interface LineSlice {
  content: string
  start: number
  end: number
}

/** 按行扫描文本，记录每行在原文中的起止位置，兼容 \n 和 \r\n */
function splitLinesWithOffsets(text: string): LineSlice[] {
  const lines: LineSlice[] = []
  let pos = 0

  while (pos < text.length) {
    const start = pos
    let contentEnd = pos
    while (contentEnd < text.length && text[contentEnd] !== '\n' && text[contentEnd] !== '\r') {
      contentEnd++
    }
    let end = contentEnd
    if (end < text.length) {
      if (text[end] === '\r' && text[end + 1] === '\n') {
        end += 2
      } else {
        end += 1
      }
    }
    lines.push({
      content: text.slice(start, contentEnd),
      start,
      end,
    })
    pos = end
  }

  return lines
}

/** 去掉文本块首尾的空白行；若去掉后没有实际内容则返回空字符串 */
function trimEdgeBlankLines(text: string): string {
  const cleaned = text.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '')
  return cleaned.trim() ? cleaned : ''
}

function parseEditTarget(raw: Record<string, unknown>): EditTarget | null {
  if (typeof raw.field !== 'string') return null
  const rawField = raw.field.trim().toLowerCase()
  if (!rawField) return null

  const canonical = rawField === 'first_message' ? 'first_mes' : rawField

  if (canonical === 'alternate_greetings' || canonical === 'alternate_greeting' || canonical === 'greeting') {
    const index = parseIntStrict(raw.index, 0)
    if (index === null) return null
    return { kind: 'greeting', index }
  }

  if (canonical === 'entry' || canonical === 'lorebook' || canonical === 'world_info') {
    const entry = parseIntStrict(raw.entry, 1)
    const title = typeof raw.title === 'string' ? raw.title.trim() : ''
    if (entry === null || !title) return null
    return { kind: 'entry', entry, title }
  }

  if (ASSISTANT_FIELD_SET.has(canonical)) {
    return { kind: 'field', field: canonical as AssistantField }
  }

  return null
}

function parseSingleEdit(raw: unknown): AssistantEdit | null {
  if (!isRecord(raw)) return null
  const op = typeof raw.op === 'string' ? raw.op.trim().toLowerCase() : ''
  const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : undefined

  switch (op) {
    case 'set': {
      const target = parseEditTarget(raw)
      if (!target || typeof raw.value !== 'string') return null
      return reason ? { op: 'set', target, value: raw.value, reason } : { op: 'set', target, value: raw.value }
    }

    case 'replace': {
      const target = parseEditTarget(raw)
      if (!target || typeof raw.find !== 'string' || raw.find.length === 0 || typeof raw.replace !== 'string') {
        return null
      }
      return reason
        ? { op: 'replace', target, find: raw.find, replace: raw.replace, reason }
        : { op: 'replace', target, find: raw.find, replace: raw.replace }
    }

    case 'add_greeting': {
      if (typeof raw.value !== 'string' || !raw.value.trim()) return null
      return reason ? { op: 'add_greeting', value: raw.value, reason } : { op: 'add_greeting', value: raw.value }
    }

    case 'add_entry': {
      const content = typeof raw.content === 'string' ? raw.content.trim() : ''
      if (!content) return null
      const keys = normalizeKeys(raw.keys)
      const rawComment = typeof raw.comment === 'string' ? raw.comment.trim() : ''
      const comment = rawComment || keys[0] || ''
      const entry: GeneratedEntry = {
        type: normalizeEntryType(raw.type),
        comment,
        keys,
        content,
        constant: raw.constant === true,
      }
      return reason ? { op: 'add_entry', entry, reason } : { op: 'add_entry', entry }
    }

    case 'entry_meta': {
      const entry = parseIntStrict(raw.entry, 1)
      const title = typeof raw.title === 'string' ? raw.title.trim() : ''
      if (entry === null || !title) return null

      const comment = typeof raw.comment === 'string' && raw.comment.trim() ? raw.comment.trim() : undefined
      let keys: string[] | undefined
      if (Array.isArray(raw.keys)) {
        keys = normalizeKeys(raw.keys)
      } else if (typeof raw.keys === 'string' && raw.keys.trim()) {
        keys = normalizeKeys(raw.keys)
      }

      if (comment === undefined && keys === undefined) return null

      const edit: Extract<AssistantEdit, { op: 'entry_meta' }> = {
        op: 'entry_meta',
        entry,
        title,
      }
      if (comment !== undefined) edit.comment = comment
      if (keys !== undefined) edit.keys = keys
      if (reason !== undefined) edit.reason = reason
      return edit
    }

    default:
      return null
  }
}

function parseEditBlock(body: string): AssistantSegment {
  let parsed: unknown
  try {
    parsed = extractJson(body)
  } catch {
    return { type: 'broken' }
  }

  let rawItems: unknown[]
  if (Array.isArray(parsed)) {
    rawItems = parsed
  } else if (isRecord(parsed) && Array.isArray(parsed.edits)) {
    rawItems = parsed.edits
  } else if (isRecord(parsed) && typeof parsed.op === 'string') {
    rawItems = [parsed]
  } else {
    return { type: 'broken' }
  }

  const edits: AssistantEdit[] = []
  let dropped = 0
  for (const item of rawItems) {
    const parsedEdit = parseSingleEdit(item)
    if (parsedEdit) {
      edits.push(parsedEdit)
    } else {
      dropped++
    }
  }

  return { type: 'edits', edits, dropped }
}

/**
 * 将助手回复按顺序拆成文字段和修改提案段。
 * 流式输出尚未闭合的 card-edit 代码块会变成末尾的 pending 段；JSON 解析失败的块变成 broken 段。
 */
export function parseAssistantReply(text: string): AssistantSegment[] {
  if (!text) return []

  const lines = splitLinesWithOffsets(text)
  const segments: AssistantSegment[] = []

  type ScanMode = 'normal' | 'other_fence' | 'card_edit'
  let mode: ScanMode = 'normal'
  let fenceLen = 0
  let textStart: number | null = null
  let textEnd = 0
  let editBodyLines: string[] = []

  const flushText = (): void => {
    if (textStart === null) return
    const cleaned = trimEdgeBlankLines(text.slice(textStart, textEnd))
    if (cleaned) {
      segments.push({ type: 'text', text: cleaned })
    }
    textStart = null
  }

  const appendTextLine = (line: LineSlice): void => {
    if (textStart === null) textStart = line.start
    textEnd = line.end
  }

  for (const line of lines) {
    if (mode === 'normal') {
      const openMatch = line.content.match(/^[ \t]*(`{3,})([^\r\n]*)$/)
      if (openMatch && !openMatch[2].includes('`')) {
        const lang = openMatch[2].trim().toLowerCase()
        if (lang === 'card-edit') {
          flushText()
          mode = 'card_edit'
          fenceLen = openMatch[1].length
          editBodyLines = []
          continue
        }
        mode = 'other_fence'
        fenceLen = openMatch[1].length
        appendTextLine(line)
        continue
      }
      appendTextLine(line)
    } else if (mode === 'other_fence') {
      appendTextLine(line)
      const closeMatch = line.content.match(/^[ \t]*(`{3,})[ \t]*$/)
      if (closeMatch && closeMatch[1].length >= fenceLen) {
        mode = 'normal'
        fenceLen = 0
      }
    } else {
      const closeMatch = line.content.match(/^[ \t]*(`{3,})[ \t]*$/)
      if (closeMatch && closeMatch[1].length >= fenceLen) {
        segments.push(parseEditBlock(editBodyLines.join('\n')))
        mode = 'normal'
        fenceLen = 0
        editBodyLines = []
      } else {
        editBodyLines.push(line.content)
      }
    }
  }

  if (mode === 'card_edit') {
    segments.push({ type: 'pending' })
  } else {
    flushText()
  }

  return segments
}

function resolveLorebookEntry(
  card: CharacterCardV3,
  entryNum: number,
  title: string,
): { entry: LorebookEntry; index: number } {
  const entries = card.data.character_book?.entries ?? []
  const wanted = title.trim()

  if (Number.isInteger(entryNum) && entryNum >= 1 && entryNum <= entries.length) {
    const idx = entryNum - 1
    const candidate = entries[idx]
    if (entryTitle(candidate, idx).trim() === wanted) {
      return { entry: candidate, index: idx }
    }
  }

  const matched: Array<{ entry: LorebookEntry; index: number }> = []
  for (let i = 0; i < entries.length; i++) {
    if (entryTitle(entries[i], i).trim() === wanted) {
      matched.push({ entry: entries[i], index: i })
    }
  }

  if (matched.length === 1) {
    return matched[0]
  }

  throw new AssistantEditError(`找不到世界书条目「${wanted || title}」，可能已被删除或改名`)
}

interface ResolvedTextTarget {
  label: string
  before: string
  write: (next: string) => void
}

function resolveTextTarget(card: CharacterCardV3, target: EditTarget): ResolvedTextTarget {
  switch (target.kind) {
    case 'field': {
      if (!ASSISTANT_FIELD_SET.has(target.field)) {
        throw new AssistantEditError(`不支持修改字段「${String(target.field)}」`)
      }
      const label = ASSISTANT_FIELD_LABELS[target.field]
      const raw: unknown = card.data[target.field]
      if (raw !== undefined && raw !== null && typeof raw !== 'string') {
        throw new AssistantEditError(`字段「${label}」不是文本，无法修改`)
      }
      return {
        label,
        before: typeof raw === 'string' ? raw : '',
        write: (next) => {
          card.data[target.field] = next
        },
      }
    }

    case 'greeting': {
      const greetings = card.data.alternate_greetings
      const displayNo = target.index + 1
      if (!Array.isArray(greetings) || !Number.isInteger(target.index) || target.index < 0 || target.index >= greetings.length) {
        throw new AssistantEditError(`找不到备选开场白 ${displayNo}，可能已被删除或序号超出范围`)
      }
      const raw: unknown = greetings[target.index]
      if (raw !== undefined && raw !== null && typeof raw !== 'string') {
        throw new AssistantEditError(`备选开场白 ${displayNo} 不是文本，无法修改`)
      }
      return {
        label: `备选开场白 ${displayNo}`,
        before: typeof raw === 'string' ? raw : '',
        write: (next) => {
          greetings[target.index] = next
        },
      }
    }

    case 'entry': {
      const { entry, index } = resolveLorebookEntry(card, target.entry, target.title)
      const label = `世界书条目「${entryTitle(entry, index)}」`
      const raw: unknown = entry.content
      if (raw !== undefined && raw !== null && typeof raw !== 'string') {
        throw new AssistantEditError(`${label}的内容不是文本，无法修改`)
      }
      return {
        label,
        before: typeof raw === 'string' ? raw : '',
        write: (next) => {
          entry.content = next
        },
      }
    }
  }
}

function computeReplace(before: string, find: string, replace: string): string {
  if (!find) {
    throw new AssistantEditError('要替换的原文内容不能为空')
  }

  const normalizedBefore = before.replace(/\r\n/g, '\n')
  const normalizedFind = find.replace(/\r\n/g, '\n')
  const normalizedReplace = replace.replace(/\r\n/g, '\n')

  let count = 0
  let firstIndex = -1
  for (
    let idx = normalizedBefore.indexOf(normalizedFind);
    idx !== -1;
    idx = normalizedBefore.indexOf(normalizedFind, idx + 1)
  ) {
    if (firstIndex === -1) firstIndex = idx
    count++
  }

  if (count === 0) {
    throw new AssistantEditError('原文里找不到要替换的内容，可能已经改过了')
  }
  if (count > 1) {
    throw new AssistantEditError(`要替换的内容在原文里出现了 ${count} 次，无法确定改哪一处`)
  }

  const replaced =
    normalizedBefore.slice(0, firstIndex) +
    normalizedReplace +
    normalizedBefore.slice(firstIndex + normalizedFind.length)

  return matchLineEndings(replaced, before)
}

function normalizeNewEntry(entry: GeneratedEntry): GeneratedEntry {
  const content = typeof entry.content === 'string' ? entry.content.trim() : ''
  if (!content) {
    throw new AssistantEditError('新增世界书条目的内容不能为空')
  }
  const keys = normalizeKeys(entry.keys)
  const rawComment = typeof entry.comment === 'string' ? entry.comment.trim() : ''
  const comment = rawComment || keys[0] || ''
  return {
    type: normalizeEntryType(entry.type),
    comment,
    keys,
    content,
    constant: entry.constant === true,
  }
}

function formatNewEntryPreview(entry: GeneratedEntry): string {
  const name = entry.comment || '（未命名）'
  const keysText = entry.keys.length > 0 ? entry.keys.join('、') : '（无）'
  const keyLine = entry.constant ? `关键词：${keysText}（常驻）` : `关键词：${keysText}`
  return `名称：${name}\n${keyLine}\n\n${entry.content}`
}

function formatEntryMetaText(name: string, keys: string[]): string {
  return `名称：${name}\n关键词：${keys.length > 0 ? keys.join('、') : '（无）'}`
}

interface EditPlan {
  preview: EditPreview
  apply: () => void
}

/** 计算提案的预览和写入动作，保证 previewEdit 与 applyEdit 的校验和结果完全一致 */
function planEdit(card: CharacterCardV3, edit: AssistantEdit): EditPlan {
  switch (edit.op) {
    case 'set': {
      const target = resolveTextTarget(card, edit.target)
      const after = matchLineEndings(edit.value, target.before)
      return {
        preview: {
          label: target.label,
          before: target.before,
          after,
          isNew: false,
        },
        apply: () => {
          target.write(after)
        },
      }
    }

    case 'replace': {
      const target = resolveTextTarget(card, edit.target)
      const after = computeReplace(target.before, edit.find, edit.replace)
      return {
        preview: {
          label: target.label,
          before: target.before,
          after,
          isNew: false,
        },
        apply: () => {
          target.write(after)
        },
      }
    }

    case 'add_greeting': {
      const existing = Array.isArray(card.data.alternate_greetings) ? card.data.alternate_greetings : []
      const nextNo = existing.length + 1
      return {
        preview: {
          label: `新备选开场白（第 ${nextNo} 条）`,
          before: '',
          after: edit.value,
          isNew: true,
        },
        apply: () => {
          if (!Array.isArray(card.data.alternate_greetings)) {
            card.data.alternate_greetings = []
          }
          card.data.alternate_greetings.push(edit.value)
        },
      }
    }

    case 'add_entry': {
      const normalized = normalizeNewEntry(edit.entry)
      const title = normalized.comment || '未命名'
      const typeLabel = GENERATED_TYPE_LABELS[normalized.type]
      return {
        preview: {
          label: `新世界书条目「${title}」（${typeLabel}）`,
          before: '',
          after: formatNewEntryPreview(normalized),
          isNew: true,
        },
        apply: () => {
          if (!card.data.character_book) {
            card.data.character_book = createLorebook(`${card.data.name} 的世界书`)
          }
          const book = card.data.character_book
          if (!Array.isArray(book.entries)) {
            book.entries = []
          }
          book.entries.push(...generatedToEntries([normalized], book.entries))
        },
      }
    }

    case 'entry_meta': {
      const nextComment = typeof edit.comment === 'string' && edit.comment.trim() ? edit.comment.trim() : undefined
      const nextKeys = Array.isArray(edit.keys) ? normalizeKeys(edit.keys) : undefined
      if (nextComment === undefined && nextKeys === undefined) {
        throw new AssistantEditError('修改世界书条目信息时，名称和关键词至少需要提供一项')
      }

      const { entry, index } = resolveLorebookEntry(card, edit.entry, edit.title)
      const currentTitle = entryTitle(entry, index)
      const beforeKeys = normalizeKeys(entry.keys)

      const afterKeys = nextKeys ?? beforeKeys
      const existingComment = typeof entry.comment === 'string' ? entry.comment.trim() : ''
      const afterComment = nextComment ?? existingComment
      const afterTitle = afterComment || afterKeys[0] || `条目 #${index + 1}`

      return {
        preview: {
          label: `世界书条目「${currentTitle}」`,
          before: formatEntryMetaText(currentTitle, beforeKeys),
          after: formatEntryMetaText(afterTitle, afterKeys),
          isNew: false,
        },
        apply: () => {
          if (nextComment !== undefined) {
            entry.comment = nextComment
          }
          if (nextKeys !== undefined) {
            entry.keys = [...nextKeys]
          }
        },
      }
    }
  }
}

/** 预览单个修改提案，算出原文与修改后的文本；不修改传入的 card */
export function previewEdit(card: CharacterCardV3, edit: AssistantEdit): EditPreview {
  return planEdit(card, edit).preview
}

/** 将单个修改提案直接写入传入的 card（兼容 Immer 草稿） */
export function applyEdit(card: CharacterCardV3, edit: AssistantEdit): void {
  planEdit(card, edit).apply()
}
