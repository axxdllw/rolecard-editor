import { ChevronDownIcon, CopyIcon, Trash2Icon } from 'lucide-react'
import { useCallback, useState, type ReactNode } from 'react'
import { TagInput } from '@/components/TagInput'
import { TextEditor } from '@/components/TextEditor'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { LorebookEntry } from '@/core/card/types'
import {
  getDepth,
  getOrder,
  getOutletName,
  getPosition,
  getRole,
  getSelectiveLogic,
  getStrategy,
  isRegexKey,
  LOGIC_OPTIONS,
  POSITION_OPTIONS,
  readEntrySettings,
  ROLE_OPTIONS,
  setCaseSensitive,
  setExt,
  setOutletName,
  setPosition,
  setStrategy,
  type EntryStrategy,
} from '@/core/lorebook/entry'
import { FieldLabel, TokenBadge } from '@/features/editor/fields'
import type { UpdateOptions } from '@/features/editor/docStore'
import { cn } from '@/lib/utils'
import { OutletNameInput } from './OutletNameInput'

const EMPTY: string[] = []

interface EntryDetailProps {
  entry: LorebookEntry
  entryKey: string
  onEdit: (edit: (entry: LorebookEntry) => void, options?: UpdateOptions) => void
  onDelete: () => void
  onDuplicate: () => void
  extraActions?: ReactNode
  /** 世界书里已有的锚点名，填锚点名时自动补全 */
  outletNames?: string[]
}

