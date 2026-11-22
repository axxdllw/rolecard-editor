/**
 * ② 抽取：查看分块抽取进度、控制开始/暂停/重试，展开每块的剧情概要并支持单块重抽。
 */
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
  LoaderIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { AiProfile } from '@/core/ai/types'
import { isHidden } from '@/core/novel/merge'
import type { ChunkPlan, MergedEntity } from '@/core/novel/types'
import type { NovelChunkRecord, NovelRecord } from '@/db/db'
import { cn } from '@/lib/utils'
import { deleteChunkRecords } from '@/services/novels'
import { useExtractRunner } from './extractRunner'
import { formatWanChars, type NovelStep } from './novelHelpers'

const CHUNK_PAGE_SIZE = 100

export interface ExtractStepProps {
  novel: NovelRecord
  records: NovelChunkRecord[]
  plans: ChunkPlan[]
  entities: MergedEntity[]
  profile: AiProfile | null
  onGoStep: (step: NovelStep) => void
}

function chapterRangeTitle(plan: ChunkPlan, toc: NovelRecord['toc']): string {
  const start = toc[plan.chapterStart]?.title ?? ''
  const end = toc[plan.chapterEnd]?.title ?? ''
  if (!start && !end) return ''
  if (plan.chapterStart === plan.chapterEnd || !end) return start
  return `${start} ～ ${end}`
}

