/**
 * 合成世界书条目：把选中的对象（人物、地点、组织、名词、世界观）各块的资料交给模型，合并成一条条世界书条目。
 * 几个对象打包成一次请求，按资料字数分批。
 */
import { extractJson } from '../ai/json'
import { AiError, type AiMessage } from '../ai/types'
import type { GeneratedEntry, GeneratedEntryType } from '../ai/tasks/lorebookGen'
import { aliasesUpTo, formatEntityNotes, isGenericTerm, isHonorificKey } from './merge'
import { ENTITY_KIND_LABELS, type EntityKind, type MergedEntity } from './types'

export type ConsolidateKind = EntityKind | 'world'

export interface ConsolidateItem {
  /** 请求里用的短 id（如 c3），模型原样返回，用来对应 */
  id: string
  kind: ConsolidateKind
  name: string
  aliases: string[]
  notes: string
}

export interface ConsolidatedEntry {
  id: string
  comment: string
  keys: string[]
  content: string
}

const SYSTEM_PROMPT = `你是 SillyTavern（酒馆）世界书的编写者。下面是从一本小说里逐段整理出的资料（按故事顺序排列，每个对象下面按出现的章节分段），请把每个对象的资料合并成一条世界书条目。

规则：
1. 每个对象输出一条，id 原样返回，不要漏，也不要合并不同 id 的对象。
2. comment：对象最常用的名字。
3. keys：2～6 个触发关键词，用书里实际出现、能明确指向这个对象的称呼（全名、字号、外号、简称）。不要用“大人”“将军”“师兄”“少女”这类多人共用的泛称，不要用单个字。
4. content 用简洁的设定式写法，分行，每行“项目：内容”。人物建议：姓名、身份、外貌、性格、能力、人际关系、经历（按时间顺序概括到资料最后一段为止）、说话风格（可引用一两句原话）；地点、组织、名词按名称、类型、简介、特点、相关人物等组织。没有资料的项直接省略。
5. 资料前后有变化时以靠后的为准，必要时写成“曾……，后来……”。
6. 不要编造资料里没有的信息。{{char}}、{{user}} 等宏原样保留。
7. 人物每条不超过 400 字，其他每条不超过 200 字；类型为“世界观”的对象写成世界观总述（分条列出时代背景、社会规则、力量体系等），不超过 600 字，keys 留空数组。
8. 只输出一个 JSON 对象，不要任何解释，不要用代码块包裹：{"entries":[{"id":"","comment":"","keys":[],"content":""}]}`

/** 单个对象的资料最多带这么多字 */
export const ITEM_NOTES_LIMIT = 6000
/** 一批请求的资料总字数 */
export const BATCH_CHARS = 14000

const KIND_PREFIX: Record<ConsolidateKind, string> = { character: 'c', place: 'p', organization: 'o', term: 't', world: 'w' }

export function entityToItem(entity: MergedEntity, index: number, maxOrder?: number): ConsolidateItem {
  return {
    id: `${KIND_PREFIX[entity.kind]}${index}`,
    kind: entity.kind,
    name: entity.name,
    aliases: aliasesUpTo(entity, maxOrder).slice(0, 12),
    notes: formatEntityNotes(entity, { maxOrder, maxChars: ITEM_NOTES_LIMIT }),
  }
}

/** 世界观：各块的世界观条目汇总成一个对象，合成一条常驻条目 */
export function worldToItem(world: string[]): ConsolidateItem {
  let notes = ''
  for (const w of world) {
    const line = `- ${w}\n`
    if (notes.length + line.length > ITEM_NOTES_LIMIT) break
    notes += line
  }
  return { id: 'w0', kind: 'world', name: '世界观', aliases: [], notes: notes.trim() }
}

/** 按资料字数分批；单个对象超过一批的也单独成一批 */
export function batchItems(items: ConsolidateItem[], maxChars = BATCH_CHARS): ConsolidateItem[][] {
  const batches: ConsolidateItem[][] = []
  let cur: ConsolidateItem[] = []
  let size = 0
  for (const item of items) {
    const len = item.notes.length + item.name.length + 40
    if (cur.length > 0 && size + len > maxChars) {
      batches.push(cur)
      cur = []
      size = 0
    }
    cur.push(item)
    size += len
  }
  if (cur.length) batches.push(cur)
  return batches
}

function kindLabel(kind: ConsolidateKind): string {
  return kind === 'world' ? '世界观' : ENTITY_KIND_LABELS[kind]
}

