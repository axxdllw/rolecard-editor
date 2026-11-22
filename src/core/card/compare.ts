/**
 * 两张卡的差异，用于“与原件对比”。
 *
 * - 比较 data 和顶层的其他字段；顶层的 V1 镜像字段跟着 data 同步，不重复列出。
 * - 对象逐键比较。带唯一 id 的对象数组（世界书条目、正则、脚本）按 id 配对，顺序变化单独算一处；
 *   其他数组按下标配对。开场白逐条比较，其他基本类型数组（关键词、标签）整体算一处。
 * - 只有两边都有的字段（changed）能单独还原；新增、删除和顺序变化只能整卡还原。
 */
import { jsonEqual } from '../mvu/diff'
import { entryTitle } from '../lorebook/entry'
import { getPath, setPath } from '../util/path'
import type { CharacterCardV3, JsonObject, LorebookEntry } from './types'

export type JsonPath = Array<string | number>

export type CardChangeKind = 'added' | 'removed' | 'changed' | 'reordered'

export type CardChangeGroup = '角色字段' | '开场白' | '世界书' | '正则' | '酒馆助手脚本' | '扩展数据' | '其他'

export interface CardChange {
  kind: CardChangeKind
  group: CardChangeGroup
  /** 显示用的位置名，如“世界书 · 秧秧 · 内容” */
  label: string
  /** 当前卡里的路径；removed 时没有 */
  path?: JsonPath
  /** 原件里的路径；added 时没有 */
  originalPath?: JsonPath
  /** 原件里的值；reordered 时是原来的顺序（名称列表） */
  before?: unknown
  /** 当前的值；reordered 时是现在的顺序 */
  after?: unknown
}

/** 顶层 V1 镜像字段（见 mirror.ts），编辑时跟着 data 自动同步 */
const MIRROR_KEYS = new Set(['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creatorcomment', 'tags', 'talkativeness', 'fav'])

/** 逐条比较的字符串数组 */
const PER_ITEM_ARRAYS = new Set(['data.alternate_greetings', 'data.group_only_greetings'])

const DATA_LABELS: Record<string, [string, CardChangeGroup]> = {
  name: ['角色名', '角色字段'],
  nickname: ['昵称', '角色字段'],
  description: ['角色描述', '角色字段'],
  personality: ['性格', '角色字段'],
  scenario: ['场景', '角色字段'],
  first_mes: ['主开场白', '开场白'],
  mes_example: ['示例对话', '角色字段'],
  creator_notes: ['创作者备注', '角色字段'],
  creator_notes_multilingual: ['多语言创作者备注', '角色字段'],
  system_prompt: ['系统提示词', '角色字段'],
  post_history_instructions: ['历史后指令', '角色字段'],
  tags: ['标签', '角色字段'],
  creator: ['作者', '角色字段'],
  character_version: ['版本', '角色字段'],
  source: ['来源', '角色字段'],
  assets: ['附加资源', '角色字段'],
  creation_date: ['创建时间', '角色字段'],
  modification_date: ['修改时间', '角色字段'],
}

const ENTRY_LABELS: Record<string, string> = {
  comment: '备注名',
  content: '内容',
  keys: '关键词',
  secondary_keys: '次要关键词',
  enabled: '启用',
  constant: '常驻',
  selective: '使用次要关键词',
  insertion_order: '顺序',
  position: '位置（规范字段）',
  use_regex: '关键词按正则',
  case_sensitive: '区分大小写',
  'extensions.position': '位置',
  'extensions.depth': '深度',
  'extensions.role': '消息角色',
  'extensions.probability': '触发概率',
  'extensions.useProbability': '启用概率',
  'extensions.selectiveLogic': '次要关键词逻辑',
  'extensions.exclude_recursion': '不被递归触发',
  'extensions.prevent_recursion': '不触发递归',
  'extensions.delay_until_recursion': '延迟到递归',
  'extensions.group': '分组',
  'extensions.group_override': '分组优先',
  'extensions.group_weight': '分组权重',
  'extensions.use_group_scoring': '分组评分',
  'extensions.sticky': '黏性',
  'extensions.cooldown': '冷却',
  'extensions.delay': '延迟',
  'extensions.scan_depth': '扫描深度',
  'extensions.display_index': '显示顺序',
  'extensions.outlet_name': '锚点名',
  'extensions.match_whole_words': '全词匹配',
  'extensions.case_sensitive': '区分大小写',
  'extensions.vectorized': '向量化',
  'extensions.automation_id': '自动化 ID',
}

