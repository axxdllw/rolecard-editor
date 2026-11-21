import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVerticalIcon } from 'lucide-react'
import { memo, useEffect, useRef } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import type { LorebookEntry } from '@/core/card/types'
import { entryTitle, getDepth, getOrder, getOutletName, getPosition, getStrategy, POSITION_OPTIONS } from '@/core/lorebook/entry'
import { cachedTokens, formatTokens, useTokenizerReady } from '@/lib/tokens'
import { cn } from '@/lib/utils'

export interface Row {
  key: string
  index: number
  entry: LorebookEntry
}

const STRATEGY_STYLE = {
  constant: { label: '常驻', className: 'bg-emerald-500' },
  keyword: { label: '关键词', className: 'bg-sky-500' },
  vectorized: { label: '向量', className: 'bg-violet-500' },
}

interface RowProps {
  row: Row
  active: boolean
  checked: boolean
  batch: boolean
  sortable: boolean
  issue: boolean
  onSelect: (key: string) => void
  onCheck: (key: string) => void
  onToggle: (key: string, enabled: boolean) => void
}

const EntryRow = memo(function EntryRow({ row, active, checked, batch, sortable, issue, onSelect, onCheck, onToggle }: RowProps) {
  useTokenizerReady()
  const { entry, index, key } = row
  const strategy = getStrategy(entry)
  const position = getPosition(entry)
  const posLabel = POSITION_OPTIONS.find((p) => p.value === position)?.short ?? String(position)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: key, disabled: !sortable })
  const keys = (entry.keys ?? []).filter((k) => k.trim())
  const elRef = useRef<HTMLDivElement | null>(null)
  // 键盘切换条目时，把选中的行滚到可见区域
  useEffect(() => {
    if (active) elRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div
      ref={(el) => {
        setNodeRef(el)
        elRef.current = el
      }}
      style={{ transform: CSS.Transform.toString(transform), transition, contentVisibility: 'auto', containIntrinsicSize: '0 52px' }}
      className={cn(
        'flex cursor-pointer items-center gap-2 border-b px-2 py-1.5 text-sm hover:bg-muted/50',
        active && 'bg-primary/8 hover:bg-primary/10',
        entry.enabled === false && 'opacity-50',
        isDragging && 'relative z-10 bg-background shadow-md',
      )}
      onClick={() => (batch ? onCheck(key) : onSelect(key))}
    >
      {sortable && (
        <button
          type="button"
          className="cursor-grab touch-none text-muted-foreground"
          aria-label="拖动排序"
          onClick={(e) => e.stopPropagation()}
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
      )}
      {batch ? (
        <Checkbox checked={checked} tabIndex={-1} />
      ) : (
        <Switch
          size="sm"
          checked={entry.enabled !== false}
          onClick={(e) => e.stopPropagation()}
          onCheckedChange={(v) => onToggle(key, v)}
          aria-label="启用"
        />
      )}
      <span className={cn('size-2 shrink-0 rounded-full', STRATEGY_STYLE[strategy].className)} title={STRATEGY_STYLE[strategy].label} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1 truncate font-medium">
          {issue && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" title="有检查提示" />}
          <span className="truncate">{entryTitle(entry, index)}</span>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {strategy === 'constant' ? '常驻' : keys.length ? keys.join('、') : '（无关键词）'}
        </span>
      </div>
      <span className="hidden max-w-32 shrink-0 truncate text-xs text-muted-foreground sm:block">
        {posLabel}
        {position === 4 ? ` ${getDepth(entry)}` : ''}
        {position === 7 ? ` ${getOutletName(entry) || '（未命名）'}` : ''}
      </span>
      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground" title="顺序">
        {getOrder(entry)}
      </span>
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground" title="token 估算">
        {formatTokens(cachedTokens(entry.content ?? ''))}
      </span>
    </div>
  )
})

interface EntryListProps {
  rows: Row[]
  activeKey: string | null
  checkedKeys: Set<string>
  batch: boolean
  sortable: boolean
  issueKeys: Set<string>
  onSelect: (key: string) => void
  onCheck: (key: string) => void
  onToggle: (key: string, enabled: boolean) => void
  onReorder: (orderedKeys: string[]) => void
}

export function EntryList({ rows, activeKey, checkedKeys, batch, sortable, issueKeys, onSelect, onCheck, onToggle, onReorder }: EntryListProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const ids = rows.map((r) => r.key)

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    onReorder(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))))
  }

  if (rows.length === 0) {
    return <p className="p-6 text-center text-sm text-muted-foreground">没有条目</p>
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {rows.map((row) => (
          <EntryRow
            key={row.key}
            row={row}
            active={row.key === activeKey}
            checked={checkedKeys.has(row.key)}
            batch={batch}
            sortable={sortable && !batch}
            issue={issueKeys.has(row.key)}
            onSelect={onSelect}
            onCheck={onCheck}
            onToggle={onToggle}
          />
        ))}
      </SortableContext>
    </DndContext>
  )
}
