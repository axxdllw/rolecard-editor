/**
 * 卡库全文搜索：在所有卡的文本槽（描述、开场白、世界书、正则……）里找关键词。
 *
 * 每张卡的文本槽预先收集并转成小写（indexCard），输入变化时只做 indexOf，
 * 上百张卡、单卡上百条世界书也能在几十毫秒内搜完。
 * 多个关键词用空格分隔，要求同一张卡里每个词都出现（不要求在同一处）。
 */
import type { CharacterCardV3 } from '../card/types'
import { collectTextSlots, type JsonPath, type TextSlot } from './search'

export interface IndexedCard {
  id: string
  name: string
  slots: TextSlot[]
  /** 与 slots 一一对应的小写文本；为 null 表示小写后长度变化，需要逐字比较 */
  lower: Array<string | null>
}

export function indexCard(id: string, name: string, card: CharacterCardV3): IndexedCard {
  const slots = collectTextSlots(card).filter((s) => s.text.length > 0)
  const lower = slots.map((s) => {
    const l = s.text.toLowerCase()
    return l.length === s.text.length ? l : null
  })
  return { id, name, slots, lower }
}

/** 按空白拆成关键词，去重，转小写 */
export function parseTerms(text: string): string[] {
  const seen = new Set<string>()
  for (const t of text.trim().toLowerCase().split(/\s+/)) {
    if (t) seen.add(t)
  }
  return [...seen]
}

export interface Snippet {
  before: string
  match: string
  after: string
}

export interface SlotMatch {
  slotIndex: number
  path: JsonPath
  label: string
  group: TextSlot['group']
  /** 该槽里命中的次数 */
  count: number
  /** 第一处命中的前后文 */
  snippet: Snippet
}

export interface CardMatch {
  id: string
  name: string
  /** 全卡命中总次数 */
  total: number
  /** 命中的位置总数（slots 可能被截断） */
  slotCount: number
  /** 命中的位置，最多 maxSlots 个 */
  slots: SlotMatch[]
}

export interface FullTextOptions {
  /** 前后文各取多少字，默认 30 */
  context?: number
  /** 每张卡最多列出多少处命中位置，默认 50；超出的只计数 */
  maxSlots?: number
}

/** 在一段文字里找所有关键词出现的位置（按起点排序，不重叠） */
function findRanges(text: string, lower: string | null, terms: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  if (lower !== null) {
    for (const term of terms) {
      let from = 0
      for (;;) {
        const at = lower.indexOf(term, from)
        if (at < 0) break
        ranges.push([at, at + term.length])
        from = at + term.length
      }
    }
  } else {
    // 极少数字符小写后长度会变（如土耳其语 İ），退回不区分大小写的正则
    const source = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    for (const m of text.matchAll(new RegExp(source, 'giu'))) {
      if (m.index !== undefined && m[0].length > 0) ranges.push([m.index, m.index + m[0].length])
    }
  }
  if (terms.length > 1) {
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1])
    let end = -1
    return ranges.filter(([s, e]) => {
      if (s < end) return false
      end = e
      return true
    })
  }
  return ranges
}

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ')
}

export function makeSnippet(text: string, start: number, end: number, context = 30): Snippet {
  const from = Math.max(0, start - context)
  const to = Math.min(text.length, end + context)
  return {
    before: (from > 0 ? '…' : '') + flatten(text.slice(from, start)).trimStart(),
    match: text.slice(start, end),
    after: flatten(text.slice(end, to)).trimEnd() + (to < text.length ? '…' : ''),
  }
}

/** 搜一张卡；任一关键词在全卡都没出现时返回 null */
export function searchIndexedCard(card: IndexedCard, terms: string[], options: FullTextOptions = {}): CardMatch | null {
  if (terms.length === 0) return null
  // 先确认每个词都在卡里出现过，避免为不满足条件的卡生成片段
  for (const term of terms) {
    const found = card.slots.some((slot, i) => {
      const lower = card.lower[i]
      return lower !== null ? lower.includes(term) : slot.text.toLowerCase().includes(term)
    })
    if (!found) return null
  }

  const maxSlots = options.maxSlots ?? 50
  const slots: SlotMatch[] = []
  let total = 0
  let slotCount = 0
  card.slots.forEach((slot, slotIndex) => {
    const ranges = findRanges(slot.text, card.lower[slotIndex], terms)
    if (ranges.length === 0) return
    total += ranges.length
    if (slotCount++ >= maxSlots) return
    const [start, end] = ranges[0]
    slots.push({
      slotIndex,
      path: slot.path,
      label: slot.label,
      group: slot.group,
      count: ranges.length,
      snippet: makeSnippet(slot.text, start, end, options.context),
    })
  })
  return { id: card.id, name: card.name, total, slotCount, slots }
}

/** 搜一批卡，按命中次数从多到少排序，同样多时按名字 */
export function searchIndexedCards(cards: IndexedCard[], text: string, options: FullTextOptions = {}): CardMatch[] {
  const terms = parseTerms(text)
  if (terms.length === 0) return []
  const out: CardMatch[] = []
  for (const card of cards) {
    const match = searchIndexedCard(card, terms, options)
    if (match) out.push(match)
  }
  out.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh'))
  return out
}

/** 命中位置对应的编辑页落点 */
export interface SlotTarget {
  tab: 'character' | 'worldbook' | 'regex'
  /** 角色页里要滚动到的元素 id */
  anchor?: string
  /** 世界书条目下标 */
  entry?: number
  /** 正则下标 */
  regex?: number
}

/** 把文本槽路径换成编辑页的落点；锚点 id 要和编辑页里的一致（fields.tsx、GreetingsSection） */
export function slotTarget(path: JsonPath): SlotTarget {
  const [, key, a, b] = path
  if (key === 'character_book') {
    return a === 'entries' && typeof b === 'number' ? { tab: 'worldbook', entry: b } : { tab: 'worldbook' }
  }
  if (key === 'extensions') {
    if (a === 'regex_scripts' && typeof b === 'number') return { tab: 'regex', regex: b }
    if (a === 'depth_prompt') return { tab: 'character', anchor: 'field-data-extensions-depth_prompt-prompt' }
    return { tab: 'character' }
  }
  if (key === 'alternate_greetings' && typeof a === 'number') return { tab: 'character', anchor: `greeting-${a}` }
  if (key === 'group_only_greetings' && typeof a === 'number') return { tab: 'character', anchor: `group-greeting-${a}` }
  if (typeof key === 'string') return { tab: 'character', anchor: `field-data-${key}` }
  return { tab: 'character' }
}

/** 把一段文字按关键词切开，用来高亮显示（不区分大小写） */
export function splitHighlights(text: string, terms: string[]): Array<{ text: string; hit: boolean }> {
  const lower = text.toLowerCase()
  const ranges = findRanges(text, lower.length === text.length ? lower : null, terms)
  const out: Array<{ text: string; hit: boolean }> = []
  let pos = 0
  for (const [s, e] of ranges) {
    if (s > pos) out.push({ text: text.slice(pos, s), hit: false })
    out.push({ text: text.slice(s, e), hit: true })
    pos = e
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false })
  return out
}
