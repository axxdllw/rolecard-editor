/**
 * 消息格式化（浏览器端）：对照酒馆 1.16 的 messageFormatting。
 * 显示正则 → 引号 → showdown → DOMPurify（带酒馆的钩子）→ <style> 作用域，
 * 最后按酒馆助手的规则把前端代码块拆出来，交给 iframe 渲染。
 */
import createDOMPurify from 'dompurify'
import showdown from 'showdown'
import type { MacroContext } from '@/core/macros'
import { finishHtml, prepareForMarkdown } from '@/core/render/display'
import { isFrontend } from '@/core/render/frontend'
import type { RegexScript } from '@/core/regex/regex'

/** 酒馆的下划线斜体扩展：单个下划线包住的词转成 <em>，跳过 <code> 和 <style> */
const underscoreExt: showdown.ShowdownExtension = {
  type: 'output',
  regex: /(<code(?:\s+[^>]*)?>[\s\S]*?<\/code>|<style(?:\s+[^>]*)?>[\s\S]*?<\/style>)|\b(?<!_)_(?!_)(.*?)(?<!_)_(?!_)\b/gi,
  replace: (match: string, tagContent?: string, italic?: string) => (tagContent ? match : italic ? `<em>${italic}</em>` : match),
}

const converter = new showdown.Converter({
  emoji: true,
  literalMidWordUnderscores: true,
  parseImgDimensions: true,
  tables: true,
  underline: true,
  simpleLineBreaks: true,
  strikethrough: true,
  disableForced4SpacesIndentedSublists: true,
  extensions: [underscoreExt],
})

const purify = createDOMPurify(window)

// 链接在新标签页打开
purify.addHook('afterSanitizeAttributes', (node) => {
  if ('target' in node) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener')
  }
})

// class 统一加 custom- 前缀，防止卡片样式影响酒馆界面（fa-、note-、monospace 除外）
purify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName !== 'class' || !data.attrValue) return
  data.attrValue = data.attrValue
    .split(' ')
    .map((v) => (v.startsWith('fa-') || v.startsWith('note-') || v === 'monospace' ? v : `custom-${v}`))
    .join(' ')
})

// 未知标签里的换行转成 <br>（<pre> 里的除外）
purify.addHook('uponSanitizeElement', (node) => {
  if (!(node instanceof HTMLUnknownElement)) return
  node.innerHTML = node.innerHTML.trim()
  const candidates: Text[] = []
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const text = walker.currentNode as Text
    if (!text.data.includes('\n')) continue
    if (text.parentElement?.closest('pre')) continue
    candidates.push(text)
  }
  for (const text of candidates) {
    const frag = document.createDocumentFragment()
    const parts = text.data.split('\n')
    parts.forEach((part, i) => {
      if (part) frag.appendChild(document.createTextNode(part))
      if (i < parts.length - 1) frag.appendChild(document.createElement('br'))
    })
    text.replaceWith(frag)
  }
})

function encodeStyleTags(text: string): string {
  return text.replaceAll(/<style>(.+?)<\/style>/gims, (_m, css: string) => `<custom-style>${encodeURIComponent(css)}</custom-style>`)
}

/** 按顶层逗号拆分选择器列表（括号和引号里的逗号不拆） */
function splitSelectors(selectorText: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < selectorText.length; i++) {
    const ch = selectorText[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ',' && depth === 0) {
      out.push(selectorText.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(selectorText.slice(start).trim())
  return out.filter(Boolean)
}

function sanitizeSimpleSelector(selector: string): string {
  return selector
    .split(/\s+/)
    .map((part) => part.replace(/\.([\w-]+)/g, (match, name: string) => (name.startsWith('custom-') ? match : `.custom-${name}`)))
    .join(' ')
}

function sanitizeSelector(selector: string): string {
  const pseudo = /:(has|not|where|is|matches|any)\(([^)]+)\)/g
  return sanitizeSimpleSelector(selector.replace(pseudo, (_m, name: string, inner: string) => `:${name}(${sanitizeSimpleSelector(inner)})`))
}

function scopeRules(rules: CSSRuleList, prefix: string): string {
  const out: string[] = []
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSImportRule) continue
    if (rule instanceof CSSStyleRule) {
      const selectors = splitSelectors(rule.selectorText).map((s) => prefix + sanitizeSelector(s))
      out.push(`${selectors.join(', ')} { ${rule.style.cssText} }`)
    } else if (rule instanceof CSSGroupingRule) {
      const header = rule.cssText.slice(0, rule.cssText.indexOf('{')).trim()
      out.push(`${header} { ${scopeRules(rule.cssRules, prefix)} }`)
    } else {
      out.push(rule.cssText)
    }
  }
  return out.join('\n')
}

/** 酒馆的 decodeStyleTags：选择器加 .mes_text 前缀、class 改成 custom-，去掉 @import */
function decodeStyleTags(html: string, prefix = '.mes_text '): string {
  return html.replaceAll(/<custom-style>(.+?)<\/custom-style>/gms, (_m, encoded: string) => {
    try {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(decodeURIComponent(encoded).replaceAll(/<br\/>/g, ''))
      return `<style>${scopeRules(sheet.cssRules, prefix)}</style>`
    } catch (error) {
      return `CSS ERROR: ${error instanceof Error ? error.message : String(error)}`
    }
  })
}

export interface FormattedMessage {
  /** 消息正文 HTML；前端代码块的位置换成 <div class="TH-render" data-th-index="n"> */
  html: string
  /** 前端代码块的源码，按出现顺序 */
  frontends: string[]
}

export interface FormatOptions {
  name: string
  isUser: boolean
  depth: number
  scripts: RegexScript[]
  ctx: MacroContext
}

/** 把一条已“收到”的消息格式化成显示用的 HTML */
export function formatMessage(text: string, opts: FormatOptions): FormattedMessage {
  if (!text) return { html: '', frontends: [] }
  let mes = prepareForMarkdown(text, { isUser: opts.isUser, depth: opts.depth, scripts: opts.scripts, ctx: opts.ctx })
  mes = converter.makeHtml(mes)
  mes = finishHtml(mes)
  mes = encodeStyleTags(mes)
  mes = purify.sanitize(mes, { ADD_TAGS: ['custom-style'] })
  mes = decodeStyleTags(mes)

  const doc = new DOMParser().parseFromString(`<body>${mes}</body>`, 'text/html')
  const frontends: string[] = []
  for (const pre of Array.from(doc.querySelectorAll('pre'))) {
    if (!isFrontend(pre.textContent ?? '')) continue
    if (pre.parentElement?.closest('pre')) continue
    const code = pre.querySelector('code')
    const holder = doc.createElement('div')
    holder.className = 'TH-render'
    holder.dataset.thIndex = String(frontends.length)
    // 酒馆助手取的是 <code> 的文本；没有 <code> 时退而取 <pre> 的文本
    frontends.push((code ?? pre).textContent ?? '')
    pre.replaceWith(holder)
  }
  return { html: doc.body.innerHTML, frontends }
}
