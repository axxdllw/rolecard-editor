/**
 * 世界书条目的读写工具。
 *
 * ST 把大部分条目设置存在 entry.extensions 里，这里统一提供带默认值的读取，
 * 以及会同步相关字段的写入（例如改位置时同步规范里的 position 字符串）。
 * 写入函数都直接修改传入的条目，配合 Immer 的草稿对象使用。
 */
import type { JsonObject, Lorebook, LorebookEntry } from '../card/types'

export const POSITION = {
  BEFORE_CHAR: 0,
  AFTER_CHAR: 1,
  AN_TOP: 2,
  AN_BOTTOM: 3,
  AT_DEPTH: 4,
  EM_TOP: 5,
  EM_BOTTOM: 6,
  OUTLET: 7,
} as const

export const POSITION_OPTIONS: Array<{ value: number; label: string; short: string; hint: string }> = [
  { value: 0, label: '角色定义前', short: '↑角色', hint: '插在角色描述之前' },
  { value: 1, label: '角色定义后', short: '↓角色', hint: '插在角色描述、性格、场景之后' },
  { value: 2, label: '作者注释上方', short: '↑注释', hint: '插在作者注释的上方' },
  { value: 3, label: '作者注释下方', short: '↓注释', hint: '插在作者注释的下方' },
  { value: 4, label: '指定深度', short: '@深度', hint: '插进聊天记录，深度 0 表示最新消息之后' },
  { value: 5, label: '示例对话前', short: '↑示例', hint: '插在示例对话之前' },
  { value: 6, label: '示例对话后', short: '↓示例', hint: '插在示例对话之后' },
  { value: 7, label: '锚点（outlet）', short: '⚓锚点', hint: '不自动插入，按锚点名收集，在预设提示词里写 {{outlet::锚点名}} 的地方展开（酒馆 1.16 起）' },
]

export const ROLE_OPTIONS = [
  { value: 0, label: 'system' },
  { value: 1, label: 'user' },
  { value: 2, label: 'assistant' },
]

export const LOGIC_OPTIONS = [
  { value: 0, label: '含任一个', hint: '次要关键词出现任意一个就触发' },
  { value: 1, label: '不全含', hint: '次要关键词没有全部出现时触发' },
  { value: 2, label: '一个都不含', hint: '次要关键词一个都没出现时触发' },
  { value: 3, label: '全部包含', hint: '次要关键词全部出现才触发' },
]

export type EntryStrategy = 'constant' | 'keyword' | 'vectorized'

function extOf(entry: LorebookEntry): JsonObject {
  return entry.extensions ?? {}
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nullableNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function nullableBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

export function getPosition(entry: LorebookEntry): number {
  const p = extOf(entry).position
  if (typeof p === 'number') return p
  return entry.position === 'after_char' ? 1 : 0
}

/** 锚点（outlet）名，卡内存在 extensions.outlet_name，ST 世界书里是 outletName */
export function getOutletName(entry: LorebookEntry): string {
  const name = extOf(entry).outlet_name
  return typeof name === 'string' ? name : ''
}

/** 世界书里已有的锚点名（去重排序），供输入时自动补全；同 ST 只收集位置是锚点的条目 */
export function collectOutletNames(entries: LorebookEntry[]): string[] {
  const names = new Set<string>()
  for (const e of entries) {
    const name = getOutletName(e)
    if (getPosition(e) === POSITION.OUTLET && name) names.add(name)
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'zh'))
}

export function getDepth(entry: LorebookEntry): number {
  return num(extOf(entry).depth, 4)
}

export function getRole(entry: LorebookEntry): number {
  return num(extOf(entry).role, 0)
}

export function getSelectiveLogic(entry: LorebookEntry): number {
  return num(extOf(entry).selectiveLogic, 0)
}

export function getOrder(entry: LorebookEntry): number {
  return num(entry.insertion_order, 100)
}

export function getDisplayIndex(entry: LorebookEntry, index: number): number {
  return num(extOf(entry).display_index, index)
}

export function getStrategy(entry: LorebookEntry): EntryStrategy {
  if (entry.constant) return 'constant'
  if (extOf(entry).vectorized === true) return 'vectorized'
  return 'keyword'
}

/** 条目的完整设置（带 ST 默认值），供编辑面板读取 */
export function readEntrySettings(entry: LorebookEntry) {
  const ext = extOf(entry)
  return {
    probability: num(ext.probability, 100),
    useProbability: bool(ext.useProbability, true),
    excludeRecursion: bool(ext.exclude_recursion, false),
    preventRecursion: bool(ext.prevent_recursion, false),
    delayUntilRecursion: ext.delay_until_recursion === true || typeof ext.delay_until_recursion === 'number',
    group: typeof ext.group === 'string' ? ext.group : '',
    groupOverride: bool(ext.group_override, false),
    groupWeight: num(ext.group_weight, 100),
    useGroupScoring: nullableBool(ext.use_group_scoring),
    scanDepth: nullableNum(ext.scan_depth),
    caseSensitive: nullableBool(ext.case_sensitive),
    matchWholeWords: nullableBool(ext.match_whole_words),
    sticky: nullableNum(ext.sticky),
    cooldown: nullableNum(ext.cooldown),
    delay: nullableNum(ext.delay),
    automationId: typeof ext.automation_id === 'string' ? ext.automation_id : '',
  }
}

