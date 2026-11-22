/**
 * 逐块抽取：让模型把一块正文里的人物、地点、组织、名词、事件和世界观整理成 JSON。
 * 提示词用测试接口在长篇小说上实测过（同一块重复跑结果稳定，2 万字一块约 45～55 秒）。
 */
import { extractJson } from '../ai/json'
import { AiError, type AiFinishReason, type AiMessage } from '../ai/types'
import type {
  ChunkExtraction,
  ChunkFailureOutput,
  ExtractedCharacter,
  ExtractedEvent,
  ExtractedOrganization,
  ExtractedPlace,
  ExtractedRelation,
  ExtractedTerm,
  MergedEntity,
} from './types'

const SYSTEM_PROMPT = `你是小说资料整理员，帮用户把小说做成 SillyTavern（酒馆）角色卡和世界书。现在给你小说的一段原文，请把这一段里出现的人物、地点、组织、名词、事件和世界观设定整理成结构化资料。

规则：
1. 只记录这一段原文里明确写到的信息，不要推测后文，不要用你对这本书的已有了解补充。
2. 人物用最完整、最常用的名字作 name，其他称呼（字、号、外号、昵称、头衔、简称）放进 aliases；同一个人只出一条。如果“已知人物”名单里有这个人，name 必须和名单里的写法一致。
3. 只收录有名字、在这段里说话或做了事的人物；只被顺口提到一句的路人不收。
4. 每个字段写短句或短语，不写长段落；没有信息的字段留空字符串或空数组，不要写“未知”“无”“未提及”。
5. facts 写这一段里和此人有关的重要经历、状态变化、秘密（每条一句，最多 5 条）。quotes 摘这一段里最能体现此人说话风格的原句（最多 2 句，照抄原文）。
6. importance 是这一段里的重要程度：5 主角或核心人物，4 重要角色，3 有戏份的配角，2 次要，1 几乎不重要。
7. 地点、组织、名词（物品、功法、种族、官职制度、专有概念等）只收对理解故事有用的，description 写它是什么、有什么特点。
8. events 按发生顺序列出这一段的关键情节（最多 8 条），summary 一两句话。summary_of_chunk 用 100～200 字概括这一段的剧情。
9. world 写这一段明确交代的世界观、时代背景、社会规则、力量体系（每条一句；没有就空数组）。
10. 只输出一个 JSON 对象，不要任何解释，不要用代码块包裹。结构：
{"summary_of_chunk":"","characters":[{"name":"","aliases":[],"gender":"男|女|","identity":"","appearance":"","personality":"","abilities":"","relations":[{"name":"","relation":""}],"facts":[],"quotes":[],"importance":3}],"places":[{"name":"","aliases":[],"description":"","facts":[]}],"organizations":[{"name":"","aliases":[],"description":"","members":[],"facts":[]}],"terms":[{"name":"","aliases":[],"category":"","description":""}],"events":[{"title":"","summary":"","characters":[],"place":"","importance":3}],"world":[]}`

/** 已知人物名单最多带这么多人 / 这么多字 */
const ROSTER_LIMIT = 80
const ROSTER_CHARS = 2000

export interface ExtractInput {
  bookTitle: string
  /** 块的位置，如“第 3～5 章” */
  chunkLabel: string
  /** 块的正文（chunkText 的结果） */
  text: string
  /** 已知人物名单（formatRoster 的结果），空串表示还没有 */
  roster?: string
}

/** 已知人物名单：按权重取前若干人，“陈恭（文礼、黑帝）” 一行一个 */
export function formatRoster(entities: MergedEntity[]): string {
  const lines: string[] = []
  let chars = 0
  const people = entities.filter((e) => e.kind === 'character').sort((a, b) => b.weight - a.weight)
  for (const e of people.slice(0, ROSTER_LIMIT)) {
    const aliases = e.aliases.slice(0, 4)
    const line = aliases.length ? `${e.name}（${aliases.join('、')}）` : e.name
    if (chars + line.length > ROSTER_CHARS) break
    lines.push(line)
    chars += line.length + 1
  }
  return lines.join('\n')
}

