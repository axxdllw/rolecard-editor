/**
 * 酒馆助手（JS-Slash-Runner）角色脚本的读写。
 *
 * 卡里有两种存法（对照酒馆助手 4.7 的 src/type/scripts.ts、src/type/backward.ts、src/store/settings/character.ts）：
 * - 新格式 extensions.tavern_helper = { scripts: 脚本树, variables: 角色变量 }，有的卡存成 Object.entries 的 [key, value][]。
 *   脚本树每项是脚本 { type: 'script', enabled, name, id, content, info, button: { enabled, buttons }, data }
 *   或文件夹 { type: 'folder', enabled, name, id, icon, color, scripts }，文件夹里只放脚本。
 * - 旧格式 extensions.TavernHelper_scripts + TavernHelper_characterScriptVariables。
 *   每项是 { type: 'script', value: 脚本数据 }、{ type: 'folder', id, name, icon, color, value: 脚本数据[] } 或直接是脚本数据；
 *   脚本数据是 { id, name, content, info, buttons, data, enabled }，没有按钮总开关，文件夹也没有开关（总是启用）。
 *   酒馆助手只在没有 tavern_helper 时把旧格式迁移成新格式，然后删掉旧字段。
 *
 * 无损：界面读的是规整后的视图；修改时按位置找到原始对象，只改动到的字段，其余原样保留，也不改变存储格式。
 * 所有修改函数都直接改传入的 extensions 对象，可以用在 Immer 草稿上。
 */
import type { JsonObject } from '../card/types'
import { uuid } from '../util/id'

export const HELPER_KEY = 'tavern_helper'
export const LEGACY_SCRIPTS_KEY = 'TavernHelper_scripts'
export const LEGACY_VARIABLES_KEY = 'TavernHelper_characterScriptVariables'
/** 由脚本编辑区管理的扩展字段 */
export const HELPER_EXTENSION_KEYS: readonly string[] = [HELPER_KEY, LEGACY_SCRIPTS_KEY, LEGACY_VARIABLES_KEY]

/** 酒馆助手新建文件夹时用主题的引用色，这里取酒馆默认主题的值 */
export const DEFAULT_FOLDER_COLOR = 'rgba(225, 138, 36, 1)'
export const DEFAULT_FOLDER_ICON = 'fa-solid fa-folder'

/** object：tavern_helper 是对象；entries：tavern_helper 是 [key, value][]；legacy：旧格式 */
export type HelperFormat = 'object' | 'entries' | 'legacy'

export interface HelperButton {
  name: string
  visible: boolean
}

/** 节点位置：顶层第 index 项；child 是文件夹里的第几项 */
export interface NodePos {
  index: number
  child?: number
}

interface NodeBase {
  pos: NodePos
  /** 列表里的稳定标识：通常就是 id，缺失或重复时用位置兜底 */
  key: string
  id: string
  name: string
}

export interface HelperScript extends NodeBase {
  type: 'script'
  enabled: boolean
  content: string
  info: string
  /** 按钮总开关；旧格式没有这个开关，为 null */
  buttonEnabled: boolean | null
  buttons: HelperButton[]
  /** 脚本绑定的变量（原始值，正常是对象） */
  data: unknown
}

export interface HelperFolder extends NodeBase {
  type: 'folder'
  /** 旧格式文件夹没有开关（总是启用），为 null */
  enabled: boolean | null
  icon: string
  color: string
  scripts: HelperScript[]
}

export type HelperNode = HelperScript | HelperFolder

export interface HelperView {
  /** null：卡里没有酒馆助手数据 */
  format: HelperFormat | null
  nodes: HelperNode[]
  /** 角色变量的原始值；卡里没有时为 undefined */
  variables: unknown
  /** 新格式之外还残留的旧格式字段（酒馆助手会忽略并删除它们） */
  staleLegacy: string[]
  /** 数据结构无法识别时的原因；此时界面不接管这些字段 */
  invalid: string | null
}

type Raw = Record<string | number, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 与酒馆助手的 z.coerce.string 一致：缺失为空串，其他类型转成字符串 */
function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

