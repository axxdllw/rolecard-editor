/**
 * 世界书触发模拟核心逻辑。
 *
 * 逐行对照 SillyTavern 1.16.0（scripts/world-info.js 与 script.js）移植：
 * - WorldInfoBuffer：扫描缓冲、全词/大小写/正则匹配、包含组评分
 * - WorldInfoTimedEffects：粘性（sticky）、冷却（cooldown）、延迟（delay）
 * - parseDecorators：内容开头 @@activate / @@dont_activate 装饰器解析
 * - checkWorldInfo：主扫描循环、次要关键词逻辑、包含组、概率、预算、递归、最少激活数、延迟递归层级
 */
import type { JsonObject, LorebookEntry } from '../card/types'
import { substituteMacros, type MacroContext } from '../macros'

export interface ScanSettings {
  /** world_info_depth：扫描最近几条消息 */
  scanDepth: number
  recursive: boolean
  /** 0 = 不限 */
  maxRecursionSteps: number
  minActivations: number
  minActivationsDepthMax: number
  /** world_info_budget，百分比 */
  budgetPercent: number
  /** world_info_budget_cap，0 = 不限 */
  budgetCap: number
  /** 上下文长度（token）。预算 = Math.round(budgetPercent * maxContext / 100) || 1，再受 budgetCap 限制 */
  maxContext: number
  includeNames: boolean
  caseSensitive: boolean
  matchWholeWords: boolean
  useGroupScoring: boolean
}

/** 默认扫描设置（和酒馆常用设置一致） */
export const DEFAULT_SCAN_SETTINGS: ScanSettings = {
  scanDepth: 2,
  recursive: true,
  maxRecursionSteps: 0,
  minActivations: 0,
  minActivationsDepthMax: 0,
  budgetPercent: 100,
  budgetCap: 0,
  maxContext: 200000,
  includeNames: false,
  caseSensitive: false,
  matchWholeWords: false,
  useGroupScoring: false,
}

export interface ScanMessage {
  role: 'user' | 'char'
  text: string
}

/** 额外匹配来源（条目的 match_character_description 等开关对应的文本） */
export interface GlobalScanData {
  personaDescription: string
  characterDescription: string
  characterPersonality: string
  characterDepthPrompt: string
  scenario: string
  creatorNotes: string
}

export interface TimedEffectRecord {
  start: number
  end: number
  protected: boolean
}

/** 对应 chat_metadata.timedWorldInfo；键用条目在 entries 里的下标（字符串），代替酒馆的内容哈希 */
export interface TimedEffectsState {
  sticky: Record<string, TimedEffectRecord>
  cooldown: Record<string, TimedEffectRecord>
}

export interface ScanInput {
  /** card.data.character_book.entries，原样传入，不许修改它（内部要深拷贝或只读） */
  entries: LorebookEntry[]
  /** 聊天记录，从旧到新（含开场白），即本轮生成前的全部消息 */
  chat: ScanMessage[]
  /** 角色名和用户名：includeNames 的前缀，以及关键词和内容里 {{char}}/{{user}} 的替换（用 substituteMacros） */
  names: MacroContext
  settings: ScanSettings
  globalScanData: GlobalScanData
  /** 生成类型，对应条目 extensions.triggers 过滤；默认 'normal' */
  trigger?: string
  /** token 计数（预算用），由调用方注入 */
  countTokens: (text: string) => number
  /** [0,1) 随机数，概率掷骰和包含组按权重抽选都用它；默认 Math.random */
  random?: () => number
  /** 上一轮留下的计时状态；不传等于空 */
  timedState?: TimedEffectsState
}

export type ActivationReason = 'constant' | 'keyword' | 'sticky' | 'decorator'

export type SkipReason =
  | 'disabled'               // 未启用
  | 'trigger-filter'         // 生成类型不符
  | 'delay'                  // 聊天消息数还不够（delay）
  | 'cooldown'               // 冷却中
  | 'delay-until-recursion'  // 只能被递归触发，但没有轮到它那一层递归
  | 'exclude-recursion'      // 只在递归扫描里命中，但条目设了不被递归触发
  | 'dont-activate'          // @@dont_activate
  | 'no-keys'                // 没有主关键词（且不是常驻）
  | 'no-match'               // 主关键词没有命中
  | 'secondary'              // 主关键词命中了，次要关键词逻辑不满足
  | 'group'                  // 包含组里落选
  | 'probability'            // 概率没掷中
  | 'budget'                 // 超出预算
  | 'not-scanned'            // 扫描提前结束（达到最大递归步数等）没轮到它

export interface EntryTrace {
  index: number
  status: 'activated' | 'skipped'
  reason: ActivationReason | SkipReason
  /** 激活（或最后一次被判定）发生在第几轮扫描循环，从 1 开始 */
  loop?: number
  scanState?: 'initial' | 'recursion' | 'min-activations'
  /** 命中的主关键词（条目里的原文） */
  matchedKey?: string
  /** 命中的次要关键词（原文） */
  matchedSecondary?: string[]
  /**
   * 命中的主关键词出现在哪里（只用于说明，不影响判定）：
   * 判定命中后，把关键词再分别对每个片段测一次，取第一个命中的片段。都不单独命中就不填。
   */
  matchSource?:
    | { kind: 'chat'; messageIndex: number }          // chat 数组里的下标（从旧到新的下标）
    | { kind: 'recursion'; entryIndex: number }       // 被哪个条目的内容递归触发
    | { kind: 'global'; field: keyof GlobalScanData }
  /** 所在包含组（落选或胜出时填） */
  group?: string
  /** 概率掷骰的值（0-100），只有真正掷了才填 */
  roll?: number
  /** 中文说明，给界面直接显示 */
  detail?: string
}

export interface ScanResult {
  /** 激活的条目下标，顺序同酒馆拼提示词时遍历的顺序（[...allActivatedEntries.values()].sort(sortFn)） */
  activated: number[]
  /** 每个条目一条，与 entries 下标对齐 */
  traces: EntryTrace[]
  /** 扫描循环跑了几轮 */
  loops: number
  budget: number
  /** 预算判断里最后一次计算的 token 数（textToScanTokens + newContent 的 token） */
  usedTokens: number
  budgetOverflowed: boolean
  /** 本轮结束后的计时状态（相当于非 dry run 时写进 chat_metadata 的结果），传给下一轮 */
  timedState: TimedEffectsState
}

export interface TurnResult extends ScanResult {
  /** 这一轮生成前，聊天里有几条消息（即用了 chat.slice(0, chatLength)） */
  chatLength: number
}

// —— 酒馆常量（world-info.js L33-100） ——

const WI_LOGIC = {
  AND_ANY: 0,
  NOT_ALL: 1,
  NOT_ANY: 2,
  AND_ALL: 3,
} as const

