/**
 * AI 批量生成世界书条目：贴一段设定或小说片段，生成人物、地点、组织、名词条目，勾选后追加到世界书。
 */
import { ChevronRightIcon, SparklesIcon, SquareIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { streamChat } from '@/core/ai/client'
import { buildLorebookGenRequest, GENERATED_TYPE_LABELS, parseGeneratedEntries, type GeneratedEntry } from '@/core/ai/tasks/lorebookGen'
import type { RewriteContext } from '@/core/ai/tasks/rewrite'
import { AiError } from '@/core/ai/types'
import { useActiveAiProfile } from '@/lib/aiSettings'

export interface AiLorebookDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 世界书里已有的条目名，避免重复 */
  existingTitles: string[]
  /** 角色卡上下文；独立世界书没有 */
  getContext?: () => RewriteContext | undefined
  /** “填入角色设定”按钮取的文本；独立世界书没有 */
  getCardSource?: () => string
  onAdd: (entries: GeneratedEntry[]) => void
}

type Phase = 'idle' | 'running' | 'done'

function Body({ existingTitles, getContext, getCardSource, onAdd, onClose }: Omit<AiLorebookDialogProps, 'open' | 'onOpenChange'> & { onClose: () => void }) {
  const profile = useActiveAiProfile()
  const [source, setSource] = useState('')
  const [instruction, setInstruction] = useState('')
  const [maxEntries, setMaxEntries] = useState(15)
  const [phase, setPhase] = useState<Phase>('idle')
  const [received, setReceived] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [entries, setEntries] = useState<GeneratedEntry[]>([])
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const abort = useRef<AbortController | null>(null)

  useEffect(() => () => abort.current?.abort(), [])

  if (!profile) {
    return (
      <div className="flex flex-col items-start gap-2 text-sm">
        <p>还没设置 AI 接口。到设置页添加一个，填上自己的 API key 就能用。</p>
        <Button size="sm" asChild onClick={onClose}>
          <Link to="/settings">去设置</Link>
        </Button>
      </div>
    )
  }

  const generate = async () => {
    if (!source.trim()) {
      setError('先贴一段参考资料')
      return
    }
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setPhase('running')
    setReceived(0)
    setError(null)
    setEntries([])
    try {
      const request = buildLorebookGenRequest({ source, instruction, existingTitles, context: getContext?.(), maxEntries })
      const result = await streamChat(profile, { ...request, signal: controller.signal, onText: (_d, full) => setReceived(full.length) })
      const list = parseGeneratedEntries(result.text)
      setEntries(list)
      setPicked(new Set(list.map((_, i) => i)))
      setPhase('done')
      if (result.finishReason === 'length') setError('输出达到了最大长度，后面的条目可能没生成完。')
    } catch (e) {
      setPhase('idle')
      if (e instanceof AiError && e.kind === 'aborted') return
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const toggle = (i: number, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (on) next.add(i)
      else next.delete(i)
      return next
    })

  return (
    <>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Label htmlFor="ai-lb-source">参考资料</Label>
            <div className="flex-1" />
            {getCardSource && (
              <Button variant="ghost" size="sm" onClick={() => setSource(getCardSource())}>
                填入角色设定
              </Button>
            )}
          </div>
          <Textarea
            id="ai-lb-source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="贴一段世界观设定、人物介绍或小说片段，AI 会从里面整理出条目"
            className="max-h-[30svh] min-h-28"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
          <Input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="其他要求（可不填），例如：只要地点；每条 150 字以内" />
          <Input
            type="number"
            min={1}
            max={50}
            value={maxEntries}
            onChange={(e) => setMaxEntries(Math.min(50, Math.max(1, Number(e.target.value) || 1)))}
            aria-label="最多生成条数"
            title="最多生成条数"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {phase === 'running' && <p className="text-sm text-muted-foreground">生成中，已收到 {received} 字…</p>}
        {entries.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-sm">
              <span>生成了 {entries.length} 条，勾选要添加的：</span>
              <Button variant="ghost" size="sm" onClick={() => setPicked(new Set(picked.size === entries.length ? [] : entries.map((_, i) => i)))}>
                {picked.size === entries.length ? '全不选' : '全选'}
              </Button>
            </div>
            <div className="flex flex-col gap-1">
              {entries.map((entry, i) => (
                <Collapsible key={i} className="rounded-md border">
                  <div className="flex items-center gap-2 px-2">
                    <Checkbox checked={picked.has(i)} onCheckedChange={(v) => toggle(i, v === true)} aria-label={`添加 ${entry.comment}`} />
                    <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-sm">
                      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                      <Badge variant="secondary" className="shrink-0">
                        {GENERATED_TYPE_LABELS[entry.type]}
                      </Badge>
                      <span className="shrink-0 font-medium">{entry.comment}</span>
                      {entry.constant && (
                        <Badge variant="outline" className="shrink-0">
                          常驻
                        </Badge>
                      )}
                      <span className="truncate text-xs text-muted-foreground">{entry.keys.join('、')}</span>
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent className="border-t px-3 py-2 text-sm whitespace-pre-wrap break-words">{entry.content}</CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          </div>
        )}
      </div>
      <DialogFooter className="items-center gap-2 sm:justify-between">
        <span className="truncate text-xs text-muted-foreground">
          使用 {profile.name} · {profile.model || '未选模型'}
        </span>
        <div className="flex flex-wrap justify-end gap-2">
          {phase === 'running' ? (
            <Button variant="outline" onClick={() => abort.current?.abort()}>
              <SquareIcon /> 停止
            </Button>
          ) : (
            <Button variant={entries.length ? 'outline' : 'default'} onClick={generate}>
              <SparklesIcon /> {entries.length ? '重新生成' : '生成条目'}
            </Button>
          )}
          {entries.length > 0 && (
            <Button
              disabled={picked.size === 0}
              onClick={() => {
                onAdd(entries.filter((_, i) => picked.has(i)))
                onClose()
              }}
            >
              添加选中的 {picked.size} 条
            </Button>
          )}
        </div>
      </DialogFooter>
    </>
  )
}

export function AiLorebookDialog({ open, onOpenChange, ...rest }: AiLorebookDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92svh] min-w-0 flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>AI 生成世界书条目</DialogTitle>
          <DialogDescription>从设定或小说片段里整理出人物、地点、组织、名词条目。生成后先预览，勾选的才会添加，添加后可以撤销。</DialogDescription>
        </DialogHeader>
        {open && <Body {...rest} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}
