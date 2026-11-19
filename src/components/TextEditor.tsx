import { html } from '@codemirror/lang-html'
import { json } from '@codemirror/lang-json'
import { foldService } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import CodeMirror from '@uiw/react-codemirror'
import { Maximize2Icon } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

function highlighter(regexp: RegExp, className: string) {
  const matcher = new MatchDecorator({ regexp, decoration: Decoration.mark({ class: className }) })
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view)
      }
      update(update: ViewUpdate) {
        this.decorations = matcher.updateDeco(update, this.decorations)
      }
    },
    { decorations: (v) => v.decorations },
  )
}

/** {{char}}、{{user}} 等宏 */
const macroHighlight = highlighter(/\{\{[^{}\n]*\}\}/g, 'cm-macro')
/** 纯文本里的 XML 风格标签，如 <char>、</Glossary> */
const tagHighlight = highlighter(/<\/?[^\s<>!/][^<>\n]{0,80}>/g, 'cm-xmltag')

/** 只有一个开标签的行，折叠到对应的收标签 */
const xmlFold = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart)
  const m = /^\s*<([^/<>\s][^<>\s]*)[^<>]*>\s*$/.exec(line.text)
  if (!m) return null
  const close = `</${m[1]}>`
  const last = Math.min(state.doc.lines, line.number + 3000)
  for (let n = line.number + 1; n <= last; n++) {
    const l = state.doc.line(n)
    if (l.text.trim().startsWith(close)) {
      return l.from - 1 > line.to ? { from: line.to, to: l.from - 1 } : null
    }
  }
  return null
})

const baseTheme = EditorView.theme({
  '&': { fontSize: '14px', backgroundColor: 'transparent' },
  '.cm-content': { fontFamily: 'var(--font-sans)', padding: '6px 0' },
  '.cm-scroller': { fontFamily: 'var(--font-sans)', lineHeight: '1.65' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
  '.cm-macro': { color: 'var(--color-violet-600, #7c3aed)', backgroundColor: 'rgba(124,58,237,0.08)', borderRadius: '3px' },
  '.cm-xmltag': { color: 'var(--color-sky-700, #0369a1)' },
  '.cm-placeholder': { color: 'var(--muted-foreground)' },
})

const codeTheme = EditorView.theme({
  '.cm-content, .cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '13px' },
})

export type EditorLanguage = 'text' | 'html' | 'json'

export interface TextEditorProps {
  value: string
  onChange: (value: string) => void
  language?: EditorLanguage
  placeholder?: string
  minHeight?: number
  maxHeight?: number
  className?: string
  /** 全屏编辑对话框的标题；提供时显示全屏按钮 */
  fullscreenTitle?: string
  readOnly?: boolean
}

function useExtensions(language: EditorLanguage): Extension[] {
  return useMemo(() => {
    const list: Extension[] = [EditorView.lineWrapping, baseTheme, macroHighlight]
    if (language === 'text') list.push(tagHighlight, xmlFold)
    if (language === 'html') list.push(html(), codeTheme)
    if (language === 'json') list.push(json(), codeTheme)
    return list
  }, [language])
}

const SETUP = {
  lineNumbers: false,
  foldGutter: true,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  history: false,
  autocompletion: false,
  bracketMatching: false,
  closeBrackets: false,
  indentOnInput: false,
  crosshairCursor: false,
  dropCursor: true,
  searchKeymap: true,
  tabSize: 2,
}

function Editor({ value, onChange, language = 'text', placeholder, minHeight = 80, maxHeight, className, readOnly }: TextEditorProps) {
  const extensions = useExtensions(language)
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      basicSetup={SETUP}
      placeholder={placeholder}
      readOnly={readOnly}
      minHeight={`${minHeight}px`}
      maxHeight={maxHeight ? `${maxHeight}px` : undefined}
      className={cn(
        'overflow-hidden rounded-lg border border-input px-1 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
        className,
      )}
    />
  )
}

/** 文本编辑器：宏高亮、XML 标签折叠、可选全屏 */
export const TextEditor = memo(function TextEditor(props: TextEditorProps) {
  const [full, setFull] = useState(false)
  return (
    <div className="relative">
      <Editor {...props} />
      {props.fullscreenTitle && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute right-1.5 bottom-1.5 z-10 opacity-60 hover:opacity-100"
          aria-label="全屏编辑"
          onClick={() => setFull(true)}
        >
          <Maximize2Icon />
        </Button>
      )}
      {props.fullscreenTitle && (
        <Dialog open={full} onOpenChange={setFull}>
          <DialogContent className="flex h-[90svh] max-w-[min(64rem,calc(100%-2rem))] flex-col sm:max-w-[min(64rem,calc(100%-2rem))]">
            <DialogHeader>
              <DialogTitle>{props.fullscreenTitle}</DialogTitle>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-auto">
              <Editor {...props} minHeight={400} maxHeight={undefined} className="min-h-full" />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
})
