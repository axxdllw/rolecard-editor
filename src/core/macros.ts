/**
 * 宏替换（只处理预览和测试需要的常用宏，其余宏原样保留）。
 */

export interface MacroContext {
  char: string
  user: string
}

export const DEFAULT_MACRO_CONTEXT: MacroContext = { char: '角色', user: '用户' }

const MACRO_PATTERN = /\{\{(char|user)\}\}|<(USER|BOT|CHAR)>/gi

export function substituteMacros(text: string, ctx: MacroContext): string {
  return text.replace(MACRO_PATTERN, (_match, braced: string | undefined, angled: string | undefined) => {
    const name = (braced ?? angled ?? '').toLowerCase()
    return name === 'user' ? ctx.user : ctx.char
  })
}

/**
 * {{outlet::锚点名}}：酒馆 1.16 的世界书锚点宏，展开为该锚点下本轮激活的条目内容。
 * 对照 ST：宏名不区分大小写，锚点名两端的空白会去掉，锚点名本身区分大小写。
 * 预览不替换它（预设不在卡里），只用来识别和高亮。
 */
export const OUTLET_MACRO_PATTERN = /\{\{outlet::([^{}\n]+?)\}\}/gi

/** 文本里引用的锚点名（去掉两端空白、去重，按出现顺序） */
export function findOutletRefs(text: string): string[] {
  const names = new Set<string>()
  for (const m of text.matchAll(OUTLET_MACRO_PATTERN)) {
    const name = m[1].trim()
    if (name) names.add(name)
  }
  return [...names]
}

/** 匹配所有 {{...}} 形式的宏，供编辑器高亮使用 */
export const ANY_MACRO_PATTERN = /\{\{[^{}\n]*\}\}/g
