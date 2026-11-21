/**
 * ST 世界书 JSON 与角色卡内嵌世界书（character_book）之间的转换。
 *
 * 转换规则对照 ST 源码：
 * - character_book → 世界书：convertCharacterBook
 * - 世界书 → character_book：convertWorldInfoToCharacterBook
 */
import type { JsonObject, Lorebook, LorebookEntry } from '../card/types'
import { CardParseError } from '../card/io'

export interface WorldEntry {
  uid: number
  key: string[]
  keysecondary: string[]
  comment: string
  content: string
  constant: boolean
  vectorized: boolean
  selective: boolean
  selectiveLogic: number
  /** 锚点名（位置为 7 时使用），对应卡内的 extensions.outlet_name */
  outletName: string
  addMemo: boolean
  order: number
  position: number
  disable: boolean
  excludeRecursion: boolean
  preventRecursion: boolean
  delayUntilRecursion: boolean | number
  probability: number
  useProbability: boolean
  depth: number
  group: string
  groupOverride: boolean
  groupWeight: number
  scanDepth: number | null
  caseSensitive: boolean | null
  matchWholeWords: boolean | null
  useGroupScoring: boolean | null
  automationId: string
  role: number
  sticky: number | null
  cooldown: number | null
  delay: number | null
  displayIndex: number
  [key: string]: unknown
}