export function buildConsolidateRequest(input: { bookTitle: string; items: ConsolidateItem[] }): {
  system: string
  messages: AiMessage[]
  json: true
} {
  const blocks = input.items.map((item) => {
    const aliases = item.aliases.length ? `（别名：${item.aliases.join('、')}）` : ''
    return `## [id=${item.id}] ${kindLabel(item.kind)}：${item.name}${aliases}\n${item.notes || '（没有更多资料）'}`
  })
  const content = [
    `# 书名：《${input.bookTitle.trim() || '未命名'}》`,
    `# 资料（按故事顺序）\n${blocks.join('\n\n')}`,
    `请为上面 ${input.items.length} 个对象各输出一条，输出 JSON。`,
  ].join('\n\n')
  return { system: SYSTEM_PROMPT, messages: [{ role: 'user', content }], json: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 关键词清理：去掉泛称和单字，名字本身一定在里面 */
function cleanKeys(raw: unknown, item: ConsolidateItem): string[] {
  if (item.kind === 'world') return []
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,，、]+/) : []
  const out: string[] = []
  const seen = new Set<string>()
  const push = (k: string) => {
    const key = k.trim()
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(key)
  }
  push(item.name)
  for (const k of list) {
    if (typeof k !== 'string') continue
    // 单字、“大人”“师兄”这类泛称、“冯大人”这种姓加客套称呼，会让条目在无关的地方被触发；“马太守”这种带官职的保留
    if (isGenericTerm(k) || isHonorificKey(k)) continue
    push(k)
  }
  return out.slice(0, 8)
}

/**
 * 去掉几个条目共用的关键词（如两个人都叫“马大人”）：只留在名字正好是这个词的条目里，没有这样的条目就都去掉。
 * 合成是分批的，要在所有批次合完之后再调用。
 */
export function dropSharedKeys<T extends { comment: string; keys: string[] }>(entries: T[]): T[] {
  const owners = new Map<string, number>()
  for (const e of entries) {
    for (const k of new Set(e.keys)) owners.set(k, (owners.get(k) ?? 0) + 1)
  }
  return entries.map((e) => {
    const keys = e.keys.filter((k) => (owners.get(k) ?? 0) <= 1 || k === e.comment)
    return keys.length === e.keys.length ? e : { ...e, keys }
  })
}

/**
 * 解析合成结果，按 id 对应回请求里的对象。模型漏掉的对象不在结果里（调用方可以重试这些）。
 */
export function parseConsolidated(text: string, items: ConsolidateItem[]): ConsolidatedEntry[] {
  const json = extractJson(text)
  const raw = Array.isArray(json) ? json : isRecord(json) && Array.isArray(json.entries) ? json.entries : null
  if (!raw) throw new AiError('bad_output', '模型返回的 JSON 缺少 entries 列表，可以重试')

  const byId = new Map(items.map((i) => [i.id, i]))
  const byName = new Map(items.map((i) => [i.name, i]))
  const out = new Map<string, ConsolidatedEntry>()
  for (const e of raw) {
    if (!isRecord(e)) continue
    const content = typeof e.content === 'string' ? e.content.trim() : ''
    if (!content) continue
    const id = typeof e.id === 'string' ? e.id.trim() : ''
    const comment = typeof e.comment === 'string' ? e.comment.trim() : ''
    // id 对不上时按名字兜底
    const item = byId.get(id) ?? byName.get(comment)
    if (!item || out.has(item.id)) continue
    out.set(item.id, { id: item.id, comment: comment || item.name, keys: cleanKeys(e.keys, item), content })
  }
  if (out.size === 0) throw new AiError('bad_output', '模型没有返回有效的条目，可以重试')
  return items.filter((i) => out.has(i.id)).map((i) => out.get(i.id)!)
}

const TYPE_OF: Record<ConsolidateKind, GeneratedEntryType> = {
  character: 'character',
  place: 'place',
  organization: 'organization',
  term: 'term',
  world: 'other',
}

/** 转成通用的“生成条目”（再用 generatedToEntries 套模板变成世界书条目）；世界观为常驻 */
export function toGeneratedEntries(entries: ConsolidatedEntry[], items: ConsolidateItem[]): GeneratedEntry[] {
  const kindOf = new Map(items.map((i) => [i.id, i.kind]))
  return entries.map((e) => {
    const kind = kindOf.get(e.id) ?? 'term'
    return { type: TYPE_OF[kind], comment: e.comment, keys: e.keys, content: e.content, constant: kind === 'world' }
  })
}