const SCAN_STATE = {
  NONE: 0,
  INITIAL: 1,
  RECURSION: 2,
  MIN_ACTIVATIONS: 3,
} as const

type ScanStateValue = (typeof SCAN_STATE)[keyof typeof SCAN_STATE]
type ActiveScanStateName = 'initial' | 'recursion' | 'min-activations'

const DEFAULT_WEIGHT = 100
const MAX_SCAN_DEPTH = 1000
const KNOWN_DECORATORS = ['@@activate', '@@dont_activate']

const LOGIC_LABEL: Record<number, string> = {
  [WI_LOGIC.AND_ANY]: '含任一个',
  [WI_LOGIC.NOT_ALL]: '不全含',
  [WI_LOGIC.NOT_ANY]: '一个都不含',
  [WI_LOGIC.AND_ALL]: '全部包含',
}

// —— 内部条目结构（对照 convertCharacterBook，world-info.js L5411-5468） ——

interface InternalEntry {
  /** 在原始 entries 数组里的下标 */
  index: number
  /** 在 sortedEntries 里的下标 */
  sortedIndex: number
  uid: number | string
  key: string[]
  keysecondary: string[]
  comment: string
  content: string
  decorators: string[]
  constant: boolean
  selective: boolean
  order: number
  excludeRecursion: boolean
  preventRecursion: boolean
  /** 原始值（可能是 true、false 或数字层级） */
  delayUntilRecursion: boolean | number
  /** 归一化后的延迟递归层级（0 表示未启用，true 映射为 1） */
  delayUntilRecursionLevel: number
  disable: boolean
  /** 卡里这条没有 enabled 字段（酒馆导入时会当作未启用） */
  missingEnabled: boolean
  probability: number
  useProbability: boolean
  selectiveLogic: number
  group: string
  groupOverride: boolean
  groupWeight: number
  scanDepth: number | null
  caseSensitive: boolean | null
  matchWholeWords: boolean | null
  useGroupScoring: boolean | null
  sticky: number | null
  cooldown: number | null
  delay: number | null
  matchPersonaDescription: boolean
  matchCharacterDescription: boolean
  matchCharacterPersonality: boolean
  matchCharacterDepthPrompt: boolean
  matchScenario: boolean
  matchCreatorNotes: boolean
  triggers: string[]
  ignoreBudget: boolean
}

const sortFn = (a: InternalEntry, b: InternalEntry): number => b.order - a.order

