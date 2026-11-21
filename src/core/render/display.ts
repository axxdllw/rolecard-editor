/**
 * 消息显示前的文本处理，对照酒馆 1.16 的 messageFormatting 和 getRegexedString。
 * 这里只放纯字符串处理；Markdown 转换和 HTML 净化依赖浏览器，在 features/render 里。
 */
import { substituteMacros, type MacroContext } from '../macros'
import { runRegexScript, type RegexScript } from '../regex/regex'

export const REGEX_PLACEMENT = { USER_INPUT: 1, AI_OUTPUT: 2 } as const

/**
 * receive：消息收到（或开场白载入）时运行，只跑两个“仅”都没勾的脚本，结果会存进聊天记录；
 * display：显示时运行，只跑“仅格式显示”的脚本。
 */
export type RegexStage = 'receive' | 'display'

export interface RegexRunOptions {
  placement: number
  stage: RegexStage
  /** 消息深度：最后一条是 0 */
  depth?: number
  ctx: MacroContext
}

function depthValue(v: unknown): number {
  if (v === null || v === undefined || v === '') return NaN
  return Number(v)
}

/** 按酒馆的规则挑出适用的正则并依次运行 */
export function applyRegexScripts(text: string, scripts: RegexScript[], opts: RegexRunOptions): string {
  let out = text
  for (const script of scripts) {
    const markdownOnly = !!script.markdownOnly
    const promptOnly = !!script.promptOnly
    const applies = opts.stage === 'display' ? markdownOnly : !markdownOnly && !promptOnly
    if (!applies) continue
    if (typeof opts.depth === 'number') {
      const min = depthValue(script.minDepth)
      const max = depthValue(script.maxDepth)
      if (!Number.isNaN(min) && min >= -1 && opts.depth < min) continue
      if (!Number.isNaN(max) && max >= 0 && opts.depth > max) continue
    }
    if (!Array.isArray(script.placement) || !script.placement.includes(opts.placement)) continue
    out = runRegexScript(script, out, opts.ctx)
  }
  return out
}

const QUOTE_PATTERN =
  /<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(“.*?”)|(«.*?»)|(「.*?」)|(『.*?』)|(＂.*?＂)/gim

/** 临时替换标签里双引号的占位字符（与酒馆相同，U+FFFE） */
const TAG_QUOTE = String.fromCharCode(0xfffe)

/** 把各种引号里的内容包进 <q>，跳过 <style> 和代码；HTML 标签里的双引号不受影响 */
export function wrapQuotes(text: string): string {
  const guarded = text.replace(/<([^>]+)>/g, (_m, contents: string) => `<${contents.replaceAll('"', TAG_QUOTE)}>`)
  const wrapped = guarded.replace(QUOTE_PATTERN, (match, ...groups: Array<string | undefined>) => {
    const [p1, p2, p3, p4, p5, p6] = groups
    if (p1) return `<q>"${p1.slice(1, -1)}"</q>`
    if (p2) return `<q>“${p2.slice(1, -1)}”</q>`
    if (p3) return `<q>«${p3.slice(1, -1)}»</q>`
    if (p4) return `<q>「${p4.slice(1, -1)}」</q>`
    if (p5) return `<q>『${p5.slice(1, -1)}』</q>`
    if (p6) return `<q>＂${p6.slice(1, -1)}＂</q>`
    return match
  })
  return wrapped.replaceAll(TAG_QUOTE, '"')
}

export interface PrepareOptions {
  isUser: boolean
  depth: number
  scripts: RegexScript[]
  ctx: MacroContext
}

/**
 * 显示阶段、交给 Markdown 转换之前的处理：显示正则 → 引号。
 * 按酒馆助手推荐的酒馆设置渲染（也是你本机酒馆的设置）：
 * 不自动修复 Markdown（auto_fix_generated_markdown 关），不转义标签（encode_tags 关）。
 */
export function prepareForMarkdown(text: string, opts: PrepareOptions): string {
  let mes = applyRegexScripts(text, opts.scripts, {
    placement: opts.isUser ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT,
    stage: 'display',
    depth: opts.depth,
    ctx: opts.ctx,
  })
  mes = wrapQuotes(mes)
  return mes.replaceAll('\\begin{align*}', '$$').replaceAll('\\end{align*}', '$$')
}

/**
 * Markdown 转换之后：代码里的 &amp; 还原。
 * 行首的「角色名:」保留（酒馆助手推荐打开 allow_name2_display）。
 */
export function finishHtml(html: string): string {
  return html.trim().replace(/<code(.*)>[\s\S]*?<\/code>/g, (match) => match.replace(/&amp;/g, '&'))
}

export interface ChatMessageSource {
  name: string
  isUser: boolean
  /** 原始文本（开场白、用户输入或 AI 回复） */
  text: string
}

/** 模拟消息收到时的处理：替换宏，再跑“收到时”的正则；返回存进聊天记录的文本 */
export function receiveMessage(source: ChatMessageSource, scripts: RegexScript[], ctx: MacroContext): string {
  const text = substituteMacros(source.text, ctx)
  return applyRegexScripts(text, scripts, {
    placement: source.isUser ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT,
    stage: 'receive',
    ctx,
  })
}
