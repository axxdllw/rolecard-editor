import { Fragment, type ReactNode } from 'react'
import { CardAvatar } from '@/components/CardAvatar'
import { substituteMacros } from '@/core/macros'

const INLINE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|"[^"\n]*"|“[^”\n]*”|「[^」\n]*」)/g

function renderLine(line: string, key: number): ReactNode {
  const parts = line.split(INLINE)
  return (
    <Fragment key={key}>
      {parts.map((part, i) => {
        if (!part) return null
        if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
        if (part.startsWith('*') && part.endsWith('*') && part.length > 1)
          return (
            <em key={i} className="text-muted-foreground">
              {part.slice(1, -1)}
            </em>
          )
        if (/^["“「]/.test(part)) return <span key={i} className="text-amber-700 dark:text-amber-400">{part}</span>
        return <Fragment key={i}>{part}</Fragment>
      })}
    </Fragment>
  )
}

/** 仿 ST 聊天气泡的开场白预览（HTML 不渲染，按纯文本显示） */
export function ChatPreview({ text, charName, userName, avatar }: { text: string; charName: string; userName: string; avatar: Blob | null }) {
  const content = substituteMacros(text, { char: charName, user: userName })
  const lines = content.split('\n')
  return (
    <div className="flex gap-3 rounded-lg bg-muted/40 p-3">
      <CardAvatar blob={avatar} name={charName} className="size-10 shrink-0 rounded-full text-base" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-sm font-semibold">{charName}</div>
        <div className="text-sm leading-relaxed break-words">
          {lines.map((line, i) => (
            <Fragment key={i}>
              {renderLine(line, i)}
              {i < lines.length - 1 && <br />}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  )
}