function scanStateName(state: ScanStateValue): ActiveScanStateName {
  if (state === SCAN_STATE.RECURSION) return 'recursion'
  if (state === SCAN_STATE.MIN_ACTIVATIONS) return 'min-activations'
  return 'initial'
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 从 /pattern/flags 形式解析正则表达式（逐行照抄 world-info.js L2825 parseRegexFromString）。
 * 不使用项目里 regexFromString，因为两者对未转义斜杠和 flags 的规则不同。
 */
function parseRegexFromString(input: string): RegExp | null {
  const match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/)
  if (!match) {
    return null
  }

  let [, pattern, flags] = match

  // 内部出现未转义的 `/` 时判为非法正则
  if (/(^|[^\\])\//.test(pattern)) {
    return null
  }

  // 与酒馆一致：反斜杠转义的斜杠还原为 `/`
  pattern = pattern.replace('\\/', '/')

  try {
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}

/** 剥掉内容开头的装饰器，返回 [装饰器列表, 剩余内容]（照抄 world-info.js L4451 parseDecorators） */
export function parseDecorators(content: string): [string[], string] {
  const isKnownDecorator = (data: string): boolean => {
    const normalized = data.startsWith('@@@') ? data.substring(1) : data
    for (let i = 0; i < KNOWN_DECORATORS.length; i++) {
      if (normalized.startsWith(KNOWN_DECORATORS[i])) {
        return true
      }
    }
    return false
  }

  if (content.startsWith('@@')) {
    let newContent = content
    const splited = content.split('\n')
    const decorators: string[] = []
    let fallbacked = false

    for (let i = 0; i < splited.length; i++) {
      if (splited[i].startsWith('@@')) {
        if (splited[i].startsWith('@@@') && !fallbacked) {
          continue
        }

        if (isKnownDecorator(splited[i])) {
          decorators.push(splited[i].startsWith('@@@') ? splited[i].substring(1) : splited[i])
          fallbacked = false
        } else {
          fallbacked = true
        }
      } else {
        newContent = splited.slice(i).join('\n')
        break
      }
    }
    return [decorators, newContent]
  }

  return [[], content]
}

/** 按 convertCharacterBook（world-info.js L5411）将卡内条目转为只读内部副本，不修改原对象 */
function convertEntry(entry: LorebookEntry, index: number): InternalEntry {
  const ext: JsonObject = entry.extensions && typeof entry.extensions === 'object' ? entry.extensions : {}
  const rawContent = typeof entry.content === 'string' ? entry.content : ''
  const [decorators, content] = parseDecorators(rawContent)

  const rawDelayUntilRecursion = ext.delay_until_recursion
  let delayUntilRecursion: boolean | number = false
  let delayUntilRecursionLevel = 0
  if (rawDelayUntilRecursion === true) {
    delayUntilRecursion = true
    delayUntilRecursionLevel = 1
  } else if (typeof rawDelayUntilRecursion === 'number' && Number.isFinite(rawDelayUntilRecursion) && rawDelayUntilRecursion !== 0) {
    delayUntilRecursion = rawDelayUntilRecursion
    delayUntilRecursionLevel = rawDelayUntilRecursion
  }

  return {
    index,
    sortedIndex: index,
    uid: entry.id ?? index,
    key: Array.isArray(entry.keys) ? entry.keys.filter((k): k is string => typeof k === 'string') : [],
    keysecondary: Array.isArray(entry.secondary_keys) ? entry.secondary_keys.filter((k): k is string => typeof k === 'string') : [],
    comment: typeof entry.comment === 'string' ? entry.comment : '',
    content,
    decorators,
    constant: Boolean(entry.constant),
    selective: Boolean(entry.selective),
    order: typeof entry.insertion_order === 'number' && Number.isFinite(entry.insertion_order) ? entry.insertion_order : 100,
    excludeRecursion: Boolean(ext.exclude_recursion ?? false),
    preventRecursion: Boolean(ext.prevent_recursion ?? false),
    delayUntilRecursion,
    delayUntilRecursionLevel,
    // 同 convertCharacterBook 的 disable: !entry.enabled：缺少 enabled 字段的条目导入酒馆后是未启用的
    disable: !entry.enabled,
    missingEnabled: entry.enabled === undefined || entry.enabled === null,
    probability: typeof ext.probability === 'number' && Number.isFinite(ext.probability) ? ext.probability : 100,
    useProbability: typeof ext.useProbability === 'boolean' ? ext.useProbability : true,
    selectiveLogic: typeof ext.selectiveLogic === 'number' && Number.isFinite(ext.selectiveLogic) ? ext.selectiveLogic : WI_LOGIC.AND_ANY,
    group: typeof ext.group === 'string' ? ext.group : '',
    groupOverride: Boolean(ext.group_override ?? false),
    groupWeight: typeof ext.group_weight === 'number' && Number.isFinite(ext.group_weight) ? ext.group_weight : DEFAULT_WEIGHT,
    scanDepth: typeof ext.scan_depth === 'number' && Number.isFinite(ext.scan_depth) ? ext.scan_depth : null,
    caseSensitive: typeof ext.case_sensitive === 'boolean' ? ext.case_sensitive : null,
    matchWholeWords: typeof ext.match_whole_words === 'boolean' ? ext.match_whole_words : null,
    useGroupScoring: typeof ext.use_group_scoring === 'boolean' ? ext.use_group_scoring : null,
    sticky: typeof ext.sticky === 'number' && Number.isFinite(ext.sticky) ? ext.sticky : null,
    cooldown: typeof ext.cooldown === 'number' && Number.isFinite(ext.cooldown) ? ext.cooldown : null,
    delay: typeof ext.delay === 'number' && Number.isFinite(ext.delay) ? ext.delay : null,
    matchPersonaDescription: Boolean(ext.match_persona_description ?? false),
    matchCharacterDescription: Boolean(ext.match_character_description ?? false),
    matchCharacterPersonality: Boolean(ext.match_character_personality ?? false),
    matchCharacterDepthPrompt: Boolean(ext.match_character_depth_prompt ?? false),
    matchScenario: Boolean(ext.match_scenario ?? false),
    matchCreatorNotes: Boolean(ext.match_creator_notes ?? false),
    triggers: Array.isArray(ext.triggers) ? ext.triggers.filter((t): t is string => typeof t === 'string') : [],
    ignoreBudget: Boolean(ext.ignore_budget ?? false),
  }
}

// —— WorldInfoBuffer（对照 world-info.js L199-475） ——

interface RecurseSourceItem {
  entryIndex: number
  text: string
}

const GLOBAL_FIELD_MAP: ReadonlyArray<{
  flag:
    | 'matchPersonaDescription'
    | 'matchCharacterDescription'
    | 'matchCharacterPersonality'
    | 'matchCharacterDepthPrompt'
    | 'matchScenario'
    | 'matchCreatorNotes'
  field: keyof GlobalScanData
}> = [
  { flag: 'matchPersonaDescription', field: 'personaDescription' },
  { flag: 'matchCharacterDescription', field: 'characterDescription' },
  { flag: 'matchCharacterPersonality', field: 'characterPersonality' },
  { flag: 'matchCharacterDepthPrompt', field: 'characterDepthPrompt' },
  { flag: 'matchScenario', field: 'scenario' },
  { flag: 'matchCreatorNotes', field: 'creatorNotes' },
]

class WorldInfoBuffer {
  #globalScanData: GlobalScanData
  #settings: ScanSettings
  #chatCount: number
  #depthBuffer: string[] = []
  #recurseBuffer: string[] = []
  #recurseSources: RecurseSourceItem[] = []
  #skew = 0
  #startDepth = 0
  #regexCache = new Map<string, RegExp | null>()
  #wholeWordCache = new Map<string, RegExp>()

  constructor(messages: string[], globalScanData: GlobalScanData, settings: ScanSettings) {
    this.#globalScanData = globalScanData
    this.#settings = settings
    this.#chatCount = messages.length
    this.#initDepthBuffer(messages)
  }

  #initDepthBuffer(messages: string[]): void {
    const limit = Math.min(messages.length, MAX_SCAN_DEPTH)
    for (let depth = 0; depth < limit; depth++) {
      if (messages[depth]) {
        this.#depthBuffer[depth] = messages[depth].trim()
      }
    }
  }

  #transformString(str: string, entry: InternalEntry): string {
    const caseSensitive = entry.caseSensitive ?? this.#settings.caseSensitive
    return caseSensitive ? str : str.toLowerCase()
  }

  #getCompiledRegex(needle: string): RegExp | null {
    if (this.#regexCache.has(needle)) {
      return this.#regexCache.get(needle) ?? null
    }
    const compiled = parseRegexFromString(needle)
    this.#regexCache.set(needle, compiled)
    return compiled
  }

  #getWholeWordRegex(transformedString: string): RegExp {
    const cached = this.#wholeWordCache.get(transformedString)
    if (cached) return cached
    const regex = new RegExp(`(?:^|\\W)(${escapeRegex(transformedString)})(?:$|\\W)`)
    this.#wholeWordCache.set(transformedString, regex)
    return regex
  }

  #effectiveDepth(entry: InternalEntry): number {
    let depth = entry.scanDepth ?? this.getDepth()
    if (depth <= this.#startDepth || depth < 0) return 0
    if (depth > MAX_SCAN_DEPTH) depth = MAX_SCAN_DEPTH
    return depth
  }

  get(entry: InternalEntry, scanState: ScanStateValue): string {
    const depth = this.#effectiveDepth(entry)
    if (depth <= 0) {
      return ''
    }

    const MATCHER = '\x01'
    const JOINER = '\n' + MATCHER
    let result = MATCHER + this.#depthBuffer.slice(this.#startDepth, depth).join(JOINER)

    for (const { flag, field } of GLOBAL_FIELD_MAP) {
      if (entry[flag] && this.#globalScanData[field]) {
        result += JOINER + this.#globalScanData[field]
      }
    }

    // 最少激活数扫描不包含递归缓冲（world-info.js L322-325）
    if (this.#recurseBuffer.length > 0 && scanState !== SCAN_STATE.MIN_ACTIVATIONS) {
      result += JOINER + this.#recurseBuffer.join(JOINER)
    }

    return result
  }

  matchKeys(haystack: string, needle: string, entry: InternalEntry): boolean {
    const keyRegex = this.#getCompiledRegex(needle)
    if (keyRegex) {
      // 复用缓存正则时重置 lastIndex，避免带 g/y 标志时状态污染
      keyRegex.lastIndex = 0
      return keyRegex.test(haystack)
    }

    const target = this.#transformString(haystack, entry)
    const transformedString = this.#transformString(needle, entry)
    const matchWholeWords = entry.matchWholeWords ?? this.#settings.matchWholeWords

    if (matchWholeWords) {
      const keyWords = transformedString.split(/\s+/)
      if (keyWords.length > 1) {
        return target.includes(transformedString)
      }
      const regex = this.#getWholeWordRegex(transformedString)
      return regex.test(target)
    }

    return target.includes(transformedString)
  }

  /** 判定命中后单独检查每个来源片段，定位命中的主关键词出现在哪里（不影响判定） */
  locateMatchSource(needle: string, entry: InternalEntry, scanState: ScanStateValue): EntryTrace['matchSource'] {
    const depth = this.#effectiveDepth(entry)
    if (depth <= 0) return undefined

    const maxChatDepth = Math.min(depth, this.#depthBuffer.length)
    for (let d = this.#startDepth; d < maxChatDepth; d++) {
      const segment = this.#depthBuffer[d]
      if (segment && this.matchKeys(segment, needle, entry)) {
        return { kind: 'chat', messageIndex: this.#chatCount - 1 - d }
      }
    }

    for (const { flag, field } of GLOBAL_FIELD_MAP) {
      const text = this.#globalScanData[field]
      if (entry[flag] && text && this.matchKeys(text, needle, entry)) {
        return { kind: 'global', field }
      }
    }

    if (this.#recurseSources.length > 0 && scanState !== SCAN_STATE.MIN_ACTIVATIONS) {
      for (const item of this.#recurseSources) {
        if (item.text && this.matchKeys(item.text, needle, entry)) {
          return { kind: 'recursion', entryIndex: item.entryIndex }
        }
      }
    }

    return undefined
  }

  addRecurse(message: string, sources: RecurseSourceItem[]): void {
    this.#recurseBuffer.push(message)
    for (const item of sources) {
      this.#recurseSources.push(item)
    }
  }

  hasRecurse(): boolean {
    return this.#recurseBuffer.length > 0
  }

  advanceScan(): void {
    this.#skew++
  }

  getDepth(): number {
    return this.#settings.scanDepth + this.#skew
  }

  /** 包含组关键词评分（对照 world-info.js L429-474） */
  getScore(entry: InternalEntry, scanState: ScanStateValue): number {
    const bufferState = this.get(entry, scanState)
    let numberOfPrimaryKeys = 0
    let numberOfSecondaryKeys = 0
    let primaryScore = 0
    let secondaryScore = 0

    if (Array.isArray(entry.key)) {
      numberOfPrimaryKeys = entry.key.length
      // 同酒馆 getScore：直接用关键词原文，不替换宏、不 trim
      for (const key of entry.key) {
        if (this.matchKeys(bufferState, key, entry)) {
          primaryScore++
        }
      }
    }

    if (Array.isArray(entry.keysecondary)) {
      numberOfSecondaryKeys = entry.keysecondary.length
      for (const key of entry.keysecondary) {
        if (this.matchKeys(bufferState, key, entry)) {
          secondaryScore++
        }
      }
    }

    if (!numberOfPrimaryKeys) {
      return 0
    }

    if (numberOfSecondaryKeys > 0) {
      switch (entry.selectiveLogic) {
        case WI_LOGIC.AND_ANY:
          return primaryScore + secondaryScore
        case WI_LOGIC.AND_ALL:
          return secondaryScore === numberOfSecondaryKeys ? primaryScore + secondaryScore : primaryScore
        default:
          break
      }
    }

    return primaryScore
  }
}

// —— WorldInfoTimedEffects（对照 world-info.js L480-795） ——

type TimedEffectType = 'sticky' | 'cooldown' | 'delay'
type PersistentEffectType = 'sticky' | 'cooldown'

function cloneTimedState(state?: TimedEffectsState): TimedEffectsState {
  const result: TimedEffectsState = { sticky: {}, cooldown: {} }
  if (!state) return result

  for (const type of ['sticky', 'cooldown'] as const) {
    const map = state[type]
    if (!map || typeof map !== 'object') continue
    for (const [key, value] of Object.entries(map)) {
      if (value && typeof value === 'object') {
        result[type][key] = {
          start: Number(value.start),
          end: Number(value.end),
          protected: Boolean(value.protected),
        }
      }
    }
  }
  return result
}

class WorldInfoTimedEffects {
  #chatLength: number
  #entries: InternalEntry[]
  #entriesByKey: Map<string, InternalEntry>
  #state: TimedEffectsState
  #buffer: Record<TimedEffectType, Set<number>> = {
    sticky: new Set(),
    cooldown: new Set(),
    delay: new Set(),
  }

  constructor(chatLength: number, entries: InternalEntry[], initialState?: TimedEffectsState) {
    this.#chatLength = chatLength
    this.#entries = entries
    this.#entriesByKey = new Map(entries.map((e) => [String(e.index), e]))
    this.#state = cloneTimedState(initialState)
  }

  #getEntryKey(entry: InternalEntry): string {
    return String(entry.index)
  }

  #createRecord(type: PersistentEffectType, entry: InternalEntry, isProtected: boolean): TimedEffectRecord {
    return {
      start: this.#chatLength,
      end: this.#chatLength + Number(entry[type]),
      protected: isProtected,
    }
  }

  #onStickyEnded(entry: InternalEntry): void {
    if (!entry.cooldown) return
    const key = this.#getEntryKey(entry)
    const effect = this.#createRecord('cooldown', entry, true)
    this.#state.cooldown[key] = effect
    this.#buffer.cooldown.add(entry.index)
  }

  #checkTimedEffectOfType(type: PersistentEffectType, onEnded?: (entry: InternalEntry) => void): void {
    const effects = Object.entries(this.#state[type])
    for (const [key, value] of effects) {
      const entry = this.#entriesByKey.get(key)

      if (this.#chatLength <= Number(value.start) && !value.protected) {
        delete this.#state[type][key]
        continue
      }

      if (!entry) {
        if (this.#chatLength >= Number(value.end)) {
          delete this.#state[type][key]
        }
        continue
      }

      if (!entry[type]) {
        delete this.#state[type][key]
        continue
      }

      if (this.#chatLength >= Number(value.end)) {
        delete this.#state[type][key]
        if (onEnded) {
          onEnded(entry)
        }
        continue
      }

      this.#buffer[type].add(entry.index)
    }
  }

  #checkDelayEffect(): void {
    for (const entry of this.#entries) {
      if (!entry.delay) continue
      if (this.#chatLength < entry.delay) {
        this.#buffer.delay.add(entry.index)
      }
    }
  }

  checkTimedEffects(): void {
    this.#checkTimedEffectOfType('sticky', (entry) => this.#onStickyEnded(entry))
    this.#checkTimedEffectOfType('cooldown')
    this.#checkDelayEffect()
  }

  getEffectMetadata(type: PersistentEffectType, entry: InternalEntry): TimedEffectRecord | undefined {
    return this.#state[type][this.#getEntryKey(entry)]
  }

  #setTimedEffectOfType(type: PersistentEffectType, entry: InternalEntry): void {
    if (!entry[type]) return
    const key = this.#getEntryKey(entry)
    if (!this.#state[type][key]) {
      this.#state[type][key] = this.#createRecord(type, entry, false)
    }
  }

  setTimedEffects(activatedEntries: InternalEntry[]): void {
    for (const entry of activatedEntries) {
      this.#setTimedEffectOfType('sticky', entry)
      this.#setTimedEffectOfType('cooldown', entry)
    }
  }

  isEffectActive(type: TimedEffectType, entry: InternalEntry): boolean {
    return this.#buffer[type].has(entry.index)
  }

  getState(): TimedEffectsState {
    return this.#state
  }
}