/** 当前生效的格式；同时有新旧格式时以新格式为准（与酒馆助手一致） */
export function detectFormat(ext: JsonObject): HelperFormat | null {
  const th = ext[HELPER_KEY]
  if (th !== undefined) return Array.isArray(th) ? 'entries' : 'object'
  if (ext[LEGACY_SCRIPTS_KEY] !== undefined || ext[LEGACY_VARIABLES_KEY] !== undefined) return 'legacy'
  return null
}

/** entries 形式里某个键所在的下标；重复时取最后一个（Object.fromEntries 的行为） */
function entryIndex(list: unknown[], key: string): number {
  return list.findLastIndex((e) => Array.isArray(e) && e[0] === key)
}

/** 读取 tavern_helper 里的某个键 */
function readSetting(ext: JsonObject, key: string): unknown {
  const th = ext[HELPER_KEY]
  if (Array.isArray(th)) {
    const i = entryIndex(th, key)
    return i >= 0 ? (th[i] as unknown[])[1] : undefined
  }
  return isObject(th) ? th[key] : undefined
}

/** 写入 tavern_helper 里的某个键，保持原来的对象/entries 形式；还没有 tavern_helper 时按新格式创建 */
function writeSetting(ext: JsonObject, key: string, value: unknown): void {
  let th = ext[HELPER_KEY]
  if (th === undefined) {
    th = ext[HELPER_KEY] = { scripts: [], variables: {} }
  }
  if (Array.isArray(th)) {
    const i = entryIndex(th, key)
    if (i >= 0) (th[i] as unknown[])[1] = value
    else th.push([key, value])
  } else if (isObject(th)) {
    th[key] = value
  }
}

/** 顶层脚本树数组；create 为真时缺失则创建（已有但不是数组时不覆盖） */
function treeList(ext: JsonObject, create: boolean): unknown[] | undefined {
  const format = detectFormat(ext)
  if (format === 'legacy') {
    const list = ext[LEGACY_SCRIPTS_KEY]
    if (Array.isArray(list)) return list
    if (list === undefined && create) return (ext[LEGACY_SCRIPTS_KEY] = [])
    return undefined
  }
  const list = format ? readSetting(ext, 'scripts') : undefined
  if (Array.isArray(list)) return list
  if (list === undefined && create) {
    writeSetting(ext, 'scripts', [])
    return readSetting(ext, 'scripts') as unknown[]
  }
  return undefined
}

type ItemKind = 'script' | 'wrapped' | 'folder'

/** 顶层项的种类；wrapped 是旧格式的 { type: 'script', value } */
function itemKind(item: Raw, legacy: boolean): ItemKind {
  if (item.type === 'folder') return 'folder'
  return legacy && item.type === 'script' ? 'wrapped' : 'script'
}

/** 文件夹的子项数组 */
function folderChildren(folder: Raw, legacy: boolean, create: boolean): unknown[] | undefined {
  const key = legacy ? 'value' : 'scripts'
  const list = folder[key]
  if (Array.isArray(list)) return list
  if (list === undefined && create) return (folder[key] = [])
  return undefined
}

interface Resolved {
  legacy: boolean
  /** 顶层或文件夹里的那一项 */
  item: Raw
  kind: ItemKind
}

function resolve(ext: JsonObject, pos: NodePos): Resolved | undefined {
  const legacy = detectFormat(ext) === 'legacy'
  const top = treeList(ext, false)?.[pos.index]
  if (!isObject(top)) return undefined
  if (pos.child === undefined) return { legacy, item: top, kind: itemKind(top, legacy) }
  if (itemKind(top, legacy) !== 'folder') return undefined
  const child = folderChildren(top, legacy, false)?.[pos.child]
  return isObject(child) ? { legacy, item: child, kind: 'script' } : undefined
}

/** 脚本字段所在的对象；旧格式的包装项是 value，缺失时 create 为真则创建 */
function scriptData(r: Resolved, create: boolean): Raw | undefined {
  if (r.kind !== 'wrapped') return r.item
  if (isObject(r.item.value)) return r.item.value
  if (create && r.item.value === undefined) return (r.item.value = {})
  return undefined
}

// —— 读取 ——