function numOrNull(raw: string): number | null {
  if (raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function TriState({ value, onChange, labels }: { value: boolean | null; onChange: (v: boolean | null) => void; labels: [string, string, string] }) {
  const current = value === null ? 'global' : value ? 'yes' : 'no'
  return (
    <Select value={current} onValueChange={(v) => onChange(v === 'global' ? null : v === 'yes')}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="global">{labels[0]}</SelectItem>
        <SelectItem value="yes">{labels[1]}</SelectItem>
        <SelectItem value="no">{labels[2]}</SelectItem>
      </SelectContent>
    </Select>
  )
}

const MATCH_SOURCES: Array<[string, string]> = [
  ['match_persona_description', '用户人设'],
  ['match_character_description', '角色描述'],
  ['match_character_personality', '角色性格'],
  ['match_character_depth_prompt', '角色注释'],
  ['match_scenario', '场景'],
  ['match_creator_notes', '创作者备注'],
]

export function EntryDetail({ entry, entryKey, onEdit, onDelete, onDuplicate, extraActions, outletNames = EMPTY }: EntryDetailProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const strategy = getStrategy(entry)
  const position = getPosition(entry)
  const settings = readEntrySettings(entry)
  const ext = entry.extensions ?? {}

  const edit = (label: string, fn: (e: LorebookEntry) => void, field?: string) =>
    onEdit(fn, { label, key: field ? `entry.${entryKey}.${field}` : undefined })

  const onContent = useCallback(
    (v: string) => onEdit((e) => void (e.content = v), { key: `entry.${entryKey}.content`, label: '编辑条目内容' }),
    [onEdit, entryKey],
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Switch checked={entry.enabled !== false} onCheckedChange={(v) => edit(v ? '启用条目' : '禁用条目', (e) => void (e.enabled = v))} aria-label="启用" />
        <Input
          className="min-w-40 flex-1 font-medium"
          value={typeof entry.comment === 'string' ? entry.comment : ''}
          placeholder="备注名（只给自己看）"
          onChange={(e) => edit('修改备注名', (x) => void (x.comment = e.target.value), 'comment')}
        />
        <div className="flex gap-1">
          {extraActions}
          <Button variant="ghost" size="icon-sm" onClick={onDuplicate} aria-label="复制条目">
            <CopyIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label="删除条目">
            <Trash2Icon />
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <FieldLabel label="触发方式" hint="常驻：每轮都发送；关键词：聊天里出现关键词才发送；向量：用向量检索匹配（需要 ST 开启向量存储）" />
          <ToggleGroup
            type="single"
            variant="outline"
            value={strategy}
            onValueChange={(v) => v && edit('修改触发方式', (e) => setStrategy(e, v as EntryStrategy))}
            className="w-full"
          >
            <ToggleGroupItem value="constant" className="flex-1">
              常驻
            </ToggleGroupItem>
            <ToggleGroupItem value="keyword" className="flex-1">
              关键词
            </ToggleGroupItem>
            <ToggleGroupItem value="vectorized" className="flex-1">
              向量
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="flex flex-col gap-1.5">
          <FieldLabel label="插入位置" hint={POSITION_OPTIONS.find((p) => p.value === position)?.hint} />
          <Select value={String(position)} onValueChange={(v) => edit('修改插入位置', (e) => setPosition(e, Number(v)))}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {POSITION_OPTIONS.map((p) => (
                <SelectItem key={p.value} value={String(p.value)}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        {position === 4 && (
          <>
            <div className="flex w-24 flex-col gap-1.5">
              <FieldLabel label="深度" hint="0 表示最新消息之后，数字越大越靠前" />
              <Input type="number" min={0} value={getDepth(entry)} onChange={(e) => edit('修改深度', (x) => setExt(x, 'depth', Number(e.target.value) || 0), 'depth')} />
            </div>
            <div className="flex w-32 flex-col gap-1.5">
              <FieldLabel label="消息角色" />
              <Select value={String(getRole(entry))} onValueChange={(v) => edit('修改消息角色', (x) => setExt(x, 'role', Number(v)))}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r.value} value={String(r.value)}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        )}
        {position === 7 && (
          <div className="flex w-44 flex-col gap-1.5">
            <FieldLabel label="锚点名" hint="在预设的提示词里写 {{outlet::锚点名}} 引用，同名的条目会拼在一起。区分大小写" />
            <OutletNameInput
              names={outletNames}
              value={getOutletName(entry)}
              onChange={(e) => edit('修改锚点名', (x) => setOutletName(x, e.target.value), 'outlet_name')}
            />
          </div>
        )}
        <div className="flex w-24 flex-col gap-1.5">
          <FieldLabel label="顺序" hint={position === 7 ? '同一锚点里数字越大越靠前（酒馆 1.16 的实际拼接顺序，与其他位置相反）' : '同一位置里数字越大越靠后、离最新消息越近'} />
          <Input type="number" value={getOrder(entry)} onChange={(e) => edit('修改顺序', (x) => void (x.insertion_order = Number(e.target.value) || 0), 'order')} />
        </div>
        <div className="flex w-36 flex-col gap-1.5">
          <FieldLabel label="触发概率 %" hint="关闭时总是 100%" />
          <div className="flex items-center gap-2">
            <Switch checked={settings.useProbability} onCheckedChange={(v) => edit('修改概率开关', (x) => setExt(x, 'useProbability', v))} aria-label="使用概率" />
            <Input
              type="number"
              min={0}
              max={100}
              disabled={!settings.useProbability}
              value={settings.probability}
              onChange={(e) => edit('修改触发概率', (x) => setExt(x, 'probability', Math.min(100, Math.max(0, Number(e.target.value) || 0))), 'probability')}
            />
          </div>
        </div>
      </div>

      {strategy !== 'constant' && (
        <>
          <div className="flex flex-col gap-1.5">
            <FieldLabel label="关键词" hint="出现任意一个就触发。/…/ 形式是正则，例如 /弗洛洛|Phrolova/i" />
            <TagInput
              value={entry.keys ?? EMPTY}
              onChange={(v) => edit('修改关键词', (x) => void (x.keys = v))}
              placeholder="回车或逗号分隔"
              tagClassName={(t) => (isRegexKey(t) ? 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300' : undefined)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <FieldLabel
              label="次要关键词"
              hint="可选。与主关键词配合，按左边的逻辑判断"
              extra={
                <Select
                  value={String(getSelectiveLogic(entry))}
                  onValueChange={(v) => edit('修改次要关键词逻辑', (x) => setExt(x, 'selectiveLogic', Number(v)))}
                >
                  <SelectTrigger size="sm" className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOGIC_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={String(o.value)}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
            <TagInput
              value={entry.secondary_keys ?? EMPTY}
              onChange={(v) =>
                edit('修改次要关键词', (x) => {
                  x.secondary_keys = v
                  if (v.length > 0) x.selective = true
                })
              }
              placeholder="可选"
            />
          </div>
        </>
      )}

      <div className="flex flex-col gap-1.5">
        <FieldLabel label="内容" extra={<TokenBadge text={entry.content ?? ''} />} />
        <TextEditor
          value={entry.content ?? ''}
          onChange={onContent}
          minHeight={220}
          maxHeight={560}
          fullscreenTitle={`条目内容 · ${entry.comment || '未命名'}`}
          placeholder="触发时发送给模型的内容"
        />
      </div>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="rounded-lg border">
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium">
          高级设置
          <span className="text-xs font-normal text-muted-foreground">递归、匹配、分组、时效</span>
          <ChevronDownIcon className={cn('ml-auto size-4 transition', advancedOpen && 'rotate-180')} />
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-4 border-t p-3">
          <div className="flex flex-col gap-2">
            <Label className="text-xs text-muted-foreground">递归</Label>
            {(
              [
                ['exclude_recursion', '不会被其他条目的内容触发', settings.excludeRecursion],
                ['prevent_recursion', '内容不会再触发其他条目', settings.preventRecursion],
                ['delay_until_recursion', '只在递归扫描时才触发', settings.delayUntilRecursion],
              ] as const
            ).map(([key, label, checked]) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <Checkbox checked={checked} onCheckedChange={(v) => edit(`修改${label}`, (x) => setExt(x, key, v === true))} />
                {label}
              </label>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <FieldLabel label="区分大小写" />
              <TriState value={settings.caseSensitive} onChange={(v) => edit('修改大小写匹配', (x) => setCaseSensitive(x, v))} labels={['跟随全局', '区分', '不区分']} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel label="全词匹配" hint="只对英文等有空格分词的语言有效" />
              <TriState value={settings.matchWholeWords} onChange={(v) => edit('修改全词匹配', (x) => setExt(x, 'match_whole_words', v))} labels={['跟随全局', '是', '否']} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel label="扫描深度" hint="往回扫描多少条消息找关键词，留空跟随全局" />
              <Input
                type="number"
                min={0}
                placeholder="跟随全局"
                value={settings.scanDepth ?? ''}
                onChange={(e) => edit('修改扫描深度', (x) => setExt(x, 'scan_depth', numOrNull(e.target.value)), 'scan_depth')}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <FieldLabel label="分组" hint="同组条目同时触发时只选一个，多个组用逗号分隔" />
              <Input value={settings.group} onChange={(e) => edit('修改分组', (x) => setExt(x, 'group', e.target.value), 'group')} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel label="组内权重" />
              <Input type="number" min={0} value={settings.groupWeight} onChange={(e) => edit('修改组内权重', (x) => setExt(x, 'group_weight', Number(e.target.value) || 0), 'group_weight')} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel label="组内评分" hint="按关键词命中数挑选组内条目" />
              <TriState value={settings.useGroupScoring} onChange={(v) => edit('修改组内评分', (x) => setExt(x, 'use_group_scoring', v))} labels={['跟随全局', '开启', '关闭']} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={settings.groupOverride} onCheckedChange={(v) => edit('修改组内优先', (x) => setExt(x, 'group_override', v === true))} />
            组内优先：按顺序挑选，而不是按权重随机
          </label>

          <div className="grid gap-3 sm:grid-cols-3">
            {(
              [
                ['sticky', '持续轮数', '触发后保持激活的消息条数', settings.sticky],
                ['cooldown', '冷却轮数', '激活结束后多少条消息内不能再触发', settings.cooldown],
                ['delay', '延迟', '聊天里至少有多少条消息才能触发', settings.delay],
              ] as const
            ).map(([key, label, hint, value]) => (
              <div key={key} className="flex flex-col gap-1.5">
                <FieldLabel label={label} hint={hint} />
                <Input type="number" min={0} placeholder="关闭" value={value ?? ''} onChange={(e) => edit(`修改${label}`, (x) => setExt(x, key, numOrNull(e.target.value)), key)} />
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <Label className="text-xs text-muted-foreground">额外匹配来源（除聊天记录外，也在这些地方找关键词）</Label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {MATCH_SOURCES.map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={ext[key] === true} onCheckedChange={(v) => edit(`修改匹配来源`, (x) => setExt(x, key, v === true))} />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5 sm:w-1/2">
            <FieldLabel label="自动化 ID" hint="配合 ST 的快捷回复自动化使用" />
            <Input value={settings.automationId} onChange={(e) => edit('修改自动化 ID', (x) => setExt(x, 'automation_id', e.target.value), 'automation_id')} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