// —— 候选激活上下文 & 次要关键词匹配 ——

interface CandidateInfo {
  reason: ActivationReason
  matchedKey?: string
  matchedKeyTrimmed?: string
  matchedSecondary?: string[]
  group?: string
}

interface KeywordMatchResult {
  matched: boolean
  primaryKey?: string
  primaryKeyTrimmed?: string
  secondaryFailed?: boolean
  matchedSecondary?: string[]
}

function matchEntryKeywords(
  entry: InternalEntry,
  textToScan: string,
  buffer: WorldInfoBuffer,
  names: MacroContext,
): KeywordMatchResult {
  let primaryKey: string | undefined
  let primaryKeyTrimmed: string | undefined

  for (const key of entry.key) {
    // 同酒馆：先看替换后的原文是否为空，再 trim 后匹配；只有空白的关键词 trim 成空串后每次都会命中
    const substituted = substituteMacros(key, names)
    const trimmed = substituted.trim()
    if (substituted && buffer.matchKeys(textToScan, trimmed, entry)) {
      primaryKey = key
      primaryKeyTrimmed = trimmed
      break
    }
  }

  if (primaryKey === undefined) {
    return { matched: false }
  }

  const hasSecondaryKeywords = entry.selective && entry.keysecondary.length > 0
  if (!hasSecondaryKeywords) {
    return { matched: true, primaryKey, primaryKeyTrimmed }
  }

  let hasAnyMatch = false
  let hasAllMatch = true
  const matchedSecondary: string[] = []

  for (const keysecondary of entry.keysecondary) {
    const secondarySubstituted = substituteMacros(keysecondary, names)
    const secondaryTrimmed = secondarySubstituted.trim()
    const hasSecondaryMatch = Boolean(secondarySubstituted) && buffer.matchKeys(textToScan, secondaryTrimmed, entry)

    if (hasSecondaryMatch) {
      hasAnyMatch = true
      matchedSecondary.push(keysecondary)
    } else {
      hasAllMatch = false
    }
  }

  let secondaryOk = false
  switch (entry.selectiveLogic) {
    case WI_LOGIC.AND_ANY:
      secondaryOk = hasAnyMatch
      break
    case WI_LOGIC.NOT_ALL:
      secondaryOk = !hasAllMatch
      break
    case WI_LOGIC.NOT_ANY:
      secondaryOk = !hasAnyMatch
      break
    case WI_LOGIC.AND_ALL:
      secondaryOk = hasAllMatch
      break
    default:
      secondaryOk = false
      break
  }

  return {
    matched: secondaryOk,
    primaryKey,
    primaryKeyTrimmed,
    secondaryFailed: !secondaryOk,
    matchedSecondary: matchedSecondary.length > 0 ? matchedSecondary : undefined,
  }
}