export function buildExtractRequest(input: ExtractInput): { system: string; messages: AiMessage[]; json: true } {
  const roster = input.roster?.trim()
  const parts = [
    `# 书名：《${input.bookTitle.trim() || '未命名'}》`,
    `# 已知人物（前面几段整理出的，同一人请沿用这里的名字）\n${roster || '（还没有）'}`,
    `# 原文（${input.chunkLabel}）\n<原文>\n${input.text}\n</原文>`,
    '请输出这一段的 JSON。',
  ]
  return { system: SYSTEM_PROMPT, messages: [{ role: 'user', content: parts.join('\n\n') }], json: true }
}

// ---------- 解析（宽松容错） ----------

/** 模型偶尔还是会写“未知”“无”，当作空 */
const EMPTY_VALUES = /^(无|没有|未知|不详|未提及|暂无|空|n\/?a|none|null|unknown|-+|—+)$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return ''
  const s = value.trim()
  return EMPTY_VALUES.test(s) ? '' : s
}

function strList(value: unknown, limit = 50): string[] {
  const raw: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，、;；]+/) : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const s = str(item)
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= limit) break
  }
  return out
}

function importance(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : Number.NaN
  if (!Number.isFinite(n)) return 3
  return Math.min(5, Math.max(1, Math.round(n)))
}

function list(o: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const k of keys) {
    if (Array.isArray(o[k])) return o[k] as unknown[]
  }
  return []
}

function aliasesOf(name: string, value: unknown): string[] {
  return strList(value).filter((a) => a !== name)
}

function parseCharacter(v: unknown): ExtractedCharacter | null {
  if (!isRecord(v)) return null
  const name = str(v.name)
  if (!name) return null
  const relations: ExtractedRelation[] = []
  for (const r of list(v, 'relations')) {
    if (isRecord(r)) {
      const rn = str(r.name)
      const rel = str(r.relation)
      if (rn && rn !== name) relations.push({ name: rn, relation: rel })
    } else if (typeof r === 'string' && str(r)) {
      relations.push({ name: str(r), relation: '' })
    }
  }
  return {
    name,
    aliases: aliasesOf(name, v.aliases),
    gender: str(v.gender),
    identity: str(v.identity),
    appearance: str(v.appearance),
    personality: str(v.personality),
    abilities: str(v.abilities),
    relations,
    facts: strList(v.facts, 8),
    quotes: strList(v.quotes, 3),
    importance: importance(v.importance),
  }
}

function parsePlace(v: unknown): ExtractedPlace | null {
  if (!isRecord(v)) return null
  const name = str(v.name)
  if (!name) return null
  return { name, aliases: aliasesOf(name, v.aliases), description: str(v.description), facts: strList(v.facts, 8) }
}

function parseOrganization(v: unknown): ExtractedOrganization | null {
  if (!isRecord(v)) return null
  const name = str(v.name)
  if (!name) return null
  return {
    name,
    aliases: aliasesOf(name, v.aliases),
    description: str(v.description),
    members: strList(v.members),
    facts: strList(v.facts, 8),
  }
}

function parseTerm(v: unknown): ExtractedTerm | null {
  if (!isRecord(v)) return null
  const name = str(v.name)
  if (!name) return null
  return { name, aliases: aliasesOf(name, v.aliases), category: str(v.category), description: str(v.description) }
}

function parseEvent(v: unknown): ExtractedEvent | null {
  if (!isRecord(v)) return null
  const summary = str(v.summary)
  const title = str(v.title)
  if (!summary && !title) return null
  return { title, summary, characters: strList(v.characters), place: str(v.place), importance: importance(v.importance) }
}

function compact<T>(items: unknown[], parse: (v: unknown) => T | null): T[] {
  const out: T[] = []
  for (const item of items) {
    const parsed = parse(item)
    if (parsed) out.push(parsed)
  }
  return out
}

/** 同名的条目（模型偶尔把同一人写两条）合成一条 */
function dedupeByName<T extends { name: string; aliases: string[] }>(items: T[], combine: (a: T, b: T) => T): T[] {
  const byName = new Map<string, T>()
  for (const item of items) {
    const prev = byName.get(item.name)
    byName.set(item.name, prev ? combine(prev, item) : item)
  }
  return [...byName.values()]
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])]
}

function longer(a: string, b: string): string {
  return b.length > a.length ? b : a
}

/**
 * 解析一块的抽取结果。finishReason 用来在解析失败时说清楚原因（截断、拒绝、没写 JSON、JSON 残缺），
 * 不让用户只看到一句笼统的“格式不对”。
 */
