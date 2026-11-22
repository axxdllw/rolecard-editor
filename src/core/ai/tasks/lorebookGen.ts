/**
 * AI 批量生成世界书条目：拼提示词、解析结构化输出、转换成标准世界书条目。
 * 只负责请求构建与结果转换，实际调用由 client.ts 完成。
 */
import { ENTRY_TEMPLATES } from '../../card/create'
import type { LorebookEntry } from '../../card/types'
import { createEntry, type NewEntryInit } from '../../lorebook/entry'
import { extractJson } from '../json'
import { AiError, type AiMessage } from '../types'
import type { RewriteContext } from './rewrite'

export type GeneratedEntryType = 'character' | 'place' | 'organization' | 'term' | 'other'

export const GENERATED_TYPE_LABELS: Record<GeneratedEntryType, string> = {
  character: '人物',
  place: '地点',
  organization: '组织',
  term: '名词',
  other: '其他',
}

export interface GeneratedEntry {
  type: GeneratedEntryType
  /** 条目名（备注名） */
  comment: string
  /** 触发关键词 */
  keys: string[]
  /** 条目内容 */
  content: string
  /** 是否常驻（世界观总述这类才常驻，默认 false） */
  constant: boolean
}

export interface LorebookGenInput {
  /** 参考资料：用户粘贴的设定、小说片段，或者角色描述 */
  source: string
  /** 额外要求，如“只要地点”“每条 200 字以内” */
  instruction?: string
  /** 世界书里已有的条目名，提示模型不要重复 */
  existingTitles?: string[]
  /** 角色卡上下文（可选），类型复用 rewrite.ts 的 RewriteContext */
  context?: RewriteContext
  /** 最多生成多少条，默认 20 */
  maxEntries?: number
}

/** 参考资料最多带这么多字，超出部分截断并注明 */
const SOURCE_LIMIT = 30000

/** 角色卡上下文里每个参考字段最多带这么多字，避免上下文过长 */
const CONTEXT_FIELD_LIMIT = 4000

/** 默认最多生成的条目数 */
const DEFAULT_MAX_ENTRIES = 20

const VALID_TYPES = new Set<GeneratedEntryType>(['character', 'place', 'organization', 'term', 'other'])