// —— 包含组过滤（对照 world-info.js L5086-5269） ——

interface InclusionGroupParams {
  newEntries: InternalEntry[]
  allActivatedEntries: Map<number, InternalEntry>
  buffer: WorldInfoBuffer
  scanState: ScanStateValue
  timedEffects: WorldInfoTimedEffects
  settings: ScanSettings
  random: () => number
  candidates: Map<number, CandidateInfo>
  recordGroupLoss: (entry: InternalEntry, group: string, detail: string) => void
}

function filterGroupsByTimedEffects(
  groups: Record<string, InternalEntry[]>,
  timedEffects: WorldInfoTimedEffects,
  removeEntry: (entry: InternalEntry, group: string, detail: string) => void,
): Map<string, boolean> {
  const hasStickyMap = new Map<string, boolean>()

  for (const [key, group] of Object.entries(groups)) {
    hasStickyMap.set(key, false)

    const stickyEntries = group.filter((x) => timedEffects.isEffectActive('sticky', x))
    if (stickyEntries.length > 0) {
      for (const entry of group) {
        if (stickyEntries.includes(entry)) continue
        removeEntry(entry, key, `包含组「${key}」中已有粘性条目胜出`)
      }
      hasStickyMap.set(key, true)
    }

    const cooldownEntries = group.filter((x) => timedEffects.isEffectActive('cooldown', x))
    for (const entry of cooldownEntries) {
      removeEntry(entry, key, `包含组「${key}」中的条目处于冷却中`)
    }

    const delayEntries = group.filter((x) => timedEffects.isEffectActive('delay', x))
    for (const entry of delayEntries) {
      removeEntry(entry, key, `包含组「${key}」中的条目处于延迟中`)
    }
  }

  return hasStickyMap
}

function filterGroupsByScoring(
  groups: Record<string, InternalEntry[]>,
  buffer: WorldInfoBuffer,
  scanState: ScanStateValue,
  hasStickyMap: Map<string, boolean>,
  settings: ScanSettings,
  removeEntry: (entry: InternalEntry, group: string, detail: string) => void,
): void {
  for (const [key, group] of Object.entries(groups)) {
    if (!settings.useGroupScoring && !group.some((x) => x.useGroupScoring)) {
      continue
    }

    if (hasStickyMap.get(key)) {
      continue
    }

    if (group.length === 0) {
      continue
    }

    const scores = group.map((entry) => buffer.getScore(entry, scanState))
    const maxScore = Math.max(...scores)

    for (let i = 0; i < group.length; i++) {
      const isScored = group[i].useGroupScoring ?? settings.useGroupScoring
      if (!isScored) {
        continue
      }

      if (scores[i] < maxScore) {
        removeEntry(group[i], key, `包含组「${key}」里关键词评分（${scores[i]}）低于最高分（${maxScore}）而落选`)
        group.splice(i, 1)
        scores.splice(i, 1)
        i--
      }
    }
  }
}

