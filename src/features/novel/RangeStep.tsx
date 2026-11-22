/**
 * ① 选范围：挑选要精读的章节、配置分块与抽样参数、查看请求与费用预估并开始抽取。
 */
import { AlertTriangleIcon, ChevronDownIcon, PlayIcon, SearchIcon, Trash2Icon } from 'lucide-react'
import { useMemo, useRef, useState, type MouseEvent } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { AiProfile, ReasoningEffort } from '@/core/ai/types'
import { estimateExtraction } from '@/core/novel/chunk'
import type { ChunkPlan } from '@/core/novel/types'
import type { NovelChunkRecord, NovelRecord, NovelSettings } from '@/db/db'
import { PROVIDER_LABELS } from '@/lib/aiSettings'
import { cn } from '@/lib/utils'
import { pruneChunkRecords, updateNovel } from '@/services/novels'
import { useExtractRunner } from './extractRunner'
import {
  APPEND_CHAR_OPTIONS,
  CHUNK_CHAR_OPTIONS,
  CONCURRENCY_OPTIONS,
  formatChapterChars,
  formatDurationMinutes,
  formatWanChars,
  formatWanTokens,
  REASONING_OPTIONS,
  SAMPLE_COUNT_OPTIONS,
  type NovelStep,
} from './novelHelpers'

const CHAPTER_PAGE_SIZE = 300
const DEFAULT_PROFILE_VALUE = '__default__'

interface ChapterItem {
  index: number
  title: string
  volume?: string
  chars: number
  /** 所属卷段的唯一标识（按连续相同卷名切分） */
  volumeGroupId: string | null
}

interface VolumeGroupInfo {
  id: string
  title: string
  indices: number[]
  chars: number
}

interface ChapterListViewProps {
  items: ChapterItem[]
  volumeGroups: Map<string, VolumeGroupInfo>
  selectedSet: ReadonlySet<number>
  onToggleChapter: (chapterIndex: number, shiftKey: boolean) => void
  onToggleVolume: (group: VolumeGroupInfo) => void
}

/** 分页展示章节列表；通过父组件传入 key={query} 在搜索条件变化时自然重置分页 */
function ChapterListView({ items, volumeGroups, selectedSet, onToggleChapter, onToggleVolume }: ChapterListViewProps) {
  const [limit, setLimit] = useState(CHAPTER_PAGE_SIZE)
  const shown = items.slice(0, limit)

  if (items.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">没有匹配的章节</p>
  }

  return (
    <div className="flex flex-col">
      {shown.map((item, pos) => {
        const prev = pos > 0 ? shown[pos - 1] : null
        const showVolumeHeader = item.volumeGroupId !== null && item.volumeGroupId !== prev?.volumeGroupId
        const group = showVolumeHeader && item.volumeGroupId ? volumeGroups.get(item.volumeGroupId) : undefined
        const groupSelectedCount = group ? group.indices.filter((i) => selectedSet.has(i)).length : 0
        const groupAllSelected = group ? groupSelectedCount === group.indices.length && group.indices.length > 0 : false
        const checked = selectedSet.has(item.index)

        return (
          <div key={item.index}>
            {group && (
              <button
                type="button"
                onClick={() => onToggleVolume(group)}
                className="flex w-full items-center gap-2 border-b bg-muted/50 px-3 py-1.5 text-left text-xs font-medium hover:bg-muted"
              >
                <input
                  type="checkbox"
                  readOnly
                  checked={groupAllSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = groupSelectedCount > 0 && !groupAllSelected
                  }}
                  tabIndex={-1}
                  className="pointer-events-none size-3.5 shrink-0 accent-primary"
                />
                <span className="truncate">{group.title}</span>
                <span className="ml-auto shrink-0 font-normal text-muted-foreground">
                  {groupSelectedCount}/{group.indices.length} 章 · {formatWanChars(group.chars)}
                </span>
              </button>
            )}
            <div
              role="checkbox"
              aria-checked={checked}
              tabIndex={0}
              onClick={(e: MouseEvent) => onToggleChapter(item.index, e.shiftKey)}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault()
                  onToggleChapter(item.index, e.shiftKey)
                }
              }}
              className={cn(
                'flex cursor-pointer select-none items-center gap-2.5 border-b px-3 py-1.5 text-sm transition-colors hover:bg-muted/40',
                checked && 'bg-primary/5',
              )}
            >
              <input
                type="checkbox"
                checked={checked}
                readOnly
                tabIndex={-1}
                className="pointer-events-none size-4 shrink-0 accent-primary"
              />
              <span className="w-10 shrink-0 text-right font-mono text-xs text-muted-foreground">{item.index + 1}</span>
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatChapterChars(item.chars)}</span>
            </div>
          </div>
        )
      })}
      {items.length > limit && (
        <div className="flex flex-wrap items-center justify-center gap-2 p-3">
          <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + CHAPTER_PAGE_SIZE)}>
            还有 {items.length - limit} 章，继续显示
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setLimit(items.length)}>
            显示全部
          </Button>
        </div>
      )}
    </div>
  )
}

