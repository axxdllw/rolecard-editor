import { AlertTriangleIcon, DicesIcon } from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { CharacterCardV3, JsonObject, LorebookEntry } from '@/core/card/types'
import {
  DEFAULT_SCAN_SETTINGS,
  seededRandom,
  simulateTurns,
  type GlobalScanData,
  type ScanMessage,
  type ScanSettings,
} from '@/core/lorebook/activate'
import { assemblePrompt, type ActivationMode, type AssembledBlock } from '@/core/lorebook/assemble'
import { readEntrySettings } from '@/core/lorebook/entry'
import { substituteMacros } from '@/core/macros'
import type { CardScanTestData } from '@/db/db'
import { useSettings } from '@/lib/settings'
import { cachedTokens, formatTokens, useTokenizerReady } from '@/lib/tokens'
import { cn } from '@/lib/utils'
import { ScanChatEditor } from './ScanChatEditor'
import { ScanSettingsPanel } from './ScanSettingsPanel'
import { TraceSection } from './TraceSection'
import { getCardGreetings, useScanTestData } from './useScanTestData'

const EMPTY_ENTRIES: LorebookEntry[] = []

type PreviewMode = Exclude<ActivationMode, 'match'>

const KIND_STYLE: Record<AssembledBlock['kind'], { label: string; className: string }> = {
  card: { label: '卡片字段', className: 'border-l-slate-400' },
  constant: { label: '常驻', className: 'border-l-emerald-500' },
  triggered: { label: '触发', className: 'border-l-sky-500' },
  note: { label: '', className: '' },
}

function buildGlobalScanData(card: CharacterCardV3): GlobalScanData {
  const data = card.data
  const ext = (data.extensions ?? {}) as JsonObject
  const depthPrompt = ext.depth_prompt as JsonObject | undefined
  return {
    personaDescription: '',
    characterDescription: data.description ?? '',
    characterPersonality: data.personality ?? '',
    characterDepthPrompt: typeof depthPrompt?.prompt === 'string' ? depthPrompt.prompt : '',
    scenario: data.scenario ?? '',
    creatorNotes: data.creator_notes ?? '',
  }
}

/** 判断世界书里有没有概率抽选或需要按权重随机抽选的包含组 */
function bookHasRandomness(entries: LorebookEntry[]): boolean {
  const groupStats = new Map<string, { count: number; hasOverride: boolean }>()
  for (const entry of entries) {
    if (entry.enabled === false) continue
    const s = readEntrySettings(entry)
    if (s.useProbability && s.probability < 100) return true
    if (s.group) {
      for (const rawName of s.group.split(/,\s*/)) {
        const name = rawName.trim()
        if (!name) continue
        const rec = groupStats.get(name) ?? { count: 0, hasOverride: false }
        rec.count++
        if (s.groupOverride) rec.hasOverride = true
        groupStats.set(name, rec)
      }
    }
  }
  for (const rec of groupStats.values()) {
    if (rec.count >= 2 && !rec.hasOverride) return true
  }
  return false
}

function Block({ block, onJumpToEntry }: { block: AssembledBlock; onJumpToEntry?: (index: number) => void }) {
  const [expanded, setExpanded] = useState(false)
  if (block.kind === 'note') {
    return <div className="pt-2 text-xs font-medium text-muted-foreground">{block.title}</div>
  }
  const long = block.content.length > 600
  const jumpIndex = block.entryIndex
  return (
    <div className={cn('rounded-md border border-l-4 bg-background p-2.5', KIND_STYLE[block.kind].className)}>
      <div className="mb-1 flex items-center gap-2 text-xs">
        {jumpIndex !== undefined && onJumpToEntry ? (
          <button
            type="button"
            className="truncate text-left font-medium hover:text-primary hover:underline"
            onClick={() => onJumpToEntry(jumpIndex)}
          >
            {block.title}
          </button>
        ) : (
          <span className="truncate font-medium">{block.title}</span>
        )}
        <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[10px]">
          {KIND_STYLE[block.kind].label}
        </Badge>
        <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">约 {formatTokens(cachedTokens(block.content))} token</span>
      </div>
      <pre className={cn('overflow-hidden text-xs leading-relaxed whitespace-pre-wrap', !expanded && long && 'max-h-40')}>{block.content}</pre>
      {long && (
        <button type="button" className="mt-1 text-xs text-primary" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起' : '展开全部'}
        </button>
      )}
    </div>
  )
}

export interface PromptPreviewProps {
  card: CharacterCardV3
  cardId: string
  onJumpToEntry?: (index: number) => void
}