function filterByInclusionGroups(params: InclusionGroupParams): void {
  const { newEntries, allActivatedEntries, buffer, scanState, timedEffects, settings, random, candidates, recordGroupLoss } = params

  const grouped: Record<string, InternalEntry[]> = {}
  for (const item of newEntries) {
    if (!item.group) continue
    for (const groupName of item.group.split(/,\s*/)) {
      if (!groupName) continue
      if (!grouped[groupName]) {
        grouped[groupName] = []
      }
      grouped[groupName].push(item)
    }
  }

  if (Object.keys(grouped).length === 0) {
    return
  }

  const removeEntry = (entry: InternalEntry, group: string, detail: string): void => {
    const idx = newEntries.indexOf(entry)
    if (idx !== -1) {
      newEntries.splice(idx, 1)
    }
    recordGroupLoss(entry, group, detail)
  }

  const removeAllBut = (group: InternalEntry[], chosen: InternalEntry | null, groupName: string, detail: string): void => {
    for (const entry of group) {
      if (entry === chosen) continue
      removeEntry(entry, groupName, detail)
    }
  }

  const markGroupWinner = (entry: InternalEntry, groupName: string): void => {
    const info = candidates.get(entry.index)
    if (info) {
      info.group = groupName
    }
  }

  const hasStickyMap = filterGroupsByTimedEffects(grouped, timedEffects, removeEntry)
  filterGroupsByScoring(grouped, buffer, scanState, hasStickyMap, settings, removeEntry)

  for (const [key, group] of Object.entries(grouped)) {
    if (hasStickyMap.get(key)) {
      for (const entry of group) {
        if (timedEffects.isEffectActive('sticky', entry)) {
          markGroupWinner(entry, key)
        }
      }
      continue
    }

    if ([...allActivatedEntries.values()].some((x) => x.group === key)) {
      removeAllBut(group, null, key, `包含组「${key}」此前已激活其他条目`)
      continue
    }

    if (group.length <= 1) {
      if (group.length === 1) {
        markGroupWinner(group[0], key)
      }
      continue
    }

    // 优先级覆盖（group_override）：选 order 最高的（同 order 保持稳定顺序）
    const prios = group.filter((x) => x.groupOverride).sort(sortFn)
    if (prios.length > 0) {
      markGroupWinner(prios[0], key)
      removeAllBut(group, prios[0], key, `包含组「${key}」里因优先级覆盖落选`)
      continue
    }

    // 按权重随机抽选
    const totalWeight = group.reduce((acc, item) => acc + item.groupWeight, 0)
    const rollValue = random() * totalWeight
    let currentWeight = 0
    let winner: InternalEntry | null = null

    for (const entry of group) {
      currentWeight += entry.groupWeight
      if (rollValue <= currentWeight) {
        winner = entry
        break
      }
    }

    if (!winner) {
      continue
    }

    markGroupWinner(winner, key)
    removeAllBut(group, winner, key, `包含组「${key}」里按权重落选`)
  }
}

// —— 主扫描入口（对照 checkWorldInfo，world-info.js L4510-5076） ——

