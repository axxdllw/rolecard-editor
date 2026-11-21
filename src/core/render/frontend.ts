/**
 * 酒馆助手的“前端代码块”规则（对照酒馆助手 4.7 的 is_frontend 和 iframe 模板）。
 */

/** 代码块文本里出现 html>、<head>、<body 之一，就当成前端界面渲染 */
export function isFrontend(content: string): boolean {
  return ['html>', '<head>', '<body'].some((tag) => content.includes(tag))
}

const VIEWPORT_VAR = 'var(--TH-viewport-height)'

function vhToViewportVar(value: string): string {
  return value.replace(/(\d+(?:\.\d+)?)vh\b/gi, (match, num: string) => {
    const n = parseFloat(num)
    if (!Number.isFinite(n)) return match
    return n === 100 ? VIEWPORT_VAR : `calc(${VIEWPORT_VAR} * ${n / 100})`
  })
}

/**
 * iframe 会随内容自动撑高，min-height 用 vh 会越撑越高。
 * 与酒馆助手一样，把 CSS、行内样式和脚本里 min-height 的 vh 换成预览区高度变量。
 */
export function replaceVhInContent(content: string): string {
  const hasCss = /min-height\s*:\s*[^;{}]*\d+(?:\.\d+)?vh/i.test(content)
  const hasJs =
    /\.style\.minHeight\s*=\s*(["'])[\s\S]*?vh\1/i.test(content) ||
    /setProperty\s*\(\s*(["'])min-height\1\s*,\s*(["'])[\s\S]*?vh\2\s*\)/i.test(content)
  if (!hasCss && !hasJs) return content

  let out = content.replace(/(min-height\s*:\s*)([^;{}]*?\d+(?:\.\d+)?vh)(?=\s*[;}])/gi, (_m, prefix: string, value: string) => prefix + vhToViewportVar(value))
  out = out.replace(/(style\s*=\s*(["']))([^"']*?)(\2)/gi, (match, prefix: string, _q: string, style: string, suffix: string) => {
    if (!/min-height\s*:\s*[^;]*vh/i.test(style)) return match
    return prefix + style.replace(/(min-height\s*:\s*)([^;]*?\d+(?:\.\d+)?vh)/gi, (_m, p: string, v: string) => p + vhToViewportVar(v)) + suffix
  })
  out = out.replace(/(\.style\.minHeight\s*=\s*(["']))([\s\S]*?)(\2)/gi, (match, prefix: string, _q: string, value: string, suffix: string) =>
    /\b\d+(?:\.\d+)?vh\b/i.test(value) ? prefix + vhToViewportVar(value) + suffix : match,
  )
  out = out.replace(
    /(setProperty\s*\(\s*(["'])min-height\2\s*,\s*(["']))([\s\S]*?)(\3\s*\))/gi,
    (match, prefix: string, _q1: string, _q2: string, value: string, suffix: string) =>
      /\b\d+(?:\.\d+)?vh\b/i.test(value) ? prefix + vhToViewportVar(value) + suffix : match,
  )
  return out
}
