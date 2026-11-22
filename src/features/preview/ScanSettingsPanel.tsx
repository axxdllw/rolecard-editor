/**
 * 扫描设置面板（可折叠，默认收起），对应 SillyTavern 的世界书全局设置。
 */
import { ChevronDownIcon, RotateCcwIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { DEFAULT_SCAN_SETTINGS, type ScanSettings } from '@/core/lorebook/activate'
import { cn } from '@/lib/utils'

interface ScanSettingsPanelProps {
  settings: ScanSettings
  onChange: (next: ScanSettings) => void
}

type BoolKey = 'recursive' | 'includeNames' | 'caseSensitive' | 'matchWholeWords' | 'useGroupScoring'
type NumKey = 'scanDepth' | 'maxRecursionSteps' | 'budgetPercent' | 'maxContext' | 'budgetCap' | 'minActivations' | 'minActivationsDepthMax'

type SettingItem =
  | { kind: 'bool'; key: BoolKey; label: string; hint: string }
  | { kind: 'num'; key: NumKey; label: string; hint: string; min: number; max?: number }

const SETTING_ITEMS: SettingItem[] = [
  { kind: 'num', key: 'scanDepth', label: '扫描深度', hint: '往回扫描最近几条消息', min: 0 },
  { kind: 'bool', key: 'recursive', label: '递归扫描', hint: '已触发条目的内容也能继续触发其他条目' },
  { kind: 'num', key: 'maxRecursionSteps', label: '最大递归步数', hint: '最多递归几轮，0 表示不限', min: 0 },
  { kind: 'bool', key: 'includeNames', label: '包含名字', hint: '扫描消息时带上“名字: ”前缀' },
  { kind: 'bool', key: 'caseSensitive', label: '区分大小写', hint: '关键词匹配区分英文字母大小写' },
  { kind: 'bool', key: 'matchWholeWords', label: '全词匹配', hint: '只对英文等有空格分词的语言有效' },
  { kind: 'bool', key: 'useGroupScoring', label: '使用组评分', hint: '包含组内按关键词命中数量挑选' },
  { kind: 'num', key: 'budgetPercent', label: '预算百分比', hint: '世界书最多占上下文长度的百分比', min: 0, max: 100 },
  { kind: 'num', key: 'maxContext', label: '上下文长度', hint: '换算预算用的总上下文 token 数', min: 1 },
  { kind: 'num', key: 'budgetCap', label: '预算上限', hint: '世界书 token 硬上限，0 表示不限', min: 0 },
  { kind: 'num', key: 'minActivations', label: '最少激活数', hint: '激活不够时自动往更早的消息扫', min: 0 },
  { kind: 'num', key: 'minActivationsDepthMax', label: '最少激活最大深度', hint: '凑最少激活数时的深度上限，0 不限', min: 0 },
]

const SETTING_KEYS = Object.keys(DEFAULT_SCAN_SETTINGS) as Array<keyof ScanSettings>

function NumberSettingInput({
  id,
  value,
  min,
  max,
  onCommit,
}: {
  id: string
  value: number
  min: number
  max?: number
  onCommit: (next: number) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)

  const clamp = (n: number) => (max !== undefined ? Math.min(max, Math.max(min, n)) : Math.max(min, n))

  return (
    <Input
      id={id}
      type="number"
      min={min}
      max={max}
      value={editing ?? String(value)}
      onChange={(e) => {
        const raw = e.target.value
        setEditing(raw)
        if (raw.trim() === '') return
        const parsed = Math.floor(Number(raw))
        if (Number.isFinite(parsed)) {
          onCommit(clamp(parsed))
        }
      }}
      onBlur={() => {
        if (editing !== null && editing.trim() === '') {
          onCommit(min)
        }
        setEditing(null)
      }}
      className="h-7 w-20 shrink-0 px-2 text-right text-xs tabular-nums"
    />
  )
}

export function ScanSettingsPanel({ settings, onChange }: ScanSettingsPanelProps) {
  const [open, setOpen] = useState(false)

  const changedCount = SETTING_KEYS.filter((k) => settings[k] !== DEFAULT_SCAN_SETTINGS[k]).length

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-xs font-medium">扫描设置（对照酒馆的世界书设置）</span>
          {changedCount > 0 && <span className="text-[11px] text-primary">与默认不同：{changedCount} 项</span>}
        </div>
        <ChevronDownIcon className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </CollapsibleTrigger>

      <CollapsibleContent className="flex flex-col gap-2.5 border-t p-2.5">
        {SETTING_ITEMS.map((item) => {
          const id = `scan-setting-${item.key}`
          const isModified = settings[item.key] !== DEFAULT_SCAN_SETTINGS[item.key]
          return (
            <div key={item.key} className="flex items-center justify-between gap-2">
              <label htmlFor={id} className="flex min-w-0 flex-1 flex-col">
                <span className={cn('text-xs font-medium', isModified && 'text-primary')}>{item.label}</span>
                <span className="text-[11px] leading-tight text-muted-foreground">{item.hint}</span>
              </label>
              {item.kind === 'bool' ? (
                <Switch
                  id={id}
                  size="sm"
                  checked={settings[item.key]}
                  onCheckedChange={(checked) => onChange({ ...settings, [item.key]: checked })}
                />
              ) : (
                <NumberSettingInput
                  id={id}
                  value={settings[item.key]}
                  min={item.min}
                  max={item.max}
                  onCommit={(next) => onChange({ ...settings, [item.key]: next })}
                />
              )}
            </div>
          )
        })}

        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={changedCount === 0}
          onClick={() => onChange({ ...DEFAULT_SCAN_SETTINGS })}
          className="mt-1 self-end text-muted-foreground"
        >
          <RotateCcwIcon /> 恢复默认
        </Button>
      </CollapsibleContent>
    </Collapsible>
  )
}
