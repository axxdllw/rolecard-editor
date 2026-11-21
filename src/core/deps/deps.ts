/**
 * 角色卡依赖体检：静态分析这张卡要配合哪些酒馆扩展、引用了哪些外部资源、哪些引用有问题。
 * 只读卡片数据，不运行任何代码。
 */
import type { CharacterCardV3, JsonObject, LorebookEntry } from '../card/types'
import { entryTitle } from '../lorebook/entry'
import { isFrontend } from '../render/frontend'
import { findUrls, isLocalHost, parseJsdelivr, RESOURCE_KIND_LABELS, urlOrigin, type ResourceKind } from './urls'

// —— 位置 ——

export type CardTextField =
  | 'description'
  | 'personality'
  | 'scenario'
  | 'first_mes'
  | 'mes_example'
  | 'creator_notes'
  | 'system_prompt'
  | 'post_history_instructions'
  | 'depth_prompt'

export const FIELD_LABELS: Record<CardTextField, string> = {
  description: '角色描述',
  personality: '性格摘要',
  scenario: '场景',
  first_mes: '主开场白',
  mes_example: '示例对话',
  creator_notes: '创作者备注',
  system_prompt: '系统提示词',
  post_history_instructions: '历史后指令',
  depth_prompt: '角色注释',
}

/** 结果所在的位置，界面据此跳转 */
export type DepLocation =
  | { type: 'field'; field: CardTextField }
  /** 备选开场白（group=false）或群聊开场白（group=true） */
  | { type: 'greeting'; group: boolean; index: number }
  | { type: 'entry'; index: number; title: string; enabled: boolean }
  | { type: 'regex'; index: number; name: string; enabled: boolean }
  /** 酒馆助手角色脚本；path 是在脚本树里的下标路径 */
  | { type: 'script'; path: number[]; name: string; enabled: boolean }
  /** data.extensions 下的某个键 */
  | { type: 'extension'; key: string; label?: string }

export function locationLabel(loc: DepLocation): string {
  switch (loc.type) {
    case 'field':
      return FIELD_LABELS[loc.field]
    case 'greeting':
      return `${loc.group ? '群聊开场白' : '备选开场白'} ${loc.index + 1}`
    case 'entry':
      return `世界书「${loc.title}」`
    case 'regex':
      return `正则「${loc.name}」`
    case 'script':
      return `酒馆助手脚本「${loc.name}」`
    case 'extension':
      return loc.label ?? `扩展字段 ${loc.key}`
  }
}

export function locationKey(loc: DepLocation): string {
  switch (loc.type) {
    case 'field':
      return `field:${loc.field}`
    case 'greeting':
      return `greeting:${loc.group ? 'group' : 'alt'}:${loc.index}`
    case 'entry':
    case 'regex':
      return `${loc.type}:${loc.index}`
    case 'script':
      return `script:${loc.path.join('.')}`
    case 'extension':
      return `extension:${loc.key}:${loc.label ?? ''}`
  }
}

/** 禁用的世界书条目、正则或脚本 */
export function isLocationDisabled(loc: DepLocation): boolean {
  return (loc.type === 'entry' || loc.type === 'regex' || loc.type === 'script') && !loc.enabled
}

// —— 结果 ——

export type ExtensionId = 'tavern-helper' | 'mvu' | 'prompt-template' | 'xiaobaix'

export interface Evidence {
  location: DepLocation
  /** 补充说明，例如“前端代码块” */
  note?: string
}

export interface RequiredExtension {
  id: ExtensionId
  name: string
  /** 这个扩展做什么、没装会怎样 */
  summary: string
  evidence: Evidence[]
  /** 依据全在禁用的条目、正则或脚本里 */
  onlyDisabled: boolean
}

export interface ResourceRef {
  url: string
  host: string
  kind: ResourceKind
  locations: DepLocation[]
}

export interface ResourceHost {
  host: string
  refs: ResourceRef[]
}

export type DependencyIssueCode = 'localhost' | 'insecure' | 'unpinned' | 'mixed-cdn'