function readButtons(list: unknown): HelperButton[] {
  if (!Array.isArray(list)) return []
  return list.map((b) => (isObject(b) ? { name: str(b.name), visible: b.visible !== false } : { name: '', visible: true }))
}

function readScript(data: Raw, legacy: boolean, pos: NodePos): HelperScript {
  const button = isObject(data.button) ? data.button : undefined
  return {
    type: 'script',
    pos,
    key: '',
    id: str(data.id),
    name: str(data.name),
    enabled: data.enabled === true,
    content: str(data.content),
    info: str(data.info),
    buttonEnabled: legacy ? null : button?.enabled !== false,
    buttons: readButtons(legacy ? data.buttons : button?.buttons),
    data: data.data,
  }
}

function invalidView(format: HelperFormat, reason: string, staleLegacy: string[]): HelperView {
  return { format, nodes: [], variables: undefined, staleLegacy, invalid: reason }
}

/** 读出规整后的脚本树和变量；不修改传入的对象 */
export function readHelper(ext: JsonObject): HelperView {
  const format = detectFormat(ext)
  if (format === null) return { format, nodes: [], variables: undefined, staleLegacy: [], invalid: null }
  const legacy = format === 'legacy'
  const staleLegacy = legacy ? [] : [LEGACY_SCRIPTS_KEY, LEGACY_VARIABLES_KEY].filter((k) => ext[k] !== undefined)

  const th = ext[HELPER_KEY]
  if (format === 'object' && !isObject(th)) return invalidView(format, 'tavern_helper 不是对象', staleLegacy)
  if (format === 'entries' && !(th as unknown[]).every((e) => Array.isArray(e) && typeof e[0] === 'string')) {
    return invalidView(format, 'tavern_helper 的键值对格式不对', staleLegacy)
  }
  const rawList = legacy ? ext[LEGACY_SCRIPTS_KEY] : readSetting(ext, 'scripts')
  if (rawList !== undefined && !Array.isArray(rawList)) return invalidView(format, '脚本列表不是数组', staleLegacy)

  const nodes: HelperNode[] = []
  for (const [index, item] of (rawList ?? []).entries()) {
    if (!isObject(item)) return invalidView(format, `第 ${index + 1} 项不是对象`, staleLegacy)
    const kind = itemKind(item, legacy)
    if (kind !== 'folder') {
      const data = kind === 'wrapped' ? (isObject(item.value) ? item.value : {}) : item
      nodes.push(readScript(data, legacy, { index }))
      continue
    }
    const children = item[legacy ? 'value' : 'scripts']
    if (children !== undefined && !Array.isArray(children)) return invalidView(format, `文件夹「${str(item.name)}」的内容不是数组`, staleLegacy)
    const scripts: HelperScript[] = []
    for (const [child, data] of (children ?? []).entries()) {
      if (!isObject(data)) return invalidView(format, `文件夹「${str(item.name)}」第 ${child + 1} 项不是对象`, staleLegacy)
      scripts.push(readScript(data, legacy, { index, child }))
    }
    nodes.push({
      type: 'folder',
      pos: { index },
      key: '',
      id: str(item.id),
      name: str(item.name),
      enabled: legacy ? null : item.enabled === true,
      icon: typeof item.icon === 'string' ? item.icon : DEFAULT_FOLDER_ICON,
      color: typeof item.color === 'string' ? item.color : '',
      scripts,
    })
  }

  // 列表 key：优先用 id，缺失或重复时用位置
  const seen = new Set<string>()
  const assignKey = (node: HelperNode) => {
    const fallback = `@${node.pos.index}${node.pos.child === undefined ? '' : `.${node.pos.child}`}`
    node.key = node.id && !seen.has(node.id) ? node.id : fallback
    seen.add(node.key)
  }
  for (const node of nodes) {
    assignKey(node)
    if (node.type === 'folder') node.scripts.forEach(assignKey)
  }

  const variables = legacy ? ext[LEGACY_VARIABLES_KEY] : readSetting(ext, 'variables')
  return { format, nodes, variables, staleLegacy, invalid: null }
}

/** 所有脚本（含文件夹里的），按显示顺序 */
export function flattenScripts(nodes: HelperNode[]): HelperScript[] {
  return nodes.flatMap((n) => (n.type === 'folder' ? n.scripts : [n]))
}

