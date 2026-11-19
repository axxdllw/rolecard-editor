import { CircleHelpIcon } from 'lucide-react'
import { useCallback, type ReactNode } from 'react'
import { TextEditor, type EditorLanguage } from '@/components/TextEditor'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Path } from '@/core/util/path'
import { formatTokens, useTokenCount } from '@/lib/tokens'
import { setCardPath, useCardPath } from './cardDoc'

export function Section({ id, title, description, children, actions }: { id: string; title: string; description?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28 rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-start gap-2">
        <div className="flex-1">
          <h2 className="font-semibold">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}

export function FieldLabel({ label, hint, htmlFor, extra }: { label: string; hint?: string; htmlFor?: string; extra?: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {hint && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={`${label}说明`}>
              <CircleHelpIcon className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{hint}</TooltipContent>
        </Tooltip>
      )}
      <div className="flex-1" />
      {extra}
    </div>
  )
}

export function TokenBadge({ text }: { text: string }) {
  const tokens = useTokenCount(text)
  if (!text) return null
  return <span className="text-xs text-muted-foreground tabular-nums">约 {formatTokens(tokens)} token</span>
}

interface TextFieldProps {
  path: Path
  label: string
  hint?: string
  placeholder?: string
  minHeight?: number
  maxHeight?: number
  language?: EditorLanguage
  /** 标签行右侧的额外操作 */
  actions?: ReactNode
}

/** 绑定到卡片路径的多行文本字段 */
export function TextField({ path, label, hint, placeholder, minHeight = 80, maxHeight = 480, language, actions }: TextFieldProps) {
  const value = useCardPath<string>(path, '')
  const pathKey = path.join('.')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const onChange = useCallback((v: string) => setCardPath(path, v, `编辑${label}`), [pathKey, label])
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel
        label={label}
        hint={hint}
        extra={
          <div className="flex items-center gap-2">
            {actions}
            <TokenBadge text={value} />
          </div>
        }
      />
      <TextEditor
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        minHeight={minHeight}
        maxHeight={maxHeight}
        language={language}
        fullscreenTitle={label}
      />
    </div>
  )
}

/** 绑定到卡片路径的单行输入 */
export function InputField({ path, label, hint, placeholder }: { path: Path; label: string; hint?: string; placeholder?: string }) {
  const value = useCardPath<string>(path, '')
  const id = `field-${path.join('-')}`
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel label={label} hint={hint} htmlFor={id} />
      <Input id={id} value={value} placeholder={placeholder} onChange={(e) => setCardPath(path, e.target.value, `编辑${label}`)} />
    </div>
  )
}
