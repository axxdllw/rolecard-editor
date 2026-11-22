/**
 * 模拟聊天的对话编辑区：选择开场白 + 增删编辑消息列表。
 */
import { ChevronDownIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { CardScanTestData } from '@/db/db'
import { cn } from '@/lib/utils'

interface ScanChatEditorProps {
  /** 卡片的所有开场白：0 主开场白，1..N 备选开场白 */
  greetings: string[]
  /** 替换过 {{char}}/{{user}} 的当前开场白内容，不带开场白时为 null */
  resolvedGreeting: string | null
  value: CardScanTestData
  onChange: (next: CardScanTestData) => void
}

function greetingSnippet(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return '（空）'
  return clean.length > 20 ? `${clean.slice(0, 20)}…` : clean
}

export function ScanChatEditor({ greetings, resolvedGreeting, value, onChange }: ScanChatEditorProps) {
  const [greetingOpen, setGreetingOpen] = useState(false)
  // 刚点“+ 消息”加出来的那条：挂载时自动聚焦，方便直接输入
  const [focusIndex, setFocusIndex] = useState<number | null>(null)

  // 选中的开场白如果已不存在，安全回退为不带开场白
  const effectiveGreeting = value.greeting >= 0 && value.greeting < greetings.length ? value.greeting : -1
  const hasGreeting = effectiveGreeting >= 0

  const setGreeting = (v: string) => {
    onChange({ ...value, greeting: Number(v) })
  }

  const updateMessage = (index: number, patch: Partial<CardScanTestData['messages'][number]>) => {
    const messages = value.messages.map((m, i) => (i === index ? { ...m, ...patch } : m))
    onChange({ ...value, messages })
  }

  const removeMessage = (index: number) => {
    const messages = value.messages.filter((_, i) => i !== index)
    onChange({ ...value, messages })
  }

  const addMessage = (role: 'user' | 'char') => {
    setFocusIndex(value.messages.length)
    onChange({ ...value, messages: [...value.messages, { role, text: '' }] })
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="scan-greeting-select" className="text-xs text-muted-foreground">
          开场白
        </Label>
        <Select value={String(effectiveGreeting)} onValueChange={setGreeting}>
          <SelectTrigger id="scan-greeting-select" size="sm" className="w-full min-w-0">
            <span className="min-w-0 flex-1 truncate text-left">
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="-1">不带开场白</SelectItem>
            {greetings.map((text, idx) => (
              <SelectItem key={idx} value={String(idx)}>
                {idx === 0 ? '主开场白' : `备选 ${idx}`}：{greetingSnippet(text)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasGreeting && (
          <Collapsible open={greetingOpen} onOpenChange={setGreetingOpen} className="rounded-lg border bg-muted/30">
            <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground">
              <span className="font-medium text-foreground">#1</span>
              <span className="rounded bg-amber-500/15 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                角色 · 开场白
              </span>
              <span className="min-w-0 flex-1 truncate">{greetingSnippet(resolvedGreeting ?? '')}</span>
              <ChevronDownIcon className={cn('size-3.5 shrink-0 transition-transform', greetingOpen && 'rotate-180')} />
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t px-2.5 py-2">
              <pre className="max-h-40 overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {resolvedGreeting || '（开场白为空）'}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">聊天消息</Label>
          <span className="text-[11px] text-muted-foreground tabular-nums">共 {value.messages.length + (hasGreeting ? 1 : 0)} 条</span>
        </div>
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-0.5">
          {value.messages.map((msg, i) => {
            const displayIndex = i + (hasGreeting ? 2 : 1)
            const isUser = msg.role === 'user'
            return (
              <div key={i} className="flex flex-col gap-1 rounded-lg border bg-background p-2 focus-within:border-ring">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-muted-foreground tabular-nums">#{displayIndex}</span>
                  <button
                    type="button"
                    onClick={() => updateMessage(i, { role: isUser ? 'char' : 'user' })}
                    title="点击切换发言者（用户 / 角色）"
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors',
                      isUser
                        ? 'bg-sky-500/15 text-sky-700 hover:bg-sky-500/25 dark:text-sky-300'
                        : 'bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-300',
                    )}
                  >
                    {isUser ? '用户' : '角色'}
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="ml-auto text-muted-foreground hover:text-destructive"
                    onClick={() => removeMessage(i)}
                    aria-label={`删除第 ${displayIndex} 条消息`}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
                <Textarea
                  value={msg.text}
                  autoFocus={focusIndex === i}
                  onChange={(e) => updateMessage(i, { text: e.target.value })}
                  placeholder={isUser ? '输入用户消息…' : '输入角色回复…'}
                  className="max-h-44 min-h-9 resize-none overflow-y-auto border-0 bg-transparent px-1 py-1 text-xs leading-relaxed shadow-none focus-visible:ring-0"
                />
              </div>
            )
          })}
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <Button type="button" variant="outline" size="sm" onClick={() => addMessage('user')}>
            <PlusIcon /> 用户消息
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => addMessage('char')}>
            <PlusIcon /> 角色消息
          </Button>
        </div>
      </div>
    </div>
  )
}
