import {
  CheckSquareIcon,
  CopyIcon,
  DownloadIcon,
  FileJsonIcon,
  LayoutGridIcon,
  ListIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TagIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { CardAvatar } from '@/components/CardAvatar'
import { confirm } from '@/components/confirm'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { db, type CardRecord } from '@/db/db'
import { useLive } from '@/db/useLive'
import { downloadBlob, pickFiles } from '@/lib/files'
import { formatTime } from '@/lib/format'
import { useSettings, type LibrarySort } from '@/lib/settings'
import { formatTokens, loadTokenizer } from '@/lib/tokens'
import { cn } from '@/lib/utils'
import {
  cardFileBase,
  computeStats,
  deleteCards,
  duplicateCard,
  exportCardJson,
  exportCardPng,
  exportCardsZip,
} from '@/services/cards'
import { importFiles } from './importFlow'
import { BatchTagDialog, MetaDialog } from './MetaDialog'
import { NewCardDialog } from './NewCardDialog'

const BACKUP_REMIND_MS = 7 * 24 * 3600 * 1000

const SORT_LABELS: Record<LibrarySort, string> = {
  updatedAt: '最近修改',
  createdAt: '最近导入',
  name: '按名字',
}

function statLine(record: CardRecord): string {
  const s = record.stats
  const parts = []
  if (s.entries) parts.push(`世界书 ${s.entries} 条`)
  if (s.greetings > 1) parts.push(`开场白 ${s.greetings}`)
  if (s.regex) parts.push(`正则 ${s.regex}`)
  parts.push(s.constantTokens != null ? `常驻约 ${formatTokens(s.constantTokens)} token` : `常驻 ${s.constantChars} 字`)
  return parts.join(' · ')
}

async function exportOne(record: CardRecord, format: 'png' | 'json') {
  try {
    if (format === 'png') {
      downloadBlob(await exportCardPng(record), `${cardFileBase(record)}.png`, 'image/png')
    } else {
      downloadBlob(exportCardJson(record), `${cardFileBase(record)}.json`, 'application/json')
    }
  } catch (error) {
    toast.error(`导出失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

export default function LibraryPage() {
  const navigate = useNavigate()
  const { librarySort, libraryView, lastBackupAt, set } = useSettings()
  const [hideBackupTip, setHideBackupTip] = useState(false)
  const [now] = useState(() => Date.now())
  const cards = useLive(() => db.cards.toArray(), [])
  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [newOpen, setNewOpen] = useState(false)
  const [metaId, setMetaId] = useState<string | null>(null)
  const [batchTagIds, setBatchTagIds] = useState<string[] | null>(null)
  const [dragging, setDragging] = useState(false)

  // 分词器加载后，补算之前没算出 token 的卡
  useEffect(() => {
    if (!cards?.some((c) => c.stats.constantTokens == null)) return
    void loadTokenizer().then(async () => {
      for (const c of cards.filter((c) => c.stats.constantTokens == null)) {
        await db.cards.update(c.id, { stats: computeStats(c.card) })
      }
    })
  }, [cards])

  const allTags = useMemo(() => {
    const set = new Set<string>()
    cards?.forEach((c) => c.localTags.forEach((t) => set.add(t)))
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'))
  }, [cards])

  const visible = useMemo(() => {
    if (!cards) return []
    const q = query.trim().toLowerCase()
    const list = cards.filter((c) => {
      if (tagFilter && !c.localTags.includes(tagFilter)) return false
      if (!q) return true
      const haystack = [c.name, c.card.data.creator, c.note, ...c.localTags, ...(c.card.data.tags ?? [])]
        .join('\n')
        .toLowerCase()
      return haystack.includes(q)
    })
    list.sort((a, b) => {
      if (librarySort === 'name') return a.name.localeCompare(b.name, 'zh')
      return b[librarySort] - a[librarySort]
    })
    return list
  }, [cards, query, tagFilter, librarySort])

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const exitSelecting = () => {
    setSelecting(false)
    setSelected(new Set())
  }

  const doImport = async (files: File[]) => {
    if (files.length === 0) return
    const ids = await importFiles(files)
    if (ids.length === 1 && files.length === 1) navigate(`/card/${ids[0]}`)
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    void doImport(Array.from(e.dataTransfer.files))
  }

  const removeCards = async (ids: string[]) => {
    const ok = await confirm({
      title: ids.length === 1 ? '删除这张卡？' : `删除选中的 ${ids.length} 张卡？`,
      description: '删除后无法恢复。如果还想留着，可以先导出或做一次备份。',
      confirmText: '删除',
      destructive: true,
    })
    if (!ok) return
    await deleteCards(ids)
    toast.success(`已删除 ${ids.length} 张卡`)
    setSelected(new Set())
  }

  const batchExport = async () => {
    const records = visible.filter((c) => selected.has(c.id))
    if (records.length === 0) return
    if (records.length === 1) return exportOne(records[0], 'png')
    const zip = await exportCardsZip(records)
    downloadBlob(zip, `角色卡导出-${records.length}张.zip`, 'application/zip')
  }

  const copy = async (id: string) => {
    const newId = await duplicateCard(id)
    if (newId) toast.success('已复制一份，原卡保持不变')
  }

  const menu = (record: CardRecord) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="更多操作" onClick={(e) => e.stopPropagation()}>
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onClick={() => navigate(`/card/${record.id}`)}>
          <PencilIcon /> 编辑
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => copy(record.id)}>
          <CopyIcon /> 复制一份
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => exportOne(record, 'png')}>
          <DownloadIcon /> 导出 PNG
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => exportOne(record, 'json')}>
          <FileJsonIcon /> 导出 JSON
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setMetaId(record.id)}>
          <TagIcon /> 标签与备注
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => removeCards([record.id])}>
          <Trash2Icon /> 删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const open = (record: CardRecord) => (selecting ? toggleSelect(record.id) : navigate(`/card/${record.id}`))

  return (
    <div
      className="relative mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-4"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-xl font-semibold">
          卡库 <span className="text-sm font-normal text-muted-foreground">{cards?.length ?? 0} 张</span>
        </h1>
        <div className="relative min-w-40 flex-1">
          <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="搜索名字、标签、作者、备注" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Select value={librarySort} onValueChange={(v) => set({ librarySort: v as LibrarySort })}>
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(SORT_LABELS).map(([k, label]) => (
              <SelectItem key={k} value={k}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ToggleGroup
          type="single"
          variant="outline"
          value={libraryView}
          onValueChange={(v) => v && set({ libraryView: v as 'grid' | 'list' })}
        >
          <ToggleGroupItem value="grid" aria-label="网格视图">
            <LayoutGridIcon />
          </ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label="列表视图">
            <ListIcon />
          </ToggleGroupItem>
        </ToggleGroup>
        <Button variant={selecting ? 'secondary' : 'outline'} onClick={() => (selecting ? exitSelecting() : setSelecting(true))}>
          <CheckSquareIcon /> {selecting ? '退出多选' : '多选'}
        </Button>
        <Button variant="outline" onClick={async () => doImport(await pickFiles('.png,.json,.charx', true))}>
          <UploadIcon /> 导入
        </Button>
        <Button onClick={() => setNewOpen(true)}>
          <PlusIcon /> 新建
        </Button>
      </div>

      {!hideBackupTip && cards && cards.length > 0 && (!lastBackupAt || now - lastBackupAt > BACKUP_REMIND_MS) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="flex-1">
            {lastBackupAt ? `已经 ${Math.floor((now - lastBackupAt) / 86400000)} 天没有备份了。` : '还没有备份过。'}
            数据只存在这个浏览器里，建议定期备份。
          </span>
          <Button size="xs" asChild>
            <Link to="/settings">去备份</Link>
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setHideBackupTip(true)}>
            稍后
          </Button>
        </div>
      )}

      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">标签：</span>
          {allTags.map((tag) => (
            <Badge
              key={tag}
              asChild
              variant={tagFilter === tag ? 'default' : 'outline'}
              className="cursor-pointer"
            >
              <button type="button" onClick={() => setTagFilter(tagFilter === tag ? null : tag)}>
                {tag}
              </button>
            </Badge>
          ))}
          {tagFilter && (
            <Button variant="ghost" size="xs" onClick={() => setTagFilter(null)}>
              <XIcon /> 清除
            </Button>
          )}
        </div>
      )}

      {selecting && (
        <div className="sticky top-14 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-background/95 p-2 shadow-sm backdrop-blur">
          <span className="px-1 text-sm">已选 {selected.size} 张</span>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(visible.map((c) => c.id)))}>
            全选
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            清空
          </Button>
          <div className="flex-1" />
          <Button size="sm" variant="outline" disabled={!selected.size} onClick={batchExport}>
            <DownloadIcon /> 导出
          </Button>
          <Button size="sm" variant="outline" disabled={!selected.size} onClick={() => setBatchTagIds([...selected])}>
            <TagIcon /> 加标签
          </Button>
          <Button size="sm" variant="destructive" disabled={!selected.size} onClick={() => removeCards([...selected])}>
            <Trash2Icon /> 删除
          </Button>
        </div>
      )}

      {cards && cards.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-10 text-center">
          <UploadIcon className="size-8 text-muted-foreground" />
          <p className="font-medium">卡库还是空的</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            把角色卡（PNG、JSON、CharX）拖到这里，或者点右上角「导入」；也可以「新建」一张自己的卡。
          </p>
        </div>
      )}

      {cards && cards.length > 0 && visible.length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground">没有符合条件的卡</p>
      )}

      {libraryView === 'grid' ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {visible.map((record) => (
            <div
              key={record.id}
              role="button"
              tabIndex={0}
              onClick={() => open(record)}
              onKeyDown={(e) => e.key === 'Enter' && open(record)}
              className={cn(
                'group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-card text-left transition hover:shadow-md',
                selected.has(record.id) && 'ring-2 ring-primary',
              )}
            >
              <CardAvatar blob={record.avatar} name={record.name} className="aspect-[2/3] w-full" />
              {selecting && (
                <Checkbox className="absolute top-2 left-2 bg-background" checked={selected.has(record.id)} tabIndex={-1} />
              )}
              {record.sourceFormat === 'copy' && (
                <Badge variant="secondary" className="absolute top-2 right-2">
                  副本
                </Badge>
              )}
              <div className="flex flex-col gap-1 p-2.5">
                <div className="flex items-center gap-1">
                  <span className="flex-1 truncate font-medium">{record.name || '未命名'}</span>
                  {menu(record)}
                </div>
                <p className="line-clamp-2 text-xs text-muted-foreground">{statLine(record)}</p>
                {record.localTags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {record.localTags.slice(0, 3).map((t) => (
                      <Badge key={t} variant="outline" className="h-4 px-1.5 text-[10px]">
                        {t}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col divide-y rounded-xl border">
          {visible.map((record) => (
            <div
              key={record.id}
              role="button"
              tabIndex={0}
              onClick={() => open(record)}
              onKeyDown={(e) => e.key === 'Enter' && open(record)}
              className={cn('flex cursor-pointer items-center gap-3 p-2 hover:bg-muted/50', selected.has(record.id) && 'bg-primary/5')}
            >
              {selecting && <Checkbox checked={selected.has(record.id)} tabIndex={-1} />}
              <CardAvatar blob={record.avatar} name={record.name} className="h-14 w-10 shrink-0 rounded-md text-base" />
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{record.name || '未命名'}</span>
                  {record.sourceFormat === 'copy' && <Badge variant="secondary">副本</Badge>}
                  {record.localTags.map((t) => (
                    <Badge key={t} variant="outline" className="hidden sm:inline-flex">
                      {t}
                    </Badge>
                  ))}
                </div>
                <span className="truncate text-xs text-muted-foreground">{statLine(record)}</span>
              </div>
              <span className="hidden text-xs text-muted-foreground sm:block">{formatTime(record.updatedAt)}</span>
              {menu(record)}
            </div>
          ))}
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-primary/10 backdrop-blur-sm">
          <div className="rounded-xl border-2 border-dashed border-primary bg-background px-8 py-6 text-lg font-medium">
            松开即可导入
          </div>
        </div>
      )}

      <NewCardDialog open={newOpen} onOpenChange={setNewOpen} />
      <MetaDialog cardId={metaId} onClose={() => setMetaId(null)} />
      <BatchTagDialog ids={batchTagIds} onClose={() => setBatchTagIds(null)} />
    </div>
  )
}
