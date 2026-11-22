/**
 * 文本差异：先按行比较，相邻的删除行和新增行再按词比较，显示行内改动；
 * 没改动的行只在改动附近留几行上下文，其余折叠。
 * 中文按 Intl.Segmenter 分词（没有时退回 jsdiff 默认的分词）。
 */
import { diffLines, diffWords } from 'diff'

export interface Segment {
  type: 'same' | 'del' | 'ins'
  text: string
}

export type DiffRow =
  | { type: 'same' | 'del' | 'ins'; text: string }
  /** 一段改动（若干行删除 + 若干行新增）合并成行内对比 */
  | { type: 'edit'; segments: Segment[] }
  /** 折叠的未改动行 */
  | { type: 'skip'; lines: string[] }

export interface TextDiff {
  rows: DiffRow[]
  /** 新增 / 删除的行数 */
  added: number
  removed: number
  /** 文本太大或差别太多，算不出来（这时 rows 为空，界面直接显示前后全文） */
  tooLarge: boolean
}

export interface TextDiffOptions {
  /** 改动前后保留的未改动行数，默认 2 */
  context?: number
  /** 行内对比的上限：删除和新增合计超过这么多字符就不做行内对比，默认 6000 */
  inlineLimit?: number
  /** 计算超时（毫秒），默认 500 */
  timeout?: number
}

let segmenter: unknown = undefined

function getSegmenter(): unknown {
  if (segmenter === undefined) {
    segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'word' }) : null
  }
  return segmenter ?? undefined
}

function splitLines(value: string): string[] {
  const lines = value.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 行内对比：按词比较两段文本 */
export function diffInline(before: string, after: string, timeout = 500): Segment[] | null {
  const parts = diffWords(before, after, { intlSegmenter: getSegmenter(), timeout })
  if (!parts) return null
  return parts.map((p) => ({ type: p.added ? 'ins' : p.removed ? 'del' : 'same', text: p.value }))
}

export function diffText(before: string, after: string, options: TextDiffOptions = {}): TextDiff {
  const context = options.context ?? 2
  const inlineLimit = options.inlineLimit ?? 6000
  const timeout = options.timeout ?? 500
  // 末尾有没有换行不算改动，否则最后一行后面追加内容时，原来的最后一行也会显示成改过
  // 行尾的 \r 也不算改动：同一段文字一边用 \r\n 换行、一边用 \n 时，不应该整段标成改过
  const parts = diffLines(before, after, { timeout, ignoreNewlineAtEof: true, stripTrailingCr: true })
  if (!parts) return { rows: [], added: 0, removed: 0, tooLarge: true }

  // 1. 展开成行，相邻的删除 + 新增合并成一段行内对比
  const raw: DiffRow[] = []
  let added = 0
  let removed = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part.added && !part.removed) {
      for (const line of splitLines(part.value)) raw.push({ type: 'same', text: line })
      continue
    }
    const next = parts[i + 1]
    if (part.removed && next?.added) {
      removed += part.count
      added += next.count
      const del = part.value.replace(/\n$/, '')
      const ins = next.value.replace(/\n$/, '')
      const segments = del.length + ins.length <= inlineLimit ? diffInline(del, ins, timeout) : null
      if (segments) {
        raw.push({ type: 'edit', segments })
      } else {
        for (const line of splitLines(part.value)) raw.push({ type: 'del', text: line })
        for (const line of splitLines(next.value)) raw.push({ type: 'ins', text: line })
      }
      i++
      continue
    }
    if (part.added) added += part.count
    else removed += part.count
    for (const line of splitLines(part.value)) raw.push({ type: part.added ? 'ins' : 'del', text: line })
  }

  // 2. 折叠离改动较远的未改动行
  const near = raw.map(() => false)
  raw.forEach((row, i) => {
    if (row.type === 'same') return
    for (let k = Math.max(0, i - context); k <= Math.min(raw.length - 1, i + context); k++) near[k] = true
  })
  const rows: DiffRow[] = []
  let hidden: string[] = []
  const flush = () => {
    if (hidden.length === 0) return
    // 只藏一行时直接显示，省得多点一次
    if (hidden.length === 1) rows.push({ type: 'same', text: hidden[0] })
    else rows.push({ type: 'skip', lines: hidden })
    hidden = []
  }
  raw.forEach((row, i) => {
    if (row.type === 'same' && !near[i]) {
      hidden.push(row.text)
      return
    }
    flush()
    rows.push(row)
  })
  flush()
  return { rows, added, removed, tooLarge: false }
}
