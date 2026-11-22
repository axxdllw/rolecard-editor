/**
 * ④ 生成：配置单角色卡/世界卡参数、预览世界书条目数与请求数、调度 AI 生成，并在结果区逐项勾选建卡或存入世界书库。
 */
import {
  AlertTriangleIcon,
  BookOpenIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  LoaderIcon,
  RotateCcwIcon,
  SparklesIcon,
  SquareIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { DRAFT_FIELDS, draftFieldFilled, type DraftCard, type DraftFieldKey } from '@/core/ai/tasks/draftCard'
import { GENERATED_TYPE_LABELS } from '@/core/ai/tasks/lorebookGen'
import type { AiProfile } from '@/core/ai/types'
import { DESCRIPTION_TEMPLATES } from '@/core/card/create'
import { chunkOrder } from '@/core/novel/chunk'
import { batchItems } from '@/core/novel/consolidate'
import { STORY_ENTRY_TITLE, toDraftCard, type NovelCardDraft, type NovelCardMode } from '@/core/novel/generate'
import { entityBrief, isHidden } from '@/core/novel/merge'
import { findEntity, prepareGeneration } from '@/core/novel/prepare'
import { ENTITY_KIND_LABELS, type ChunkPlan, type ChunkResult, type EntityKind, type MergedEntity } from '@/core/novel/types'
import { db, type CardRecord, type NovelChunkRecord, type NovelGenerateSettings, type NovelGeneratedResult, type NovelRecord } from '@/db/db'
import { useLive } from '@/db/useLive'
import { formatTime } from '@/lib/format'
import { useSettings } from '@/lib/settings'
import { createCardFromDraft } from '@/services/cards'
import { addNovelCard, saveNovelLorebook, updateNovel } from '@/services/novels'
import { useGenerateRunner, type GenerateScope } from './generateRunner'
import {
  entityChunkCount,
  formatTimePointLabel,
  resolveStyle,
  USER_ROLE_PRESETS,
  type NovelStep,
} from './novelHelpers'
import { useDebouncedField } from './useNovelData'

const LATEST_TIME_POINT = '__latest__'
const CARD_FIELD_ITEMS = DRAFT_FIELDS.filter((f) => f.key !== 'lorebook')

function fieldPreviewText(draft: NovelCardDraft, key: Exclude<DraftFieldKey, 'lorebook'>): string {
  if (key === 'alternate_greetings') {
    return draft.alternate_greetings.map((g, i) => `—— 备选开场白 ${i + 1} ——\n${g}`).join('\n\n')
  }
  if (key === 'tags') return draft.tags.join('、')
  return draft[key]
}

function fieldSummaryText(draft: NovelCardDraft, key: Exclude<DraftFieldKey, 'lorebook'>): string {
  if (key === 'alternate_greetings') return `${draft.alternate_greetings.length} 条`
  if (key === 'tags') return draft.tags.join('、')
  const text = draft[key].replace(/\s+/g, ' ').trim()
  return text.length > 48 ? `${text.slice(0, 48)}…` : text
}

interface GenerateResultSectionProps {
  novel: NovelRecord
  result: NovelGeneratedResult
  defaultCardName: string
  template: string
  storyEntryEnabled: boolean
  canRun: boolean
  onRunScope: (scope: GenerateScope) => void
}

/**
 * 上一次生成的结果区。父组件用 key={result.createdAt} 挂载，
 * 每次有新生成结果时自动重置默认勾选与卡名，不需要在 effect 里 setState。
 */
function GenerateResultSection({
  novel,
  result,
  defaultCardName,
  template,
  storyEntryEnabled,
  canRun,
  onRunScope,
}: GenerateResultSectionProps) {
  const navigate = useNavigate()
  const customTemplates = useSettings((s) => s.customTemplates)

  const [cardName, setCardName] = useState(result.draft?.name || defaultCardName)
  const [checkedFields, setCheckedFields] = useState<Set<DraftFieldKey>>(() => {
    const initial = new Set<DraftFieldKey>()
    if (result.draft) {
      const dummyDraft: DraftCard = { ...result.draft, lorebook: [] }
      for (const f of CARD_FIELD_ITEMS) {
        if (draftFieldFilled(dummyDraft, f.key)) initial.add(f.key)
      }
    }
    return initial
  })
  const [checkedStory, setCheckedStory] = useState(() => Boolean(result.draft?.story_so_far))
  const [checkedEntryIndices, setCheckedEntryIndices] = useState<Set<number>>(
    () => new Set(result.entries.map((_, idx) => idx)),
  )
  const [saving, setSaving] = useState(false)

  const filledCardFields = useMemo(() => {
    if (!result.draft) return []
    const dummyDraft: DraftCard = { ...result.draft, lorebook: [] }
    return CARD_FIELD_ITEMS.filter((f) => draftFieldFilled(dummyDraft, f.key))
  }, [result.draft])

  const pickedEntries = useMemo(
    () => result.entries.filter((_, idx) => checkedEntryIndices.has(idx)),
    [result.entries, checkedEntryIndices],
  )

  const toggleField = (key: DraftFieldKey, on: boolean) => {
    setCheckedFields((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }

  const toggleEntry = (idx: number, on: boolean) => {
    setCheckedEntryIndices((prev) => {
      const next = new Set(prev)
      if (on) next.add(idx)
      else next.delete(idx)
      return next
    })
  }

  const handleCreateCard = async () => {
    if (!result.draft || saving) return
    setSaving(true)
    try {
      const includeStory = checkedStory && storyEntryEnabled && Boolean(result.draft.story_so_far)
      const draftCard = toDraftCard(result.draft, pickedEntries, { storyEntry: includeStory })
      const fields = new Set<DraftFieldKey>(checkedFields)
      if (draftCard.lorebook.length > 0) fields.add('lorebook')
      const finalName = cardName.trim() || result.draft.name || defaultCardName || '未命名'
      const style = resolveStyle(template, customTemplates)
      const cardId = await createCardFromDraft(finalName, style.templateId, null, draftCard, fields)
      await addNovelCard(novel.id, cardId)
      toast.success(`已创建角色卡「${finalName}」`)
      navigate(`/card/${cardId}`)
    } catch (error) {
      toast.error(`建卡失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleSaveLorebook = async () => {
    if (pickedEntries.length === 0 || saving) return
    setSaving(true)
    try {
      const id = await saveNovelLorebook(`${novel.title || '未命名'} 世界书`, pickedEntries)
      toast.success(`已保存 ${pickedEntries.length} 条到世界书库`, {
        action: {
          label: '去看看',
          onClick: () => navigate(`/lorebook/${id}`),
        },
      })
    } catch (error) {
      toast.error(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }

  const hasAnyCardSelection =
    checkedFields.size > 0 || pickedEntries.length > 0 || (checkedStory && storyEntryEnabled && Boolean(result.draft?.story_so_far))

  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">生成结果</h2>
        <span className="text-xs text-muted-foreground">
          上次生成于 {formatTime(result.createdAt)}（调整上方表单后需要重新生成才会更新）
        </span>
      </div>

      {/* 卡的字段 */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">角色卡内容</h3>
          <Button size="xs" variant="outline" disabled={!canRun} onClick={() => onRunScope('card')}>
            <RotateCcwIcon /> 重写卡的内容
          </Button>
        </div>

        {result.draft ? (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor="generated-card-name" className="text-xs text-muted-foreground">
                角色卡名字
              </Label>
              <Input
                id="generated-card-name"
                value={cardName}
                onChange={(e) => setCardName(e.target.value)}
                placeholder={defaultCardName}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              {filledCardFields.map((f) => {
                const key = f.key as Exclude<DraftFieldKey, 'lorebook'>
                const text = fieldPreviewText(result.draft!, key)
                const sum = fieldSummaryText(result.draft!, key)
                return (
                  <Collapsible key={f.key} className="rounded-lg border">
                    <div className="flex items-center gap-2 px-2.5">
                      <Checkbox
                        checked={checkedFields.has(f.key)}
                        onCheckedChange={(v) => toggleField(f.key, v === true)}
                        aria-label={`使用${f.label}`}
                      />
                      <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 py-2 text-left text-sm">
                        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                        <span className="shrink-0 font-medium">{f.label}</span>
                        {key === 'alternate_greetings' ? (
                          <Badge variant="secondary">{sum}</Badge>
                        ) : (
                          <span className="truncate text-xs text-muted-foreground">{sum}</span>
                        )}
                      </CollapsibleTrigger>
                    </div>
                    <CollapsibleContent className="max-h-72 overflow-y-auto border-t px-3 py-2 text-sm whitespace-pre-wrap break-words">
                      {text}
                    </CollapsibleContent>
                  </Collapsible>
                )
              })}

              {result.draft.story_so_far && (
                <Collapsible className="rounded-lg border">
                  <div className="flex items-center gap-2 px-2.5">
                    <Checkbox
                      checked={checkedStory}
                      onCheckedChange={(v) => setCheckedStory(v === true)}
                      aria-label={`使用${STORY_ENTRY_TITLE}`}
                    />
                    <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 py-2 text-left text-sm">
                      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                      <span className="shrink-0 font-medium">{STORY_ENTRY_TITLE}</span>
                      {storyEntryEnabled ? (
                        <Badge variant="secondary" className="shrink-0">
                          常驻世界书
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="shrink-0 text-muted-foreground">
                          未开启写入世界书
                        </Badge>
                      )}
                      <span className="truncate text-xs text-muted-foreground">
                        {result.draft.story_so_far.replace(/\s+/g, ' ').slice(0, 40)}…
                      </span>
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent className="max-h-72 overflow-y-auto border-t px-3 py-2 text-sm whitespace-pre-wrap break-words">
                    {result.draft.story_so_far}
                  </CollapsibleContent>
                </Collapsible>
              )}
            </div>
          </>
        ) : (
          <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
            还没有生成角色卡内容，可以点右上角“重写卡的内容”。
          </p>
        )}
      </div>

      <Separator />

      {/* 世界书条目 */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">
              世界书条目{' '}
              <span className="font-normal text-muted-foreground">
                已选 {pickedEntries.length} / {result.entries.length} 条
              </span>
            </h3>
            {result.entries.length > 0 && (
              <>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setCheckedEntryIndices(new Set(result.entries.map((_, idx) => idx)))}
                >
                  全选
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setCheckedEntryIndices(new Set())}>
                  全不选
                </Button>
              </>
            )}
          </div>
          <Button size="xs" variant="outline" disabled={!canRun} onClick={() => onRunScope('entries')}>
            <RotateCcwIcon /> 重新合成条目
          </Button>
        </div>

        {result.failedKeys.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <span className="flex items-center gap-1.5">
              <AlertTriangleIcon className="size-3.5 shrink-0" />
              有 {result.failedKeys.length} 个对象没合成出来
            </span>
            <Button size="xs" variant="outline" disabled={!canRun} onClick={() => onRunScope('failed')}>
              <RotateCcwIcon /> 重试失败的
            </Button>
          </div>
        )}

        {result.entries.length === 0 ? (
          <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">没有合成的世界书条目。</p>
        ) : (
          <div className="flex max-h-[45svh] flex-col gap-1.5 overflow-y-auto">
            {result.entries.map((entry, idx) => (
              <Collapsible key={`${entry.sourceKey}-${idx}`} className="rounded-lg border">
                <div className="flex items-center gap-2 px-2.5">
                  <Checkbox
                    checked={checkedEntryIndices.has(idx)}
                    onCheckedChange={(v) => toggleEntry(idx, v === true)}
                    aria-label={`选择条目 ${entry.comment}`}
                  />
                  <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 py-2 text-left text-sm">
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                    <Badge variant="secondary" className="shrink-0">
                      {GENERATED_TYPE_LABELS[entry.type]}
                    </Badge>
                    {entry.constant && (
                      <Badge variant="outline" className="shrink-0 border-primary/40 text-primary">
                        常驻
                      </Badge>
                    )}
                    <span className="shrink-0 font-medium">{entry.comment}</span>
                    {entry.keys.length > 0 && (
                      <span className="truncate text-xs text-muted-foreground">{entry.keys.join('、')}</span>
                    )}
                  </CollapsibleTrigger>
                </div>
                <CollapsibleContent className="border-t px-3 py-2 text-sm whitespace-pre-wrap break-words">
                  {entry.keys.length > 0 && (
                    <p className="mb-1.5 text-xs text-muted-foreground">触发词：{entry.keys.join('、')}</p>
                  )}
                  {entry.content}
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        )}
      </div>

      {/* 底部操作 */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
        <Button
          variant="outline"
          disabled={saving || pickedEntries.length === 0}
          onClick={() => void handleSaveLorebook()}
        >
          <BookOpenIcon /> 只把条目存进世界书库
        </Button>
        <Button
          disabled={saving || !result.draft || !hasAnyCardSelection}
          onClick={() => void handleCreateCard()}
        >
          <SparklesIcon /> 建卡并打开编辑器
        </Button>
      </div>
    </section>
  )
}

export interface GenerateStepProps {
  novel: NovelRecord
  records: NovelChunkRecord[]
  plans: ChunkPlan[]
  results: ChunkResult[]
  entities: MergedEntity[]
  profile: AiProfile | null
  onGoStep: (step: NovelStep) => void
}

export function GenerateStep({ novel, records, plans, results, entities, profile, onGoStep }: GenerateStepProps) {
  const customTemplates = useSettings((s) => s.customTemplates)
  const runnerNovelId = useGenerateRunner((s) => s.novelId)
  const runnerRunning = useGenerateRunner((s) => s.running)
  const runnerBatches = useGenerateRunner((s) => s.batches)
  const runnerBatchesDone = useGenerateRunner((s) => s.batchesDone)
  const runnerCard = useGenerateRunner((s) => s.card)
  const runnerReceived = useGenerateRunner((s) => s.received)
  const runnerError = useGenerateRunner((s) => s.error)
  const startGenerate = useGenerateRunner((s) => s.start)
  const stopGenerate = useGenerateRunner((s) => s.stop)

  const [charFilter, setCharFilter] = useState('')

  const gen = novel.generate
  const updateGenerate = (patch: Partial<NovelGenerateSettings>) => {
    void updateNovel(novel.id, { generate: { ...gen, ...patch } })
  }

  const worldNameField = useDebouncedField(gen.worldName, (v) => updateGenerate({ worldName: v }))
  const userRoleField = useDebouncedField(gen.userRole, (v) => updateGenerate({ userRole: v }))
  const instructionField = useDebouncedField(gen.instruction, (v) => updateGenerate({ instruction: v }))

  // 当前计划里已完成的块（供时间点下拉）
  const donePlans = useMemo(() => {
    const doneSet = new Set(records.filter((r) => r.status === 'done').map((r) => r.planId))
    return plans.filter((p) => doneSet.has(p.id))
  }, [plans, records])

  const selectedPlan = useMemo(
    () => (gen.timePoint ? donePlans.find((p) => p.id === gen.timePoint) ?? null : null),
    [donePlans, gen.timePoint],
  )
  const maxOrder = selectedPlan ? chunkOrder(selectedPlan) : undefined
  const effectivePlan = selectedPlan ?? donePlans.at(-1) ?? null
  const timePointText = effectivePlan ? formatTimePointLabel(effectivePlan, novel.toc) : '资料的最后一段之后'

  // 可选主角列表（未隐藏、时间点前出现、按权重降序）
  const visibleCharacters = useMemo(() => {
    return entities
      .filter(
        (e) =>
          e.kind === 'character' &&
          !isHidden(e, novel.review) &&
          (maxOrder === undefined || e.mentions.some((m) => m.order <= maxOrder)),
      )
      .sort((a, b) => b.weight - a.weight || (a.mentions[0]?.order ?? 0) - (b.mentions[0]?.order ?? 0))
  }, [entities, novel.review, maxOrder])

  const matchedMain = useMemo(() => findEntity(visibleCharacters, gen.mainKey), [visibleCharacters, gen.mainKey])

  const filteredCharacters = useMemo(() => {
    const q = charFilter.trim().toLowerCase()
    if (!q) return visibleCharacters
    const list = visibleCharacters.filter(
      (c) => c.name.toLowerCase().includes(q) || c.aliases.some((a) => a.toLowerCase().includes(q)),
    )
    if (matchedMain && !list.some((c) => c.id === matchedMain.id)) {
      return [matchedMain, ...list]
    }
    return list
  }, [visibleCharacters, charFilter, matchedMain])

  const prepared = useMemo(
    () =>
      prepareGeneration({
        mode: gen.mode,
        entities,
        overrides: novel.review,
        results,
        maxOrder,
        mainKey: gen.mainKey,
        worldEntry: gen.worldEntry,
      }),
    [gen.mode, entities, novel.review, results, maxOrder, gen.mainKey, gen.worldEntry],
  )

  const batches = useMemo(() => batchItems(prepared.items), [prepared.items])

  const lorebookCounts = useMemo(() => {
    const counts: Record<EntityKind, number> = { character: 0, place: 0, organization: 0, term: 0 }
    for (const e of prepared.lorebook) counts[e.kind]++
    const hasWorld = prepared.items.some((i) => i.kind === 'world')
    return { ...counts, hasWorld }
  }, [prepared])

  // 用这本书建过的卡
  const cardIdsKey = novel.cardIds.join(',')
  const createdCards = useLive(async () => {
    const ids = cardIdsKey ? cardIdsKey.split(',') : []
    if (ids.length === 0) return [] as CardRecord[]
    const list = await db.cards.bulkGet(ids)
    return list.filter((c): c is CardRecord => Boolean(c))
  }, [cardIdsKey])

  const isThisBook = runnerNovelId === novel.id
  const isRunningHere = runnerRunning && isThisBook
  const isRunningOther = runnerRunning && !isThisBook
  const errorText = isThisBook ? runnerError : null

  const needsMain = gen.mode === 'character' && !prepared.main
  const canRun = Boolean(profile) && !runnerRunning && !needsMain && results.length > 0

  const runGenerate = (scope: GenerateScope) => {
    if (!profile || runnerRunning) return
    if ((scope === 'all' || scope === 'card') && needsMain) {
      toast.error(matchedMain ? '主角在这个时间点之前还没出场' : '请先选择一位主角')
      return
    }
    const style = resolveStyle(gen.template, customTemplates)
    // 把输入框里可能还没触发防抖的最新值合并后一次性落库并带入本次请求
    const latestGenerate: NovelGenerateSettings = {
      ...gen,
      worldName: worldNameField.value,
      userRole: userRoleField.value,
      instruction: instructionField.value,
    }
    worldNameField.cancel()
    userRoleField.cancel()
    instructionField.cancel()
    if (
      latestGenerate.worldName !== gen.worldName ||
      latestGenerate.userRole !== gen.userRole ||
      latestGenerate.instruction !== gen.instruction
    ) {
      void updateNovel(novel.id, { generate: latestGenerate })
    }
    const latestNovel: NovelRecord = {
      ...novel,
      generate: latestGenerate,
    }
    void startGenerate({
      novel: latestNovel,
      prepared,
      profile,
      style: { label: style.label, skeleton: style.skeleton },
      timePoint: timePointText,
      scope,
    })
  }

  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
        <p>还没有抽取结果，先去 ② 抽取至少一块内容，再回来生成角色卡。</p>
        <Button size="sm" onClick={() => onGoStep('extract')}>
          去抽取
        </Button>
      </div>
    )
  }

  const defaultCardName =
    gen.mode === 'character' ? matchedMain?.name || novel.title : gen.worldName.trim() || novel.title

  const lorebookSummaryParts: string[] = []
  for (const kind of ['character', 'place', 'organization', 'term'] as EntityKind[]) {
    if (lorebookCounts[kind] > 0) lorebookSummaryParts.push(`${ENTITY_KIND_LABELS[kind]} ${lorebookCounts[kind]}`)
  }
  if (lorebookCounts.hasWorld) lorebookSummaryParts.push('世界观 1')

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        {/* 左：生成配置表单 */}
        <section className="flex flex-col gap-4 rounded-xl border bg-card p-4">
          <div className="flex flex-col gap-2">
            <Label>卡的类型</Label>
            <RadioGroup
              value={gen.mode}
              onValueChange={(v) => updateGenerate({ mode: v as NovelCardMode })}
              className="grid gap-2 sm:grid-cols-2"
            >
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5">
                <RadioGroupItem value="character" className="mt-0.5" />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">单角色卡</span>
                  <span className="text-xs text-muted-foreground">
                    选书中一个人物当 {'{{char}}'}，其他人物和地点进世界书
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5">
                <RadioGroupItem value="world" className="mt-0.5" />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">世界卡</span>
                  <span className="text-xs text-muted-foreground">
                    {'{{char}}'} 是叙述者，扮演书中所有人物；适合群像、跑团式玩法
                  </span>
                </span>
              </label>
            </RadioGroup>
          </div>

          {gen.mode === 'character' ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>主角</Label>
                {visibleCharacters.length > 15 && (
                  <Input
                    value={charFilter}
                    onChange={(e) => setCharFilter(e.target.value)}
                    placeholder="筛选人物…"
                    className="h-7 w-40 text-xs"
                  />
                )}
              </div>
              <Select value={matchedMain?.id ?? ''} onValueChange={(v) => updateGenerate({ mainKey: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="请选择主角" />
                </SelectTrigger>
                <SelectContent>
                  {filteredCharacters.map((c) => {
                    const brief = entityBrief(c, maxOrder)
                    return (
                      <SelectItem key={c.id} value={c.id}>
                        <span className="flex items-center gap-1.5 truncate">
                          <span className="font-medium">{c.name}</span>
                          <span className="text-xs text-muted-foreground">出现 {entityChunkCount(c)} 段</span>
                          {brief && <span className="truncate text-xs text-muted-foreground">· {brief}</span>}
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
              {visibleCharacters.length === 0 && (
                <p className="text-xs text-muted-foreground">当前时间点之前还没有抽取出人物。</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="novel-world-name">世界卡名字</Label>
              <Input
                id="novel-world-name"
                value={worldNameField.value}
                onChange={(e) => worldNameField.onChange(e.target.value)}
                onBlur={worldNameField.onBlur}
                placeholder={novel.title || '默认使用书名'}
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label>时间点</Label>
            <Select
              value={selectedPlan ? selectedPlan.id : LATEST_TIME_POINT}
              onValueChange={(v) => updateGenerate({ timePoint: v === LATEST_TIME_POINT ? null : v })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={LATEST_TIME_POINT}>
                  截至最后一块{donePlans.length > 0 ? `（${donePlans[donePlans.length - 1].label}）` : ''}
                </SelectItem>
                {donePlans.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                    {novel.toc[p.chapterStart]?.title ? ` · ${novel.toc[p.chapterStart].title}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              角色状态和前情写到这里为止，可以选早一点避免剧透（当前：{timePointText}）
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="novel-user-role">{'{{user}}'} 的身份</Label>
            <Textarea
              id="novel-user-role"
              value={userRoleField.value}
              onChange={(e) => userRoleField.onChange(e.target.value)}
              onBlur={userRoleField.onBlur}
              placeholder="留空则由 AI 安排成原创人物，身份在开场白里自然交代"
              className="min-h-20"
            />
            <div className="flex flex-wrap gap-1.5">
              {USER_ROLE_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => userRoleField.setImmediate(preset)}
                >
                  {preset}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label>描述写法</Label>
            <RadioGroup
              value={gen.template}
              onValueChange={(v) => updateGenerate({ template: v })}
              className="grid gap-2 sm:grid-cols-2"
            >
              {DESCRIPTION_TEMPLATES.map((t) => (
                <label
                  key={t.id}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5"
                >
                  <RadioGroupItem value={t.id} className="mt-0.5" />
                  <span className="flex flex-col">
                    <span className="text-sm font-medium">{t.label}</span>
                    <span className="text-xs text-muted-foreground">{t.hint}</span>
                  </span>
                </label>
              ))}
              {customTemplates.map((t) => (
                <label
                  key={t.id}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5"
                >
                  <RadioGroupItem value={`custom:${t.id}`} className="mt-0.5" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{t.label}</span>
                    <span className="text-xs text-muted-foreground">我的模板</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="novel-greetings">开场白数量（1～5）</Label>
              <Select
                value={String(gen.greetings)}
                onValueChange={(v) => updateGenerate({ greetings: Number(v) })}
              >
                <SelectTrigger id="novel-greetings" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} 条（主开场白 1 条{n > 1 ? ` + 备选 ${n - 1} 条` : ''}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col justify-end gap-2 pb-1">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Switch checked={gen.storyEntry} onCheckedChange={(v) => updateGenerate({ storyEntry: v })} />
                前情提要放进世界书（常驻）
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Switch checked={gen.worldEntry} onCheckedChange={(v) => updateGenerate({ worldEntry: v })} />
                世界观总述放进世界书（常驻）
              </label>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="novel-instruction">其他要求（选填）</Label>
            <Textarea
              id="novel-instruction"
              value={instructionField.value}
              onChange={(e) => instructionField.onChange(e.target.value)}
              onBlur={instructionField.onBlur}
              placeholder="例如：文风尽量贴近原著；开场白 500 字左右；不要写死剧情走向"
              className="min-h-16"
            />
          </div>
        </section>

        {/* 右：生成预览、开始按钮与已建卡片 */}
        <aside className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
            <h2 className="font-medium">生成预览</h2>

            <div className="flex flex-col gap-1.5 text-sm">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">待合成条目</span>
                <span className="font-medium">{prepared.items.length} 条</span>
              </div>
              {lorebookSummaryParts.length > 0 && (
                <p className="text-right text-xs text-muted-foreground">{lorebookSummaryParts.join(' · ')}</p>
              )}
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">预计请求</span>
                <span>约 {batches.length + 1} 次</span>
              </div>
              <p className="text-xs text-muted-foreground">
                合成条目 {batches.length} 批 + 写角色卡 1 次。
                <button
                  type="button"
                  className="ml-1 text-primary hover:underline"
                  onClick={() => onGoStep('review')}
                >
                  在 ③ 整理里调整勾选
                </button>
              </p>
            </div>

            {!profile && (
              <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                <span>还没配置 AI 接口，去设置页添加后再生成。</span>
                <Button size="xs" asChild>
                  <Link to="/settings">去设置</Link>
                </Button>
              </div>
            )}

            {isRunningHere ? (
              <div className="flex flex-col gap-2.5 rounded-lg border bg-muted/40 p-3 text-sm">
                <div className="flex items-center gap-2">
                  <LoaderIcon className="size-4 shrink-0 animate-spin text-primary" />
                  <span className="font-medium">正在生成…</span>
                </div>
                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {runnerBatches > 0 && (
                    <span>
                      合成世界书条目：{runnerBatchesDone} / {runnerBatches} 批
                    </span>
                  )}
                  {runnerCard !== 'idle' && (
                    <span>
                      写角色卡：
                      {runnerCard === 'running'
                        ? `已收到 ${runnerReceived} 字…`
                        : runnerCard === 'done'
                          ? '已完成'
                          : '出错'}
                    </span>
                  )}
                </div>
                <Button size="sm" variant="outline" onClick={stopGenerate}>
                  <SquareIcon /> 停止
                </Button>
              </div>
            ) : (
              <Button size="lg" className="w-full" disabled={!canRun} onClick={() => runGenerate('all')}>
                <SparklesIcon /> {novel.result ? '全部重新生成' : '生成'}
              </Button>
            )}

            {needsMain && !isRunningHere && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {matchedMain ? `「${matchedMain.name}」在这个时间点之前还没出场，换个靠后的时间点或换个主角。` : '单角色卡需要先在左侧选一位主角。'}
              </p>
            )}

            {isRunningOther && (
              <p className="text-xs text-amber-700 dark:text-amber-400">另一本书正在生成中，请等它完成或停止。</p>
            )}

            {errorText && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span className="break-words">{errorText}</span>
              </div>
            )}
          </div>

          {createdCards && createdCards.length > 0 && (
            <div className="flex flex-col gap-2 rounded-xl border bg-card p-4">
              <h2 className="text-sm font-medium">用这本书建过的卡</h2>
              <div className="flex flex-col gap-1.5">
                {createdCards.map((card) => (
                  <Link
                    key={card.id}
                    to={`/card/${card.id}`}
                    className="flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-sm transition hover:bg-muted/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{card.name || '未命名'}</div>
                      <div className="text-xs text-muted-foreground">{formatTime(card.updatedAt)}</div>
                    </div>
                    <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  </Link>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* 生成结果 */}
      {novel.result && (
        <GenerateResultSection
          key={novel.result.createdAt}
          novel={novel}
          result={novel.result}
          defaultCardName={defaultCardName}
          template={gen.template}
          storyEntryEnabled={gen.storyEntry}
          canRun={Boolean(profile) && !runnerRunning}
          onRunScope={runGenerate}
        />
      )}
    </div>
  )
}
