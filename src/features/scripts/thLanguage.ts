/**
 * 酒馆助手脚本的编辑器扩展：JavaScript 语法、酒馆助手接口自动补全、语法错误提示。
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript'
import { syntaxTree } from '@codemirror/language'
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint'
import type { Extension } from '@codemirror/state'
import { API_NAMES } from '@/features/render/hostFrame'
import { TH_FUNCTIONS, TH_OBJECTS, type ThApiDoc } from './thApi'

/** 脚本 iframe 里能直接用的全局对象（对照酒馆助手 predefine.js 和脚本模板） */
const GLOBALS: ThApiDoc[] = [
  { name: 'TavernHelper', signature: 'TavernHelper', doc: '酒馆助手接口集合；里面的函数在脚本里也可以直接调用' },
  { name: 'SillyTavern', signature: 'SillyTavern', doc: '酒馆的 getContext() 接口' },
  { name: 'Mvu', signature: 'Mvu', doc: 'MVU 变量框架的接口，使用前先 await waitGlobalInitialized(\'Mvu\')' },
  { name: 'EjsTemplate', signature: 'EjsTemplate', doc: '提示词模板语法插件的接口，需要另外安装该插件' },
  { name: 'tavern_events', signature: 'tavern_events', doc: '酒馆事件名，配合 eventOn 使用' },
  { name: 'iframe_events', signature: 'iframe_events', doc: '酒馆助手自己的事件名，配合 eventOn 使用' },
  { name: '_', signature: '_', doc: 'lodash' },
  { name: '$', signature: '$', doc: 'jQuery（操作的是脚本自己的 iframe，酒馆页面用 $(window.parent.document)）' },
  { name: 'toastr', signature: 'toastr', doc: '右上角弹出提示：toastr.success / info / warning / error' },
  { name: 'YAML', signature: 'YAML', doc: 'yaml 库：YAML.parse / YAML.stringify' },
  { name: 'z', signature: 'z', doc: 'zod 库，常用来定义 MVU 变量结构' },
  { name: 'showdown', signature: 'showdown', doc: 'Markdown 转 HTML' },
  { name: 'Vue', signature: 'Vue', doc: 'Vue 3' },
  { name: 'VueRouter', signature: 'VueRouter', doc: 'Vue Router' },
]

function renderInfo(doc: ThApiDoc): () => Node {
  return () => {
    const root = document.createElement('div')
    const sig = document.createElement('code')
    sig.textContent = doc.signature
    sig.style.cssText = 'display:block;font-family:ui-monospace,monospace;font-size:12px;margin-bottom:4px;white-space:pre-wrap;word-break:break-all'
    root.appendChild(sig)
    if (doc.doc) {
      const text = document.createElement('div')
      text.textContent = doc.doc
      text.style.cssText = 'font-size:12px;white-space:pre-wrap'
      root.appendChild(text)
    }
    return root
  }
}

/** 签名里括号之后的部分，显示在补全项右侧 */
function shortDetail(doc: ThApiDoc): string {
  const i = doc.signature.indexOf('(')
  const colon = doc.signature.indexOf(':')
  if (i >= 0 && (colon < 0 || i < colon)) {
    const params = doc.signature.slice(i)
    return params.length > 48 ? `${params.slice(0, 47)}…` : params
  }
  const type = colon >= 0 ? doc.signature.slice(colon + 1).trim() : ''
  return type.length > 40 ? `${type.slice(0, 39)}…` : type
}

function toCompletion(doc: ThApiDoc, type: string, boost = 0): Completion {
  return { label: doc.name, type, detail: shortDetail(doc), info: renderInfo(doc), boost }
}

const functionDocs: ThApiDoc[] = (() => {
  const known = new Set(TH_FUNCTIONS.map((f) => f.name))
  // 预览模拟环境里登记的接口名，类型文件里没有的也补上
  const extra = API_NAMES.filter((n) => !known.has(n)).map((name) => ({ name, signature: `${name}(…)`, doc: '酒馆助手接口' }))
  return [...TH_FUNCTIONS, ...extra]
})()

const globalOptions: Completion[] = [
  ...functionDocs.map((d) => toCompletion(d, 'function', 1)),
  ...GLOBALS.map((d) => toCompletion(d, 'namespace', 2)),
]

const memberOptions = new Map<string, Completion[]>([
  ['TavernHelper', functionDocs.map((d) => toCompletion(d, 'function'))],
  ...Object.entries(TH_OBJECTS).map(([key, list]) => [key, list.map((d) => toCompletion(d, d.signature.includes('(') ? 'method' : 'property'))] as [string, Completion[]]),
])

const SKIP_NODES = new Set(['String', 'TemplateString', 'LineComment', 'BlockComment', 'RegExp'])

/** 补全来源：全局函数/对象，以及 TavernHelper.、tavern_events.、Mvu. 等后面的成员 */
export function thCompletionSource(context: CompletionContext): CompletionResult | null {
  const node = syntaxTree(context.state).resolveInner(context.pos, -1)
  if (SKIP_NODES.has(node.name)) return null

  const member = context.matchBefore(/(?:[A-Za-z_$][\w$]*\.)+[\w$]*$/)
  if (member) {
    const dot = member.text.lastIndexOf('.')
    const path = member.text.slice(0, dot).replace(/^(?:window\.)?(?:parent\.)?/, '')
    const options = memberOptions.get(path)
    if (!options) return null
    return { from: member.from + dot + 1, options, validFor: /^[\w$]*$/ }
  }

  const word = context.matchBefore(/[A-Za-z_$][\w$]*$/)
  if (!word && !context.explicit) return null
  return { from: word?.from ?? context.pos, options: globalOptions, validFor: /^[\w$]*$/ }
}

/** 语法错误：取解析树里的错误节点（只检查已解析的部分，大文件不会卡） */
const syntaxLinter = linter(
  (view) => {
    const diagnostics: Diagnostic[] = []
    const length = view.state.doc.length
    syntaxTree(view.state).iterate({
      enter: (node) => {
        if (!node.type.isError || diagnostics.length >= 50) return
        const from = Math.min(node.from, length)
        diagnostics.push({ from, to: Math.min(Math.max(node.to, from + 1), length), severity: 'error', message: '语法错误' })
      },
    })
    return diagnostics
  },
  { delay: 800 },
)

/** 酒馆助手脚本编辑器的扩展 */
export const scriptExtensions: Extension[] = [
  javascript(),
  javascriptLanguage.data.of({ autocomplete: thCompletionSource }),
  syntaxLinter,
  lintGutter(),
]