const REGEX_LABELS: Record<string, string> = {
  scriptName: '名称',
  findRegex: '查找',
  replaceString: '替换',
  trimStrings: '修剪',
  placement: '作用范围',
  disabled: '禁用',
  markdownOnly: '仅显示',
  promptOnly: '仅提示词',
  runOnEdit: '编辑时运行',
  substituteRegex: '宏替换',
  minDepth: '最小深度',
  maxDepth: '最大深度',
}

const EXTENSION_LABELS: Record<string, [string, CardChangeGroup]> = {
  depth_prompt: ['角色注释', '角色字段'],
  talkativeness: ['群聊发言频率', '角色字段'],
  fav: ['收藏', '角色字段'],
  world: ['绑定世界书', '世界书'],
  tavern_helper: ['酒馆助手脚本', '酒馆助手脚本'],
  TavernHelper_scripts: ['酒馆助手脚本（旧格式）', '酒馆助手脚本'],
  TavernHelper_characterScriptVariables: ['酒馆助手角色变量（旧格式）', '酒馆助手脚本'],
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPrimitive(value: unknown): boolean {
  return value === null || typeof value !== 'object'
}

/** 数组里的每一项都是带唯一 id 的对象时，返回 id 列表 */
function uniqueIds(list: unknown[]): Array<string | number> | null {
  if (list.length === 0) return []
  const ids: Array<string | number> = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!isObject(item)) return null
    const id = item.id
    if (typeof id !== 'string' && typeof id !== 'number') return null
    const k = `${typeof id}:${id}`
    if (seen.has(k)) return null
    seen.add(k)
    ids.push(id)
  }
  return ids
}