/** 跑一次扫描，等价于酒馆生成前的 checkWorldInfo（非 dry run） */
export function scanWorldInfo(input: ScanInput): ScanResult {
  const { entries, chat, names, settings, globalScanData, countTokens } = input
  const trigger = input.trigger ?? 'normal'
  const random = input.random ?? Math.random

  // 聊天消息进扫描缓冲：includeNames 时为 "名字: 消息"，然后 reverse 使最新的在前（script.js L4455）
  const chatForWI = chat
    .map((msg) => {
      if (!settings.includeNames) return msg.text
      const speaker = msg.role === 'user' ? names.user : names.char
      return `${speaker}: ${msg.text}`
    })
    .reverse()

  const buffer = new WorldInfoBuffer(chatForWI, globalScanData, settings)

  let scanState: ScanStateValue = SCAN_STATE.INITIAL
  let tokenBudgetOverflowed = false
  let loops = 0
  let usedTokens = 0
  const allActivatedEntries = new Map<number, InternalEntry>()
  const failedProbabilityChecks = new Set<InternalEntry>()
  let allActivatedText = ''

  let budget = Math.round((settings.budgetPercent * settings.maxContext) / 100) || 1
  if (settings.budgetCap > 0 && budget > settings.budgetCap) {
    budget = settings.budgetCap
  }

  // 转换并按 order 从大到小稳定排序
  const sortedEntries = entries.map((entry, index) => convertEntry(entry, index)).sort(sortFn)
  sortedEntries.forEach((entry, i) => {
    entry.sortedIndex = i
  })

  const timedEffects = new WorldInfoTimedEffects(chatForWI.length, sortedEntries, input.timedState)
  timedEffects.checkTimedEffects()

  if (sortedEntries.length === 0) {
    return {
      activated: [],
      traces: [],
      loops: 0,
      budget,
      usedTokens: 0,
      budgetOverflowed: false,
      timedState: timedEffects.getState(),
    }
  }

  const traceMap = new Map<number, EntryTrace>()
  const setTrace = (trace: EntryTrace): void => {
    traceMap.set(trace.index, trace)
  }

  // 收集延迟到递归的层级并按升序排列（world-info.js L4555-4560）
  const availableRecursionDelayLevels = [
    ...new Set(
      sortedEntries
        .filter((entry) => entry.delayUntilRecursion)
        .map((entry) => entry.delayUntilRecursionLevel),
    ),
  ].sort((a, b) => a - b)
  let currentRecursionDelayLevel = availableRecursionDelayLevels.shift() ?? 0

  while (scanState) {
    if (settings.maxRecursionSteps && settings.maxRecursionSteps <= loops) {
      break
    }

    loops++
    const currentStateName = scanStateName(scanState)
    let nextScanState: ScanStateValue = SCAN_STATE.NONE
    const activatedNow = new Set<InternalEntry>()
    const candidates = new Map<number, CandidateInfo>()

    for (const entry of sortedEntries) {
      // 已经概率失败或已激活的条目不再重复处理
      if (failedProbabilityChecks.has(entry) || allActivatedEntries.has(entry.index)) {
        continue
      }

      if (entry.disable) {
        setTrace({
          index: entry.index,
          status: 'skipped',
          reason: 'disabled',
          loop: loops,
          scanState: currentStateName,
          detail: entry.missingEnabled ? '条目缺少 enabled 字段，导入酒馆后会被当作未启用' : '条目未启用',
        })
        continue
      }

      if (entry.triggers.length > 0 && !entry.triggers.includes(trigger)) {
        setTrace({
          index: entry.index,
          status: 'skipped',
          reason: 'trigger-filter',
          loop: loops,
          scanState: currentStateName,
          detail: `生成类型「${trigger}」不在允许列表（${entry.triggers.join('、')}）中`,
        })
        continue
      }

      const isSticky = timedEffects.isEffectActive('sticky', entry)
      const isCooldown = timedEffects.isEffectActive('cooldown', entry)
      const isDelay = timedEffects.isEffectActive('delay', entry)

      if (isDelay) {
        setTrace({
          index: entry.index,
          status: 'skipped',
          reason: 'delay',
          loop: loops,
          scanState: currentStateName,
          detail: `延迟生效中，需至少 ${entry.delay} 条消息（当前 ${chatForWI.length} 条）`,
        })
        continue
      }

      if (isCooldown && !isSticky) {
        const meta = timedEffects.getEffectMetadata('cooldown', entry)
        setTrace({
          index: entry.index,
          status: 'skipped',
          reason: 'cooldown',
          loop: loops,
          scanState: currentStateName,
          detail: meta ? `冷却中，到第 ${meta.end} 条消息结束` : '冷却中',
        })
        continue
      }

      if (scanState !== SCAN_STATE.RECURSION && entry.delayUntilRecursion && !isSticky) {
        setTrace({
          index: entry.index,
          status: 'skipped',
          reason: 'delay-until-recursion',
          loop: loops,
          scanState: currentStateName,
          detail: `只在第 ${entry.delayUntilRecursionLevel} 层递归时触发`,
        })
        continue
      }

      if (
        scanState === SCAN_STATE.RECURSION &&
        entry.delayUntilRecursion &&
        entry.delayUntilRecursionLevel > currentRecursionDelayLevel &&
        !isSticky
      ) {
        setTrace({
          index: entry.index,
          status: 'skipped',
          reason: 'delay-until-recursion',
          loop: loops,
          scanState: currentStateName,
          detail: `只在第 ${entry.delayUntilRecursionLevel} 层递归时触发（当前第 ${currentRecursionDelayLevel} 层）`,
        })
        continue
      }

      if (scanState === SCAN_STATE.RECURSION && settings.recursive && entry.excludeRecursion && !isSticky) {
        // 仅影响 trace 说明：判断是否真的会在本轮递归中命中，避免覆盖无关条目的“未命中”原因
        const prev = traceMap.get(entry.index)
        let wouldActivateInRecursion = false
        if (entry.decorators.includes('@@activate') || entry.constant) {
          wouldActivateInRecursion = true
        } else if (!entry.decorators.includes('@@dont_activate') && entry.key.length > 0) {
          const probeText = buffer.get(entry, scanState)
          wouldActivateInRecursion = matchEntryKeywords(entry, probeText, buffer, names).matched
        }
        if (wouldActivateInRecursion || !prev) {
          setTrace({
            index: entry.index,
            status: 'skipped',
            reason: 'exclude-recursion',
            loop: loops,
            scanState: currentStateName,
            detail: '在递归扫描中命中，但条目设置了不被递归触发',
          })
        }
        continue
      }

      if (entry.decorators.includes('@@activate')) {
        activatedNow.add(entry)
        candidates.set(entry.index, { reason: 'decorator' })
        continue
      }

      if (entry.decorators.includes('@@dont_activate')) {
        setTrace({
          index: entry.index,
          status: 'skipped',
          reason: 'dont-activate',
          loop: loops,
          scanState: currentStateName,
          detail: '因 @@dont_activate 装饰器跳过',
        })
        continue
      }

      if (entry.constant) {
        activatedNow.add(entry)
        candidates.set(entry.index, { reason: 'constant' })
        continue
      }

      if (isSticky) {
        activatedNow.add(entry)
        candidates.set(entry.index, { reason: 'sticky' })
        continue
      }

      if (!entry.key.length) {
        setTrace({
          index: entry.index,
          status: 'skipped',
          reason: 'no-keys',
          loop: loops,
          scanState: currentStateName,
          detail: '未设置主关键词',
        })
        continue
      }

      const textToScan = buffer.get(entry, scanState)
      const kwResult = matchEntryKeywords(entry, textToScan, buffer, names)

      if (!kwResult.matched) {
        if (kwResult.secondaryFailed) {
          const logicText = LOGIC_LABEL[entry.selectiveLogic] ?? String(entry.selectiveLogic)
          const trace: EntryTrace = {
            index: entry.index,
            status: 'skipped',
            reason: 'secondary',
            loop: loops,
            scanState: currentStateName,
            matchedKey: kwResult.primaryKey,
            detail: `主关键词已命中，但次要关键词未满足「${logicText}」条件`,
          }
          if (kwResult.matchedSecondary) {
            trace.matchedSecondary = kwResult.matchedSecondary
          }
          setTrace(trace)
        } else {
          setTrace({
            index: entry.index,
            status: 'skipped',
            reason: 'no-match',
            loop: loops,
            scanState: currentStateName,
            detail: '主关键词未命中',
          })
        }
        continue
      }

      activatedNow.add(entry)
      candidates.set(entry.index, {
        reason: 'keyword',
        matchedKey: kwResult.primaryKey,
        matchedKeyTrimmed: kwResult.primaryKeyTrimmed,
        matchedSecondary: kwResult.matchedSecondary,
      })
    }

    // 粘性条目排前面，其次保持 sortedEntries 的顺序（world-info.js L4795-4800）
    const newEntries = [...activatedNow].sort((a, b) => {
      const isASticky = timedEffects.isEffectActive('sticky', a) ? 1 : 0
      const isBSticky = timedEffects.isEffectActive('sticky', b) ? 1 : 0
      return isBSticky - isASticky || a.sortedIndex - b.sortedIndex
    })

    let newContent = ''
    const textToScanTokens = countTokens(allActivatedText)

    filterByInclusionGroups({
      newEntries,
      allActivatedEntries,
      buffer,
      scanState,
      timedEffects,
      settings,
      random,
      candidates,
      recordGroupLoss: (entry, group, detail) => {
        const info = candidates.get(entry.index)
        const trace: EntryTrace = {
          index: entry.index,
          status: 'skipped',
          reason: 'group',
          loop: loops,
          scanState: currentStateName,
          group,
          detail,
        }
        if (info?.matchedKey !== undefined) trace.matchedKey = info.matchedKey
        if (info?.matchedSecondary) trace.matchedSecondary = info.matchedSecondary
        setTrace(trace)
      },
    })

    // 概率与预算检查（world-info.js L4811-4871）
    for (const entry of newEntries) {
      const info = candidates.get(entry.index)

      if (tokenBudgetOverflowed && !entry.ignoreBudget) {
        const trace: EntryTrace = {
          index: entry.index,
          status: 'skipped',
          reason: 'budget',
          loop: loops,
          scanState: currentStateName,
          detail: `超出世界书预算（${budget} token）`,
        }
        if (info?.matchedKey !== undefined) trace.matchedKey = info.matchedKey
        if (info?.matchedSecondary) trace.matchedSecondary = info.matchedSecondary
        if (info?.group) trace.group = info.group
        setTrace(trace)
        continue
      }

      const isSticky = timedEffects.isEffectActive('sticky', entry)
      let rollValue: number | undefined
      let probPassed = true

      if (entry.useProbability && entry.probability !== 100 && !isSticky) {
        rollValue = random() * 100
        if (rollValue > entry.probability) {
          probPassed = false
          failedProbabilityChecks.add(entry)
        }
      }

      if (!probPassed) {
        const trace: EntryTrace = {
          index: entry.index,
          status: 'skipped',
          reason: 'probability',
          loop: loops,
          scanState: currentStateName,
          roll: rollValue,
          detail: `概率未命中（掷出 ${rollValue !== undefined ? rollValue.toFixed(1) : ''}，需 ≤ ${entry.probability}）`,
        }
        if (info?.matchedKey !== undefined) trace.matchedKey = info.matchedKey
        if (info?.matchedSecondary) trace.matchedSecondary = info.matchedSecondary
        if (info?.group) trace.group = info.group
        setTrace(trace)
        continue
      }

      entry.content = substituteMacros(entry.content, names)
      newContent += `${entry.content}\n`

      if (!entry.ignoreBudget) {
        const currentTokens = textToScanTokens + countTokens(newContent)
        usedTokens = currentTokens
        if (currentTokens >= budget) {
          tokenBudgetOverflowed = true
          const trace: EntryTrace = {
            index: entry.index,
            status: 'skipped',
            reason: 'budget',
            loop: loops,
            scanState: currentStateName,
            detail: `超出世界书预算（${currentTokens} ≥ ${budget} token）`,
          }
          if (info?.matchedKey !== undefined) trace.matchedKey = info.matchedKey
          if (info?.matchedSecondary) trace.matchedSecondary = info.matchedSecondary
          if (info?.group) trace.group = info.group
          if (rollValue !== undefined) trace.roll = rollValue
          setTrace(trace)
          continue
        }
      }

      allActivatedEntries.set(entry.index, entry)

      const reason: ActivationReason = info?.reason ?? 'keyword'
      const trace: EntryTrace = {
        index: entry.index,
        status: 'activated',
        reason,
        loop: loops,
        scanState: currentStateName,
      }
      if (info?.matchedKey !== undefined) {
        trace.matchedKey = info.matchedKey
      }
      if (info?.matchedSecondary) {
        trace.matchedSecondary = info.matchedSecondary
      }
      if (reason === 'keyword' && info?.matchedKeyTrimmed) {
        const source = buffer.locateMatchSource(info.matchedKeyTrimmed, entry, scanState)
        if (source) {
          trace.matchSource = source
        }
      }
      if (info?.group) {
        trace.group = info.group
      }
      if (rollValue !== undefined) {
        trace.roll = rollValue
      }

      if (reason === 'constant') {
        trace.detail = '常驻激活'
      } else if (reason === 'decorator') {
        trace.detail = '因 @@activate 装饰器激活'
      } else if (reason === 'sticky') {
        const meta = timedEffects.getEffectMetadata('sticky', entry)
        trace.detail = meta ? `粘性生效中，到第 ${meta.end} 条消息结束` : '粘性生效中'
      } else {
        trace.detail = '关键词命中激活'
      }

      setTrace(trace)
    }

    const successfulNewEntries = newEntries.filter((x) => !failedProbabilityChecks.has(x))
    const successfulNewEntriesForRecursion = successfulNewEntries.filter((x) => !x.preventRecursion)

    // 决定下一轮扫描状态（world-info.js L4891-4927）
    if (settings.recursive && !tokenBudgetOverflowed && successfulNewEntriesForRecursion.length > 0) {
      nextScanState = SCAN_STATE.RECURSION
    }

    if (settings.recursive && !tokenBudgetOverflowed && scanState === SCAN_STATE.MIN_ACTIVATIONS && buffer.hasRecurse()) {
      nextScanState = SCAN_STATE.RECURSION
    }

    const minActivationsNotSatisfied = settings.minActivations > 0 && allActivatedEntries.size < settings.minActivations
    if (!nextScanState && !tokenBudgetOverflowed && minActivationsNotSatisfied) {
      const overMax =
        (settings.minActivationsDepthMax > 0 && buffer.getDepth() > settings.minActivationsDepthMax) ||
        buffer.getDepth() > chatForWI.length

      if (!overMax) {
        nextScanState = SCAN_STATE.MIN_ACTIVATIONS
        buffer.advanceScan()
      }
    }

    if (nextScanState === SCAN_STATE.NONE && availableRecursionDelayLevels.length > 0) {
      nextScanState = SCAN_STATE.RECURSION
      currentRecursionDelayLevel = availableRecursionDelayLevels.shift() ?? currentRecursionDelayLevel
    }

    scanState = nextScanState
    if (scanState) {
      const text = successfulNewEntriesForRecursion.map((x) => x.content).join('\n')
      if (text) {
        buffer.addRecurse(
          text,
          successfulNewEntriesForRecursion.map((x) => ({ entryIndex: x.index, text: x.content })),
        )
        allActivatedText = `${text}\n${allActivatedText}`
      }
    }
  }

  const activatedSorted = [...allActivatedEntries.values()].sort(sortFn)
  timedEffects.setTimedEffects([...allActivatedEntries.values()])

  const traces: EntryTrace[] = entries.map((_, index) => {
    const existing = traceMap.get(index)
    if (existing) return existing
    return {
      index,
      status: 'skipped',
      reason: 'not-scanned',
      detail: '扫描提前结束，未轮到该条目',
    }
  })

  return {
    activated: activatedSorted.map((entry) => entry.index),
    traces,
    loops,
    budget,
    usedTokens,
    budgetOverflowed: tokenBudgetOverflowed,
    timedState: timedEffects.getState(),
  }
}

/**
 * 逐轮模拟：聊天里每个以用户消息结尾的前缀各算一轮生成；如果整段聊天不以用户消息结尾，整段聊天也算最后一轮。
 * 计时状态（粘性、冷却）逐轮传递。返回的最后一项就是“当前这一轮”。聊天为空时返回空数组。
 */
export function simulateTurns(input: Omit<ScanInput, 'timedState'>): TurnResult[] {
  const { chat } = input
  if (chat.length === 0) {
    return []
  }

  const cutPoints: number[] = []
  for (let i = 0; i < chat.length; i++) {
    if (chat[i].role === 'user') {
      cutPoints.push(i + 1)
    }
  }
  if (chat[chat.length - 1].role !== 'user') {
    cutPoints.push(chat.length)
  }

  const results: TurnResult[] = []
  let timedState: TimedEffectsState | undefined

  for (const chatLength of cutPoints) {
    const result = scanWorldInfo({
      ...input,
      chat: chat.slice(0, chatLength),
      timedState,
    })
    timedState = result.timedState
    results.push({ ...result, chatLength })
  }

  return results
}

/** 带种子的随机数（mulberry32），返回 [0, 1) 浮点数 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
