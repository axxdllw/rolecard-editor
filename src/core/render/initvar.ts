/**
 * MVU 的初始变量：世界书里注释带 [initvar] 的条目（通常是禁用状态），内容是 YAML 或 JSON。
 * 多个条目按顺序深度合并，作为预览里 stat_data 的默认值。
 *
 * 读取方式对照 MagVarUpdate 的 loadInitVarData / parseString：
 * - 条目内容可以包在 <initvar>…</initvar> 或 ``` 代码块里，只解析里面的部分；
 * - 以 { 或 [ 开头按 JSON 读（MVU 还会用 JSON5、jsonrepair 修复），否则按 YAML 读；
 * - YAML 有语法错误时 MVU 不报错，而是用解析器尽量读出的部分。
 */
import { parseDocument, type YAMLError } from 'yaml'
import type { Lorebook } from '../card/types'

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type JsonRecord = { [key: string]: JsonValue }

export interface InitVarResult {
  data: JsonRecord
  /** 参与合并的条目名 */
  sources: string[]
  errors: string[]
}

export interface InitvarIssue {
  /** 在条目原文中的行、列（从 1 开始；0 表示位置未知） */
  line: number
  col: number
  /** 问题跨多行时的结束行 */
  endLine?: number
  message: string
}

export interface InitvarEntryReport {
  title: string
  enabled: boolean
  /** 条目原文 */
  content: string
  /** 实际解析的文本（去掉 <initvar> 标签和代码块围栏） */
  body: string
  /** body 第一行在原文里的行号（从 1 开始） */
  bodyLine: number
  format: 'yaml' | 'json'
  /** 解析结果；YAML 有错误时是解析器尽量读出的部分 */
  data: JsonRecord | null
  errors: InitvarIssue[]
  /** 不影响读取但值得注意的问题（如 JSON 不标准，MVU 会自动修复） */
  warnings: InitvarIssue[]
}

function isRecord(v: unknown): v is JsonRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMerge(target: JsonRecord, source: JsonRecord): JsonRecord {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key]
    target[key] = isRecord(current) && isRecord(value) ? deepMerge({ ...current }, value) : value
  }
  return target
}

/** 偏移量换算成行、列（从 1 开始） */
function lineCol(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  return { line, col: offset - (before.lastIndexOf('\n') + 1) + 1 }
}

/**
 * 严格按 JSON 语法检查，返回第一个错误的位置和原因（浏览器的 JSON.parse 报错不一定带位置）。
 * 没有错误时返回 null。
 */
export function findJsonError(text: string): { offset: number; message: string } | null {
  let i = 0
  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
  class JsonSyntaxError {
    offset: number
    message: string
    constructor(offset: number, message: string) {
      this.offset = offset
      this.message = message
    }
  }
  const fail = (message: string, at = i): never => {
    throw new JsonSyntaxError(at, message)
  }
  const space = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++
  }
  const string = () => {
    const start = i++
    while (i < text.length) {
      const c = text[i]
      if (c === '"') {
        i++
        return
      }
      if (c === '\\') {
        const next = text[i + 1]
        if (next === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail('\\u 后面要跟 4 位十六进制数')
          i += 6
          continue
        }
        if (next === undefined || !'"\\/bfnrt'.includes(next)) fail('无效的转义字符')
        i += 2
        continue
      }
      if (c < ' ') fail('字符串里不能直接换行或包含控制字符（换行要写成 \\n）')
      i++
    }
    fail('字符串没有结束，缺少右引号', start)
  }
  const container = (close: '}' | ']') => {
    const isObject = close === '}'
    const name = isObject ? '对象' : '数组'
    i++
    space()
    if (text[i] === close) {
      i++
      return
    }
    for (;;) {
      space()
      if (isObject) {
        if (text[i] === '"') string()
        else if (text[i] === close) fail('最后一项后面多了逗号')
        else if (i >= text.length) fail(`${name}没有结束，缺少 ${close}`)
        else fail('属性名要用双引号括起来')
        space()
        if (text[i] !== ':') fail('属性名后面缺少冒号')
        i++
      } else if (text[i] === close) {
        fail('最后一项后面多了逗号')
      }
      value()
      space()
      if (text[i] === ',') {
        i++
        continue
      }
      if (text[i] === close) {
        i++
        return
      }
      fail(i >= text.length ? `${name}没有结束，缺少 ${close}` : `缺少逗号或 ${close}`)
    }
  }
  const value = (): void => {
    space()
    const c = text[i]
    if (c === '{') return container('}')
    if (c === '[') return container(']')
    if (c === '"') return string()
    if (c === '-' || (c >= '0' && c <= '9')) {
      NUMBER.lastIndex = i
      const match = NUMBER.exec(text)
      if (!match) fail('数字格式错误')
      i += match![0].length
      return
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, i)) {
        i += literal.length
        return
      }
    }
    if (c === undefined) fail('内容不完整，这里缺少值')
    if (c === "'") fail('字符串要用双引号')
    if (c === ',' || c === '}' || c === ']') fail('这里缺少值')
    fail(`无法识别的值（以「${c}」开头）`)
  }
  try {
    value()
    space()
    if (i < text.length) fail('后面有多余的内容')
    return null
  } catch (error) {
    if (error instanceof JsonSyntaxError) return { offset: error.offset, message: error.message }
    throw error
  }
}

