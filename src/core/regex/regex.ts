/**
 * ST 正则脚本（data.extensions.regex_scripts）。
 * 执行逻辑对照 ST 的 runRegexScript / regexFromString，
 * 在浏览器里用同一个 JS 正则引擎运行，测试结果与 ST 一致。
 */
import { CardParseError } from '../card/io'
import { substituteMacros, type MacroContext } from '../macros'
import { uuid } from '../util/id'

export interface RegexScript {
  id: string
  scriptName: string
  findRegex: string
  replaceString: string
  trimStrings: string[]
  /** 1 用户输入，2 AI 输出，3 快捷命令，5 世界书，6 推理 */
  placement: number[]
  disabled: boolean
  markdownOnly: boolean
  promptOnly: boolean
  runOnEdit: boolean
  /** 0 不替换宏，1 原样替换，2 转义后替换 */
  substituteRegex: number | boolean
  minDepth: number | null
  maxDepth: number | null
  [key: string]: unknown
}

export const PLACEMENT_OPTIONS = [
  { value: 1, label: '用户输入' },
  { value: 2, label: 'AI 输出' },
  { value: 3, label: '快捷命令' },
  { value: 5, label: '世界书' },
  { value: 6, label: '推理' },
]

export const SUBSTITUTE_OPTIONS = [
  { value: 0, label: '不替换' },
  { value: 1, label: '原样替换' },
  { value: 2, label: '转义后替换' },
]

export function createRegexScript(name = '新正则'): RegexScript {
  return {
    id: uuid(),
    scriptName: name,
    findRegex: '',
    replaceString: '',
    trimStrings: [],
    placement: [2],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
  }
}

/** 解析 "/pattern/flags" 形式的字符串；不带斜杠时整个字符串作为 pattern */
export function regexFromString(input: string): RegExp | null {
  try {
    const m = input.match(/(\/?)(.+)\1([a-z]*)/i)
    if (!m) return null
    if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) {
      return new RegExp(input)
    }
    return new RegExp(m[2], m[3])
  } catch {
    return null
  }
}

/** 检查查找正则是否有效，返回错误信息 */
export function validateFindRegex(input: string): string | null {
  if (!input) return '查找正则为空'
  const m = input.match(/(\/?)(.+)\1([a-z]*)/i)
  if (!m) return '格式不正确'
  try {
    new RegExp(m[2], m[3])
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function resolveFindRegex(script: RegexScript, ctx: MacroContext): RegExp | null {
  const mode = Number(script.substituteRegex)
  let source = script.findRegex
  if (mode === 1) {
    source = substituteMacros(source, ctx)
  } else if (mode === 2) {
    source = substituteMacros(source, { char: escapeRegex(ctx.char), user: escapeRegex(ctx.user) })
  }
  return regexFromString(source)
}

function filterString(text: string, trimStrings: string[], ctx: MacroContext): string {
  let out = text
  for (const trim of trimStrings) {
    const sub = substituteMacros(trim, ctx)
    if (sub) out = out.replaceAll(sub, '')
  }
  return out
}

/** 按 ST 的规则执行一条正则脚本 */
export function runRegexScript(script: RegexScript, text: string, ctx: MacroContext): string {
  if (!script || script.disabled || !script.findRegex || !text) return text
  const findRegex = resolveFindRegex(script, ctx)
  if (!findRegex) return text

  return text.replace(findRegex, (...args: unknown[]) => {
    const replaceString = String(script.replaceString ?? '').replace(/{{match}}/gi, '$0')
    const withGroups = replaceString.replaceAll(
      /\$(\d+)|\$<([^>]+)>/g,
      (_m: string, num: string | undefined, groupName: string | undefined) => {
        let value: unknown
        if (num) {
          value = args[Number(num)]
        } else if (groupName) {
          const groups = args[args.length - 1]
          value = groups && typeof groups === 'object' ? (groups as Record<string, unknown>)[groupName] : undefined
        }
        if (typeof value !== 'string' || !value) return ''
        return filterString(value, script.trimStrings ?? [], ctx)
      },
    )
    return substituteMacros(withGroups, ctx)
  })
}

/** 列出命中位置，用于测试面板高亮 */
export function findRegexMatches(
  script: RegexScript,
  text: string,
  ctx: MacroContext,
): Array<{ start: number; end: number }> {
  const regex = resolveFindRegex(script, ctx)
  if (!regex || !text) return []
  const global = regex.global ? regex : new RegExp(regex.source, regex.flags + 'g')
  const out: Array<{ start: number; end: number }> = []
  for (const m of text.matchAll(global)) {
    if (m.index === undefined) continue
    out.push({ start: m.index, end: m.index + m[0].length })
    if (!regex.global) break
  }
  return out
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 补全缺失字段，未知字段保留 */
export function normalizeRegexScript(raw: Record<string, unknown>): RegexScript {
  const base = createRegexScript(typeof raw.scriptName === 'string' ? raw.scriptName : '未命名正则')
  const merged = { ...base, ...raw } as RegexScript
  if (typeof raw.id !== 'string' || !raw.id) merged.id = base.id
  if (!Array.isArray(merged.trimStrings)) merged.trimStrings = []
  if (!Array.isArray(merged.placement)) merged.placement = []
  return merged
}

/** 解析 ST 导出的正则 JSON（单个脚本对象或脚本数组） */
export function parseRegexJson(text: string): RegexScript[] {
  let json: unknown
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (error) {
    throw new CardParseError(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const list = Array.isArray(json) ? json : [json]
  const scripts = list.filter(isObject).filter((s) => typeof s.findRegex === 'string')
  if (scripts.length === 0) {
    throw new CardParseError('没有找到正则脚本（需要包含 findRegex 字段）')
  }
  return scripts.map(normalizeRegexScript)
}

/** 读取卡里的正则脚本列表 */
export function getRegexScripts(extensions: Record<string, unknown>): RegexScript[] {
  const list = extensions.regex_scripts
  return Array.isArray(list) ? (list.filter(isObject) as RegexScript[]) : []
}
