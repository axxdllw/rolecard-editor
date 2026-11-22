/**
 * ③ 整理：浏览和整理 AI 抽取的人物、地点、组织、名词、时间线与世界观；支持勾选进世界书、改名、合并、拆出、删除/恢复。
 */
import {
  ArrowRightIcon,
  CheckSquareIcon,
  ChevronRightIcon,
  GitMergeIcon,
  RotateCcwIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  collectTimeline,
  collectWorld,
  entityBrief,
  isHidden,
  isSelected,
  mergeOverride,
  renameOverride,
  setHidden,
  setSelected,
  splitOverride,
  type TimelineItem,
} from '@/core/novel/merge'
import { findEntity } from '@/core/novel/prepare'
import {
  ENTITY_KIND_LABELS,
  type ChunkResult,
  type EntityKind,
  type MergedEntity,
  type ReviewOverrides,
} from '@/core/novel/types'
import type { NovelRecord } from '@/db/db'
import { useIsDesktop } from '@/lib/useMediaQuery'
import { cn } from '@/lib/utils'
import { updateNovel } from '@/services/novels'
import { EntityDetail } from './EntityDetail'
import { entityChunkCount, type NovelStep } from './novelHelpers'

type ReviewTab = EntityKind | 'timeline' | 'world'
type EntitySort = 'weight' | 'first'

const ENTITY_PAGE_SIZE = 150
const TIMELINE_PAGE_SIZE = 40

function isEntityKind(tab: ReviewTab): tab is EntityKind {
  return tab === 'character' || tab === 'place' || tab === 'organization' || tab === 'term'
}

interface ModifierKeys {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

interface EntityListViewProps {
  items: MergedEntity[]
  review: ReviewOverrides
  chunkCount: number
  activeId: string | null
  batchMode: boolean
  batchIds: ReadonlySet<string>
  onOpenDetail: (entity: MergedEntity, modifiers: ModifierKeys) => void
  onToggleLorebook: (entity: MergedEntity, on: boolean) => void
  onToggleBatch: (entityId: string, shiftKey: boolean) => void
}

/** 分页展示实体列表；切换标签/搜索/排序时通过 key 自然重置 limit */
function EntityListView({
  items,
  review,
  chunkCount,
  activeId,
  batchMode,
  batchIds,
  onOpenDetail,
  onToggleLorebook,
  onToggleBatch,
}: EntityListViewProps) {
  const [limit, setLimit] = useState(ENTITY_PAGE_SIZE)
  const shown = items.slice(0, limit)

  if (items.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">没有符合条件的对象</p>
  }

  return (
    <div className="flex flex-col divide-y">
      {shown.map((entity) => {
        const inLorebook = isSelected(entity, review, chunkCount)
        const isActive = activeId === entity.id
        const isBatchChecked = batchIds.has(entity.id)
        const brief = entityBrief(entity)
        const chunks = entityChunkCount(entity)

        return (
          <div
            key={entity.id}
            role="button"
            tabIndex={0}
            onClick={(e) => onOpenDetail(entity, { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onOpenDetail(entity, { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey })
              }
            }}
            className={cn(
              'flex cursor-pointer items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/40',
              isActive && 'bg-primary/8',
              isBatchChecked && 'bg-accent/60',
            )}
          >
            {batchMode && (
              <input
                type="checkbox"
                checked={isBatchChecked}
                onChange={() => {}}
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleBatch(entity.id, e.shiftKey)
                }}
                aria-label={`多选 ${entity.name}`}
                className="mt-1 size-4 shrink-0 cursor-pointer accent-primary"
              />
            )}

            <div
              className="mt-0.5 shrink-0"
              onClick={(e) => e.stopPropagation()}
              title="勾选后在生成时写入世界书"
            >
              <input
                type="checkbox"
                checked={inLorebook}
                onChange={(e) => onToggleLorebook(entity, e.target.checked)}
                aria-label={`${entity.name} 进世界书`}
                className="size-4 cursor-pointer accent-primary"
              />
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-medium">{entity.name}</span>
                {entity.kind === 'character' && entity.importance > 0 && (
                  <span className="text-xs text-amber-600 dark:text-amber-400">★{entity.importance}</span>
                )}
                {entity.kind === 'character' && entity.gender && (
                  <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                    {entity.gender}
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">出现 {chunks} 段</span>
                {entity.aliases.length > 0 && (
                  <span className="truncate text-xs text-muted-foreground">
                    别名：{entity.aliases.slice(0, 3).join('、')}
                    {entity.aliases.length > 3 ? '…' : ''}
                  </span>
                )}
              </div>
              {brief && <p className="line-clamp-1 text-xs text-muted-foreground">{brief}</p>}
            </div>
          </div>
        )
      })}

      {items.length > limit && (
        <div className="flex justify-center p-3">
          <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + ENTITY_PAGE_SIZE)}>
            还有 {items.length - limit} 个，继续显示
          </Button>
        </div>
      )}
    </div>
  )
}

