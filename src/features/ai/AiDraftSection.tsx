/**
 * 新建卡时用 AI 生成草稿：写一句设定，生成后逐项勾选，再建卡。
 */
import { ChevronRightIcon, SparklesIcon, SquareIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { streamChat } from '@/core/ai/client'
import { buildDraftCardRequest, DRAFT_FIELDS, draftFieldFilled, parseDraftCard, type DraftCard, type DraftFieldKey } from '@/core/ai/tasks/draftCard'
import { GENERATED_TYPE_LABELS } from '@/core/ai/tasks/lorebookGen'
import { AiError } from '@/core/ai/types'
import { useActiveAiProfile } from '@/lib/aiSettings'

export interface AiDraftSectionProps {
  /** 用户在上面填的角色名，可以为空 */
  name: string
  style: { label: string; skeleton?: string }
  busy: boolean
  onCreate: (draft: DraftCard, fields: ReadonlySet<DraftFieldKey>) => void
}

type Phase = 'idle' | 'running' | 'done'

function preview(draft: DraftCard, key: DraftFieldKey): string {
  const value = draft[key]
  if (key === 'lorebook') return draft.lorebook.map((e) => `【${GENERATED_TYPE_LABELS[e.type]}】${e.comment}（${e.keys.join('、')}）\n${e.content}`).join('\n\n')
  if (key === 'alternate_greetings') return draft.alternate_greetings.map((g, i) => `—— 备选开场白 ${i + 1} ——\n${g}`).join('\n\n')
  if (key === 'tags') return draft.tags.join('、')
  return typeof value === 'string' ? value : ''
}

function summary(draft: DraftCard, key: DraftFieldKey): string {
  if (key === 'lorebook') return `${draft.lorebook.length} 条`
  if (key === 'alternate_greetings') return `${draft.alternate_greetings.length} 条`
  if (key === 'tags') return draft.tags.join('、')
  const text = preview(draft, key).replace(/\s+/g, ' ')
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

export function AiDraftSection({ name, style, busy, onCreate }: AiDraftSectionProps) {
  const profile = useActiveAiProfile()
  const [concept, setConcept] = useState('')
  const [greetings, setGreetings] = useState(3)
  const [withLorebook, setWithLorebook] = useState(true)
  const [instruction, setInstruction] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [received, setReceived] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftCard | null>(null)
  const [fields, setFields] = useState<Set<DraftFieldKey>>(new Set())
  const abort = useRef<AbortController | null>(null)

  useEffect(() => () => abort.current?.abort(), [])

  if (!profile) {
    return (
      <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed p-3 text-sm">
        <p>还没设置 AI 接口。到设置页添加一个，填上自己的 API key 就能用。</p>
        <Button size="sm" asChild>
          <Link to="/settings">去设置</Link>
        </Button>
      </div>
    )
  }

  const generate = async () => {
    if (!concept.trim()) {
      setError('先写一句设定')
      return
    }
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setPhase('running')
    setReceived(0)
    setError(null)
    setDraft(null)
    try {
      const request = buildDraftCardRequest({ concept, name, style, greetings, withLorebook, instruction })
      const result = await streamChat(profile, { ...request, signal: controller.signal, onText: (_d, full) => setReceived(full.length) })
      const parsed = parseDraftCard(result.text)
      setDraft(parsed)
      setFields(new Set(DRAFT_FIELDS.filter((f) => draftFieldFilled(parsed, f.key)).map((f) => f.key)))
      setPhase('done')
      if (result.finishReason === 'length') setError('输出达到了最大长度，可能有内容被截断。可以在设置里调大最大输出 token。')
    } catch (e) {
      setPhase('idle')
      if (e instanceof AiError && e.kind === 'aborted') return
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const toggle = (key: DraftFieldKey, on: boolean) =>
    setFields((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ai-concept">一句话设定</Label>
        <Textarea
          id="ai-concept"
          value={concept}
          onChange={(e) => setConcept(e.target.value)}
          placeholder="例如：落魄贵族出身的女剑士，嘴硬心软，在边境小镇当赏金猎人，和 {{user}} 是搭档"
          className="min-h-20"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ai-greetings">开场白数量</Label>
          <Input id="ai-greetings" type="number" min={1} max={5} value={greetings} onChange={(e) => setGreetings(Math.min(5, Math.max(1, Number(e.target.value) || 1)))} />
        </div>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <Switch checked={withLorebook} onCheckedChange={setWithLorebook} />
          顺带生成世界书条目（配角、地点等）
        </label>
      </div>
      <Input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="其他要求（可不填），例如：文风偏轻小说；描述控制在 800 字以内" />
      <div className="flex items-center gap-2">
        {phase === 'running' ? (
          <Button variant="outline" onClick={() => abort.current?.abort()}>
            <SquareIcon /> 停止
          </Button>
        ) : (
          <Button variant={draft ? 'outline' : 'default'} onClick={generate}>
            <SparklesIcon /> {draft ? '重新生成' : 'AI 生成草稿'}
          </Button>
        )}
        <span className="truncate text-xs text-muted-foreground">
          {phase === 'running' ? `生成中，已收到 ${received} 字…` : `使用 ${profile.name} · ${profile.model || '未选模型'}`}
        </span>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}

      {draft && (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm">
            生成结果{draft.name && !name.trim() && <>：角色名「{draft.name}」</>}。勾选要用的部分，建卡后还能继续改。
          </p>
          <div className="flex max-h-[40svh] flex-col gap-1 overflow-y-auto">
            {DRAFT_FIELDS.filter((f) => draftFieldFilled(draft, f.key)).map((f) => (
              <Collapsible key={f.key} className="rounded-md border">
                <div className="flex items-center gap-2 px-2">
                  <Checkbox checked={fields.has(f.key)} onCheckedChange={(v) => toggle(f.key, v === true)} aria-label={`使用${f.label}`} />
                  <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-sm">
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                    <span className="shrink-0 font-medium">{f.label}</span>
                    {(f.key === 'lorebook' || f.key === 'alternate_greetings') && <Badge variant="secondary">{summary(draft, f.key)}</Badge>}
                    {f.key !== 'lorebook' && f.key !== 'alternate_greetings' && <span className="truncate text-xs text-muted-foreground">{summary(draft, f.key)}</span>}
                  </CollapsibleTrigger>
                </div>
                <CollapsibleContent className="max-h-60 overflow-y-auto border-t px-3 py-2 text-sm whitespace-pre-wrap break-words">{preview(draft, f.key)}</CollapsibleContent>
              </Collapsible>
            ))}
          </div>
          <Button className="self-end" disabled={busy || fields.size === 0} onClick={() => onCreate(draft, fields)}>
            用选中的内容建卡
          </Button>
        </div>
      )}
    </div>
  )
}