/** 脚本总数 */
export function countScripts(ext: JsonObject): number {
  return flattenScripts(readHelper(ext).nodes).length
}

/** 实际会运行的脚本数：脚本和所在文件夹都启用（两者缺省都是关闭，旧格式文件夹总是启用） */
export function countEnabledScripts(ext: JsonObject): number {
  return readHelper(ext).nodes.reduce((n, node) => {
    if (node.type === 'script') return n + (node.enabled ? 1 : 0)
    if (node.enabled === false) return n
    return n + node.scripts.filter((s) => s.enabled).length
  }, 0)
}

/** 在视图里按位置找节点 */
export function findNode(nodes: HelperNode[], pos: NodePos): HelperNode | undefined {
  const top = nodes[pos.index]
  if (pos.child === undefined) return top
  return top?.type === 'folder' ? top.scripts[pos.child] : undefined
}

// —— 修改 ——

export interface ScriptPatch {
  enabled?: boolean
  name?: string
  content?: string
  info?: string
  /** 旧格式没有按钮总开关，忽略 */
  buttonEnabled?: boolean
  data?: JsonObject
}

/** 改脚本的字段，只写传入的字段 */
export function updateScript(ext: JsonObject, pos: NodePos, patch: ScriptPatch): void {
  const r = resolve(ext, pos)
  if (!r || r.kind === 'folder') return
  const data = scriptData(r, true)
  if (!data) return
  for (const key of ['enabled', 'name', 'content', 'info', 'data'] as const) {
    if (patch[key] !== undefined && data[key] !== patch[key]) data[key] = patch[key]
  }
  if (patch.buttonEnabled !== undefined && !r.legacy) {
    if (!isObject(data.button)) data.button = { enabled: patch.buttonEnabled, buttons: [] }
    else if (data.button.enabled !== patch.buttonEnabled) data.button.enabled = patch.buttonEnabled
  }
}

/** 修改脚本的按钮列表；recipe 拿到原始数组，可以增删、排序、改字段 */
export function updateButtons(ext: JsonObject, pos: NodePos, recipe: (buttons: JsonObject[]) => void): void {
  const r = resolve(ext, pos)
  if (!r || r.kind === 'folder') return
  const data = scriptData(r, true)
  if (!data) return
  let holder: Raw = data
  if (!r.legacy) {
    if (data.button === undefined) data.button = { enabled: true, buttons: [] }
    if (!isObject(data.button)) return
    holder = data.button
  }
  if (holder.buttons === undefined) holder.buttons = []
  if (!Array.isArray(holder.buttons)) return
  recipe(holder.buttons as JsonObject[])
}

export interface FolderPatch {
  /** 旧格式文件夹没有开关，忽略 */
  enabled?: boolean
  name?: string
  icon?: string
  color?: string
}

export function updateFolder(ext: JsonObject, pos: NodePos, patch: FolderPatch): void {
  const r = resolve(ext, pos)
  if (!r || r.kind !== 'folder') return
  for (const key of ['enabled', 'name', 'icon', 'color'] as const) {
    if (key === 'enabled' && r.legacy) continue
    if (patch[key] !== undefined && r.item[key] !== patch[key]) r.item[key] = patch[key]
  }
}

/** 角色变量；卡里还没有酒馆助手数据时按新格式创建 */
export function setVariables(ext: JsonObject, value: JsonObject): void {
  if (detectFormat(ext) === 'legacy') ext[LEGACY_VARIABLES_KEY] = value
  else writeSetting(ext, 'variables', value)
}

export interface NewScript {
  name?: string
  content?: string
  info?: string
  enabled?: boolean
}

/** 按格式生成新脚本的原始对象；inFolder 只影响旧格式（文件夹里放的是不带包装的脚本数据） */
function makeScriptRaw(legacy: boolean, inFolder: boolean, init: NewScript): JsonObject {
  const id = uuid()
  if (!legacy) {
    return {
      type: 'script',
      enabled: init.enabled ?? false,
      name: init.name ?? '',
      id,
      content: init.content ?? '',
      info: init.info ?? '',
      button: { enabled: true, buttons: [] },
      data: {},
    }
  }
  const data = { id, name: init.name ?? '', content: init.content ?? '', info: init.info ?? '', buttons: [], data: {}, enabled: init.enabled ?? false }
  return inFolder ? data : { type: 'script', value: data }
}