export interface RangeStepProps {
  novel: NovelRecord
  records: NovelChunkRecord[]
  plans: ChunkPlan[]
  profile: AiProfile | null
  profiles: AiProfile[]
  onGoStep: (step: NovelStep) => void
}

export function RangeStep({ novel, records, plans, profile, profiles, onGoStep }: RangeStepProps) {
  const runnerNovelId = useExtractRunner((s) => s.novelId)
  const runnerRunning = useExtractRunner((s) => s.running)
  const startExtract = useExtractRunner((s) => s.start)

  const [query, setQuery] = useState('')
  const [firstNText, setFirstNText] = useState('50')
  const [pruning, setPruning] = useState(false)
  const lastClickedRef = useRef<number | null>(null)

  const selectedSet = useMemo(() => new Set(novel.selected), [novel.selected])

  // 预先整理章节与卷分组
  const { allItems, volumeGroups } = useMemo(() => {
    const groups = new Map<string, VolumeGroupInfo>()
    const items: ChapterItem[] = []
    let currentGroup: VolumeGroupInfo | null = null
    let groupSeq = 0

    novel.toc.forEach((ch, index) => {
      const vol = ch.volume?.trim()
      if (vol) {
        if (!currentGroup || currentGroup.title !== vol) {
          groupSeq++
          currentGroup = { id: `v${groupSeq}`, title: vol, indices: [], chars: 0 }
          groups.set(currentGroup.id, currentGroup)
        }
        currentGroup.indices.push(index)
        currentGroup.chars += ch.chars
        items.push({ index, title: ch.title, volume: vol, chars: ch.chars, volumeGroupId: currentGroup.id })
      } else {
        currentGroup = null
        items.push({ index, title: ch.title, chars: ch.chars, volumeGroupId: null })
      }
    })
    return { allItems: items, volumeGroups: groups }
  }, [novel.toc])

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allItems
    return allItems.filter(
      (item) => item.title.toLowerCase().includes(q) || (item.volume && item.volume.toLowerCase().includes(q)),
    )
  }, [allItems, query])

  const selectedChars = useMemo(() => {
    let sum = 0
    for (const i of selectedSet) {
      sum += novel.toc[i]?.chars ?? 0
    }
    return sum
  }, [novel.toc, selectedSet])

  const { sampledCount, doneInPlanCount, pendingPlans, staleCount, estimate } = useMemo(() => {
    const doneSet = new Set(records.filter((r) => r.status === 'done').map((r) => r.planId))
    const planIds = new Set(plans.map((p) => p.id))
    let sampled = 0
    let doneInPlan = 0
    const pending: ChunkPlan[] = []
    for (const p of plans) {
      if (p.sampled) sampled++
      if (doneSet.has(p.id)) doneInPlan++
      else pending.push(p)
    }
    const stale = records.filter((r) => !planIds.has(r.planId)).length
    return {
      sampledCount: sampled,
      doneInPlanCount: doneInPlan,
      pendingPlans: pending,
      staleCount: stale,
      estimate: estimateExtraction(pending),
    }
  }, [plans, records])

  const saveSelected = (next: Set<number>) => {
    const sorted = [...next].filter((i) => i >= 0 && i < novel.toc.length).sort((a, b) => a - b)
    void updateNovel(novel.id, { selected: sorted })
  }

  const updateSettings = (patch: Partial<NovelSettings>) => {
    void updateNovel(novel.id, { settings: { ...novel.settings, ...patch } })
  }

  const handleToggleChapter = (chapterIndex: number, shiftKey: boolean) => {
    const next = new Set(selectedSet)
    const targetChecked = !next.has(chapterIndex)

    if (shiftKey && lastClickedRef.current !== null) {
      const anchor = lastClickedRef.current
      const posA = filteredItems.findIndex((i) => i.index === anchor)
      const posB = filteredItems.findIndex((i) => i.index === chapterIndex)
      if (posA >= 0 && posB >= 0) {
        const [from, to] = posA < posB ? [posA, posB] : [posB, posA]
        for (let pos = from; pos <= to; pos++) {
          const idx = filteredItems[pos].index
          if (targetChecked) next.add(idx)
          else next.delete(idx)
        }
      } else {
        const [from, to] = anchor < chapterIndex ? [anchor, chapterIndex] : [chapterIndex, anchor]
        for (let idx = from; idx <= to; idx++) {
          if (targetChecked) next.add(idx)
          else next.delete(idx)
        }
      }
    } else {
      if (targetChecked) next.add(chapterIndex)
      else next.delete(chapterIndex)
    }

    lastClickedRef.current = chapterIndex
    saveSelected(next)
  }

  const handleToggleVolume = (group: VolumeGroupInfo) => {
    const allChecked = group.indices.every((i) => selectedSet.has(i))
    const next = new Set(selectedSet)
    for (const i of group.indices) {
      if (allChecked) next.delete(i)
      else next.add(i)
    }
    saveSelected(next)
  }

  const selectAll = () => saveSelected(new Set(novel.toc.map((_, i) => i)))
  const selectNone = () => saveSelected(new Set())

  const selectFirstN = () => {
    const n = Math.max(0, Math.min(novel.toc.length, Math.floor(Number(firstNText) || 0)))
    if (n <= 0) {
      toast.error('请输入大于 0 的章数')
      return
    }
    const next = new Set<number>()
    for (let i = 0; i < n; i++) next.add(i)
    saveSelected(next)
  }

  const appendByChars = (targetChars: number) => {
    const last = novel.selected.length > 0 ? Math.max(...novel.selected) : -1
    const start = last + 1
    if (start >= novel.toc.length) {
      toast('已经选到最后一章了')
      return
    }
    const next = new Set(selectedSet)
    let addedChars = 0
    let addedCount = 0
    for (let i = start; i < novel.toc.length; i++) {
      if (addedCount > 0 && addedChars >= targetChars) break
      next.add(i)
      addedChars += novel.toc[i].chars
      addedCount++
    }
    saveSelected(next)
    toast.success(`已往后再选 ${addedCount} 章（${formatWanChars(addedChars)}）`)
  }

  const handlePrune = async () => {
    setPruning(true)
    try {
      const removed = await pruneChunkRecords(novel.id, plans)
      toast.success(`已清理 ${removed} 块旧结果`)
    } finally {
      setPruning(false)
    }
  }

  const isRunningHere = runnerRunning && runnerNovelId === novel.id
  const isRunningOther = runnerRunning && runnerNovelId !== novel.id

  const handleStart = () => {
    if (isRunningHere || (pendingPlans.length === 0 && plans.length > 0)) {
      onGoStep('extract')
      return
    }
    if (!profile || plans.length === 0 || isRunningOther) return
    void startExtract({ novel, plans, profile })
    onGoStep('extract')
  }

  const profileSelectValue =
    novel.settings.profileId && profiles.some((p) => p.id === novel.settings.profileId)
      ? novel.settings.profileId
      : DEFAULT_PROFILE_VALUE

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
      {/* 左栏：章节选择 */}
      <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-col gap-2.5 border-b p-3">
          <div className="relative">
            <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="按章节标题或卷名筛选"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={selectAll}>
              全选
            </Button>
            <Button size="sm" variant="outline" onClick={selectNone}>
              全不选
            </Button>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={1}
                max={novel.toc.length}
                value={firstNText}
                onChange={(e) => setFirstNText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && selectFirstN()}
                aria-label="前多少章"
                className="h-7 w-18 px-2 text-xs"
              />
              <Button size="sm" variant="outline" onClick={selectFirstN}>
                选前 N 章
              </Button>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  往后再选… <ChevronDownIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {APPEND_CHAR_OPTIONS.map((opt) => (
                  <DropdownMenuItem key={opt.chars} onClick={() => appendByChars(opt.chars)}>
                    从当前位置往后再选约 {opt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              已选 <strong className="text-foreground">{selectedSet.size}</strong> / {novel.toc.length} 章（
              {formatWanChars(selectedChars)}）
            </span>
            <span>按住 Shift 点击可连选范围；点卷标题可整卷切换</span>
          </div>
        </div>

        <div className="max-h-[65svh] overflow-y-auto lg:max-h-[70svh]">
          <ChapterListView
            key={query.trim()}
            items={filteredItems}
            volumeGroups={volumeGroups}
            selectedSet={selectedSet}
            onToggleChapter={handleToggleChapter}
            onToggleVolume={handleToggleVolume}
          />
        </div>
      </section>

      {/* 右栏：设置、预估与开始按钮 */}
      <aside className="flex flex-col gap-3">
        <div className="flex flex-col gap-3.5 rounded-xl border bg-card p-4">
          <h2 className="font-medium">抽取设置</h2>

          <div className="flex flex-col gap-1.5">
            <Label>每块字数</Label>
            <Select
              value={String(novel.settings.chunkChars)}
              onValueChange={(v) => updateSettings({ chunkChars: Number(v) })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHUNK_CHAR_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={String(opt.value)}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">块越大请求越少，但每块整理得越粗</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>全书抽样块数</Label>
            <Select
              value={String(novel.settings.sampleCount)}
              onValueChange={(v) => updateSettings({ sampleCount: Number(v) })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SAMPLE_COUNT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={String(opt.value)}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              从没选的章节里均匀抽几块，补全书的人物和世界观，不保证剧情连贯
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>同时请求数</Label>
              <Select
                value={String(novel.settings.concurrency)}
                onValueChange={(v) => updateSettings({ concurrency: Number(v) })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONCURRENCY_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} 个
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>思考强度</Label>
              <Select
                value={novel.settings.reasoningEffort}
                onValueChange={(v) => updateSettings({ reasoningEffort: v as 'profile' | ReasoningEffort })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REASONING_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">思考强度只对 OpenAI 兼容接口生效</p>

          <div className="flex flex-col gap-1.5">
            <Label>AI 接口</Label>
            {profiles.length === 0 ? (
              <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                <span>还没配置 AI 接口，去设置页添加一个后就能开始抽取。</span>
                <Button size="xs" asChild>
                  <Link to="/settings">去设置</Link>
                </Button>
              </div>
            ) : (
              <Select
                value={profileSelectValue}
                onValueChange={(v) => updateSettings({ profileId: v === DEFAULT_PROFILE_VALUE ? null : v })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_PROFILE_VALUE}>
                    跟随当前接口{profile ? `（${profile.name}）` : ''}
                  </SelectItem>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} · {p.model || PROVIDER_LABELS[p.kind]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>

        {/* 预估卡片 */}
        <div className="flex flex-col gap-2.5 rounded-xl border bg-card p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">预估用量</h2>
            {sampledCount > 0 && <Badge variant="secondary">含抽样 {sampledCount} 块</Badge>}
          </div>

          <div className="flex flex-col gap-1.5 text-sm">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">已选范围</span>
              <span>
                {selectedSet.size} 章 · {formatWanChars(selectedChars)}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">计划分块</span>
              <span>
                {plans.length} 块{doneInPlanCount > 0 ? `（已完成 ${doneInPlanCount} 块可复用）` : ''}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">还需请求</span>
              <span className="font-medium">{estimate.requests} 次</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">输入 / 输出</span>
              <span className="text-right">
                约 {formatWanTokens(estimate.inputTokens)} / {formatWanTokens(estimate.outputTokens)}
              </span>
            </div>
            <p className="text-right text-xs text-muted-foreground">输出不含思考 token</p>
            <div className="flex justify-between gap-2 border-t pt-1.5">
              <span className="text-muted-foreground">预计用时</span>
              <span>{formatDurationMinutes(estimate.requests, novel.settings.concurrency)}</span>
            </div>
          </div>

          {estimate.requests > 100 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>请求比较多，可以先选一部分试试效果</span>
            </div>
          )}

          <Button
            size="lg"
            className="mt-1 w-full"
            disabled={isRunningOther || (!isRunningHere && (plans.length === 0 || (pendingPlans.length > 0 && !profile)))}
            onClick={handleStart}
          >
            <PlayIcon />
            {isRunningHere
              ? '正在抽取，查看进度'
              : pendingPlans.length === 0 && plans.length > 0
                ? '当前范围已抽完，去查看'
                : '开始抽取'}
          </Button>

          {isRunningOther && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              另一本书正在抽取中，等它完成或暂停后才能开始这一本。
            </p>
          )}

          {staleCount > 0 && (
            <div className="flex items-center justify-between gap-2 border-t pt-2.5 text-xs text-muted-foreground">
              <span>有 {staleCount} 块旧结果不在当前范围里</span>
              <Button size="xs" variant="ghost" disabled={pruning} onClick={handlePrune}>
                <Trash2Icon /> 清理
              </Button>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