export interface DependencyIssue {
  severity: 'warning' | 'info'
  code: DependencyIssueCode
  message: string
  urls: string[]
  locations: DepLocation[]
}

export interface DependencyReport {
  extensions: RequiredExtension[]
  /** 不认识的 extensions 键 */
  unknownKeys: string[]
  /** 按域名分组，引用多的在前 */
  hosts: ResourceHost[]
  /** 警告在前 */
  issues: DependencyIssue[]
}

// —— 酒馆助手脚本 ——

export interface HelperScript {
  path: number[]
  name: string
  /** 脚本本身和所在文件夹都启用 */
  enabled: boolean
  content: string
  info: string
  data: unknown
}

function asRecord(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 酒馆助手的角色设置：对象，或 [键, 值] 数组（部分版本这样导出） */
function readHelperSettings(extensions: JsonObject): JsonObject | null {
  const raw = extensions.tavern_helper
  if (Array.isArray(raw)) {
    const pairs = raw.filter((p): p is [string, unknown] => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string')
    return Object.fromEntries(pairs)
  }
  return asRecord(raw)
}

/**
 * 读出酒馆助手角色脚本（含文件夹里的）。
 * 新版在 extensions.tavern_helper.scripts，旧版在 extensions.TavernHelper_scripts，
 * 旧版的每一项可能再包一层 { type, value }。
 */
export function readHelperScripts(extensions: JsonObject): HelperScript[] {
  const list = readHelperSettings(extensions)?.scripts ?? extensions.TavernHelper_scripts
  const out: HelperScript[] = []
  const visit = (items: unknown, parent: number[], parentEnabled: boolean) => {
    if (!Array.isArray(items)) return
    items.forEach((raw, i) => {
      const wrapper = asRecord(raw)
      if (!wrapper) return
      const item = typeof wrapper.type === 'string' ? (asRecord(wrapper.value) ?? wrapper) : wrapper
      const path = [...parent, i]
      const enabled = parentEnabled && item.enabled !== false
      if (Array.isArray(item.scripts)) {
        visit(item.scripts, path, enabled)
        return
      }
      out.push({ path, name: str(item.name) || `脚本 ${path.map((n) => n + 1).join('-')}`, enabled, content: str(item.content), info: str(item.info), data: item.data })
    })
  }
  visit(list, [], true)
  return out
}

// —— 检测规则 ——

const EJS_PATTERN = /<%[\s\S]*?%>/
const CODE_BLOCK_PATTERN = /```[\s\S]*?```|<pre\b[\s\S]*?<\/pre>/gi
const MVU_BUNDLE_PATTERN = /MagVarUpdate[^'"`\s]*\/bundle\.js/i
const MVU_ENTRY_PATTERN = /\[(?:initvar|mvu_update|mvu_plot)\]/i

/** 和酒馆助手一样：代码块（``` 或 <pre>）里有 html>、<head>、<body 就当前端界面渲染 */
export function hasFrontendBlock(text: string): boolean {
  if (!text.includes('```') && !/<pre\b/i.test(text)) return false
  for (const m of text.matchAll(CODE_BLOCK_PATTERN)) {
    if (isFrontend(m[0])) return true
  }
  return false
}

export function hasEjs(text: string): boolean {
  return text.includes('<%') && EJS_PATTERN.test(text)
}

/** ST 自己的字段，和一眼能认出来的扩展 */
const ST_KEYS = new Set(['talkativeness', 'fav', 'world', 'depth_prompt', 'regex_scripts', 'chub'])
const HELPER_KEYS = new Set(['tavern_helper', 'TavernHelper_scripts', 'TavernHelper_characterScriptVariables'])

function isXiaobaiKey(key: string): boolean {
  return /^xiaobaix/i.test(key) || /littlewhitebox/i.test(key)
}

const EXTENSION_INFO: Record<ExtensionId, { name: string; summary: string }> = {
  'tavern-helper': {
    name: '酒馆助手',
    summary: '运行卡里的脚本，并把开场白和正则里的前端代码块渲染成界面。没装时脚本不会运行，界面会显示成一大段代码。',
  },
  mvu: {
    name: 'MVU 变量框架',
    summary: 'MagVarUpdate 管理状态栏等变量，它本身是一个酒馆助手脚本，需要先装酒馆助手。',
  },
  'prompt-template': {
    name: '提示词模板（ST-Prompt-Template）',
    summary: '执行世界书和角色字段里 <% %> 包着的代码。没装时这些代码会原样发给模型。',
  },
  xiaobaix: {
    name: '小白X（LittleWhiteBox）',
    summary: '卡里带了小白X 的设置，没装时这些设置不起作用。',
  },
}

const EXTENSION_ORDER: ExtensionId[] = ['tavern-helper', 'mvu', 'prompt-template', 'xiaobaix']

const KIND_ORDER: ResourceKind[] = ['script', 'style', 'font', 'image', 'media', 'other', 'link']

/** 遍历任意 JSON 里的字符串 */
function walkStrings(value: unknown, visit: (text: string) => void, depth = 0): void {
  if (depth > 32) return
  if (typeof value === 'string') visit(value)
  else if (Array.isArray(value)) for (const item of value) walkStrings(item, visit, depth + 1)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) walkStrings(item, visit, depth + 1)
}

function plural(list: string[]): string {
  return list.length === 1 ? list[0] : `${list.slice(0, -1).join('、')}和${list.at(-1)}`
}

export function analyzeDependencies(card: CharacterCardV3): DependencyReport {
  const data = card.data
  const extensions = asRecord(data.extensions) ?? {}
  const evidence = new Map<ExtensionId, Evidence[]>()
  const urls = new Map<string, ResourceRef>()

  const need = (id: ExtensionId, location: DepLocation, note?: string) => {
    const list = evidence.get(id) ?? []
    const key = locationKey(location)
    if (!list.some((e) => locationKey(e.location) === key && e.note === note)) list.push({ location, note })
    evidence.set(id, list)
  }
  const scanUrls = (text: string, location: DepLocation) => {
    for (const found of findUrls(text)) {
      let ref = urls.get(found.url)
      if (!ref) {
        ref = { ...found, locations: [] }
        urls.set(found.url, ref)
      } else if (ref.kind === 'other' && found.kind !== 'other') {
        ref.kind = found.kind
      }
      const key = locationKey(location)
      if (!ref.locations.some((l) => locationKey(l) === key)) ref.locations.push(location)
    }
  }

  // 1. 酒馆助手脚本
  const scripts = readHelperScripts(extensions)
  for (const script of scripts) {
    const location: DepLocation = { type: 'script', path: script.path, name: script.name, enabled: script.enabled }
    need('tavern-helper', location)
    if (MVU_BUNDLE_PATTERN.test(script.content)) need('mvu', location, '导入了 MagVarUpdate')
    scanUrls(script.content, location)
    scanUrls(script.info, location)
    walkStrings(script.data, (text) => scanUrls(text, location))
  }
  const helper = readHelperSettings(extensions)
  walkStrings(helper?.variables, (text) => scanUrls(text, { type: 'extension', key: 'tavern_helper', label: '酒馆助手角色变量' }))
  walkStrings(extensions.TavernHelper_characterScriptVariables, (text) =>
    scanUrls(text, { type: 'extension', key: 'TavernHelper_characterScriptVariables', label: '酒馆助手角色变量' }),
  )

  // 2. 角色字段与开场白
  const fields: Array<[CardTextField, string]> = [
    ['description', str(data.description)],
    ['personality', str(data.personality)],
    ['scenario', str(data.scenario)],
    ['first_mes', str(data.first_mes)],
    ['mes_example', str(data.mes_example)],
    ['creator_notes', str(data.creator_notes)],
    ['system_prompt', str(data.system_prompt)],
    ['post_history_instructions', str(data.post_history_instructions)],
    ['depth_prompt', str(asRecord(extensions.depth_prompt)?.prompt)],
  ]
  for (const [field, text] of fields) {
    if (!text) continue
    const location: DepLocation = { type: 'field', field }
    // 创作者备注不进提示词，也不按消息渲染
    if (field !== 'creator_notes' && hasEjs(text)) need('prompt-template', location)
    if (field === 'first_mes' && hasFrontendBlock(text)) need('tavern-helper', location, '前端代码块')
    scanUrls(text, location)
  }
  const greetingLists: Array<[boolean, unknown]> = [
    [false, data.alternate_greetings],
    [true, data.group_only_greetings],
  ]
  for (const [group, list] of greetingLists) {
    if (!Array.isArray(list)) continue
    list.forEach((raw, index) => {
      const text = str(raw)
      if (!text) return
      const location: DepLocation = { type: 'greeting', group, index }
      if (hasEjs(text)) need('prompt-template', location)
      if (hasFrontendBlock(text)) need('tavern-helper', location, '前端代码块')
      scanUrls(text, location)
    })
  }

  // 3. 正则：替换结果里的前端代码块和地址
  const regexScripts = Array.isArray(extensions.regex_scripts) ? extensions.regex_scripts : []
  regexScripts.forEach((raw, index) => {
    const script = asRecord(raw)
    if (!script) return
    const replace = str(script.replaceString)
    if (!replace) return
    const location: DepLocation = { type: 'regex', index, name: str(script.scriptName) || `正则 ${index + 1}`, enabled: script.disabled !== true }
    // 只改提示词的正则不会显示出来
    if (script.promptOnly !== true && hasFrontendBlock(replace)) need('tavern-helper', location, '替换结果是前端代码块')
    scanUrls(replace, location)
  })

  // 4. 世界书
  const entries = Array.isArray(data.character_book?.entries) ? data.character_book.entries : []
  entries.forEach((raw, index) => {
    const entry = asRecord(raw) as LorebookEntry | null
    if (!entry) return
    const location: DepLocation = { type: 'entry', index, title: entryTitle(entry, index), enabled: entry.enabled !== false }
    const content = str(entry.content)
    // 标记就在条目名里，不用再写备注
    if (MVU_ENTRY_PATTERN.test(str(entry.comment))) need('mvu', location)
    if (hasEjs(content)) need('prompt-template', location)
    scanUrls(content, location)
  })

  // 5. 其他扩展字段
  const unknownKeys: string[] = []
  for (const [key, value] of Object.entries(extensions)) {
    if (ST_KEYS.has(key) || HELPER_KEYS.has(key)) continue
    const location: DepLocation = { type: 'extension', key }
    if (isXiaobaiKey(key)) need('xiaobaix', location)
    else unknownKeys.push(key)
    walkStrings(value, (text) => scanUrls(text, location))
  }

  // MVU 是酒馆助手脚本
  const mvu = evidence.get('mvu')
  if (mvu && !evidence.has('tavern-helper')) need('tavern-helper', mvu[0].location, 'MVU 需要酒馆助手')

  const required: RequiredExtension[] = EXTENSION_ORDER.filter((id) => evidence.has(id)).map((id) => {
    const list = evidence.get(id)!
    let summary = EXTENSION_INFO[id].summary
    if (id === 'mvu' && !list.some((e) => e.location.type === 'script')) {
      summary += '卡里没有导入 MVU 的脚本，需要自己在酒馆助手里装上 MVU。'
    }
    return { id, name: EXTENSION_INFO[id].name, summary, evidence: list, onlyDisabled: list.every((e) => isLocationDisabled(e.location)) }
  })

  const refs = [...urls.values()]
  return { extensions: required, unknownKeys, hosts: groupByHost(refs), issues: findIssues(refs) }
}

function groupByHost(refs: ResourceRef[]): ResourceHost[] {
  const map = new Map<string, ResourceRef[]>()
  for (const ref of refs) map.set(ref.host, [...(map.get(ref.host) ?? []), ref])
  return [...map.entries()]
    .map(([host, list]) => ({
      host,
      refs: list.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.url.localeCompare(b.url)),
    }))
    .sort((a, b) => b.refs.length - a.refs.length || a.host.localeCompare(b.host))
}

function mergeLocations(refs: ResourceRef[]): DepLocation[] {
  const seen = new Map<string, DepLocation>()
  for (const ref of refs) for (const loc of ref.locations) if (!seen.has(locationKey(loc))) seen.set(locationKey(loc), loc)
  return [...seen.values()]
}

function groupBy<T>(list: T[], key: (item: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of list) {
    const k = key(item)
    if (k !== null) map.set(k, [...(map.get(k) ?? []), item])
  }
  return map
}

function findIssues(refs: ResourceRef[]): DependencyIssue[] {
  const issues: DependencyIssue[] = []
  const issue = (severity: DependencyIssue['severity'], code: DependencyIssueCode, message: string, list: ResourceRef[]) =>
    issues.push({ severity, code, message, urls: list.map((r) => r.url), locations: mergeLocations(list) })

  // 1. 作者本机 / 局域网地址
  for (const [origin, list] of groupBy(refs, (r) => (isLocalHost(r.host) ? urlOrigin(r.url) : null))) {
    const locations = mergeLocations(list)
    const allDisabled = locations.every(isLocationDisabled)
    issue(
      'warning',
      'localhost',
      `引用了作者电脑上的地址 ${origin}（${list.length} 个），别人的电脑上访问不到${allDisabled ? '。所在位置目前是禁用的，启用后会加载失败' : ''}`,
      list,
    )
  }

  // 2. 明文 http（超链接只是让人点开，不算）
  const loaded = refs.filter((r) => r.kind !== 'link')
  for (const [host, list] of groupBy(loaded, (r) => (/^http:/i.test(r.url) && !isLocalHost(r.host) ? r.host : null))) {
    const kinds = [...new Set(list.map((r) => RESOURCE_KIND_LABELS[r.kind]))]
    const active = list.some((r) => r.kind === 'script' || r.kind === 'style')
    issue(
      active ? 'warning' : 'info',
      'insecure',
      `用明文 http:// 加载 ${host} 的${plural(kinds)}（${list.length} 个）：酒馆用 https 打开时浏览器会拦截，内容也可能在路上被篡改，能用 https:// 就换成 https://`,
      list,
    )
  }

  // 3. jsDelivr 没固定版本
  // 说明文字里只写到仓库的地址（如“CDN: …/gh/user/repo@main”）不是实际加载的文件
  const jsdelivr = loaded
    .map((ref) => ({ ref, info: parseJsdelivr(ref.url) }))
    .filter((x) => x.info !== null && !(x.info.file === '' && x.ref.kind === 'other'))
  for (const list of groupBy(jsdelivr, ({ info }) => (info!.pinned ? null : `${info!.source}/${info!.name}@${info!.version ?? ''}`)).values()) {
    const { name, version } = list[0].info!
    const what =
      version === null
        ? `jsDelivr 上的 ${name} 没写版本号`
        : version === ''
          ? `jsDelivr 地址 ${name}@ 后面是空的（可能被换行截断了）`
          : `jsDelivr 上的 ${name} 用的是 @${version}，不是固定版本`
    issue(
      'info',
      'unpinned',
      `${what}（${list.length} 个文件）：作者一更新，卡的效果就可能跟着变；想稳定可以改成具体版本号或提交哈希`,
      list.map((x) => x.ref),
    )
  }

  // 4. cdn.jsdelivr.net 和国内镜像混用
  const byCdn = groupBy(
    jsdelivr.map((x) => x.ref),
    (r) => r.host,
  )
  if (byCdn.size > 1) {
    const counts = [...byCdn.entries()].map(([host, list]) => `${host}（${list.length} 个）`)
    const official = byCdn.get('cdn.jsdelivr.net')
    const advice =
      byCdn.has('testingcf.jsdelivr.net') && official
        ? 'testingcf.jsdelivr.net 是国内能访问的镜像，cdn.jsdelivr.net 在国内经常打不开，建议统一换成 testingcf.jsdelivr.net'
        : '建议统一用同一个'
    issue('info', 'mixed-cdn', `jsDelivr 地址混用了 ${plural(counts)}。${advice}`, official && byCdn.has('testingcf.jsdelivr.net') ? official : jsdelivr.map((x) => x.ref))
  }

  return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warning' ? -1 : 1))
}
