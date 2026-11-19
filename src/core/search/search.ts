/**
 * 全卡查找替换与改名向导的核心逻辑。
 *
 * 把卡里所有可能出现文字的地方收集成“文本槽”（带 JSON 路径），
 * 在槽里查找命中，再按选中的命中逐条替换。替换函数直接修改传入的卡（配合 Immer 草稿）。
 */
import type { CharacterCardV3, JsonObject } from '../card/types'
import { entryTitle } from '../lorebook/entry'
import { getRegexScripts } from '../regex/regex'

export type JsonPath = Array<string | number>

export interface TextSlot {
  path: JsonPath
  /** 显示用的位置名，如“世界书 · 秧秧 · 内容” */
  label: string
  group: '角色字段' | '开场白' | '世界书' | '正则' | '扩展'
  text: string
  /** 关键词槽：替换成空字符串时会删除该关键词 */
  isKey?: boolean
}

export interface SearchQuery {
  text: string
  useRegex: boolean
  caseSensitive: boolean
}

export interface SearchHit {
  id: string
  slotIndex: number
  path: JsonPath
  label: string
  group: TextSlot['group']
  isKey: boolean
  start: number
  end: number
  match: string
  before: string
  after: string
}

const FIELD_LABELS: Array<[string, string]> = [
  ['name', '角色名'],
  ['nickname', '昵称'],
  ['description', '角色描述'],
  ['personality', '性格'],
  ['scenario', '场景'],
  ['first_mes', '主开场白'],
  ['mes_example', '示例对话'],
  ['creator_notes', '创作者备注'],
  ['system_prompt', '系统提示词'],
  ['post_history_instructions', '历史后指令'],
]

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function collectTextSlots(card: CharacterCardV3): TextSlot[] {
  const slots: TextSlot[] = []
  const data = card.data

  for (const [key, label] of FIELD_LABELS) {
    const value = data[key]
    if (typeof value === 'string') {
      slots.push({ path: ['data', key], label, group: key === 'first_mes' ? '开场白' : '角色字段', text: value })
    }
  }

  data.alternate_greetings?.forEach((text, i) => {
    if (typeof text === 'string') {
      slots.push({ path: ['data', 'alternate_greetings', i], label: `备选开场白 ${i + 1}`, group: '开场白', text })
    }
  })
  data.group_only_greetings?.forEach((text, i) => {
    if (typeof text === 'string') {
      slots.push({ path: ['data', 'group_only_greetings', i], label: `群聊开场白 ${i + 1}`, group: '开场白', text })
    }
  })

  const ext = isObject(data.extensions) ? data.extensions : {}
  const depthPrompt = ext.depth_prompt
  if (isObject(depthPrompt) && typeof depthPrompt.prompt === 'string') {
    slots.push({ path: ['data', 'extensions', 'depth_prompt', 'prompt'], label: '角色注释', group: '扩展', text: depthPrompt.prompt })
  }

  const book = data.character_book
  if (book) {
    if (typeof book.name === 'string') {
      slots.push({ path: ['data', 'character_book', 'name'], label: '世界书名称', group: '世界书', text: book.name })
    }
    book.entries.forEach((entry, i) => {
      const title = entryTitle(entry, i)
      const base: JsonPath = ['data', 'character_book', 'entries', i]
      if (typeof entry.comment === 'string') {
        slots.push({ path: [...base, 'comment'], label: `世界书 · ${title} · 备注名`, group: '世界书', text: entry.comment })
      }
      entry.keys?.forEach((key, k) => {
        slots.push({ path: [...base, 'keys', k], label: `世界书 · ${title} · 关键词`, group: '世界书', text: key, isKey: true })
      })
      entry.secondary_keys?.forEach((key, k) => {
        slots.push({ path: [...base, 'secondary_keys', k], label: `世界书 · ${title} · 次要关键词`, group: '世界书', text: key, isKey: true })
      })
      if (typeof entry.content === 'string') {
        slots.push({ path: [...base, 'content'], label: `世界书 · ${title} · 内容`, group: '世界书', text: entry.content })
      }
    })
  }

  getRegexScripts(ext).forEach((script, i) => {
    const base: JsonPath = ['data', 'extensions', 'regex_scripts', i]
    const name = script.scriptName || `正则 ${i + 1}`
    if (typeof script.scriptName === 'string') {
      slots.push({ path: [...base, 'scriptName'], label: `正则 · ${name} · 名称`, group: '正则', text: script.scriptName })
    }
    if (typeof script.findRegex === 'string') {
      slots.push({ path: [...base, 'findRegex'], label: `正则 · ${name} · 查找`, group: '正则', text: script.findRegex })
    }
    if (typeof script.replaceString === 'string') {
      slots.push({ path: [...base, 'replaceString'], label: `正则 · ${name} · 替换`, group: '正则', text: script.replaceString })
    }
  })

  return slots
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把查询编译成全局正则；正则写错时返回错误信息 */
export function compileQuery(query: SearchQuery): RegExp | string {
  if (!query.text) return '请输入要查找的内容'
  const source = query.useRegex ? query.text : escapeRegex(query.text)
  try {
    return new RegExp(source, query.caseSensitive ? 'g' : 'gi')
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const CONTEXT = 24

export function findInSlots(slots: TextSlot[], regex: RegExp, idPrefix = ''): SearchHit[] {
  const hits: SearchHit[] = []
  slots.forEach((slot, slotIndex) => {
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g')
    for (const m of slot.text.matchAll(re)) {
      if (m.index === undefined || m[0].length === 0) continue
      const start = m.index
      const end = start + m[0].length
      hits.push({
        id: `${idPrefix}${slotIndex}:${start}`,
        slotIndex,
        path: slot.path,
        label: slot.label,
        group: slot.group,
        isKey: slot.isKey === true,
        start,
        end,
        match: m[0],
        before: slot.text.slice(Math.max(0, start - CONTEXT), start),
        after: slot.text.slice(end, end + CONTEXT),
      })
    }
  })
  return hits
}

export function getAtPath(root: unknown, path: JsonPath): unknown {
  let cur: unknown = root
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string | number, unknown>)[key]
  }
  return cur
}

function setAtPath(root: unknown, path: JsonPath, value: unknown): void {
  let cur = root as Record<string | number, unknown>
  for (let i = 0; i < path.length - 1; i++) {
    cur = cur[path[i]] as Record<string | number, unknown>
  }
  cur[path[path.length - 1]] = value
}

export interface Replacement {
  hit: SearchHit
  /** 替换成的文字 */
  text: string
}

/**
 * 按选中的命中逐条替换。同一个槽里从后往前替换，偏移不会错乱。
 * 关键词被替换成空字符串时，从关键词列表里删除。
 * 返回实际替换的条数。
 */
export function applyReplacements(card: CharacterCardV3, replacements: Replacement[]): number {
  const bySlot = new Map<string, { path: JsonPath; isKey: boolean; items: Replacement[] }>()
  for (const r of replacements) {
    const key = JSON.stringify(r.hit.path)
    const group = bySlot.get(key) ?? { path: r.hit.path, isKey: r.hit.isKey, items: [] }
    group.items.push(r)
    bySlot.set(key, group)
  }

  let count = 0
  const keyArraysToClean = new Map<string, JsonPath>()
  for (const { path, isKey, items } of bySlot.values()) {
    const current = getAtPath(card, path)
    if (typeof current !== 'string') continue
    let text = current
    const sorted = [...items].sort((a, b) => b.hit.start - a.hit.start)
    for (const { hit, text: replacement } of sorted) {
      // 槽内容已经变化（与查找时不一致）就跳过，避免错位替换
      if (text.slice(hit.start, hit.end) !== hit.match) continue
      text = text.slice(0, hit.start) + replacement + text.slice(hit.end)
      count++
    }
    setAtPath(card, path, text)
    if (isKey && text.trim() === '') {
      const arrayPath = path.slice(0, -1)
      keyArraysToClean.set(JSON.stringify(arrayPath), arrayPath)
    }
  }

  for (const arrayPath of keyArraysToClean.values()) {
    const arr = getAtPath(card, arrayPath)
    if (Array.isArray(arr)) {
      setAtPath(card, arrayPath, arr.filter((k) => typeof k !== 'string' || k.trim() !== ''))
    }
  }
  return count
}

/** 计算正则模式下某条命中的替换结果（支持 $1 等分组引用） */
export function replacementFor(hit: SearchHit, query: SearchQuery, replace: string): string {
  if (!query.useRegex) return replace
  try {
    const re = new RegExp(query.text, query.caseSensitive ? '' : 'i')
    return hit.match.replace(re, replace)
  } catch {
    return replace
  }
}

export interface NameCandidate {
  name: string
  source: string
}

const NAME_LINE =
  /^[\s\-*]*(Chinese[_ ]?name|English[_ ]?name|Japanese[_ ]?name|Korean[_ ]?name|中文名|英文名|日文名|韩文名|姓名|名字|全名|name)\s*[:：]\s*(.+?)\s*$/gim

/** 从角色名、昵称和描述里的“xx_name: 名字”行识别角色的各种叫法 */
export function detectNameCandidates(card: CharacterCardV3): NameCandidate[] {
  const out: NameCandidate[] = []
  const seen = new Set<string>()
  const add = (name: string, source: string) => {
    const clean = name.replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '').trim()
    if (!clean || clean.length > 40 || seen.has(clean) || /\{\{.*\}\}/.test(clean)) return
    seen.add(clean)
    out.push({ name: clean, source })
  }

  add(card.data.name ?? '', '角色名')
  if (typeof card.data.nickname === 'string') add(card.data.nickname, '昵称')
  const description = typeof card.data.description === 'string' ? card.data.description : ''
  for (const m of description.matchAll(NAME_LINE)) {
    add(m[2], `描述里的 ${m[1]}`)
  }
  return out
}
