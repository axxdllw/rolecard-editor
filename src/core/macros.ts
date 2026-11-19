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

/** 匹配所有 {{...}} 形式的宏，供编辑器高亮使用 */
export const ANY_MACRO_PATTERN = /\{\{[^{}\n]*\}\}/g