interface TimelineViewProps {
  items: TimelineItem[]
}

function TimelineView({ items }: TimelineViewProps) {
  const [onlyImportant, setOnlyImportant] = useState(true)
  const [limit, setLimit] = useState(TIMELINE_PAGE_SIZE)

  const filtered = useMemo(
    () => (onlyImportant ? items.filter((e) => e.importance >= 3) : items),
    [items, onlyImportant],
  )

  const groups = useMemo(() => {
    const out: Array<{ chunkId: string; label: string; events: TimelineItem[] }> = []
    for (const ev of filtered) {
      const last = out[out.length - 1]
      if (last && last.chunkId === ev.chunkId) last.events.push(ev)
      else out.push({ chunkId: ev.chunkId, label: ev.label, events: [ev] })
    }
    return out
  }, [filtered])

  const shown = groups.slice(0, limit)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-3.5 py-2.5 text-sm">
        <span className="text-muted-foreground">
          共 {items.length} 条事件{onlyImportant ? `，当前显示重要度 ≥ 3 的 ${filtered.length} 条` : ''}
        </span>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Switch checked={!onlyImportant} onCheckedChange={(all) => setOnlyImportant(!all)} />
          显示全部事件
        </label>
      </div>

      {groups.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {items.length === 0 ? '没有抽取出时间线事件' : '没有重要度 ≥ 3 的事件，可以打开“显示全部事件”看看'}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map((group) => (
            <section key={group.chunkId} className="flex flex-col gap-2 rounded-xl border bg-card p-3.5">
              <h3 className="text-sm font-medium text-foreground">{group.label}</h3>
              <div className="flex flex-col divide-y">
                {group.events.map((ev, idx) => (
                  <div key={idx} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-sm">{ev.title}</span>
                      {ev.importance > 0 && (
                        <span className="text-xs text-amber-600 dark:text-amber-400">★{ev.importance}</span>
                      )}
                      {ev.place && (
                        <Badge variant="outline" className="text-[11px]">
                          {ev.place}
                        </Badge>
                      )}
                    </div>
                    {ev.summary && <p className="text-sm text-muted-foreground">{ev.summary}</p>}
                    {ev.characters.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {ev.characters.map((name) => (
                          <Badge key={name} variant="secondary" className="text-[11px] font-normal">
                            {name}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
          {groups.length > limit && (
            <Button variant="outline" size="sm" className="self-center" onClick={() => setLimit((n) => n + TIMELINE_PAGE_SIZE)}>
              还有 {groups.length - limit} 段，继续显示
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export interface ReviewStepProps {
  novel: NovelRecord
  results: ChunkResult[]
  entities: MergedEntity[]
  chunkCount: number
  onGoStep: (step: NovelStep) => void
}

export function ReviewStep({ novel, results, entities, chunkCount, onGoStep }: ReviewStepProps) {
  const isDesktop = useIsDesktop()
  const review = novel.review

  const [tab, setTab] = useState<ReviewTab>('character')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<EntitySort>('weight')
  const [onlySelected, setOnlySelected] = useState(false)
  const [batchMode, setBatchMode] = useState(false)
  const [batchIds, setBatchIds] = useState<Set<string>>(() => new Set())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [mergeTargets, setMergeTargets] = useState<MergedEntity[] | null>(null)
  const [mergePrimaryId, setMergePrimaryId] = useState<string>('')
  const lastBatchClickRef = useRef<string | null>(null)

  const timeline = useMemo(() => collectTimeline(results), [results])
  const worldLines = useMemo(() => collectWorld(results), [results])

  const countsByKind = useMemo(() => {
    const counts: Record<EntityKind, number> = { character: 0, place: 0, organization: 0, term: 0 }
    for (const e of entities) {
      if (!isHidden(e, review)) counts[e.kind]++
    }
    return counts
  }, [entities, review])

  const { visibleEntities, hiddenEntities } = useMemo(() => {
    if (!isEntityKind(tab)) return { visibleEntities: [] as MergedEntity[], hiddenEntities: [] as MergedEntity[] }
    const q = query.trim().toLowerCase()
    const visible: MergedEntity[] = []
    const hidden: MergedEntity[] = []

    for (const e of entities) {
      if (e.kind !== tab) continue
      if (isHidden(e, review)) {
        hidden.push(e)
        continue
      }
      if (onlySelected && !isSelected(e, review, chunkCount)) continue
      if (q) {
        const hit =
          e.name.toLowerCase().includes(q) || e.aliases.some((alias) => alias.toLowerCase().includes(q))
        if (!hit) continue
      }
      visible.push(e)
    }

    if (sort === 'first') {
      visible.sort((a, b) => (a.mentions[0]?.order ?? 0) - (b.mentions[0]?.order ?? 0))
    } else {
      visible.sort((a, b) => b.weight - a.weight || (a.mentions[0]?.order ?? 0) - (b.mentions[0]?.order ?? 0))
    }

    return { visibleEntities: visible, hiddenEntities: hidden }
  }, [entities, tab, review, query, onlySelected, chunkCount, sort])

  const activeEntity = useMemo(() => findEntity(entities, activeId), [entities, activeId])

  // 只统计当前类别里还存在于 visibleEntities 的批量选中对象
  const validBatchEntities = useMemo(
    () => visibleEntities.filter((e) => batchIds.has(e.id)),
    [visibleEntities, batchIds],
  )

  const saveReview = (next: ReviewOverrides) => {
    void updateNovel(novel.id, { review: next })
  }

  const handleTabChange = (next: string) => {
    setTab(next as ReviewTab)
    setBatchIds(new Set())
    lastBatchClickRef.current = null
  }

  const toggleBatchId = (id: string, shiftKey: boolean) => {
    setBatchIds((prev) => {
      const next = new Set(prev)
      const targetChecked = !next.has(id)
      if (shiftKey && lastBatchClickRef.current) {
        const posA = visibleEntities.findIndex((e) => e.id === lastBatchClickRef.current)
        const posB = visibleEntities.findIndex((e) => e.id === id)
        if (posA >= 0 && posB >= 0) {
          const [from, to] = posA < posB ? [posA, posB] : [posB, posA]
          for (let i = from; i <= to; i++) {
            if (targetChecked) next.add(visibleEntities[i].id)
            else next.delete(visibleEntities[i].id)
          }
          lastBatchClickRef.current = id
          return next
        }
      }
      if (targetChecked) next.add(id)
      else next.delete(id)
      lastBatchClickRef.current = id
      return next
    })
  }

  const handleOpenDetail = (entity: MergedEntity, modifiers: ModifierKeys) => {
    if (batchMode || modifiers.ctrlKey || modifiers.metaKey || modifiers.shiftKey) {
      if (!batchMode) setBatchMode(true)
      toggleBatchId(entity.id, modifiers.shiftKey)
      return
    }
    setActiveId(entity.id)
  }

  const openMergeDialog = () => {
    if (validBatchEntities.length < 2) return
    setMergeTargets(validBatchEntities)
    setMergePrimaryId(validBatchEntities[0].id)
  }

  const confirmMerge = () => {
    if (!mergeTargets || mergeTargets.length < 2) return
    const primary = mergeTargets.find((e) => e.id === mergePrimaryId) ?? mergeTargets[0]
    const ordered = [primary, ...mergeTargets.filter((e) => e.id !== primary.id)]
    saveReview(mergeOverride(review, ordered))
    toast.success(`已合并成「${primary.name}」`)
    setMergeTargets(null)
    setBatchIds(new Set())
    setActiveId(primary.id)
  }

  const batchHide = () => {
    if (validBatchEntities.length === 0) return
    saveReview(setHidden(review, validBatchEntities, true))
    toast.success(`已删除 ${validBatchEntities.length} 个对象（可在底部恢复）`)
    setBatchIds(new Set())
  }

  const batchSetLorebook = (on: boolean) => {
    if (validBatchEntities.length === 0) return
    saveReview(setSelected(review, entities, validBatchEntities, on, chunkCount))
    toast.success(on ? `已勾选 ${validBatchEntities.length} 个进世界书` : `已取消 ${validBatchEntities.length} 个`)
  }

  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
        <p>还没有抽取结果，先去 ② 抽取至少一块内容。</p>
        <Button size="sm" onClick={() => onGoStep('extract')}>
          去抽取
        </Button>
      </div>
    )
  }

  const detailNode = activeEntity ? (
    <EntityDetail
      key={activeEntity.id}
      entity={activeEntity}
      selected={isSelected(activeEntity, review, chunkCount)}
      hidden={isHidden(activeEntity, review)}
      onRename={(e, name) => {
        saveReview(renameOverride(review, e, name))
        toast.success(name ? `已改名为「${name}」` : '已恢复自动命名')
      }}
      onToggleSelect={(e, on) => saveReview(setSelected(review, entities, [e], on, chunkCount))}
      onToggleHide={(e, hide) => {
        saveReview(setHidden(review, [e], hide))
        toast.success(hide ? `已删除「${e.name}」` : `已恢复「${e.name}」`)
      }}
      onSplit={(key) => {
        saveReview(splitOverride(review, key))
        toast.success('已拆出为独立对象')
      }}
    />
  ) : null

  return (
    <div className="flex flex-col gap-3">
      {/* 二级标签栏 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={tab} onValueChange={handleTabChange} className="min-w-0 flex-1">
          <TabsList className="w-fit max-w-full justify-start overflow-x-auto [scrollbar-width:none]">
            {(['character', 'place', 'organization', 'term'] as EntityKind[]).map((kind) => (
              <TabsTrigger key={kind} value={kind}>
                {ENTITY_KIND_LABELS[kind]}
                <span className="text-xs text-muted-foreground">{countsByKind[kind]}</span>
              </TabsTrigger>
            ))}
            <TabsTrigger value="timeline">
              时间线 <span className="text-xs text-muted-foreground">{timeline.length}</span>
            </TabsTrigger>
            <TabsTrigger value="world">
              世界观 <span className="text-xs text-muted-foreground">{worldLines.length}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <Button size="sm" onClick={() => onGoStep('generate')}>
          去生成角色卡 <ArrowRightIcon />
        </Button>
      </div>

      {/* 人物/地点/组织/名词 */}
      {isEntityKind(tab) && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
          {/* 左：列表与工具条 */}
          <div className="flex min-w-0 flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-40 flex-1">
                <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder="搜索名字或别名"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <Select value={sort} onValueChange={(v) => setSort(v as EntitySort)}>
                <SelectTrigger className="w-30">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="weight">重要程度</SelectItem>
                  <SelectItem value="first">首次出现</SelectItem>
                </SelectContent>
              </Select>
              <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm">
                <Checkbox checked={onlySelected} onCheckedChange={(v) => setOnlySelected(v === true)} />
                <span className="whitespace-nowrap">只看勾选的</span>
              </label>
              <Button
                variant={batchMode ? 'secondary' : 'outline'}
                size="sm"
                onClick={() => {
                  setBatchMode((m) => !m)
                  setBatchIds(new Set())
                  lastBatchClickRef.current = null
                }}
              >
                <CheckSquareIcon /> {batchMode ? '退出批量' : '批量管理'}
              </Button>
            </div>

            {/* 推荐勾选说明 */}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>默认勾选：重要人物，以及出现在不止一段里的地点、组织、名词。行前复选框控制是否进世界书。</span>
              {review.selected !== null && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    saveReview({ ...review, selected: null })
                    toast.success('已恢复推荐勾选')
                  }}
                >
                  <RotateCcwIcon /> 恢复推荐勾选
                </Button>
              )}
            </div>

            {/* 批量操作条 */}
            {batchMode && (
              <div className="sticky top-14 z-10 flex flex-wrap items-center gap-1.5 rounded-lg border bg-background/95 p-2 shadow-sm backdrop-blur">
                <span className="px-1 text-xs font-medium">已选 {validBatchEntities.length} 个</span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setBatchIds(new Set(visibleEntities.map((e) => e.id)))}
                >
                  全选
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setBatchIds(new Set())}>
                  清空
                </Button>
                <div className="flex-1" />
                <Button
                  size="xs"
                  variant="outline"
                  disabled={validBatchEntities.length < 2}
                  onClick={openMergeDialog}
                >
                  <GitMergeIcon /> 合并
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={validBatchEntities.length === 0}
                  onClick={() => batchSetLorebook(true)}
                >
                  勾选进世界书
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={validBatchEntities.length === 0}
                  onClick={() => batchSetLorebook(false)}
                >
                  取消进世界书
                </Button>
                <Button
                  size="xs"
                  variant="destructive"
                  disabled={validBatchEntities.length === 0}
                  onClick={batchHide}
                >
                  <Trash2Icon /> 删除
                </Button>
              </div>
            )}

            <div className="overflow-hidden rounded-xl border bg-card">
              <EntityListView
                key={`${tab}|${query.trim()}|${sort}|${onlySelected}`}
                items={visibleEntities}
                review={review}
                chunkCount={chunkCount}
                activeId={activeEntity?.id ?? null}
                batchMode={batchMode}
                batchIds={batchIds}
                onOpenDetail={handleOpenDetail}
                onToggleLorebook={(e, on) => saveReview(setSelected(review, entities, [e], on, chunkCount))}
                onToggleBatch={toggleBatchId}
              />
            </div>

            {/* 已删除对象折叠区 */}
            {hiddenEntities.length > 0 && (
              <Collapsible className="rounded-xl border bg-card">
                <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:text-foreground">
                  <ChevronRightIcon className="size-4 transition-transform group-data-[state=open]:rotate-90" />
                  <span>已删除 {hiddenEntities.length} 个</span>
                </CollapsibleTrigger>
                <CollapsibleContent className="divide-y border-t">
                  {hiddenEntities.map((e) => (
                    <div key={e.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                      <button
                        type="button"
                        onClick={() => setActiveId(e.id)}
                        className="min-w-0 flex-1 truncate text-left text-muted-foreground line-through hover:text-foreground"
                      >
                        {e.name}
                      </button>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          saveReview(setHidden(review, [e], false))
                          toast.success(`已恢复「${e.name}」`)
                        }}
                      >
                        <RotateCcwIcon /> 恢复
                      </Button>
                    </div>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>

          {/* 右：桌面详情面板 */}
          {isDesktop && (
            <aside className="sticky top-16 max-h-[calc(100svh-5rem)] overflow-y-auto rounded-xl border bg-card p-4">
              {detailNode ? (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-muted-foreground">对象详情</h3>
                    <Button size="icon-xs" variant="ghost" aria-label="关闭详情" onClick={() => setActiveId(null)}>
                      <XIcon />
                    </Button>
                  </div>
                  {detailNode}
                </div>
              ) : (
                <div className="flex min-h-48 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                  <p>点左侧任意一项查看各段资料</p>
                  <p className="text-xs">支持改名、拆出误合并的别名；按 Ctrl/Shift 点击可快速批量合并或删除。</p>
                </div>
              )}
            </aside>
          )}
        </div>
      )}

      {/* 时间线 */}
      {tab === 'timeline' && <TimelineView items={timeline} />}

      {/* 世界观 */}
      {tab === 'world' && (
        <div className="rounded-xl border bg-card p-4">
          {worldLines.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">还没有抽取出世界观条目</p>
          ) : (
            <ul className="flex flex-col divide-y text-sm">
              {worldLines.map((line, idx) => (
                <li key={idx} className="flex gap-2.5 py-2.5 first:pt-0 last:pb-0">
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{idx + 1}.</span>
                  <span className="whitespace-pre-wrap">{line}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 手机端详情 Sheet */}
      {!isDesktop && (
        <Sheet open={!!activeEntity} onOpenChange={(open) => !open && setActiveId(null)}>
          <SheetContent side="bottom" className="h-[85svh] overflow-y-auto p-4">
            <SheetHeader className="p-0 pb-2">
              <SheetTitle>{activeEntity?.name ?? '对象详情'}</SheetTitle>
              <SheetDescription>可以修改名字、拆出误合并的名字，或查看各章节块的抽取资料。</SheetDescription>
            </SheetHeader>
            {detailNode}
          </SheetContent>
        </Sheet>
      )}

      {/* 合并确认对话框（可先选哪个当主名） */}
      <Dialog open={!!mergeTargets} onOpenChange={(open) => !open && setMergeTargets(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>合并选中的 {mergeTargets?.length ?? 0} 个对象</DialogTitle>
            <DialogDescription>
              选一个作为合并后的主名，其余名字会保留为别名，各段资料会合在一起。
            </DialogDescription>
          </DialogHeader>
          {mergeTargets && (
            <RadioGroup value={mergePrimaryId} onValueChange={setMergePrimaryId} className="max-h-60 overflow-y-auto">
              {mergeTargets.map((item) => (
                <label
                  key={item.id}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg border p-2.5 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5"
                >
                  <RadioGroupItem value={item.id} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{item.name}</div>
                    <div className="text-xs text-muted-foreground">出现 {entityChunkCount(item)} 段</div>
                  </div>
                </label>
              ))}
            </RadioGroup>
          )}
          {mergeTargets && (
            <p className="text-xs text-muted-foreground">
              将合并成「{(mergeTargets.find((e) => e.id === mergePrimaryId) ?? mergeTargets[0]).name}」
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMergeTargets(null)}>
              取消
            </Button>
            <Button onClick={confirmMerge}>确认合并</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