/** 目标位置：folder 是目标文件夹在顶层的下标（不填表示顶层），index 是插入到那一层的第几个 */
export interface InsertTarget {
  folder?: number
  index?: number
}

function targetList(ext: JsonObject, target: InsertTarget): unknown[] | undefined {
  const list = treeList(ext, true)
  if (!list || target.folder === undefined) return list
  const folder = list[target.folder]
  if (!isObject(folder) || itemKind(folder, detectFormat(ext) === 'legacy') !== 'folder') return undefined
  return folderChildren(folder, detectFormat(ext) === 'legacy', true)
}

function insertAt(list: unknown[], index: number | undefined, item: unknown): number {
  const at = index === undefined ? list.length : Math.max(0, Math.min(index, list.length))
  list.splice(at, 0, item)
  return at
}

function posOf(target: InsertTarget, at: number): NodePos {
  return target.folder === undefined ? { index: at } : { index: target.folder, child: at }
}

/** 新建脚本，返回它的位置；默认加到顶层末尾 */
export function addScript(ext: JsonObject, init: NewScript = {}, target: InsertTarget = {}): NodePos | null {
  const list = targetList(ext, target)
  if (!list) return null
  const legacy = detectFormat(ext) === 'legacy'
  return posOf(target, insertAt(list, target.index, makeScriptRaw(legacy, target.folder !== undefined, init)))
}

/** 新建文件夹（只能在顶层），返回它的位置 */
export function addFolder(ext: JsonObject, name: string, index?: number): NodePos | null {
  const list = treeList(ext, true)
  if (!list) return null
  const legacy = detectFormat(ext) === 'legacy'
  const id = uuid()
  const folder = legacy
    ? { type: 'folder', id, name, icon: DEFAULT_FOLDER_ICON, color: DEFAULT_FOLDER_COLOR, value: [] }
    : { type: 'folder', enabled: true, name, id, icon: DEFAULT_FOLDER_ICON, color: DEFAULT_FOLDER_COLOR, scripts: [] }
  return { index: insertAt(list, index, folder) }
}

/** 节点所在的数组（顶层或文件夹的子项） */
function containerOf(ext: JsonObject, pos: NodePos): unknown[] | undefined {
  const list = treeList(ext, false)
  if (!list || pos.child === undefined) return list
  const folder = list[pos.index]
  return isObject(folder) ? folderChildren(folder, detectFormat(ext) === 'legacy', false) : undefined
}

/** 取出某一项（从所在数组里删掉），返回原始对象 */
function takeOut(ext: JsonObject, pos: NodePos): unknown {
  return containerOf(ext, pos)?.splice(pos.child ?? pos.index, 1)[0]
}

export function removeNode(ext: JsonObject, pos: NodePos): void {
  if (resolve(ext, pos)) takeOut(ext, pos)
}

/**
 * 移动节点。to 是在“先删掉原节点之后”的树里的位置。
 * 文件夹只能放在顶层；旧格式的包装脚本移进文件夹时去掉包装（文件夹里放的是脚本数据本身）。
 */
export function moveNode(ext: JsonObject, from: NodePos, to: InsertTarget): void {
  const r = resolve(ext, from)
  if (!r) return
  if (r.kind === 'folder' && to.folder !== undefined) return
  const item = takeOut(ext, from) as Raw
  const list = targetList(ext, to)
  if (!list) {
    // 目标不存在：放回原处，不丢数据
    targetList(ext, { folder: from.child === undefined ? undefined : from.index })?.splice(from.child ?? from.index, 0, item)
    return
  }
  const moved = r.legacy && r.kind === 'wrapped' && to.folder !== undefined ? (isObject(item.value) ? item.value : {}) : item
  insertAt(list, to.index, moved)
}

/** 把删掉 from 之后，顶层第 folder 项的新下标 */
export function folderIndexAfterRemoval(from: NodePos, folder: number): number {
  return from.child === undefined && from.index < folder ? folder - 1 : folder
}