function itemName(item: unknown, index: number): string {
  if (isObject(item)) {
    for (const key of ['comment', 'scriptName', 'name']) {
      const v = item[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  return `#${index + 1}`
}

/** 给路径起显示名；card 是路径所在的那张卡（用来取条目标题、正则名） */
export function describePath(card: CharacterCardV3, path: JsonPath): { label: string; group: CardChangeGroup } {
  if (path[0] !== 'data') return { label: `顶层字段 · ${path.join('.')}`, group: '其他' }
  const [, key, ...rest] = path
  if (key === undefined) return { label: '角色卡数据', group: '其他' }

  if (key === 'alternate_greetings' || key === 'group_only_greetings') {
    const name = key === 'alternate_greetings' ? '备选开场白' : '群聊开场白'
    return { label: typeof rest[0] === 'number' ? `${name} ${rest[0] + 1}` : name, group: '开场白' }
  }

  if (key === 'character_book') {
    if (rest[0] === 'entries' && typeof rest[1] === 'number') {
      const entry = getPath(card, ['data', 'character_book', 'entries', rest[1]])
      const title = isObject(entry) ? entryTitle(entry as LorebookEntry, rest[1]) : `条目 ${rest[1] + 1}`
      const field = rest.slice(2).join('.')
      return { label: field ? `世界书 · ${title} · ${ENTRY_LABELS[field] ?? field}` : `世界书 · ${title}`, group: '世界书' }
    }
    if (rest[0] === 'entries') return { label: '世界书 · 条目顺序', group: '世界书' }
    return { label: rest.length ? `世界书 · 设置 · ${rest.join('.')}` : '世界书', group: '世界书' }
  }

  if (key === 'extensions') {
    const [extKey, ...extRest] = rest
    if (extKey === 'regex_scripts') {
      if (typeof extRest[0] === 'number') {
        const script = getPath(card, ['data', 'extensions', 'regex_scripts', extRest[0]])
        const name = itemName(script, extRest[0])
        const field = extRest.slice(1).join('.')
        return { label: field ? `正则 · ${name} · ${REGEX_LABELS[field] ?? field}` : `正则 · ${name}`, group: '正则' }
      }
      return { label: '正则 · 执行顺序', group: '正则' }
    }
    const known = typeof extKey === 'string' ? EXTENSION_LABELS[extKey] : undefined
    if (known) {
      const tail = extRest.length ? ` · ${extRest.join('.')}` : ''
      return { label: `${known[0]}${tail}`, group: known[1] }
    }
    return { label: `扩展数据 · ${rest.join('.')}`, group: '扩展数据' }
  }

  const known = typeof key === 'string' ? DATA_LABELS[key] : undefined
  if (known) return { label: rest.length ? `${known[0]} · ${rest.join('.')}` : known[0], group: known[1] }
  return { label: `其他字段 · ${[key, ...rest].join('.')}`, group: '其他' }
}

/** 比较原件和当前卡，返回改动列表（按在卡里出现的顺序） */
export function compareCards(original: CharacterCardV3, current: CharacterCardV3): CardChange[] {
  const changes: CardChange[] = []

  const push = (kind: CardChangeKind, origPath: JsonPath | undefined, curPath: JsonPath | undefined, before?: unknown, after?: unknown) => {
    const { label, group } = curPath ? describePath(current, curPath) : describePath(original, origPath!)
    const change: CardChange = { kind, group, label }
    if (curPath) change.path = curPath
    if (origPath) change.originalPath = origPath
    if (kind !== 'added') change.before = before
    if (kind !== 'removed') change.after = after
    changes.push(change)
  }

  const walk = (a: unknown, b: unknown, pa: JsonPath, pb: JsonPath) => {
    if (a === b) return
    if (isObject(a) && isObject(b)) {
      for (const key of Object.keys(a)) {
        if (!Object.hasOwn(b, key)) push('removed', [...pa, key], undefined, a[key])
        else walk(a[key], b[key], [...pa, key], [...pb, key])
      }
      for (const key of Object.keys(b)) {
        if (!Object.hasOwn(a, key)) push('added', undefined, [...pb, key], undefined, b[key])
      }
      return
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      walkArray(a, b, pa, pb)
      return
    }
    if (!jsonEqual(a, b)) push('changed', pa, pb, a, b)
  }

  const walkArray = (a: unknown[], b: unknown[], pa: JsonPath, pb: JsonPath) => {
    const perItem = PER_ITEM_ARRAYS.has(pb.join('.'))
    if (!perItem && a.every(isPrimitive) && b.every(isPrimitive)) {
      if (!jsonEqual(a, b)) push('changed', pa, pb, a, b)
      return
    }
    const idsA = perItem ? null : uniqueIds(a)
    const idsB = perItem ? null : uniqueIds(b)
    if (idsA && idsB && (idsA.length > 0 || idsB.length > 0)) {
      const indexB = new Map(idsB.map((id, i) => [`${typeof id}:${id}`, i]))
      const indexA = new Map(idsA.map((id, i) => [`${typeof id}:${id}`, i]))
      idsA.forEach((id, i) => {
        const j = indexB.get(`${typeof id}:${id}`)
        if (j === undefined) push('removed', [...pa, i], undefined, a[i])
        else walk(a[i], b[j], [...pa, i], [...pb, j])
      })
      idsB.forEach((id, j) => {
        if (!indexA.has(`${typeof id}:${id}`)) push('added', undefined, [...pb, j], undefined, b[j])
      })
      // 两边都有的项相对顺序变了
      const commonA = idsA.filter((id) => indexB.has(`${typeof id}:${id}`)).map((id) => `${typeof id}:${id}`)
      const commonB = idsB.filter((id) => indexA.has(`${typeof id}:${id}`)).map((id) => `${typeof id}:${id}`)
      if (commonA.some((k, i) => k !== commonB[i])) {
        push(
          'reordered',
          pa,
          pb,
          commonA.map((k) => itemName(a[indexA.get(k)!], indexA.get(k)!)),
          commonB.map((k) => itemName(b[indexB.get(k)!], indexB.get(k)!)),
        )
      }
      return
    }
    const common = Math.min(a.length, b.length)
    for (let i = 0; i < common; i++) walk(a[i], b[i], [...pa, i], [...pb, i])
    for (let i = common; i < a.length; i++) push('removed', [...pa, i], undefined, a[i])
    for (let i = common; i < b.length; i++) push('added', undefined, [...pb, i], undefined, b[i])
  }

  const topKeys = new Set([...Object.keys(original), ...Object.keys(current)])
  for (const key of topKeys) {
    if (key !== 'data' && MIRROR_KEYS.has(key)) continue
    const inA = Object.hasOwn(original, key)
    const inB = Object.hasOwn(current, key)
    if (inA && !inB) push('removed', [key], undefined, original[key])
    else if (!inA && inB) push('added', undefined, [key], undefined, current[key])
    else walk(original[key], current[key], [key], [key])
  }
  return changes
}

/** 能单独还原的改动：两边都有、值不同的字段 */
export function isRestorable(change: CardChange): boolean {
  return change.kind === 'changed' && change.path !== undefined
}

/** 把一处改动还原成原件的值（直接改传入的卡，可用在 Immer 草稿上）；不能单独还原时返回 false */
export function restoreChange(card: CharacterCardV3, change: CardChange): boolean {
  if (!isRestorable(change)) return false
  setPath(card, change.path!, structuredClone(change.before))
  return true
}
