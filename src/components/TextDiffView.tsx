import { useMemo, useState } from 'react'
import { diffText, type DiffRow } from '@/core/text/textDiff'
import { cn } from '@/lib/utils'

const ROW_BASE = 'whitespace-pre-wrap break-words border-l-2 px-2'

function Row({ row, onExpand }: { row: DiffRow; onExpand: () => void }) {
  switch (row.type) {
    case 'same':
      return <div className={cn(ROW_BASE, 'border-transparent text-muted-foreground')}>{row.text || ' '}</div>
    case 'del':
      return <div className={cn(ROW_BASE, 'border-red-500 bg-red-500/10 text-red-800 dark:text-red-300')}>{row.text || ' '}</div>
    case 'ins':
      return <div className={cn(ROW_BASE, 'border-green-600 bg-green-500/10 text-green-800 dark:text-green-300')}>{row.text || ' '}</div>
    case 'edit':
      return (
        <div className={cn(ROW_BASE, 'border-amber-500')}>
          {row.segments.map((s, i) =>
            s.type === 'del' ? (
              <del key={i} className="rounded-sm bg-red-500/20 text-red-800 decoration-red-500/60 dark:text-red-300">
                {s.text}
              </del>
            ) : s.type === 'ins' ? (
              <ins key={i} className="rounded-sm bg-green-500/20 text-green-800 no-underline dark:text-green-300">
                {s.text}
              </ins>
            ) : (
              <span key={i}>{s.text}</span>
            ),
          )}
        </div>
      )
    case 'skip':
      return (
        <button type="button" onClick={onExpand} className="w-full px-2 py-0.5 text-left text-xs text-muted-foreground hover:bg-muted">
          ⋯ {row.lines.length} 行未改动（展开）
        </button>
      )
  }
}

/** 两段文本的差异：红色是删掉的，绿色是新增的，黄色竖线的行是行内改动 */
export function TextDiffView({ before, after, className }: { before: string; after: string; className?: string }) {
  const diff = useMemo(() => diffText(before, after), [before, after])
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())

  if (diff.tooLarge) {
    return (
      <div className={cn('flex flex-col gap-2 text-sm', className)}>
        <p className="text-xs text-muted-foreground">改动太多，没法逐行对比，下面分别是原件和现在的全文。</p>
        <div className={cn(ROW_BASE, 'max-h-60 overflow-y-auto border-red-500 bg-red-500/5')}>{before}</div>
        <div className={cn(ROW_BASE, 'max-h-60 overflow-y-auto border-green-600 bg-green-500/5')}>{after}</div>
      </div>
    )
  }
  if (diff.added === 0 && diff.removed === 0) {
    return <p className={cn('text-xs text-muted-foreground', className)}>文字相同，只有换行符不同。</p>
  }
  return (
    <div className={cn('flex flex-col text-sm leading-relaxed', className)}>
      {diff.rows.map((row, i) =>
        row.type === 'skip' && expanded.has(i) ? (
          row.lines.map((line, k) => <Row key={`${i}-${k}`} row={{ type: 'same', text: line }} onExpand={() => {}} />)
        ) : (
          <Row key={i} row={row} onExpand={() => setExpanded((prev) => new Set(prev).add(i))} />
        ),
      )}
    </div>
  )
}