/** 常见 YAML 错误码的中文说明 */
const YAML_HINTS: Record<string, string> = {
  BAD_INDENT: '缩进不对',
  TAB_AS_INDENT: '不能用 Tab 缩进',
  DUPLICATE_KEY: '键重复',
  MISSING_CHAR: '缺少字符（如引号、括号没有闭合）',
  MULTILINE_IMPLICIT_KEY: '键不能跨行（可能冒号后缺空格或缩进不对）',
  BLOCK_AS_IMPLICIT_KEY: '键的写法不对',
  UNEXPECTED_TOKEN: '出现了意外的符号',
  BAD_SCALAR_START: '值不能以这个字符开头（可以加引号）',
  BAD_DQ_ESCAPE: '双引号字符串里的转义无效',
  BAD_ALIAS: '别名（*）无效',
  KEY_OVER_1024_CHARS: '键太长',
}

function yamlIssue(error: YAMLError, lineOffset: number): InitvarIssue {
  const [pos, end] = error.linePos ?? []
  const message = error.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '')
  const hint = YAML_HINTS[error.code]
  return {
    line: pos ? pos.line + lineOffset : 0,
    col: pos?.col ?? 0,
    ...(pos && end && end.line > pos.line ? { endLine: end.line + lineOffset } : {}),
    message: hint ? `${hint}：${message}` : message,
  }
}

/** 去掉 <initvar> 标签和代码块围栏（MVU 的做法） */
function extractBody(content: string): string {
  let body = content
  const xml = body.trim().match(/.*<initvar>.*\n([\s\S]*)\n.*<\/initvar>.*/m)
  if (xml) body = xml[1]
  const codeblock = body.trim().match(/```.*\n([\s\S]*)\n```/m)
  if (codeblock) body = codeblock[1]
  return body
}

function inspectEntry(title: string, enabled: boolean, content: string): InitvarEntryReport {
  const body = extractBody(content)
  const at = content.indexOf(body)
  const bodyLine = at > 0 ? content.slice(0, at).split('\n').length : 1
  const offset = bodyLine - 1
  const format = /^[[{]/.test(body.trimStart()) ? 'json' : 'yaml'
  const report: InitvarEntryReport = { title, enabled, content, body, bodyLine, format, data: null, errors: [], warnings: [] }
  const readYaml = () => {
    const doc = parseDocument(body, { merge: true })
    let data: unknown = null
    try {
      data = doc.toJS()
    } catch (error) {
      return { data: null, errors: [{ line: 0, col: 0, message: error instanceof Error ? error.message : String(error) }], warnings: [] }
    }
    return { data, errors: doc.errors.map((e) => yamlIssue(e, offset)), warnings: doc.warnings.map((e) => yamlIssue(e, offset)) }
  }

  let data: unknown = null
  if (format === 'json') {
    const jsonError = findJsonError(body)
    if (!jsonError) {
      data = JSON.parse(body)
    } else {
      const pos = lineCol(body, jsonError.offset)
      const issue = { line: pos.line + offset, col: pos.col, message: jsonError.message }
      const yaml = readYaml()
      if (!yaml.errors.length && isRecord(yaml.data)) {
        // YAML 能读的写法（如单引号、末尾逗号），MVU 的 JSON5 / jsonrepair 一般也能修好
        report.warnings.push({ ...issue, message: `不是标准 JSON（${issue.message}），MVU 会尝试自动修复后读取` })
        data = yaml.data
      } else {
        report.errors.push(issue)
      }
    }
  } else {
    const yaml = readYaml()
    report.errors.push(...yaml.errors)
    report.warnings.push(...yaml.warnings)
    data = yaml.data
  }
  if (isRecord(data)) report.data = data
  else if (!report.errors.length && body.trim()) report.errors.push({ line: 0, col: 0, message: '内容不是键值结构' })
  return report
}

/** 逐条检查世界书里的 [initvar] 条目（启用和禁用的都算，MVU 都会读取） */
export function inspectInitvar(book: Lorebook | undefined): InitvarEntryReport[] {
  const result: InitvarEntryReport[] = []
  for (const entry of book?.entries ?? []) {
    const title = typeof entry.comment === 'string' ? entry.comment : ''
    if (!/\[initvar\]/i.test(title)) continue
    result.push(inspectEntry(title, entry.enabled !== false, typeof entry.content === 'string' ? entry.content : ''))
  }
  return result
}

export function initVariablesFromBook(book: Lorebook | undefined): InitVarResult {
  const result: InitVarResult = { data: {}, sources: [], errors: [] }
  for (const report of inspectInitvar(book)) {
    if (!report.body.trim()) continue
    const error = report.errors[0]
    if (error || !report.data) {
      const where = error?.line ? `（第 ${error.line} 行）` : ''
      result.errors.push(`「${report.title}」解析失败${where}：${error?.message ?? '内容不是键值结构'}`)
      continue
    }
    deepMerge(result.data, report.data)
    result.sources.push(report.title)
  }
  return result
}
