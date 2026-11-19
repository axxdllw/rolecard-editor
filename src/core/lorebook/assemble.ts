/**
 * 提示词组装预览：按 ST（Chat Completion 默认顺序）模拟世界书条目插入的位置。
 *
 * 同一位置内按 insertion_order 从小到大排，越大越靠后；
 * @depth 条目按（深度，消息角色）分组插进聊天记录。
 */
import type { CharacterCardV3, JsonObject, Lorebook, LorebookEntry } from '../card/types'
import { substituteMacros, type MacroContext } from '../macros'
import { regexFromString } from '../regex/regex'
import { entryTitle, getDepth, getOrder, getPosition, getRole, getSelectiveLogic, getStrategy, isRegexKey, readEntrySettings, ROLE_OPTIONS } from './entry'

/** constant：只看常驻；all：把所有关键词条目当作已触发；match：用测试文本匹配关键词 */
export type ActivationMode = 'constant' | 'all' | 'match'

export interface AssembleOptions {
  mode: ActivationMode
  /** match 模式下用来匹配关键词的文本 */
  chatText?: string
  macros: MacroContext
}

export interface AssembledBlock {
  title: string
  content: string
  /** card：卡片字段；constant：常驻条目；triggered：触发的关键词条目；note：说明 */
  kind: 'card' | 'constant' | 'triggered' | 'note'
  entryIndex?: number
}

export interface AssembledSection {
  id: string
  title: string
  hint?: string
  blocks: AssembledBlock[]
}

function keyMatches(rawKey: string, text: string, entry: LorebookEntry, macros: MacroContext): boolean {
  const key = substituteMacros(rawKey.trim(), macros)
  if (!key) return false
  if (isRegexKey(key)) {
    const re = regexFromString(key)
    return re ? re.test(text) : false
  }
  const settings = readEntrySettings(entry)
  const caseSensitive = settings.caseSensitive === true
  const haystack = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? key : key.toLowerCase()
  if (settings.matchWholeWords === true && /^[\w\s]+$/.test(needle)) {
    const re = new RegExp(`(?:^|\\W)${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\W)`, caseSensitive ? '' : 'i')
    return re.test(text)
  }
  return haystack.includes(needle)
}

/** 简易关键词匹配（不含递归、概率、分组），供预览和测试使用 */
export function entryMatchesText(entry: LorebookEntry, text: string, macros: MacroContext): boolean {
  const keys = (entry.keys ?? []).filter((k) => k.trim())
  if (!keys.some((k) => keyMatches(k, text, entry, macros))) return false

  const secondary = (entry.secondary_keys ?? []).filter((k) => k.trim())
  if (!entry.selective || secondary.length === 0) return true

  const hits = secondary.filter((k) => keyMatches(k, text, entry, macros)).length
  switch (getSelectiveLogic(entry)) {
    case 1:
      return hits < secondary.length
    case 2:
      return hits === 0
    case 3:
      return hits === secondary.length
    default:
      return hits > 0
  }
}

export interface ActiveEntry {
  index: number
  entry: LorebookEntry
  source: 'constant' | 'triggered'
}

export function activeEntries(book: Lorebook | undefined, options: AssembleOptions): ActiveEntry[] {
  if (!book) return []
  const out: ActiveEntry[] = []
  book.entries.forEach((entry, index) => {
    if (entry.enabled === false) return
    const strategy = getStrategy(entry)
    if (strategy === 'constant') {
      out.push({ index, entry, source: 'constant' })
      return
    }
    if (options.mode === 'all') {
      out.push({ index, entry, source: 'triggered' })
    } else if (options.mode === 'match' && strategy === 'keyword' && options.chatText) {
      if (entryMatchesText(entry, options.chatText, options.macros)) {
        out.push({ index, entry, source: 'triggered' })
      }
    }
  })
  return out
}

function sortByOrder(list: ActiveEntry[]): ActiveEntry[] {
  return [...list].sort((a, b) => getOrder(a.entry) - getOrder(b.entry) || a.index - b.index)
}

function toBlocks(list: ActiveEntry[], macros: MacroContext): AssembledBlock[] {
  return sortByOrder(list).map(({ entry, index, source }) => ({
    title: entryTitle(entry, index),
    content: substituteMacros(entry.content ?? '', macros),
    kind: source,
    entryIndex: index,
  }))
}

function cardBlock(title: string, text: unknown, macros: MacroContext): AssembledBlock[] {
  if (typeof text !== 'string' || !text.trim()) return []
  return [{ title, content: substituteMacros(text, macros), kind: 'card' }]
}

