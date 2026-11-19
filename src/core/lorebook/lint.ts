/**
 * 世界书自动检查。
 */
import type { Lorebook, LorebookEntry } from '../card/types'
import { entryTitle, getDepth, getOrder, getPosition, getRole, getSelectiveLogic, getStrategy, isRegexKey } from './entry'

export interface LintIssue {
  severity: 'warning' | 'info'
  code: 'duplicate-key' | 'same-trigger' | 'wrapper-unclosed' | 'wrapper-misplaced' | 'short-key' | 'no-keys' | 'empty-content' | 'constant-budget'
  message: string
  entryIndexes: number[]
}

export interface LintOptions {
  /** 常驻内容的 token 上限 */
  constantTokenBudget?: number
  tokenCount?: (text: string) => number
}

const WRAPPER = /^<(\/?)([^<>/\n][^<>\n]*)>$/

function slotKey(entry: LorebookEntry): string {
  const p = getPosition(entry)
  return p === 4 ? `4:${getDepth(entry)}:${getRole(entry)}` : String(p)
}

function slotLabel(entry: LorebookEntry): string {
  const p = getPosition(entry)
  const names = ['角色定义前', '角色定义后', '作者注释上方', '作者注释下方', '指定深度', '示例对话前', '示例对话后']
  return p === 4 ? `深度 ${getDepth(entry)}` : (names[p] ?? `位置 ${p}`)
}

interface Wrapper {
  index: number
  tag: string
  closing: boolean
  slot: string
  order: number
}

function isShortKey(key: string): boolean {
  const k = key.trim()
  if (!k || isRegexKey(k) || /\{\{.*\}\}/.test(k)) return false
  if (/^[\x00-\x7f]+$/.test(k)) return k.length <= 2
  return [...k].length <= 1
}

export function lintLorebook(book: Lorebook | undefined, options: LintOptions = {}): LintIssue[] {
  if (!book) return []
  const issues: LintIssue[] = []
  const enabled = book.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.enabled !== false)
  const title = (i: number) => `「${entryTitle(book.entries[i], i)}」`

  // 1. 同一个关键词触发多个条目
  const keyMap = new Map<string, Set<number>>()
  for (const { entry, index } of enabled) {
    if (getStrategy(entry) !== 'keyword') continue
    for (const key of entry.keys ?? []) {
      const k = key.trim().toLowerCase()
      if (!k) continue
      const set = keyMap.get(k) ?? new Set()
      set.add(index)
      keyMap.set(k, set)
    }
  }
  for (const [key, set] of keyMap) {
    if (set.size > 1) {
      issues.push({
        severity: 'info',
        code: 'duplicate-key',
        message: `关键词「${key}」会同时触发 ${set.size} 个条目：${[...set].map(title).join('、')}`,
        entryIndexes: [...set],
      })
    }
  }

  // 2. 主次关键词完全相同
  const triggerMap = new Map<string, number[]>()
  for (const { entry, index } of enabled) {
    if (getStrategy(entry) !== 'keyword' || !(entry.keys ?? []).some((k) => k.trim())) continue
    const norm = (list: string[] | undefined) => (list ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean).sort().join('\u0000')
    const sig = `${norm(entry.keys)}|${norm(entry.selective ? entry.secondary_keys : [])}|${getSelectiveLogic(entry)}`
    triggerMap.set(sig, [...(triggerMap.get(sig) ?? []), index])
  }
  for (const list of triggerMap.values()) {
    if (list.length > 1) {
      issues.push({
        severity: 'warning',
        code: 'same-trigger',
        message: `${list.map(title).join('、')} 的主次关键词完全相同，总是一起触发，可以考虑合并`,
        entryIndexes: list,
      })
    }
  }

  // 3. 包裹标签：<tag> 与 </tag> 必须在同一位置内成对出现
  const wrappers: Wrapper[] = []
  for (const { entry, index } of enabled) {
    if (getStrategy(entry) !== 'constant') continue
    const m = (entry.content ?? '').trim().match(WRAPPER)
    if (!m) continue
    wrappers.push({ index, tag: m[2].trim(), closing: m[1] === '/', slot: slotKey(entry), order: getOrder(entry) })
  }
  const pairs: Array<{ open: Wrapper; close: Wrapper }> = []
  for (const open of wrappers.filter((w) => !w.closing)) {
    const close = wrappers
      .filter((w) => w.closing && w.tag === open.tag && w.slot === open.slot && w.order >= open.order)
      .sort((a, b) => a.order - b.order)[0]
    if (close) {
      pairs.push({ open, close })
    } else {
      issues.push({
        severity: 'warning',
        code: 'wrapper-unclosed',
        message: `包裹标签 <${open.tag}> 在${slotLabel(book.entries[open.index])}找不到对应的 </${open.tag}>`,
        entryIndexes: [open.index],
      })
    }
  }
  const wrapperIndexes = new Set(wrappers.map((w) => w.index))
  const charSlots = new Set(['0', '1'])
  for (const { entry, index } of enabled) {
    if (wrapperIndexes.has(index)) continue
    const slot = slotKey(entry)
    const order = getOrder(entry)
    const insideOwn = pairs.some((p) => p.open.slot === slot && order > p.open.order && order < p.close.order)
    if (insideOwn || !charSlots.has(slot)) continue
    const misplaced = pairs.find(
      (p) => p.open.slot !== slot && charSlots.has(p.open.slot) && order > p.open.order && order < p.close.order,
    )
    if (misplaced) {
      issues.push({
        severity: 'warning',
        code: 'wrapper-misplaced',
        message: `${title(index)} 的顺序 ${order} 落在 <${misplaced.open.tag}> 的包裹范围内，但它在${slotLabel(entry)}，而包裹标签在${slotLabel(book.entries[misplaced.open.index])}，实际不会被包进去`,
        entryIndexes: [index, misplaced.open.index, misplaced.close.index],
      })
    }
  }

  // 4. 关键词太短 / 5. 没有关键词 / 6. 内容为空
  for (const { entry, index } of enabled) {
    const strategy = getStrategy(entry)
    if (strategy === 'keyword') {
      const short = (entry.keys ?? []).filter(isShortKey)
      if (short.length > 0) {
        issues.push({
          severity: 'info',
          code: 'short-key',
          message: `${title(index)} 的关键词「${short.join('」「')}」太短，容易被无关文字误触发`,
          entryIndexes: [index],
        })
      }
      if (!(entry.keys ?? []).some((k) => k.trim())) {
        issues.push({
          severity: 'warning',
          code: 'no-keys',
          message: `${title(index)} 没有关键词，也不是常驻，永远不会触发`,
          entryIndexes: [index],
        })
      }
    }
    if (!(entry.content ?? '').trim()) {
      issues.push({ severity: 'info', code: 'empty-content', message: `${title(index)} 的内容是空的`, entryIndexes: [index] })
    }
  }

  // 7. 常驻内容超预算
  if (options.tokenCount && options.constantTokenBudget) {
    const constants = enabled.filter(({ entry }) => getStrategy(entry) === 'constant')
    const total = constants.reduce((sum, { entry }) => sum + options.tokenCount!(entry.content ?? ''), 0)
    if (total > options.constantTokenBudget) {
      issues.push({
        severity: 'warning',
        code: 'constant-budget',
        message: `常驻条目共约 ${total} token，超过预算 ${options.constantTokenBudget}`,
        entryIndexes: constants.map((c) => c.index),
      })
    }
  }

  return issues
}
