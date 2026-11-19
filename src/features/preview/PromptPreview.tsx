import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { assemblePrompt, type ActivationMode, type AssembledBlock } from '@/core/lorebook/assemble'
import type { CharacterCardV3 } from '@/core/card/types'
import { useSettings } from '@/lib/settings'
import { cachedTokens, formatTokens, useTokenizerReady } from '@/lib/tokens'
import { cn } from '@/lib/utils'

const KIND_STYLE: Record<AssembledBlock['kind'], { label: string; className: string }> = {
  card: { label: '卡片字段', className: 'border-l-slate-400' },
  constant: { label: '常驻', className: 'border-l-emerald-500' },
  triggered: { label: '触发', className: 'border-l-sky-500' },
  note: { label: '', className: '' },
}

function Block({ block }: { block: AssembledBlock }) {
  const [expanded, setExpanded] = useState(false)
  if (block.kind === 'note') {
    return <div className="pt-2 text-xs font-medium text-muted-foreground">{block.title}</div>
  }
  const long = block.content.length > 600
  return (
    <div className={cn('rounded-md border border-l-4 bg-background p-2.5', KIND_STYLE[block.kind].className)}>
      <div className="mb-1 flex items-center gap-2 text-xs">
        <span className="font-medium">{block.title}</span>
        <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
          {KIND_STYLE[block.kind].label}
        </Badge>
        <span className="ml-auto text-muted-foreground tabular-nums">约 {formatTokens(cachedTokens(block.content))} token</span>
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

/** 提示词组装预览：模拟 ST 把卡片字段和世界书条目拼进提示词的位置 */
export function PromptPreview({ card }: { card: CharacterCardV3 }) {
  useTokenizerReady()
  const userName = useSettings((s) => s.previewUserName)
  const setSettings = useSettings((s) => s.set)
  const [mode, setMode] = useState<ActivationMode>('constant')
  const [chatText, setChatText] = useState('')

  const sections = useMemo(
    () => assemblePrompt(card, { mode, chatText, macros: { char: card.data.name || '角色', user: userName || '用户' } }),
    [card, mode, chatText, userName],
  )
  const total = sections.flatMap((s) => s.blocks).reduce((sum, b) => sum + (cachedTokens(b.content) ?? 0), 0)
  const triggered = sections.flatMap((s) => s.blocks).filter((b) => b.kind === 'triggered').length

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
      <div className="flex h-fit flex-col gap-4 rounded-xl border bg-card p-4 lg:sticky lg:top-28">
        <div className="flex flex-col gap-2">
          <Label>哪些世界书条目算作触发</Label>
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as ActivationMode)} className="gap-2">
            {(
              [
                ['constant', '只看常驻', '最小情况：每轮固定发送的内容'],
                ['all', '全部关键词条目', '最大情况：假设所有条目都被触发'],
                ['match', '用测试文本匹配', '输入一段聊天内容，按关键词判断（不含递归）'],
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
          {mode === 'match' && (
            <Textarea rows={5} placeholder="例如：我们去拉古那的广场找秧秧吧" value={chatText} onChange={(e) => setChatText(e.target.value)} />
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="preview-user">{'{{user}}'} 显示为</Label>
          <Input id="preview-user" value={userName} onChange={(e) => setSettings({ previewUserName: e.target.value })} />
        </div>
        <div className="rounded-lg bg-muted/50 p-3 text-sm">
          合计约 <span className="font-semibold tabular-nums">{formatTokens(total)}</span> token
          {mode !== 'constant' && <span className="text-muted-foreground">，其中触发条目 {triggered} 个</span>}
          <p className="mt-1 text-xs text-muted-foreground">不含主提示词、预设和聊天记录本身。同顺序条目的先后以 ST 实际为准。</p>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {sections.map((section) => (
          <section key={section.id} className="rounded-xl border bg-card p-3">
            <h3 className="mb-0.5 text-sm font-semibold">{section.title}</h3>
            {section.hint && <p className="mb-2 text-xs text-muted-foreground">{section.hint}</p>}
            <div className="flex flex-col gap-2">
              {section.blocks.map((block, i) => (
                <Block key={i} block={block} />
              ))}
            </div>
          </section>
        ))}
        {sections.length === 0 && <p className="p-10 text-center text-sm text-muted-foreground">卡片还没有内容</p>}
      </div>
    </div>
  )
}