export type EntrySettings = ReturnType<typeof readEntrySettings>

/** 写 extensions 里的字段；条目没有 extensions 时自动创建 */
export function setExt(entry: LorebookEntry, key: string, value: unknown): void {
  if (!entry.extensions || typeof entry.extensions !== 'object') {
    entry.extensions = {}
  }
  entry.extensions[key] = value
}

/** 改位置，同时同步规范里的 position 字符串（ST 的规则：0 为 before_char，其余为 after_char，锚点 7 也是 after_char） */
export function setPosition(entry: LorebookEntry, position: number): void {
  setExt(entry, 'position', position)
  entry.position = position === 0 ? 'before_char' : 'after_char'
}

export function setOutletName(entry: LorebookEntry, name: string): void {
  setExt(entry, 'outlet_name', name)
}

export function setStrategy(entry: LorebookEntry, strategy: EntryStrategy): void {
  entry.constant = strategy === 'constant'
  if (strategy === 'vectorized' || extOf(entry).vectorized !== undefined) {
    setExt(entry, 'vectorized', strategy === 'vectorized')
  }
}

/** 改大小写匹配时，若顶层有 case_sensitive 也一起同步 */
export function setCaseSensitive(entry: LorebookEntry, value: boolean | null): void {
  setExt(entry, 'case_sensitive', value)
  if ('case_sensitive' in entry) {
    entry.case_sensitive = value ?? false
  }
}

export function entryTitle(entry: LorebookEntry, index: number): string {
  const comment = typeof entry.comment === 'string' ? entry.comment.trim() : ''
  if (comment) return comment
  const firstKey = entry.keys?.find((k) => k.trim())
  if (firstKey) return firstKey
  return `条目 #${index + 1}`
}

export function nextEntryId(entries: LorebookEntry[]): number {
  let max = -1
  for (const e of entries) {
    if (typeof e.id === 'number' && e.id > max) max = e.id
  }
  return max + 1
}

function nextDisplayIndex(entries: LorebookEntry[]): number {
  let max = -1
  entries.forEach((e, i) => {
    const d = getDisplayIndex(e, i)
    if (d > max) max = d
  })
  return max + 1
}

export interface NewEntryInit {
  comment?: string
  content?: string
  keys?: string[]
  constant?: boolean
  position?: number
  depth?: number
  order?: number
  outletName?: string
}

/** 新建条目，字段与 ST 导出的结构一致 */
export function createEntry(entries: LorebookEntry[], init: NewEntryInit = {}): LorebookEntry {
  const position = init.position ?? 0
  return {
    id: nextEntryId(entries),
    keys: init.keys ?? [],
    secondary_keys: [],
    comment: init.comment ?? '',
    content: init.content ?? '',
    constant: init.constant ?? false,
    selective: true,
    insertion_order: init.order ?? 100,
    enabled: true,
    position: position === 0 ? 'before_char' : 'after_char',
    use_regex: true,
    extensions: {
      position,
      exclude_recursion: false,
      display_index: nextDisplayIndex(entries),
      probability: 100,
      useProbability: true,
      depth: init.depth ?? 4,
      selectiveLogic: 0,
      outlet_name: init.outletName ?? '',
      group: '',
      group_override: false,
      group_weight: 100,
      prevent_recursion: false,
      delay_until_recursion: false,
      scan_depth: null,
      match_whole_words: null,
      use_group_scoring: false,
      case_sensitive: null,
      automation_id: '',
      role: 0,
      vectorized: false,
      sticky: 0,
      cooldown: 0,
      delay: 0,
      match_persona_description: false,
      match_character_description: false,
      match_character_personality: false,
      match_character_depth_prompt: false,
      match_scenario: false,
      match_creator_notes: false,
    },
  }
}

/** 复制条目：深拷贝，换新 id 和显示顺序 */
export function cloneEntry(entries: LorebookEntry[], source: LorebookEntry): LorebookEntry {
  const copy = structuredClone(source)
  copy.id = nextEntryId(entries)
  setExt(copy, 'display_index', nextDisplayIndex(entries))
  return copy
}

export function createLorebook(name = ''): Lorebook {
  return { name, entries: [], extensions: {} }
}

/** 判断关键词是不是 /pattern/flags 形式的正则 */
export function isRegexKey(key: string): boolean {
  return /^\/.+\/[a-z]*$/i.test(key.trim())
}
