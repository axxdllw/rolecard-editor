/**
 * 右侧结果区“条目触发情况”面板：展示每个世界书条目的激活或跳过原因、命中关键词与来源。
 */
import { ArrowUpRightIcon, ChevronRightIcon, SearchIcon, XIcon } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { LorebookEntry } from '@/core/card/types'
import type { ActivationReason, EntryTrace, GlobalScanData, SkipReason, TurnResult } from '@/core/lorebook/activate'
import { entryTitle, readEntrySettings } from '@/core/lorebook/entry'
import { cn } from '@/lib/utils'

interface TraceSectionProps {
  entries: LorebookEntry[]
  turn: TurnResult | null
  hasGreeting: boolean
  onJumpToEntry?: (index: number) => void
}

type TraceFilter = 'activated' | 'skipped' | 'all'

const PAGE_SIZE = 200
const EMPTY_TRACES: EntryTrace[] = []

const ACTIVATION_BADGE: Record<ActivationReason, { label: string; className: string }> = {
  constant: {
    label: '常驻',
    className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
  keyword: {
    label: '关键词',
    className: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  },
  sticky: {
    label: '粘性',
    className: 'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  },
  decorator: {
    label: '装饰器',
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
}

const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  disabled: '未启用',
  'trigger-filter': '生成类型不符',
  delay: '消息数不够',
  cooldown: '冷却中',
  'delay-until-recursion': '只能被递归触发',
  'exclude-recursion': '不被递归触发',
  'dont-activate': '装饰器禁止',
  'no-keys': '没有关键词',
  'no-match': '关键词没命中',
  secondary: '次要关键词不满足',
  group: '包含组落选',
  probability: '概率没中',
  budget: '超出预算',
  'not-scanned': '扫描提前结束',
}

/** 未触发原因的排序权重：越值得排查的原因越靠前 */
const SKIP_PRIORITY: Record<SkipReason, number> = {
  budget: 1,
  probability: 2,
  group: 3,
  secondary: 4,
  cooldown: 5,
  delay: 6,
  'exclude-recursion': 7,
  'delay-until-recursion': 8,
  'dont-activate': 9,
  'trigger-filter': 10,
  'not-scanned': 11,
  disabled: 12,
  'no-match': 20,
  'no-keys': 21,
}

const GLOBAL_FIELD_LABEL: Record<keyof GlobalScanData, string> = {
  personaDescription: '用户人设',
  characterDescription: '角色描述',
  characterPersonality: '角色性格',
  characterDepthPrompt: '角色注释',
  scenario: '场景',
  creatorNotes: '创作者备注',
}

function isQuietSkip(trace: EntryTrace): boolean {
  return trace.status === 'skipped' && (trace.reason === 'no-match' || trace.reason === 'no-keys')
}

function skipBadgeClass(reason: SkipReason): string {
  switch (reason) {
    case 'budget':
      return 'border-destructive/40 bg-destructive/10 text-destructive'
    case 'probability':
    case 'group':
    case 'secondary':
    case 'cooldown':
    case 'delay':
    case 'exclude-recursion':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    default:
      return 'border-border bg-muted/60 text-muted-foreground'
  }
}

function formatRoll(roll: number, probability: number): string {
  const rounded = Math.round(roll)
  // 如果刚好四舍五入后和概率相等但其实没中，保留一位小数以免误解
  const numText = roll > probability && rounded === probability ? roll.toFixed(1) : String(rounded)
  return `掷出 ${numText}，概率 ${probability}%`
}

function formatScanLoop(loop: number | undefined, scanState: EntryTrace['scanState']): string | null {
  if (!loop || loop <= 1) return null
  if (scanState === 'recursion') return `第 ${loop} 轮扫描（递归）`
  if (scanState === 'min-activations') return `第 ${loop} 轮扫描（凑最少激活数）`
  return `第 ${loop} 轮扫描`
}

function formatMatchSource(
  source: EntryTrace['matchSource'],
  entries: LorebookEntry[],
  hasGreeting: boolean,
): string | null {
  if (!source) return null
  if (source.kind === 'chat') {
    const num = source.messageIndex + 1
    return hasGreeting && source.messageIndex === 0 ? '第 1 条消息（开场白）' : `第 ${num} 条消息`
  }
  if (source.kind === 'recursion') {
    const srcEntry = entries[source.entryIndex]
    const title = srcEntry ? entryTitle(srcEntry, source.entryIndex) : `条目 #${source.entryIndex + 1}`
    return `由「${title}」递归触发`
  }
  return GLOBAL_FIELD_LABEL[source.field]
}

function shouldShowDetail(trace: EntryTrace): boolean {
  if (!trace.detail) return false
  if (trace.status === 'activated') {
    if (trace.reason === 'keyword' && trace.matchedKey) return false
    if (trace.reason === 'constant') return false
    return true
  }
  // 跳过原因里与徽标或掷骰说明完全重复的，不再啰嗦
  if (trace.reason === 'no-match' || trace.reason === 'no-keys' || trace.reason === 'disabled') return false
  if (trace.reason === 'probability' && trace.roll !== undefined) return false
  return true
}

function TraceRow({
  trace,
  entry,
  entries,
  hasGreeting,
  onJumpToEntry,
}: {
  trace: EntryTrace
  entry: LorebookEntry
  entries: LorebookEntry[]
  hasGreeting: boolean
  onJumpToEntry?: (index: number) => void
}) {
  const title = entryTitle(entry, trace.index)
  const badge =
    trace.status === 'activated'
      ? ACTIVATION_BADGE[trace.reason as ActivationReason]
      : { label: SKIP_REASON_LABEL[trace.reason as SkipReason], className: skipBadgeClass(trace.reason as SkipReason) }

  const parts: ReactNode[] = []

  if (trace.matchedKey) {
    parts.push(
      <span key="key" className="inline-flex items-center gap-1">
        <span>命中</span>
        <mark className="rounded bg-sky-500/15 px-1 py-0.5 font-mono text-[11px] font-medium text-sky-800 dark:text-sky-200">
          {trace.matchedKey}
        </mark>
      </span>,
    )
  }

  if (trace.matchedSecondary && trace.matchedSecondary.length > 0) {
    parts.push(
      <span key="secondary" className="inline-flex flex-wrap items-center gap-1">
        <span>次要：</span>
        {trace.matchedSecondary.map((k, idx) => (
          <mark
            key={idx}
            className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground"
          >
            {k}
          </mark>
        ))}
      </span>,
    )
  }

  const sourceText = formatMatchSource(trace.matchSource, entries, hasGreeting)
  if (sourceText) {
    parts.push(<span key="source">{sourceText}</span>)
  }

  const loopText = formatScanLoop(trace.loop, trace.scanState)
  if (loopText) {
    parts.push(<span key="loop">{loopText}</span>)
  }

  if (trace.roll !== undefined) {
    const prob = readEntrySettings(entry).probability
    parts.push(<span key="roll">{formatRoll(trace.roll, prob)}</span>)
  }

  const showDetail = shouldShowDetail(trace)
  const detailAlreadyHasGroup = Boolean(showDetail && trace.group && trace.detail?.includes(trace.group))

  if (trace.group && !detailAlreadyHasGroup) {
    parts.push(
      <span key="group">
        包含组「{trace.group}」{trace.status === 'activated' ? '胜出' : ''}
      </span>,
    )
  }

  if (showDetail && trace.detail) {
    parts.push(<span key="detail">{trace.detail}</span>)
  }

  return (
    <div className="flex flex-col gap-1 rounded-md border bg-background px-2.5 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        {onJumpToEntry ? (
          <button
            type="button"
            onClick={() => onJumpToEntry(trace.index)}
            title="跳到世界书里查看该条目"
            className="group inline-flex min-w-0 items-center gap-0.5 text-left font-medium text-foreground hover:text-primary hover:underline"
          >
            <span className="truncate">{title}</span>
            <ArrowUpRightIcon className="size-3 shrink-0 text-muted-foreground opacity-70 transition group-hover:text-primary group-hover:opacity-100" />
          </button>
        ) : (
          <span className="truncate font-medium">{title}</span>
        )}
        <Badge variant="outline" className={cn('h-4 shrink-0 px-1.5 text-[10px]', badge.className)}>
          {badge.label}
        </Badge>
      </div>
      {parts.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-relaxed text-muted-foreground">
          {parts.map((part, idx) => (
            <span key={idx} className="inline-flex items-center gap-1.5">
              {idx > 0 && <span aria-hidden="true">·</span>}
              {part}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function PagedTraceList({
  traces,
  entries,
  hasGreeting,
  onJumpToEntry,
  resetKey,
}: {
  traces: EntryTrace[]
  entries: LorebookEntry[]
  hasGreeting: boolean
  onJumpToEntry?: (index: number) => void
  resetKey: string
}) {
  const [pageState, setPageState] = useState({ key: resetKey, limit: PAGE_SIZE })
  const limit = pageState.key === resetKey ? pageState.limit : PAGE_SIZE
  const shown = traces.slice(0, limit)

  return (
    <div className="flex flex-col gap-1.5">
      {shown.map((trace) => {
        const entry = entries[trace.index]
        if (!entry) return null
        return (
          <TraceRow
            key={trace.index}
            trace={trace}
            entry={entry}
            entries={entries}
            hasGreeting={hasGreeting}
            onJumpToEntry={onJumpToEntry}
          />
        )
      })}
      {traces.length > limit && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setPageState({ key: resetKey, limit: limit + PAGE_SIZE })}
          className="mt-1"
        >
          还有 {traces.length - limit} 条，继续显示
        </Button>
      )}
    </div>
  )
}

export function TraceSection({ entries, turn, hasGreeting, onJumpToEntry }: TraceSectionProps) {
  const [filter, setFilter] = useState<TraceFilter>('activated')
  const [query, setQuery] = useState('')
  const [quietOpen, setQuietOpen] = useState(false)

  const traces = turn?.traces ?? EMPTY_TRACES
  const activatedOrder = useMemo(() => {
    const map = new Map<number, number>()
    ;(turn?.activated ?? []).forEach((entryIndex, pos) => {
      map.set(entryIndex, pos)
    })
    return map
  }, [turn])

  const activatedCount = turn?.activated.length ?? 0
  const skippedCount = Math.max(0, traces.length - activatedCount)
  const trimmedQuery = query.trim().toLowerCase()

  const { mainList, quietList } = useMemo(() => {
    const matchesSearch = (trace: EntryTrace): boolean => {
      if (!trimmedQuery) return true
      const entry = entries[trace.index]
      if (!entry) return false
      const title = entryTitle(entry, trace.index).toLowerCase()
      if (title.includes(trimmedQuery)) return true
      if (trace.matchedKey?.toLowerCase().includes(trimmedQuery)) return true
      if (trace.group?.toLowerCase().includes(trimmedQuery)) return true
      if (trace.detail?.toLowerCase().includes(trimmedQuery)) return true
      const reasonLabel =
        trace.status === 'activated'
          ? ACTIVATION_BADGE[trace.reason as ActivationReason].label
          : SKIP_REASON_LABEL[trace.reason as SkipReason]
      if (reasonLabel.toLowerCase().includes(trimmedQuery)) return true
      if (entry.keys?.some((k) => k.toLowerCase().includes(trimmedQuery))) return true
      return false
    }

    const activated: EntryTrace[] = []
    const notableSkipped: EntryTrace[] = []
    const quietSkipped: EntryTrace[] = []

    for (const trace of traces) {
      if (filter === 'activated' && trace.status !== 'activated') continue
      if (filter === 'skipped' && trace.status !== 'skipped') continue
      if (!matchesSearch(trace)) continue

      if (trace.status === 'activated') {
        activated.push(trace)
      } else if (isQuietSkip(trace)) {
        quietSkipped.push(trace)
      } else {
        notableSkipped.push(trace)
      }
    }

    activated.sort((a, b) => (activatedOrder.get(a.index) ?? a.index) - (activatedOrder.get(b.index) ?? b.index))
    notableSkipped.sort(
      (a, b) =>
        (SKIP_PRIORITY[a.reason as SkipReason] ?? 99) - (SKIP_PRIORITY[b.reason as SkipReason] ?? 99) ||
        a.index - b.index,
    )
    quietSkipped.sort(
      (a, b) =>
        (SKIP_PRIORITY[a.reason as SkipReason] ?? 99) - (SKIP_PRIORITY[b.reason as SkipReason] ?? 99) ||
        a.index - b.index,
    )

    // 搜索时直接展开全部匹配结果，不藏进折叠区
    if (trimmedQuery) {
      return { mainList: [...activated, ...notableSkipped, ...quietSkipped], quietList: [] as EntryTrace[] }
    }
    return { mainList: [...activated, ...notableSkipped], quietList: quietSkipped }
  }, [traces, entries, filter, trimmedQuery, activatedOrder])

  const resetKey = `${filter}|${trimmedQuery}|${turn?.chatLength ?? 0}|${activatedCount}`

  return (
    <section className="rounded-xl border bg-card p-3">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-semibold">条目触发情况</h3>
          <span className="text-xs text-muted-foreground tabular-nums">
            已触发 {activatedCount} 条 · 未触发 {skippedCount} 条
            {turn && turn.loops > 1 ? ` · 扫描 ${turn.loops} 轮` : ''}
          </span>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative w-40">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="筛选条目或关键词…"
              className="h-7 pr-6 pl-7 text-xs"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="清空搜索"
                className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </div>

          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            value={filter}
            onValueChange={(v) => {
              if (v) setFilter(v as TraceFilter)
            }}
          >
            <ToggleGroupItem value="activated" className="h-7 px-2 text-xs">
              触发的
            </ToggleGroupItem>
            <ToggleGroupItem value="skipped" className="h-7 px-2 text-xs">
              没触发的
            </ToggleGroupItem>
            <ToggleGroupItem value="all" className="h-7 px-2 text-xs">
              全部
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      {mainList.length > 0 && (
        <PagedTraceList
          traces={mainList}
          entries={entries}
          hasGreeting={hasGreeting}
          onJumpToEntry={onJumpToEntry}
          resetKey={`main|${resetKey}`}
        />
      )}

      {quietList.length > 0 && (
        <Collapsible open={quietOpen} onOpenChange={setQuietOpen} className={cn(mainList.length > 0 && 'mt-2')}>
          <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground">
            <ChevronRightIcon className={cn('size-3.5 shrink-0 transition-transform', quietOpen && 'rotate-90')} />
            <span>还有 {quietList.length} 条关键词没命中</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1.5">
            <PagedTraceList
              traces={quietList}
              entries={entries}
              hasGreeting={hasGreeting}
              onJumpToEntry={onJumpToEntry}
              resetKey={`quiet|${resetKey}`}
            />
          </CollapsibleContent>
        </Collapsible>
      )}

      {mainList.length === 0 && quietList.length === 0 && (
        <p className="py-6 text-center text-xs text-muted-foreground">
          {trimmedQuery
            ? '没有找到匹配的条目'
            : filter === 'activated'
              ? '这一轮没有触发任何世界书条目'
              : '没有未触发的条目'}
        </p>
      )}
    </section>
  )
}