const SYSTEM_PROMPT = `你是 SillyTavern（酒馆）世界书的写作助手，帮用户从参考资料里提取并整理成结构化的世界书条目。

规则：
1. 从参考资料里提取值得做成世界书条目的人物（character）、地点（place）、组织（organization）、名词（term，如术语/物品/魔法/事件）以及其他设定（other）。
2. 每条只写一个主题，不要把多个无关对象混在一条里。
3. 触发关键词（keys）用资料里实际出现的称呼（全名、简称、别名、英文名等），一般 2～5 个；不要用过于宽泛的词（如“他”“她”“这里”“城市”“世界”）。
4. 条目内容（content）采用简洁的设定式写法（可用“名称：/身份：/特征：”等分行格式），不要写成小说故事或长段散文。
5. {{char}}、{{user}} 等双花括号宏原样保留，不要替换成名字，也不要改写法。
6. 不要编造资料里没有的重要设定，可以在忠于原意的前提下合理归纳和整理。
7. 不要与世界书里已有的条目重复。
8. constant 表示是否每轮常驻发送：只有整个世界观总述、核心背景规则这类全局信息才设为 true，其余具体条目一律为 false。
9. 只输出一个合法的 JSON 对象，不要任何解释、前言、结尾或代码块，顶层格式严格为：
{"entries":[{"type":"character|place|organization|term|other","comment":"条目名","keys":["关键词1","关键词2"],"content":"条目内容","constant":false}]}`

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n……（后面省略 ${text.length - limit} 字）` : text
}

function resolveMaxEntries(maxEntries?: number): number {
  if (typeof maxEntries === 'number' && Number.isFinite(maxEntries) && maxEntries >= 1) {
    return Math.floor(maxEntries)
  }
  return DEFAULT_MAX_ENTRIES
}

/** 构造世界书批量生成的请求参数（开启 JSON 模式） */
export function buildLorebookGenRequest(input: LorebookGenInput): { system: string; messages: AiMessage[]; json: true } {
  const parts: string[] = []

  const context = input.context
  if (context) {
    const lines = [`角色名：${context.name || '（未命名）'}`]
    for (const f of context.fields) {
      if (f.text.trim()) lines.push(`<${f.label}>\n${truncate(f.text.trim(), CONTEXT_FIELD_LIMIT)}\n</${f.label}>`)
    }
    parts.push(`# 角色卡上下文（仅供参考，用来保持设定一致）\n${lines.join('\n')}`)
  }

  const existingTitles = (input.existingTitles ?? []).map((t) => t.trim()).filter(Boolean)
  if (existingTitles.length > 0) {
    parts.push(`# 世界书里已有的条目（不要重复生成）\n${existingTitles.map((t) => `- ${t}`).join('\n')}`)
  }

  const source = input.source.trim()
  parts.push(source ? `# 参考资料\n<资料>\n${truncate(source, SOURCE_LIMIT)}\n</资料>` : '# 参考资料\n（空）')

  const maxEntries = resolveMaxEntries(input.maxEntries)
  const instruction = input.instruction?.trim()
  const taskLines = [`请从参考资料中提取值得收录的世界书条目，最多生成 ${maxEntries} 条（资料内容较少时宁缺毋滥，不必凑数）。`]
  if (instruction) {
    taskLines.push(`用户的额外要求：${instruction}`)
  }
  parts.push(`# 任务\n${taskLines.join('\n')}`)
  parts.push('请直接输出符合要求的 JSON 对象。')

  return {
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: parts.join('\n\n') }],
    json: true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeType(value: unknown): GeneratedEntryType {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase() as GeneratedEntryType
    if (VALID_TYPES.has(normalized)) return normalized
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

/** 解析模型返回的 JSON 文本，宽松容错并过滤掉无效条目 */
export function parseGeneratedEntries(text: string): GeneratedEntry[] {
  const parsed = extractJson(text)

  let rawEntries: unknown[]
  if (Array.isArray(parsed)) {
    rawEntries = parsed
  } else if (isRecord(parsed) && Array.isArray(parsed.entries)) {
    rawEntries = parsed.entries
  } else {
    throw new AiError('bad_output', '模型返回的 JSON 缺少 entries 列表，可以重新生成试试')
  }

  const entries: GeneratedEntry[] = []
  for (const item of rawEntries) {
    if (!isRecord(item)) continue
    const content = typeof item.content === 'string' ? item.content.trim() : ''
    if (!content) continue

    const keys = normalizeKeys(item.keys)
    const rawComment = typeof item.comment === 'string' ? item.comment.trim() : ''
    const comment = rawComment || keys[0] || ''

    entries.push({
      type: normalizeType(item.type),
      comment,
      keys,
      content,
      constant: item.constant === true,
    })
  }

  if (entries.length === 0) {
    throw new AiError('bad_output', '模型返回的内容里没有有效的世界书条目，可以重新生成试试')
  }

  return entries
}

function templateInitFor(type: GeneratedEntryType): NewEntryInit {
  const templateId = type === 'other' ? 'blank' : type
  return ENTRY_TEMPLATES.find((t) => t.id === templateId)?.init ?? {}
}

/**
 * 将生成结果转为标准世界书条目，按类型套用模板的 position/order。
 * 逐条追加进临时列表以分配不冲突的 id 和 display_index，不修改传入的 existing。
 */
export function generatedToEntries(generated: GeneratedEntry[], existing: LorebookEntry[]): LorebookEntry[] {
  const pool = [...existing]
  const created: LorebookEntry[] = []

  for (const item of generated) {
    const tpl = templateInitFor(item.type)
    const entry = createEntry(pool, {
      position: tpl.position,
      order: tpl.order,
      comment: item.comment,
      keys: [...item.keys],
      content: item.content,
      constant: item.constant === true,
    })
    pool.push(entry)
    created.push(entry)
  }

  return created
}
