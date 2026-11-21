import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronRightIcon, FileCode2Icon, FolderIcon, GripVerticalIcon } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { computeDrop, flattenTree, type FlatRow } from '@/core/tavern-helper/drop'
import { moveNode, updateFolder, type HelperFolder, type HelperNode, type HelperScript } from '@/core/tavern-helper/scripts'
import { cn } from '@/lib/utils'
import { currentPos, editHelper, editScript, findByKey, formatChars } from './state'

interface RowProps {
  row: FlatRow
  node: HelperNode
  /** 脚本所在文件夹被关闭时为 true */
  parentOff: boolean
  selected: boolean
  onSelect: (key: string) => void
  onToggleCollapse: (key: string) => void
}

const TreeRow = memo(function TreeRow({ row, node, parentOff, selected, onSelect, onToggleCollapse }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.key })
  const child = row.pos.child !== undefined
  const folder = node.type === 'folder' ? (node as HelperFolder) : null
  const script = node.type === 'script' ? (node as HelperScript) : null
  const off = node.enabled === false || parentOff

  const toggle = (enabled: boolean) => {
    if (script) {
      editScript(node.key, { enabled }, enabled ? '启用脚本' : '停用脚本')
      return
    }
    const pos = currentPos(node.key)
    if (pos) editHelper((ext) => updateFolder(ext, pos, { enabled }), enabled ? '启用文件夹' : '停用文件夹')
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'flex items-center gap-1 border-b bg-card py-1 pr-2 text-sm last:border-b-0',
        child ? 'pl-6' : 'pl-1',
        selected && 'bg-primary/8',
        isDragging && 'relative z-10 shadow-md',
      )}
    >
      <button
        type="button"
        className="flex h-8 w-6 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground hover:text-foreground"
        aria-label={`拖动「${node.name || '未命名'}」调整顺序`}
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-4" />
      </button>
      {folder ? (
        <button
          type="button"
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
          aria-label={row.expanded ? '折叠' : '展开'}
          aria-expanded={row.expanded}
          onClick={() => onToggleCollapse(node.key)}
        >
          <ChevronRightIcon className={cn('size-4 transition-transform', row.expanded && 'rotate-90')} />
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => onSelect(node.key)}
        className={cn('flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left', off && 'text-muted-foreground')}
        aria-current={selected || undefined}
      >
        {folder ? (
          <FolderIcon className="size-4 shrink-0" style={folder.color ? { color: folder.color } : undefined} />
        ) : (
          <FileCode2Icon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{node.name || '未命名'}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {script ? formatChars(script.content.length) : `${folder!.scripts.length} 个`}
        </span>
      </button>
      {node.enabled !== null && (
        <Switch size="sm" checked={node.enabled} onCheckedChange={toggle} aria-label={`${folder ? '启用文件夹' : '启用脚本'}「${node.name || '未命名'}」`} />
      )}
    </div>
  )
})

interface ScriptTreeProps {
  nodes: HelperNode[]
  selected: string | null
  onSelect: (key: string) => void
}

/** 脚本树：文件夹可折叠，拖动手柄调整顺序或移进移出文件夹 */
export function ScriptTree({ nodes, selected, onSelect }: ScriptTreeProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [draggingFolder, setDraggingFolder] = useState<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const rows = useMemo(() => flattenTree(nodes, collapsed, draggingFolder), [nodes, collapsed, draggingFolder])
  const ids = useMemo(() => rows.map((r) => r.key), [rows])

  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const onDragStart = ({ active }: DragStartEvent) => {
    const node = findByKey(nodes, String(active.id))
    // 拖文件夹时先收起它的子项，整个文件夹一起移动
    if (node?.type === 'folder') setDraggingFolder(node.key)
  }

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDraggingFolder(null)
    if (!over || active.id === over.id) return
    const drop = computeDrop(rows, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)))
    if (drop) editHelper((ext) => moveNode(ext, drop.from, drop.to), '调整脚本顺序')
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDraggingFolder(null)}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col overflow-hidden rounded-xl border bg-card">
          {rows.map((row) => {
            const node = findByKey(nodes, row.key)!
            const parent = row.pos.child !== undefined ? nodes[row.pos.index] : undefined
            return (
              <TreeRow
                key={row.key}
                row={row}
                node={node}
                parentOff={parent?.enabled === false}
                selected={row.key === selected}
                onSelect={onSelect}
                onToggleCollapse={toggleCollapse}
              />
            )
          })}
        </div>
      </SortableContext>
    </DndContext>
  )
}
