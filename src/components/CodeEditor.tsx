/**
 * 代码编辑器（CodeMirror 6），给几十万字的脚本用：
 * - 直接管理 EditorView，外部值变化（撤销/重做）时只替换差异部分，光标和滚动位置不跳；
 * - 自己发出的值不再回写，避免每次渲染都把整篇文档转成字符串比较；
 * - 全屏只是给同一个编辑器换样式，不会再建一份文档。
 */
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Annotation, Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import { drawSelection, dropCursor, EditorView, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers, placeholder as placeholderExt } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { Maximize2Icon, Minimize2Icon } from 'lucide-react'
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** 标记外部同步进来的修改，不触发 onChange */
const External = Annotation.define<boolean>()

/** 中间色调，亮色和暗色背景下都看得清 */
const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: '#8b5cf6' },
  { tag: [t.string, t.special(t.string), t.character], color: '#16a34a' },
  { tag: [t.regexp, t.escape], color: '#e11d48' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#d97706' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--muted-foreground)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: '#0284c7' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: '#0891b2' },
  { tag: [t.typeName, t.className, t.namespace], color: '#0d9488' },
  { tag: [t.tagName, t.angleBracket], color: '#2563eb' },
  { tag: t.attributeName, color: '#c026d3' },
  { tag: t.invalid, color: '#dc2626' },
])

const theme = EditorView.theme({
  '&': { fontSize: '13px', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content, .cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--muted-foreground)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--muted) 45%, transparent)' },
  '.cm-placeholder': { color: 'var(--muted-foreground)' },
  '.cm-tooltip': { borderRadius: '6px', border: '1px solid var(--border)', backgroundColor: 'var(--popover)', color: 'var(--popover-foreground)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' },
  '.cm-completionInfo': { maxWidth: 'min(28rem, 80vw)', whiteSpace: 'pre-wrap', padding: '6px 8px' },
  '.cm-completionDetail': { marginLeft: '0.6em', opacity: 0.7, fontStyle: 'normal' },
  '.cm-panels': { backgroundColor: 'var(--muted)', color: 'var(--foreground)' },
  '.cm-searchMatch': { backgroundColor: 'rgba(250, 204, 21, 0.35)' },
  '.cm-searchMatch-selected': { backgroundColor: 'rgba(249, 115, 22, 0.45)' },
})

function baseExtensions(): Extension[] {
  return [
    lineNumbers(),
    foldGutter(),
    highlightSpecialChars(),
    drawSelection(),
    dropCursor(),
    highlightActiveLine(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    highlightSelectionMatches(),
    search({ top: true }),
    syntaxHighlighting(highlightStyle),
    EditorState.tabSize.of(2),
    EditorView.lineWrapping,
    theme,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
  ]
}

/** 两段文本的最小差异：去掉公共前缀和后缀 */
function diffRange(a: string, b: string) {
  const max = Math.min(a.length, b.length)
  let start = 0
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--
    endB--
  }
  return { from: start, to: endA, insert: b.slice(start, endB) }
}

export interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  /** 语言、补全等额外扩展；引用变化时重新配置 */
  extensions?: Extension[]
  placeholder?: string
  className?: string
  /** 全屏时的标题；提供时显示全屏按钮 */
  fullscreenTitle?: string
  /** 全屏标题栏右侧的额外内容 */
  fullscreenExtra?: ReactNode
}

export const CodeEditor = memo(function CodeEditor({ value, onChange, extensions, placeholder, className, fullscreenTitle, fullscreenExtra }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  /** 编辑器当前内容对应的值（自己发出的或已同步进来的） */
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const [compartments] = useState(() => ({ extra: new Compartment(), placeholder: new Compartment() }))
  const [full, setFull] = useState(false)
  const fullRef = useRef(full)

  useEffect(() => {
    onChangeRef.current = onChange
    fullRef.current = full
  })

  // 编辑器只创建一次；value、extensions、placeholder 的变化由下面的 effect 同步
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          baseExtensions(),
          compartments.extra.of([]),
          compartments.placeholder.of([]),
          Prec.lowest(
            keymap.of([
              {
                key: 'Escape',
                run: () => {
                  if (!fullRef.current) return false
                  setFull(false)
                  return true
                },
              },
            ]),
          ),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || update.transactions.some((tr) => tr.annotation(External))) return
            const text = update.state.doc.toString()
            valueRef.current = text
            onChangeRef.current(text)
          }),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [compartments])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.extra.reconfigure(extensions ?? []) })
  }, [extensions, compartments])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.placeholder.reconfigure(placeholder ? placeholderExt(placeholder) : []) })
  }, [placeholder, compartments])

  useEffect(() => {
    const view = viewRef.current
    if (!view || value === valueRef.current) return
    valueRef.current = value
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({ changes: diffRange(current, value), annotations: External.of(true) })
  }, [value])

  // 全屏时锁住页面滚动，退出后把焦点还给编辑器
  useEffect(() => {
    if (!full) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    viewRef.current?.focus()
    return () => {
      document.body.style.overflow = prev
      viewRef.current?.focus()
    }
  }, [full])

  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden rounded-lg border border-input focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
        full ? 'fixed inset-0 z-50 rounded-none border-0 bg-background focus-within:ring-0' : 'relative',
        className,
      )}
      role={full ? 'dialog' : undefined}
      aria-modal={full || undefined}
      aria-label={full ? fullscreenTitle : undefined}
    >
      {full && (
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{fullscreenTitle}</span>
          {fullscreenExtra}
          <Button variant="ghost" size="sm" onClick={() => setFull(false)}>
            <Minimize2Icon /> 退出全屏
          </Button>
        </div>
      )}
      <div
        ref={host}
        className={cn(
          'min-h-0 [&_.cm-editor]:h-full',
          full ? 'flex-1' : '[&_.cm-editor]:max-h-[min(65svh,720px)] [&_.cm-editor]:min-h-[220px]',
        )}
      />
      {fullscreenTitle && !full && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute right-1.5 bottom-1.5 z-10 bg-background/80 opacity-60 hover:opacity-100"
          aria-label="全屏编辑"
          onClick={() => setFull(true)}
        >
          <Maximize2Icon />
        </Button>
      )}
    </div>
  )
})