export function assemblePrompt(card: CharacterCardV3, options: AssembleOptions): AssembledSection[] {
  const { macros } = options
  const data = card.data
  const active = activeEntries(data.character_book, options)
  const at = (position: number) => active.filter((a) => getPosition(a.entry) === position)

  const sections: AssembledSection[] = []
  const push = (section: AssembledSection) => {
    if (section.blocks.length > 0) sections.push(section)
  }

  push({
    id: 'system',
    title: '系统提示词（角色卡覆盖）',
    hint: '只有开启“优先使用角色卡里的提示词”时才会替换主提示词',
    blocks: cardBlock('system_prompt', data.system_prompt, macros),
  })
  push({ id: 'wi-before', title: '世界书 · 角色定义前', blocks: toBlocks(at(0), macros) })
  push({
    id: 'char',
    title: '角色定义',
    blocks: [
      ...cardBlock('角色描述', data.description, macros),
      ...cardBlock('性格', data.personality, macros),
      ...cardBlock('场景', data.scenario, macros),
    ],
  })
  push({ id: 'wi-after', title: '世界书 · 角色定义后', blocks: toBlocks(at(1), macros) })
  push({
    id: 'examples',
    title: '示例对话',
    blocks: [...toBlocks(at(5), macros), ...cardBlock('示例对话', data.mes_example, macros), ...toBlocks(at(6), macros)],
  })

  // 聊天记录：@depth 条目、作者注释、角色注释
  const chatBlocks: AssembledBlock[] = []
  const depthGroups = new Map<string, { depth: number; role: number; items: ActiveEntry[] }>()
  for (const a of at(4)) {
    const depth = getDepth(a.entry)
    const role = getRole(a.entry)
    const key = `${depth}:${role}`
    const group = depthGroups.get(key) ?? { depth, role, items: [] }
    group.items.push(a)
    depthGroups.set(key, group)
  }

  const ext: JsonObject = data.extensions ?? {}
  const depthPrompt = ext.depth_prompt as JsonObject | undefined
  const notePrompt = typeof depthPrompt?.prompt === 'string' ? depthPrompt.prompt.trim() : ''

  const groups = [...depthGroups.values()].sort((a, b) => b.depth - a.depth || a.role - b.role)
  for (const g of groups) {
    chatBlocks.push({
      title: `深度 ${g.depth} · ${ROLE_OPTIONS[g.role]?.label ?? 'system'}`,
      content: '',
      kind: 'note',
    })
    chatBlocks.push(...toBlocks(g.items, macros))
  }
  if (notePrompt && depthPrompt) {
    const depth = typeof depthPrompt.depth === 'number' ? depthPrompt.depth : 4
    const role = typeof depthPrompt.role === 'string' ? depthPrompt.role : 'system'
    chatBlocks.push({ title: `角色注释 · 深度 ${depth} · ${role}`, content: substituteMacros(notePrompt, macros), kind: 'card' })
  }
  const anTop = at(2)
  const anBottom = at(3)
  if (anTop.length + anBottom.length > 0) {
    chatBlocks.push({ title: '作者注释（深度由聊天设置决定）', content: '', kind: 'note' })
    chatBlocks.push(...toBlocks(anTop, macros))
    chatBlocks.push({ title: '〔作者注释正文〕', content: '', kind: 'note' })
    chatBlocks.push(...toBlocks(anBottom, macros))
  }
  push({
    id: 'chat',
    title: '聊天记录中的插入',
    hint: '深度 N 表示插在倒数第 N 条消息之前，深度 0 在最新消息之后',
    blocks: chatBlocks,
  })

  push({
    id: 'post-history',
    title: '历史后指令（角色卡覆盖）',
    blocks: cardBlock('post_history_instructions', data.post_history_instructions, macros),
  })

  return sections
}

/** 统计提示词里每轮都会发送的固定文本（不含聊天记录） */
export function constantPromptTexts(card: CharacterCardV3): string[] {
  const data = card.data
  const texts = [
    data.description,
    data.personality,
    data.scenario,
    data.mes_example,
    data.system_prompt,
    data.post_history_instructions,
  ].filter((t): t is string => typeof t === 'string' && t.length > 0)
  const depthPrompt = (data.extensions ?? {}).depth_prompt as JsonObject | undefined
  if (typeof depthPrompt?.prompt === 'string' && depthPrompt.prompt) texts.push(depthPrompt.prompt)
  for (const entry of data.character_book?.entries ?? []) {
    if (entry.enabled !== false && entry.constant && entry.content) texts.push(entry.content)
  }
  return texts
}
