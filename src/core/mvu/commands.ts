/**
 * MVU 的变量更新命令（对照 MagVarUpdate 的 update_variables.ts）。
 *
 * MVU 把 <JSONPatch> 里的操作翻译成内部命令：replace → set、delta → add、insert/add → insert、remove → delete、move → move，
 * 此时 reason 是 'json_patch'，full_match 是这条操作的 JSON；旧式 _.set(...) 等命令的 full_match 是原文。
 */
import { jsonPointer } from './diff'

export interface MvuCommand {
  type: string
  fullMatch: string
  args: string[]
  reason: string
}

export interface CommandView {
  /** JSONPatch 的 op（replace/delta/insert/remove/move），旧式命令显示为 _.set 等 */
  op: string
  /** JSON Pointer 形式的目标路径 */
  path: string
  /** move 的来源路径 */
  from?: string
  /** 写入的值或增量（原文） */
  value?: string
  /** 是否来自 <JSONPatch> */
  patch: boolean
}

/** 去掉首尾的引号、反引号、反斜杠和空格（MVU 的 trimQuotesAndBackslashes） */
function trimQuotes(text: string): string {
  return text.replace(/^[\\"'` ]*(.*?)[\\"'` ]*$/s, '$1')
}

const PROP_NAME = /[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]/g

/** lodash 风格路径（a.b[0]、["a"]["b"]）拆成路径段，与 _.toPath 的常见情况一致 */
export function toPathSegments(path: string): string[] {
  const text = trimQuotes(path.trim()).replace(/^(?:stat_data|status_current_variables)\./, '')
  const segments: string[] = []
  for (const match of text.matchAll(PROP_NAME)) {
    if (match[1] !== undefined) segments.push(match[1])
    else if (match[2] !== undefined) segments.push(match[3].replace(/\\(\\)?/g, '$1'))
    else segments.push(match[0])
  }
  return segments
}

function literalKey(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'string' || typeof parsed === 'number' ? String(parsed) : text
  } catch {
    return trimQuotes(text)
  }
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** 解析 full_match 里的 JSONPatch 操作 */
function readPatchOp(fullMatch: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fullMatch)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as { op?: unknown }).op === 'string'
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** 整理成便于显示的形式 */
export function describeCommand(command: MvuCommand): CommandView {
  const op = command.reason === 'json_patch' ? readPatchOp(command.fullMatch) : null
  if (op) {
    return {
      op: String(op.op),
      path: typeof op.path === 'string' ? op.path : '',
      ...(typeof op.from === 'string' ? { from: op.from } : {}),
      ...('value' in op ? { value: stringify(op.value) } : {}),
      patch: true,
    }
  }
  const [first = '', second] = command.args
  const pointer = (text: string) => jsonPointer(toPathSegments(text))
  switch (command.type) {
    case 'move':
      return { op: '_.move', from: pointer(first), path: pointer(second ?? ''), patch: false }
    case 'insert':
      return command.args.length >= 3
        ? { op: '_.insert', path: jsonPointer([...toPathSegments(first), literalKey(second!)]), value: command.args.at(-1), patch: false }
        : { op: '_.insert', path: pointer(first), value: second, patch: false }
    default:
      return {
        op: `_.${command.type}`,
        path: pointer(first),
        ...(command.args.length >= 2 ? { value: command.args.at(-1) } : {}),
        patch: false,
      }
  }
}