/** 复制一份放在原节点后面：新 id、默认关闭（与酒馆助手的复制一致），名字加“副本” */
export function duplicateNode(ext: JsonObject, pos: NodePos): NodePos | null {
  const r = resolve(ext, pos)
  const list = containerOf(ext, pos)
  if (!r || !list) return null
  // 用 JSON 复制：传进来的可能是 Immer 草稿，structuredClone 复制不了代理对象
  const copy = JSON.parse(JSON.stringify(r.item)) as Raw
  const renew = (data: Raw) => {
    data.id = uuid()
    data.enabled = false
  }
  if (r.kind === 'folder') {
    copy.id = uuid()
    copy.name = `${str(copy.name)} 副本`
    for (const child of folderChildren(copy, r.legacy, false) ?? []) if (isObject(child)) renew(child)
  } else {
    const data = r.kind === 'wrapped' ? (isObject(copy.value) ? copy.value : (copy.value = {})) : copy
    renew(data)
    data.name = `${str(data.name)} 副本`
  }
  const at = (pos.child ?? pos.index) + 1
  list.splice(at, 0, copy)
  return pos.child === undefined ? { index: at } : { index: pos.index, child: at }
}

// —— 旧格式升级 ——

/** 旧格式脚本数据转新格式（对照酒馆助手 backward.ts 的 ScriptData），保留未知字段 */
function upgradeScriptData(src: Raw): JsonObject {
  const { enabled, name, id, content, info, buttons, data, ...rest } = src
  return {
    type: 'script',
    enabled: typeof enabled === 'boolean' ? enabled : false,
    name: typeof name === 'string' ? name : '',
    id: typeof id === 'string' ? id : uuid(),
    content: typeof content === 'string' ? content : '',
    info: typeof info === 'string' ? info : '',
    button: {
      enabled: true,
      buttons: (Array.isArray(buttons) ? buttons : []).map((b: unknown) => ({
        name: isObject(b) && typeof b.name === 'string' ? b.name : '',
        visible: isObject(b) && typeof b.visible === 'boolean' ? b.visible : true,
      })),
    },
    data: isObject(data) ? data : {},
    ...rest,
  }
}

/** 旧格式脚本树转新格式 */
export function upgradeLegacyTree(list: unknown[]): JsonObject[] {
  return list.map((item) => {
    const raw = isObject(item) ? item : {}
    const kind = itemKind(raw, true)
    if (kind === 'wrapped') return upgradeScriptData(isObject(raw.value) ? raw.value : {})
    if (kind === 'script') return upgradeScriptData(raw)
    const children = Array.isArray(raw.value) ? raw.value : []
    return {
      type: 'folder',
      enabled: true,
      name: typeof raw.name === 'string' ? raw.name : '',
      id: typeof raw.id === 'string' ? raw.id : uuid(),
      icon: typeof raw.icon === 'string' ? raw.icon : DEFAULT_FOLDER_ICON,
      color: typeof raw.color === 'string' ? raw.color : DEFAULT_FOLDER_COLOR,
      scripts: children.map((c) => upgradeScriptData(isObject(c) ? c : {})),
    }
  })
}

/**
 * 把旧格式升级成新格式（与酒馆助手加载旧卡时做的迁移一致）：
 * 写入 tavern_helper，删掉 TavernHelper_scripts 和 TavernHelper_characterScriptVariables。
 */
export function upgradeLegacy(ext: JsonObject): void {
  if (detectFormat(ext) !== 'legacy') return
  const list = ext[LEGACY_SCRIPTS_KEY]
  const variables = ext[LEGACY_VARIABLES_KEY]
  delete ext[LEGACY_SCRIPTS_KEY]
  delete ext[LEGACY_VARIABLES_KEY]
  ext[HELPER_KEY] = {
    scripts: upgradeLegacyTree(Array.isArray(list) ? list : []),
    variables: isObject(variables) ? variables : {},
  }
}

/** 删掉新格式之外残留的旧格式字段 */
export function removeStaleLegacy(ext: JsonObject): void {
  if (detectFormat(ext) === 'legacy') return
  delete ext[LEGACY_SCRIPTS_KEY]
  delete ext[LEGACY_VARIABLES_KEY]
}