export function parseExtraction(text: string, finishReason?: AiFinishReason): ChunkExtraction {
  let json: unknown
  try {
    json = extractJson(text)
  } catch {
    throw explainBadJson(text, finishReason)
  }
  if (!isRecord(json)) throw new AiError('bad_output', '模型返回的不是整理结果的格式，可以重试')

  const characters = dedupeByName(compact(list(json, 'characters', 'people'), parseCharacter), (a, b) => ({
    ...a,
    aliases: union(a.aliases, b.aliases),
    gender: a.gender || b.gender,
    identity: longer(a.identity, b.identity),
    appearance: longer(a.appearance, b.appearance),
    personality: longer(a.personality, b.personality),
    abilities: longer(a.abilities, b.abilities),
    relations: [...a.relations, ...b.relations],
    facts: union(a.facts, b.facts),
    quotes: union(a.quotes, b.quotes),
    importance: Math.max(a.importance, b.importance),
  }))
  const places = dedupeByName(compact(list(json, 'places', 'locations'), parsePlace), (a, b) => ({
    ...a,
    aliases: union(a.aliases, b.aliases),
    description: longer(a.description, b.description),
    facts: union(a.facts, b.facts),
  }))
  const organizations = dedupeByName(compact(list(json, 'organizations', 'factions'), parseOrganization), (a, b) => ({
    ...a,
    aliases: union(a.aliases, b.aliases),
    description: longer(a.description, b.description),
    members: union(a.members, b.members),
    facts: union(a.facts, b.facts),
  }))
  const terms = dedupeByName(compact(list(json, 'terms', 'items'), parseTerm), (a, b) => ({
    ...a,
    aliases: union(a.aliases, b.aliases),
    category: a.category || b.category,
    description: longer(a.description, b.description),
  }))

  const result: ChunkExtraction = {
    summary: str(json.summary_of_chunk) || str(json.summary),
    characters,
    places,
    organizations,
    terms,
    events: compact(list(json, 'events'), parseEvent),
    world: strList(json.world, 30),
  }
  if (!result.summary && result.characters.length === 0 && result.events.length === 0) {
    throw new AiError('bad_output', '模型没有整理出任何内容，可以重试')
  }
  return result
}

// ---------- 失败原因 ----------

/** 模型用文字拒绝时常见的说法（被内容审核拦下后，有的接口不给拒绝信号，只回一句话） */
const REFUSAL_TEXT =
  /抱歉|对不起|很遗憾|无法(?:为你|为您|帮|提供|处理|协助|完成|满足|生成|回答)|不能(?:为你|为您|帮|提供|处理|协助|完成|生成)|违反|违规|不当内容|敏感内容|sorry|apologi[sz]e|I (?:can(?:no|'|’)t|am unable|'m unable|won't)|unable to (?:help|assist|comply|process)|against .{0,30}polic/i

/** 拒绝的话一般很短；长回复多半是别的内容 */
const REFUSAL_MAX_CHARS = 1500

/** 解析不出 JSON 时，按回复的样子判断是哪种情况 */
function explainBadJson(text: string, finishReason?: AiFinishReason): AiError {
  const t = text.trim()
  if (finishReason === 'length') {
    return new AiError('bad_output', '输出太长被截断了：可以把每块字数调小，或在接口设置里调大最大输出 token')
  }
  if (!t.includes('{')) {
    if (t.length <= REFUSAL_MAX_CHARS && REFUSAL_TEXT.test(t)) {
      return new AiError('refusal', '模型拒绝处理这一段（可能触发了内容审核），可以换个模型再试')
    }
    return new AiError('bad_output', '模型没按要求输出 JSON，回了一段普通文字，可以重试或换个模型')
  }
  return new AiError('bad_output', '模型输出的 JSON 不完整或有语法错误（可能写到一半被中断了），可以重试')
}

/** 留给用户查看的回复：太长时头尾各留这么多字 */
const OUTPUT_KEEP = 300

/** 抽取失败时要存下来的模型回复 */
export function failureOutput(text: string, finishReason?: string): ChunkFailureOutput {
  const t = text.trim()
  const kept =
    t.length <= OUTPUT_KEEP * 2
      ? t
      : `${t.slice(0, OUTPUT_KEEP)}\n\n……（中间省略 ${t.length - OUTPUT_KEEP * 2} 字）……\n\n${t.slice(-OUTPUT_KEEP)}`
  return finishReason ? { text: kept, chars: t.length, finishReason } : { text: kept, chars: t.length }
}
