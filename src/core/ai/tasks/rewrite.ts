/**
 * 字段改写：润色、扩写、精简、按要求修改，字段为空时直接撰写。
 * 只负责拼提示词和清理输出，调用由 client.ts 完成。
 */
import type { AiMessage } from '../types'

export type RewriteMode = 'polish' | 'expand' | 'condense' | 'custom' | 'write'

export const REWRITE_MODE_LABELS: Record<RewriteMode, string> = {
  polish: '润色',
  expand: '扩写',
  condense: '精简',
  custom: '按要求改',
  write: '撰写',
}

export interface RewriteContext {
  /** 角色名 */
  name: string
  /** 其他字段的内容（不含正在改的字段），按“字段名 → 内容”给出，用来保持设定一致 */
  fields: Array<{ label: string; text: string }>
}

export interface RewriteInput {
  mode: RewriteMode
  /** 用户的补充要求；custom 模式必填 */
  instruction?: string
  fieldLabel: string
  /** 字段在酒馆里的作用（字段说明） */
  fieldHint?: string
  text: string
  context?: RewriteContext
}

/** 每个参考字段最多带这么多字，避免上下文过长 */
const CONTEXT_FIELD_LIMIT = 4000

const SYSTEM_PROMPT = `你是 SillyTavern（酒馆）角色卡的写作助手，帮用户修改角色卡里的某一个字段。

规则：
1. 只输出修改后的字段全文，不要任何解释、标题、前言或结尾，不要用代码块包起来。
2. {{char}}、{{user}} 等双花括号宏原样保留，不要替换成名字，也不要改写法。
3. 保留原文的格式和结构：XML/HTML 标签、YAML 或 W++ 的键名、列表、空行风格都不要改。
4. 不和角色卡已有的设定矛盾；没有要求时不要新增与原文无关的设定。
5. 沿用原文的语言（原文是中文就写中文）；字段为空时用用户要求的语言，没有要求就写中文。`

const MODE_INSTRUCTIONS: Record<RewriteMode, string> = {
  polish: '润色：修正语病和错别字，让表达更流畅自然；保持原有信息、结构和篇幅基本不变。',
  expand: '扩写：在原有设定基础上补充细节（如外貌、性格表现、习惯、经历、说话方式），不改变已有设定；篇幅增加到原来的 1.5～2 倍。',
  condense: '精简：删去重复、冗余和空泛的描写，保留全部关键设定；篇幅缩短到原来的一半左右，以节省 token。',
  custom: '按用户的要求修改。',
  write: '这个字段目前是空的，请根据角色卡已有的信息为它写一段合适的内容。',
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n……（后面省略 ${text.length - limit} 字）` : text
}

export function buildRewriteRequest(input: RewriteInput): { system: string; messages: AiMessage[] } {
  const parts: string[] = []
  const context = input.context
  if (context) {
    const lines = [`角色名：${context.name || '（未命名）'}`]
    for (const f of context.fields) {
      if (f.text.trim()) lines.push(`<${f.label}>\n${truncate(f.text.trim(), CONTEXT_FIELD_LIMIT)}\n</${f.label}>`)
    }
    parts.push(`# 角色卡里的其他内容（仅供参考，不要输出）\n${lines.join('\n')}`)
  }
  parts.push(`# 要修改的字段：${input.fieldLabel}${input.fieldHint ? `\n字段作用：${input.fieldHint}` : ''}`)
  parts.push(input.text.trim() ? `# 字段原文\n<原文>\n${input.text}\n</原文>` : '# 字段原文\n（空）')
  const instruction = input.instruction?.trim()
  parts.push(`# 任务\n${MODE_INSTRUCTIONS[input.mode]}${instruction ? `\n用户的要求：${instruction}` : ''}`)
  parts.push('请直接输出修改后的字段全文。')
  return { system: SYSTEM_PROMPT, messages: [{ role: 'user', content: parts.join('\n\n') }] }
}

/** 换行符跟原文保持一致：原文用 \r\n 时输出也转成 \r\n，否则统一成 \n（模型一般只输出 \n） */
export function matchLineEndings(text: string, reference: string): string {
  return reference.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n')
}

/** 清理模型输出：去掉整段包裹的代码块和 <原文> 标签、首尾空行 */
export function cleanRewriteOutput(text: string): string {
  let out = text.trim()
  const fence = out.match(/^```[^\n]*\n([\s\S]*?)\n?```$/)
  if (fence) out = fence[1]
  const tagged = out.match(/^<原文>\n?([\s\S]*?)\n?<\/原文>$/)
  if (tagged) out = tagged[1]
  return out.replace(/^\n+|\n+$/g, '')
}
