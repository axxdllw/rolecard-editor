import { XIcon } from 'lucide-react'
import { useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'

interface TagInputProps {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  className?: string
  /** 标签的额外样式，例如正则关键词用不同颜色 */
  tagClassName?: (tag: string) => string | undefined
}

const SEPARATORS = /[,，、\n]/

/** 标签输入：回车或逗号分隔，粘贴一串会自动拆开，空输入时退格删除最后一个 */
export function TagInput({ value, onChange, placeholder, className, tagClassName }: TagInputProps) {
  const [draft, setDraft] = useState('')

  const commit = (raw: string) => {
    const parts = raw
      .split(SEPARATORS)
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length === 0) return
    const next = [...value]
    for (const p of parts) if (!next.includes(p)) next.push(p)
    onChange(next)
    setDraft('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault()
      commit(draft)
    } else if (e.key === 'Backspace' && !draft && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    if (SEPARATORS.test(text)) {
      e.preventDefault()
      commit(draft + text)
    }
  }

  return (
    <div
      className={cn(
        'flex min-h-8 flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-1.5 py-1 text-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
        className,
      )}
    >
      {value.map((tag, i) => (
        <span
          key={`${tag}-${i}`}
          className={cn('inline-flex items-center gap-0.5 rounded-md bg-secondary px-1.5 py-0.5 text-xs', tagClassName?.(tag))}
        >
          {tag}
          <button
            type="button"
            className="rounded-sm opacity-60 hover:opacity-100"
            aria-label={`删除 ${tag}`}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
      <input
        className="min-w-24 flex-1 bg-transparent px-1 py-0.5 outline-none placeholder:text-muted-foreground"
        value={draft}
        placeholder={value.length === 0 ? placeholder : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => commit(draft)}
      />
    </div>
  )
}
