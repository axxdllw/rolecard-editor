/**
 * AI 改写字段：选模式（润色 / 扩写 / 精简 / 按要求改 / 撰写），流式生成，和原文对比后再决定是否采用。
 * 采用时由调用方写回字段（编辑页里算一步，可以撤销）。
 */
import { SparklesIcon, SquareIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { TextDiffView } from '@/components/TextDiffView'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { streamChat } from '@/core/ai/client'
import { buildRewriteRequest, cleanRewriteOutput, matchLineEndings, REWRITE_MODE_LABELS, type RewriteContext, type RewriteMode } from '@/core/ai/tasks/rewrite'
import { AiError } from '@/core/ai/types'
import { useActiveAiProfile, useAiSettings } from '@/lib/aiSettings'

export interface AiRewriteTarget {
  fieldLabel: string
  fieldHint?: string
  value: string
  /** 打开时再取，保证拿到最新的卡片内容 */
  getContext?: () => RewriteContext | undefined
  onApply: (text: string) => void
}

type Phase = 'idle' | 'running' | 'done'

const MODES: RewriteMode[] = ['polish', 'expand', 'condense', 'custom']

function ProfilePicker() {
  const { profiles, setActive } = useAiSettings()
  const active = useActiveAiProfile()
  if (profiles.length < 2 || !active) return active ? <span className="truncate text-xs text-muted-foreground">使用 {active.name} · {active.model}</span> : null
  return (
    <Select value={active.id} onValueChange={setActive}>
      <SelectTrigger size="sm" className="max-w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {profiles.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name} · {p.model || '未选模型'}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function RewriteBody({ target, onClose }: { target: AiRewriteTarget; onClose: () => void }) {
  const profile = useActiveAiProfile()
  const empty = !target.value.trim()
  const [mode, setMode] = useState<RewriteMode>(empty ? 'write' : 'polish')
  const [instruction, setInstruction] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [view, setView] = useState('diff')
  const abort = useRef<AbortController | null>(null)
  const context = useRef<RewriteContext | undefined>(undefined)

  useEffect(() => () => abort.current?.abort(), [])

  const generate = async () => {
    if (!profile) return
    if (mode === 'custom' && !instruction.trim()) {
      setError('“按要求改”需要先写下要求')
      return
    }
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    context.current ??= target.getContext?.()
    setPhase('running')
    setOutput('')
    setError(null)
    setNotice(null)
    try {
      const request = buildRewriteRequest({
        mode,
        instruction,
        fieldLabel: target.fieldLabel,
        fieldHint: target.fieldHint,
        text: target.value,
        context: context.current,
      })
      const result = await streamChat(profile, { ...request, signal: controller.signal, onText: (_d, full) => setOutput(full) })
      setOutput(matchLineEndings(cleanRewriteOutput(result.text), target.value))
      if (result.finishReason === 'length') setNotice('输出达到了最大长度，结尾可能不完整。')
      setView('diff')
      setPhase('done')
    } catch (e) {
      if (e instanceof AiError && e.kind === 'aborted') {
        setPhase(output ? 'done' : 'idle')
        setOutput((prev) => matchLineEndings(cleanRewriteOutput(prev), target.value))
        if (output) setNotice('已停止，下面是停止前生成的部分。')
        return
      }
      setError(e instanceof Error ? e.message : String(e))
      setPhase('idle')
    }
  }

  if (!profile) {
    return (
      <div className="flex flex-col items-start gap-3 text-sm">
        <p>还没设置 AI 接口。到设置页添加一个（支持 OpenAI 兼容接口、Claude、Gemini），填上自己的 API key 就能用。</p>
        <Button asChild onClick={onClose}>
          <Link to="/settings">去设置</Link>
        </Button>
      </div>
    )
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        {!empty && (
          <ToggleGroup type="single" variant="outline" size="sm" value={mode} onValueChange={(v) => v && setMode(v as RewriteMode)} className="flex-wrap">
            {MODES.map((m) => (
              <ToggleGroupItem key={m} value={m} className="px-3">
                {REWRITE_MODE_LABELS[m]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <Textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={
            empty
              ? '想写成什么样？例如：用 YAML 格式，写外貌、性格、口癖（可不填）'
              : mode === 'custom'
                ? '要怎么改？例如：把 {{user}} 的性别改成女性；改成第三人称'
                : '补充要求（可不填），例如：语气更冷淡一些'
          }
          className="min-h-16"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && phase !== 'running') void generate()
          }}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        {phase === 'running' && (
          <div className="max-h-[45svh] overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-sm">
            {output || <span className="text-muted-foreground">等待模型回复…</span>}
          </div>
        )}
        {phase === 'done' && (
          <Tabs value={view} onValueChange={setView} className="min-h-0 gap-2">
            <TabsList>
              <TabsTrigger value="diff">和原文对比</TabsTrigger>
              <TabsTrigger value="edit">结果（可修改）</TabsTrigger>
            </TabsList>
            <TabsContent value="diff" className="max-h-[45svh] overflow-y-auto rounded-md border p-2">
              <TextDiffView before={target.value} after={output} />
            </TabsContent>
            <TabsContent value="edit">
              <Textarea value={output} onChange={(e) => setOutput(e.target.value)} className="max-h-[45svh] min-h-40" />
            </TabsContent>
          </Tabs>
        )}
        {notice && <p className="text-xs text-amber-700 dark:text-amber-400">{notice}</p>}
      </div>
      <DialogFooter className="items-center gap-2 sm:justify-between">
        <ProfilePicker />
        <div className="flex flex-wrap justify-end gap-2">
          {phase === 'running' ? (
            <Button variant="outline" onClick={() => abort.current?.abort()}>
              <SquareIcon /> 停止
            </Button>
          ) : (
            <Button variant={phase === 'done' ? 'outline' : 'default'} onClick={generate}>
              <SparklesIcon /> {phase === 'done' ? '重新生成' : '生成'}
            </Button>
          )}
          {phase === 'done' && (
            <Button
              onClick={() => {
                target.onApply(output)
                onClose()
              }}
              disabled={!output.trim()}
            >
              采用
            </Button>
          )}
        </div>
      </DialogFooter>
    </>
  )
}

export function AiRewriteDialog({ target, onOpenChange }: { target: AiRewriteTarget | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92svh] min-w-0 flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>AI {target && !target.value.trim() ? '撰写' : '改写'} · {target?.fieldLabel}</DialogTitle>
          <DialogDescription>生成后先和原文对比，点“采用”才会写入字段，写入后也可以撤销。</DialogDescription>
        </DialogHeader>
        {target && <RewriteBody target={target} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

/** 字段标签行上的 AI 按钮 */
export function AiFieldButton({ target }: { target: () => AiRewriteTarget }) {
  const [open, setOpen] = useState<AiRewriteTarget | null>(null)
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="size-6 text-muted-foreground" onClick={() => setOpen(target())} aria-label="AI 改写">
            <SparklesIcon className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>AI 润色 / 扩写 / 精简</TooltipContent>
      </Tooltip>
      <AiRewriteDialog target={open} onOpenChange={(o) => !o && setOpen(null)} />
    </>
  )
}