/** 提示词组装预览：模拟 ST 把卡片字段和世界书条目拼进提示词的位置，支持按酒馆规则模拟触发 */
export function PromptPreview({ card, cardId, onJumpToEntry }: PromptPreviewProps) {
  const tokenizerReady = useTokenizerReady()
  const userName = useSettings((s) => s.previewUserName)
  const storedScanSettings = useSettings((s) => s.scanSettings)
  const setSettings = useSettings((s) => s.set)

  const scanSettings = useMemo<ScanSettings>(
    () => ({ ...DEFAULT_SCAN_SETTINGS, ...storedScanSettings }),
    [storedScanSettings],
  )

  const mode = useSettings((s) => s.promptPreviewMode)
  const setMode = (next: PreviewMode) => useSettings.getState().set({ promptPreviewMode: next })
  const [selectedTurn, setSelectedTurn] = useState<number | null>(null)
  const [seed, setSeed] = useState(1)

  const hasFirstMes = Boolean(card.data.first_mes?.trim())
  const [scanTest, setScanTest] = useScanTestData(cardId, hasFirstMes)

  const greetings = useMemo(() => getCardGreetings(card), [card])
  const immediateMacros = useMemo(
    () => ({ char: card.data.name || '角色', user: userName || '用户' }),
    [card.data.name, userName],
  )
  const resolvedGreeting = useMemo(() => {
    if (scanTest.greeting < 0 || scanTest.greeting >= greetings.length) return null
    return substituteMacros(greetings[scanTest.greeting] ?? '', immediateMacros)
  }, [scanTest.greeting, greetings, immediateMacros])

  // 延迟更新高开销的世界书扫描与提示词组装，保证编辑聊天消息时不卡顿
  const deferredCard = useDeferredValue(card)
  const deferredScanTest = useDeferredValue(scanTest)
  const deferredUserName = useDeferredValue(userName)
  const deferredScanSettings = useDeferredValue(scanSettings)

  const countTokens = useMemo(
    () => (text: string) => (tokenizerReady ? cachedTokens(text) : null) ?? Math.ceil(text.length / 2),
    [tokenizerReady],
  )

  const deferredEntries = deferredCard.data.character_book?.entries ?? EMPTY_ENTRIES
  const deferredMacros = useMemo(
    () => ({ char: deferredCard.data.name || '角色', user: deferredUserName || '用户' }),
    [deferredCard.data.name, deferredUserName],
  )

  const { turns, deferredHasGreeting } = useMemo(() => {
    if (mode !== 'simulate') {
      return { turns: [], deferredHasGreeting: false }
    }
    const cardGreetings = getCardGreetings(deferredCard)
    const hasGreeting = deferredScanTest.greeting >= 0 && deferredScanTest.greeting < cardGreetings.length
    const chat: ScanMessage[] = []
    if (hasGreeting) {
      chat.push({
        role: 'char',
        text: substituteMacros(cardGreetings[deferredScanTest.greeting] ?? '', deferredMacros),
      })
    }
    for (const msg of deferredScanTest.messages) {
      chat.push(msg)
    }
    if (deferredEntries.length === 0) {
      return { turns: [], deferredHasGreeting: hasGreeting }
    }
    const result = simulateTurns({
      entries: deferredEntries,
      chat,
      names: deferredMacros,
      settings: deferredScanSettings,
      globalScanData: buildGlobalScanData(deferredCard),
      countTokens,
      random: seededRandom(seed),
    })
    return { turns: result, deferredHasGreeting: hasGreeting }
  }, [mode, deferredCard, deferredEntries, deferredScanTest, deferredMacros, deferredScanSettings, countTokens, seed])

  const activeTurnIndex =
    turns.length === 0
      ? -1
      : selectedTurn !== null && selectedTurn >= 0 && selectedTurn < turns.length
        ? selectedTurn
        : turns.length - 1
  const currentTurn = activeTurnIndex >= 0 ? turns[activeTurnIndex] : null

  const showReroll = useMemo(() => {
    if (mode !== 'simulate' || deferredEntries.length === 0) return false
    if (bookHasRandomness(deferredEntries)) return true
    return Boolean(currentTurn?.traces.some((t) => t.roll !== undefined))
  }, [mode, deferredEntries, currentTurn])

  const sections = useMemo(
    () =>
      assemblePrompt(deferredCard, {
        mode,
        simulated: mode === 'simulate' ? { activated: currentTurn?.activated ?? [] } : undefined,
        macros: deferredMacros,
      }),
    [deferredCard, mode, currentTurn, deferredMacros],
  )

  const total = sections.flatMap((s) => s.blocks).reduce((sum, b) => sum + (cachedTokens(b.content) ?? 0), 0)
  const triggered =
    mode === 'simulate'
      ? (currentTurn?.activated.length ?? 0)
      : sections.flatMap((s) => s.blocks).filter((b) => b.kind === 'triggered').length

  const handleScanTestChange = (next: CardScanTestData) => {
    setSelectedTurn(null)
    setScanTest(next)
  }

  const handleScanSettingsChange = (next: ScanSettings) => {
    useSettings.getState().set({ scanSettings: next })
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <div className="flex h-fit min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 lg:sticky lg:top-28 lg:max-h-[calc(100svh-8rem)] lg:overflow-y-auto">
        <div className="flex flex-col gap-2">
          <Label>哪些世界书条目算作触发</Label>
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as PreviewMode)} className="gap-2">
            {(
              [
                ['constant', '只看常驻', '最小情况：每轮固定发送的内容'],
                ['all', '全部关键词条目', '最大情况：假设所有条目都被触发'],
                ['simulate', '模拟聊天（按酒馆规则）', '按聊天记录、递归、时效和预算模拟触发'],
              ] as const
            ).map(([value, label, hint]) => (
              <label key={value} className="flex cursor-pointer items-start gap-2">
                <RadioGroupItem value={value} className="mt-0.5" />
                <span className="flex flex-col">
                  <span className="text-sm">{label}</span>
                  <span className="text-xs text-muted-foreground">{hint}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </div>

        {mode === 'simulate' && (
          <div className="flex flex-col gap-3 border-t pt-3">
            <ScanChatEditor
              greetings={greetings}
              resolvedGreeting={resolvedGreeting}
              value={scanTest}
              onChange={handleScanTestChange}
            />

            {turns.length > 1 && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">查看轮次</Label>
                <div className="flex flex-wrap gap-1">
                  {turns.map((t, i) => {
                    const selected = i === activeTurnIndex
                    return (
                      <Button
                        key={i}
                        type="button"
                        size="xs"
                        variant={selected ? 'secondary' : 'outline'}
                        className={cn('tabular-nums', selected && 'border-primary/40 font-semibold text-primary')}
                        onClick={() => setSelectedTurn(i === turns.length - 1 ? null : i)}
                      >
                        第 {i + 1} 轮 · {t.activated.length} 条
                      </Button>
                    )
                  })}
                </div>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  每条用户消息之后算一轮生成，粘性和冷却按轮次累计
                </p>
              </div>
            )}

            {showReroll && (
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setSeed((s) => s + 1)}>
                  <DicesIcon /> 重新掷骰
                </Button>
                <span className="text-[11px] leading-tight text-muted-foreground">概率和包含组抽选用随机数</span>
              </div>
            )}

            <ScanSettingsPanel settings={scanSettings} onChange={handleScanSettingsChange} />
          </div>
        )}

        <div className="flex flex-col gap-1.5 border-t pt-3">
          <Label htmlFor="preview-user">{'{{user}}'} 显示为</Label>
          <Input id="preview-user" value={userName} onChange={(e) => setSettings({ previewUserName: e.target.value })} />
        </div>

        <div className="rounded-lg bg-muted/50 p-3 text-sm">
          <div>
            合计约 <span className="font-semibold tabular-nums">{formatTokens(total)}</span> token
            {mode === 'all' && <span className="text-muted-foreground">，其中触发条目 {triggered} 个</span>}
            {mode === 'simulate' && <span className="text-muted-foreground">，触发条目 {triggered} 个</span>}
          </div>
          {mode === 'simulate' && currentTurn?.budgetOverflowed && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-destructive">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>超出世界书预算，后面的条目没有加入</span>
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">不含主提示词、预设和聊天记录本身。同顺序条目的先后以 ST 实际为准。</p>
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        {mode === 'simulate' &&
          (deferredEntries.length === 0 ? (
            <section className="rounded-xl border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
              这张卡没有世界书条目
            </section>
          ) : (
            <TraceSection
              entries={deferredEntries}
              turn={currentTurn}
              hasGreeting={deferredHasGreeting}
              onJumpToEntry={onJumpToEntry}
            />
          ))}

        {sections.map((section) => (
          <section key={section.id} className="rounded-xl border bg-card p-3">
            <h3 className="mb-0.5 text-sm font-semibold">{section.title}</h3>
            {section.hint && <p className="mb-2 text-xs text-muted-foreground">{section.hint}</p>}
            <div className="flex flex-col gap-2">
              {section.blocks.map((block, i) => (
                <Block key={i} block={block} onJumpToEntry={onJumpToEntry} />
              ))}
            </div>
          </section>
        ))}
        {sections.length === 0 && <p className="p-10 text-center text-sm text-muted-foreground">卡片还没有内容</p>}
      </div>
    </div>
  )
}
