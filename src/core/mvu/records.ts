/**
 * 预览宿主页发来的 MVU 记录（变量初始化、每轮变量更新、各楼层变量）。
 *
 * 宿主页里运行着卡片脚本，发来的内容不可信：这里逐项检查类型、限制长度，
 * 变量值本身保持原样（只用于比较和以纯文本显示）。
 */
import type { MvuCommand } from './commands'

export type CommandStatus = 'applied' | 'failed' | 'noop'

export interface MvuCommandRecord extends MvuCommand {
  status: CommandStatus
  /** 失败原因（MVU 或变量结构给出的原文） */
  error?: string
}

export interface MvuUpdateRecord {
  /** 被解析的楼层 */
  messageId: number
  /** 命令是否由变量结构（MVU zod）执行 */
  zod: boolean
  commands: MvuCommandRecord[]
  /** 更新前后的 stat_data */
  before: unknown
  after: unknown
  /** 没能对应到具体命令的报错 */
  errors: string[]
}

export interface ZodIssueRecord {
  path: string[]
  message: string
  /** 出错的输入值（JSON 文本） */
  input?: string
}

export interface MvuInitRecord {
  swipeId: number
  /** 是否有变量结构（zod）参与初始化 */
  zod: boolean
  /** MVU 从 [initvar] 读到的 stat_data（变量结构处理前） */
  before: unknown
  /** 变量结构处理后的 stat_data */
  after: unknown
  /** 变量结构的校验问题；校验失败时 MVU zod 不会套用默认值 */
  issues: ZodIssueRecord[]
  /** 校验本身出错（如 schema 里的函数抛错） */
  error?: string
}

export interface FloorRecord {
  messageId: number
  isUser: boolean
  /** 楼层变量（MVU 的数据在 stat_data 里） */
  variables: Record<string, unknown>
}

const MAX_TEXT = 4000
const MAX_ITEMS = 500

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, max = MAX_TEXT): string {
  const s = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function int(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isInteger(n) ? n : fallback
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, MAX_ITEMS) : []
}

const STATUSES = new Set<CommandStatus>(['applied', 'failed', 'noop'])

function readCommand(value: unknown): MvuCommandRecord | null {
  if (!isObject(value)) return null
  const status = STATUSES.has(value.status as CommandStatus) ? (value.status as CommandStatus) : 'noop'
  const error = text(value.error)
  return {
    type: text(value.type, 40),
    fullMatch: text(value.fullMatch),
    args: list(value.args).map((a) => text(a)),
    reason: text(value.reason, 200),
    status,
    ...(error ? { error } : {}),
  }
}

export function readMvuUpdate(value: unknown): MvuUpdateRecord | null {
  if (!isObject(value)) return null
  return {
    messageId: int(value.messageId),
    zod: value.zod === true,
    commands: list(value.commands)
      .map(readCommand)
      .filter((c): c is MvuCommandRecord => c !== null),
    before: value.before,
    after: value.after,
    errors: list(value.errors).map((e) => text(e)),
  }
}

export function readMvuInit(value: unknown): MvuInitRecord | null {
  if (!isObject(value)) return null
  const error = text(value.error)
  return {
    swipeId: int(value.swipeId),
    zod: value.zod === true,
    before: value.before,
    after: value.after,
    issues: list(value.issues)
      .filter(isObject)
      .map((i) => ({
        path: list(i.path).map((s) => text(s, 200)),
        message: text(i.message),
        ...(i.input !== undefined ? { input: text(i.input, 300) } : {}),
      })),
    ...(error ? { error } : {}),
  }
}

export function readFloors(value: unknown): FloorRecord[] {
  return list(value)
    .filter(isObject)
    .map((f) => ({ messageId: int(f.messageId, -1), isUser: f.isUser === true, variables: isObject(f.variables) ? f.variables : {} }))
    .filter((f) => f.messageId >= 0)
}

/** 楼层的 stat_data（没有 MVU 时就是整个变量） */
export function statData(variables: Record<string, unknown> | undefined): unknown {
  if (!variables) return undefined
  return 'stat_data' in variables ? variables.stat_data : variables
}