export interface WorldJson {
  entries: Record<string, WorldEntry>
  [key: string]: unknown
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/** 内嵌世界书 → ST 世界书 JSON */
export function lorebookToWorld(book: Lorebook): WorldJson {
  const entries: Record<string, WorldEntry> = {}
  const usedUids = new Set<number>()

  book.entries.forEach((entry, index) => {
    const ext: JsonObject = isObject(entry.extensions) ? entry.extensions : {}
    let uid = typeof entry.id === 'number' ? entry.id : index
    while (usedUids.has(uid)) uid++
    usedUids.add(uid)

    const position =
      typeof ext.position === 'number' ? ext.position : entry.position === 'before_char' ? 0 : 1

    entries[String(uid)] = {
      uid,
      key: strArr(entry.keys),
      keysecondary: strArr(entry.secondary_keys),
      comment: typeof entry.comment === 'string' ? entry.comment : '',
      content: typeof entry.content === 'string' ? entry.content : '',
      constant: entry.constant === true,
      vectorized: ext.vectorized === true,
      selective: entry.selective === true,
      selectiveLogic: typeof ext.selectiveLogic === 'number' ? ext.selectiveLogic : 0,
      outletName: typeof ext.outlet_name === 'string' ? ext.outlet_name : '',
      addMemo: !!entry.comment,
      order: typeof entry.insertion_order === 'number' ? entry.insertion_order : 100,
      position,
      disable: entry.enabled === false,
      excludeRecursion: ext.exclude_recursion === true,
      preventRecursion: ext.prevent_recursion === true,
      delayUntilRecursion: (ext.delay_until_recursion as boolean | number | undefined) ?? false,
      probability: typeof ext.probability === 'number' ? ext.probability : 100,
      useProbability: typeof ext.useProbability === 'boolean' ? ext.useProbability : true,
      depth: typeof ext.depth === 'number' ? ext.depth : 4,
      group: typeof ext.group === 'string' ? ext.group : '',
      groupOverride: ext.group_override === true,
      groupWeight: typeof ext.group_weight === 'number' ? ext.group_weight : 100,
      scanDepth: (ext.scan_depth as number | null | undefined) ?? null,
      caseSensitive: (ext.case_sensitive as boolean | null | undefined) ?? null,
      matchWholeWords: (ext.match_whole_words as boolean | null | undefined) ?? null,
      useGroupScoring: (ext.use_group_scoring as boolean | null | undefined) ?? null,
      automationId: typeof ext.automation_id === 'string' ? ext.automation_id : '',
      role: typeof ext.role === 'number' ? ext.role : 0,
      sticky: (ext.sticky as number | null | undefined) ?? null,
      cooldown: (ext.cooldown as number | null | undefined) ?? null,
      delay: (ext.delay as number | null | undefined) ?? null,
      displayIndex: typeof ext.display_index === 'number' ? ext.display_index : index,
      matchPersonaDescription: ext.match_persona_description === true,
      matchCharacterDescription: ext.match_character_description === true,
      matchCharacterPersonality: ext.match_character_personality === true,
      matchCharacterDepthPrompt: ext.match_character_depth_prompt === true,
      matchScenario: ext.match_scenario === true,
      matchCreatorNotes: ext.match_creator_notes === true,
      extensions: ext,
    }
  })

  return { entries }
}

/** ST 世界书条目 → 内嵌世界书条目 */
function worldEntryToBookEntry(entry: JsonObject, index: number): LorebookEntry {
  const ext: JsonObject = isObject(entry.extensions) ? { ...entry.extensions } : {}
  const position = typeof entry.position === 'number' ? entry.position : 0
  const pick = <T>(value: unknown, fallback: T): T => (value === undefined ? fallback : (value as T))

  return {
    id: typeof entry.uid === 'number' ? entry.uid : index,
    keys: strArr(entry.key),
    secondary_keys: strArr(entry.keysecondary),
    comment: typeof entry.comment === 'string' ? entry.comment : '',
    content: typeof entry.content === 'string' ? entry.content : '',
    constant: entry.constant === true,
    selective: entry.selective !== false,
    insertion_order: typeof entry.order === 'number' ? entry.order : 100,
    enabled: entry.disable !== true,
    position: position === 0 ? 'before_char' : 'after_char',
    use_regex: true,
    extensions: {
      ...ext,
      position,
      exclude_recursion: pick(entry.excludeRecursion, false),
      display_index: pick(entry.displayIndex, index),
      probability: pick(entry.probability, 100),
      useProbability: pick(entry.useProbability, true),
      depth: pick(entry.depth, 4),
      selectiveLogic: pick(entry.selectiveLogic, 0),
      outlet_name: pick(entry.outletName, ext.outlet_name ?? ''),
      group: pick(entry.group, ''),
      group_override: pick(entry.groupOverride, false),
      group_weight: pick(entry.groupWeight, 100),
      prevent_recursion: pick(entry.preventRecursion, false),
      delay_until_recursion: pick(entry.delayUntilRecursion, false),
      scan_depth: pick(entry.scanDepth, null),
      match_whole_words: pick(entry.matchWholeWords, null),
      use_group_scoring: pick(entry.useGroupScoring, false),
      case_sensitive: pick(entry.caseSensitive, null),
      automation_id: pick(entry.automationId, ''),
      role: pick(entry.role, 0),
      vectorized: pick(entry.vectorized, false),
      sticky: pick(entry.sticky, null),
      cooldown: pick(entry.cooldown, null),
      delay: pick(entry.delay, null),
      match_persona_description: pick(entry.matchPersonaDescription, false),
      match_character_description: pick(entry.matchCharacterDescription, false),
      match_character_personality: pick(entry.matchCharacterPersonality, false),
      match_character_depth_prompt: pick(entry.matchCharacterDepthPrompt, false),
      match_scenario: pick(entry.matchScenario, false),
      match_creator_notes: pick(entry.matchCreatorNotes, false),
    },
  }
}

/** ST 世界书 JSON → 内嵌世界书 */
export function worldToLorebook(world: JsonObject, name = ''): Lorebook {
  const raw = world.entries
  const list: JsonObject[] = Array.isArray(raw)
    ? raw.filter(isObject)
    : isObject(raw)
      ? Object.values(raw).filter(isObject)
      : []
  list.sort((a, b) => {
    const da = typeof a.displayIndex === 'number' ? a.displayIndex : 0
    const db = typeof b.displayIndex === 'number' ? b.displayIndex : 0
    return da - db
  })
  return {
    name: typeof world.name === 'string' && world.name ? world.name : name,
    entries: list.map(worldEntryToBookEntry),
    extensions: {},
  }
}

export type LorebookSourceFormat = 'st-world' | 'character-book' | 'card'

export interface ParsedLorebook {
  book: Lorebook
  format: LorebookSourceFormat
}

/**
 * 解析任意来源的世界书 JSON：
 * ST 世界书（entries 是对象，字段 key/uid）、内嵌世界书（entries 是数组，字段 keys），或整张角色卡。
 */
export function parseLorebookJson(text: string, fallbackName = ''): ParsedLorebook {
  let json: unknown
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (error) {
    throw new CardParseError(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isObject(json)) {
    throw new CardParseError('世界书数据不是 JSON 对象')
  }

  const data = isObject(json.data) ? json.data : null
  if (data && isObject(data.character_book)) {
    const book = structuredClone(data.character_book) as Lorebook
    if (!book.name && typeof data.name === 'string') book.name = `${data.name} 的世界书`
    book.extensions ??= {}
    return { book, format: 'card' }
  }

  if (Array.isArray(json.entries)) {
    const first = json.entries.find(isObject)
    if (!first || 'keys' in first) {
      const book = structuredClone(json) as Lorebook
      book.name ||= fallbackName
      book.extensions ??= {}
      return { book, format: 'character-book' }
    }
  }

  if (isObject(json.entries) || Array.isArray(json.entries)) {
    return { book: worldToLorebook(json, fallbackName), format: 'st-world' }
  }

  throw new CardParseError('无法识别的世界书格式')
}