export function ExtractStep({ novel, records, plans, entities, profile, onGoStep }: ExtractStepProps) {
  const runnerNovelId = useExtractRunner((s) => s.novelId)
  const runnerRunning = useExtractRunner((s) => s.running)
  const runnerActive = useExtractRunner((s) => s.active)
  const runnerFatal = useExtractRunner((s) => s.fatal)
  const startExtract = useExtractRunner((s) => s.start)
  const stopExtract = useExtractRunner((s) => s.stop)

  const [limit, setLimit] = useState(CHUNK_PAGE_SIZE)

  const isThisBook = runnerNovelId === novel.id
  const isRunningHere = runnerRunning && isThisBook
  const isRunningOther = runnerRunning && !isThisBook
  const fatal = isThisBook ? runnerFatal : null

  const activeSet = useMemo(() => new Set(isRunningHere ? runnerActive : []), [isRunningHere, runnerActive])
  const recordMap = useMemo(() => new Map(records.map((r) => [r.planId, r])), [records])

  const stats = useMemo(() => {
    let done = 0
    let active = 0
    const failedIds: string[] = []
    for (const plan of plans) {
      if (activeSet.has(plan.id)) {
        active++
        continue
      }
      const rec = recordMap.get(plan.id)
      if (rec?.status === 'done') done++
      else if (rec?.status === 'error') failedIds.push(plan.id)
    }
    const pending = Math.max(0, plans.length - done - active - failedIds.length)
    return { done, active, failedIds, pending }
  }, [plans, activeSet, recordMap])

  const entityCounts = useMemo(() => {
    const counts = { character: 0, place: 0, organization: 0, term: 0 }
    for (const e of entities) {
      if (isHidden(e, novel.review)) continue
      counts[e.kind]++
    }
    return counts
  }, [entities, novel.review])

  const progressPercent = plans.length > 0 ? Math.round((stats.done / plans.length) * 100) : 0
  const hasTodo = stats.pending > 0 || stats.failedIds.length > 0

  const handleStart = (onlyIds?: string[]) => {
    if (!profile || runnerRunning) return
    void startExtract({ novel, plans, profile, onlyIds })
  }

  const handleReExtract = async (planId: string) => {
    if (!profile || runnerRunning) return
    await deleteChunkRecords(novel.id, [planId])
    void startExtract({ novel, plans, profile, onlyIds: [planId] })
  }

  const shownPlans = plans.slice(0, limit)

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部控制与进度卡片 */}
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">
              已完成 {stats.done} / {plans.length} 块（{progressPercent}%）
            </span>
            {stats.active > 0 && (
              <Badge variant="outline" className="border-primary/40 text-primary">
                <LoaderIcon className="size-3 animate-spin" /> 进行中 {stats.active}
              </Badge>
            )}
            {stats.failedIds.length > 0 && <Badge variant="destructive">失败 {stats.failedIds.length}</Badge>}
            {stats.pending > 0 && <Badge variant="secondary">待处理 {stats.pending}</Badge>}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isRunningHere ? (
              <Button variant="outline" onClick={stopExtract}>
                <PauseIcon /> 暂停
              </Button>
            ) : (
              <>
                <Button disabled={!profile || !hasTodo || isRunningOther} onClick={() => handleStart()}>
                  <PlayIcon /> {stats.done > 0 ? '继续抽取' : '开始抽取'}
                </Button>
                {stats.failedIds.length > 0 && (
                  <Button
                    variant="outline"
                    disabled={!profile || isRunningOther}
                    onClick={() => handleStart(stats.failedIds)}
                  >
                    <RotateCcwIcon /> 重试失败的（{stats.failedIds.length}）
                  </Button>
                )}
              </>
            )}
            {stats.done > 0 && (
              <Button variant="secondary" onClick={() => onGoStep('review')}>
                去整理 <ArrowRightIcon />
              </Button>
            )}
          </div>
        </div>

        {/* 进度条 */}
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            抽取在后台进行，可以切到别的步骤看结果；关闭或刷新页面会中断，已完成的块会保存。
            {isRunningHere && ' 点暂停后，正在进行的请求会被取消。'}
          </span>
          {stats.done > 0 && (
            <span className="text-foreground">
              已整理：人物 {entityCounts.character} · 地点 {entityCounts.place} · 组织 {entityCounts.organization} ·
              名词 {entityCounts.term}
            </span>
          )}
        </div>

        {!profile && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed p-3 text-sm">
            <span>还没设置 AI 接口，无法开始抽取。</span>
            <Button size="sm" asChild>
              <Link to="/settings">去设置</Link>
            </Button>
          </div>
        )}

        {isRunningOther && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            另一本书正在抽取中，等它完成或暂停后才能继续这一本。
          </div>
        )}

        {fatal && (
          <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
              <span className="break-words">抽取已中止：{fatal}</span>
            </div>
            <Button size="sm" variant="outline" asChild className="shrink-0">
              <Link to="/settings">去设置</Link>
            </Button>
          </div>
        )}
      </section>

      {/* 块列表 */}
      {plans.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          <p>当前没有规划好的分块，请先选一些章节。</p>
          <Button variant="outline" size="sm" onClick={() => onGoStep('range')}>
            去选范围
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {shownPlans.map((plan) => {
            const isActive = activeSet.has(plan.id)
            const rec = recordMap.get(plan.id)
            const isDone = !isActive && rec?.status === 'done' && !!rec.extraction
            const isError = !isActive && rec?.status === 'error'
            const rangeTitle = chapterRangeTitle(plan, novel.toc)

            if (isDone && rec?.extraction) {
              const ex = rec.extraction
              return (
                <Collapsible key={plan.id} className="rounded-lg border bg-card">
                  <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 text-left text-sm">
                      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                      <span className="shrink-0 font-medium">{plan.label}</span>
                      {plan.sampled && (
                        <Badge variant="secondary" className="shrink-0">
                          抽样
                        </Badge>
                      )}
                      {rangeTitle && (
                        <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:inline">
                          {rangeTitle}
                        </span>
                      )}
                    </CollapsibleTrigger>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatWanChars(plan.chars)}</span>
                    <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                      <CheckIcon className="size-3.5" />
                      人物 {ex.characters.length} · 地点 {ex.places.length} · 事件 {ex.events.length}
                    </span>
                  </div>
                  <CollapsibleContent className="border-t px-3 py-2.5 text-sm">
                    {rangeTitle && <p className="mb-1.5 text-xs text-muted-foreground sm:hidden">{rangeTitle}</p>}
                    <p className="whitespace-pre-wrap text-muted-foreground">
                      {ex.summary || '（这一块没有剧情概要）'}
                    </p>
                    <div className="mt-2.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>
                        组织 {ex.organizations.length} · 名词 {ex.terms.length} · 世界观 {ex.world.length}
                      </span>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!profile || runnerRunning}
                        onClick={() => void handleReExtract(plan.id)}
                      >
                        <RotateCcwIcon /> 重新抽取
                      </Button>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )
            }

            // 失败且留下了模型回复：可以展开看模型到底回了什么
            if (isError && rec?.errorOutput) {
              const out = rec.errorOutput
              return (
                <Collapsible key={plan.id} className="rounded-lg border border-destructive/40 bg-destructive/5">
                  <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <CollapsibleTrigger
                      className="group flex min-w-0 flex-1 items-center gap-2 text-left"
                      title="查看模型的回复"
                    >
                      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                      <span className="shrink-0 font-medium">{plan.label}</span>
                      {plan.sampled && (
                        <Badge variant="secondary" className="shrink-0">
                          抽样
                        </Badge>
                      )}
                      {rangeTitle && (
                        <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:inline">
                          {rangeTitle}
                        </span>
                      )}
                    </CollapsibleTrigger>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatWanChars(plan.chars)}</span>
                    <div className="flex w-full items-center justify-between gap-2 pt-1 text-xs text-destructive sm:w-auto sm:pt-0">
                      <span className="break-words">{rec.error || '抽取失败'}</span>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!profile || runnerRunning}
                        onClick={() => handleStart([plan.id])}
                      >
                        <RotateCcwIcon /> 重试
                      </Button>
                    </div>
                  </div>
                  <CollapsibleContent className="border-t border-destructive/20 px-3 py-2.5 text-xs">
                    <p className="mb-1.5 text-muted-foreground">
                      模型的回复：{out.chars > 0 ? `共 ${out.chars} 字` : '没有回复内容'}
                      {out.finishReason && ` · 结束原因 ${out.finishReason}`}
                    </p>
                    {out.text && (
                      <pre className="max-h-60 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-foreground/80">
                        {out.text}
                      </pre>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              )
            }

            return (
              <div
                key={plan.id}
                className={cn(
                  'flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm',
                  isActive && 'border-primary/40 bg-primary/5',
                  isError && 'border-destructive/40 bg-destructive/5',
                )}
              >
                <span className="shrink-0 font-medium">{plan.label}</span>
                {plan.sampled && (
                  <Badge variant="secondary" className="shrink-0">
                    抽样
                  </Badge>
                )}
                {rangeTitle && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{rangeTitle}</span>}
                {!rangeTitle && <div className="flex-1" />}
                <span className="shrink-0 text-xs text-muted-foreground">{formatWanChars(plan.chars)}</span>
                {isActive ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-primary">
                    <LoaderIcon className="size-3.5 animate-spin" /> 抽取中…
                  </span>
                ) : isError ? (
                  <div className="flex w-full items-center justify-between gap-2 pt-1 text-xs text-destructive sm:w-auto sm:pt-0">
                    <span className="break-words">{rec?.error || '抽取失败'}</span>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!profile || runnerRunning}
                      onClick={() => handleStart([plan.id])}
                    >
                      <RotateCcwIcon /> 重试
                    </Button>
                  </div>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">待处理</span>
                )}
              </div>
            )
          })}

          {plans.length > limit && (
            <Button variant="outline" size="sm" className="mt-1 self-center" onClick={() => setLimit((n) => n + CHUNK_PAGE_SIZE)}>
              还有 {plans.length - limit} 块，继续显示
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
