import { useState } from 'react'
import { ArrowRightIcon, MinusIcon, PlusIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DEFAULT_TITLE_VOCAB, RULE_KINDS, type NamePair, type RenameRule, type RuleKind, type TitleVocab } from '@/core/search/rename'
import { cn } from '@/lib/utils'
import { useRenameStore, type RenamePreset } from './renameStore'

/** 一侧姓名：全名 + 拆出来的姓和名，姓的字数可以加减 */
export function NameBox(props: {
  title: string
  full: string
  surname: string
  given: string
  placeholder: string
  canShift: boolean
  onFull: (v: string) => void
  onSurname: (v: string) => void
  onGiven: (v: string) => void
  onShift: (delta: number) => void
}) {
  const { title, full, surname, given, placeholder, canShift } = props
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border p-2.5">
      <Label>{title}</Label>
      <Input value={full} placeholder={placeholder} onChange={(e) => props.onFull(e.target.value)} />
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-xs text-muted-foreground">姓</span>
        <Input className="h-7 w-20" value={surname} onChange={(e) => props.onSurname(e.target.value)} />
        <Button size="icon-xs" variant="ghost" title="姓少一个字" disabled={!canShift || surname.length === 0} onClick={() => props.onShift(-1)}>
          <MinusIcon />
        </Button>
        <Button size="icon-xs" variant="ghost" title="姓多一个字" disabled={!canShift || given.length <= 1} onClick={() => props.onShift(1)}>
          <PlusIcon />
        </Button>
        <span className="ml-1 shrink-0 text-xs text-muted-foreground">名</span>
        <Input className="h-7 min-w-0 flex-1" value={given} onChange={(e) => props.onGiven(e.target.value)} />
      </div>
    </div>
  )
}

/** 「旧 → 新」成对清单（绰号、其他替换） */
export function PairList({ pairs, onChange, fromPlaceholder, toPlaceholder }: { pairs: NamePair[]; onChange: (pairs: NamePair[]) => void; fromPlaceholder: string; toPlaceholder: string }) {
  const update = (i: number, patch: Partial<NamePair>) => onChange(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  return (
    <div className="flex flex-col gap-1.5">
      {pairs.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input className="h-7 min-w-0 flex-1" value={p.from} placeholder={fromPlaceholder} onChange={(e) => update(i, { from: e.target.value })} />
          <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground" />
          <Input className="h-7 min-w-0 flex-1" value={p.to} placeholder={toPlaceholder} onChange={(e) => update(i, { to: e.target.value })} />
          <Button size="icon-xs" variant="ghost" aria-label="删除" onClick={() => onChange(pairs.filter((_, j) => j !== i))}>
            <Trash2Icon />
          </Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Button size="xs" variant="outline" onClick={() => onChange([...pairs, { from: '', to: '' }])}>
          <PlusIcon /> 添加
        </Button>
        {pairs.length > 0 && (
          <Button size="xs" variant="ghost" onClick={() => onChange([])}>
            清空
          </Button>
        )}
      </div>
    </div>
  )
}

const VOCAB_FIELDS: Array<[keyof TitleVocab, string, string]> = [
  ['surnamePrefixes', '姓前称谓', '老张、小张'],
  ['surnameAny', '姓后称谓 · 通用', '张老师、张总'],
  ['surnameMale', '姓后称谓 · 男', '张先生、张公子'],
  ['surnameFemale', '姓后称谓 · 女', '张小姐、张夫人'],
  ['givenPrefixes', '名前称谓', '阿丰、小丰'],
  ['givenAny', '名后称谓 · 通用', '丰酱、三丰君'],
  ['givenMale', '名后称谓 · 男', '丰哥、三丰兄'],
  ['givenFemale', '名后称谓 · 女', '丰姐、丰儿'],
]

/** 词表输入框：打字时不拆分，失焦再保存，避免空格被吞 */
function VocabInput({ words, onCommit }: { words: string[]; onCommit: (words: string[]) => void }) {
  const [text, setText] = useState(words.join(' '))
  return (
    <Input
      className="h-7"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(text.split(/[\s,，、]+/).filter(Boolean))}
    />
  )
}

export function VocabPanel() {
  const vocab = useRenameStore((s) => s.vocab)
  const setVocab = useRenameStore((s) => s.setVocab)
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        按这些词把姓和名组合成各种叫法，只有卡里真的出现过的才会列进替换规则。词之间用空格分开；性别选「男」时不派生「女」的称谓，反之亦然。外文姓会自动用
        Mr. / Ms. / Miss 等。
      </p>
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
        {VOCAB_FIELDS.map(([key, label, example]) => (
          <div key={key} className="flex flex-col gap-1">
            <span className="text-xs">
              {label} <span className="text-muted-foreground">（如 {example}）</span>
            </span>
            <VocabInput key={vocab[key].join(' ')} words={vocab[key]} onCommit={(words) => setVocab({ ...vocab, [key]: words })} />
          </div>
        ))}
      </div>
      <Button size="xs" variant="ghost" className="self-start" onClick={() => setVocab(DEFAULT_TITLE_VOCAB)}>
        <RotateCcwIcon /> 恢复默认词表
      </Button>
    </div>
  )
}

export function PresetPanel({ current, suggestedName, onLoad }: { current: Omit<RenamePreset, 'id' | 'name' | 'savedAt'>; suggestedName: string; onLoad: (preset: RenamePreset) => void }) {
  const presets = useRenameStore((s) => s.presets)
  const savePreset = useRenameStore((s) => s.savePreset)
  const deletePreset = useRenameStore((s) => s.deletePreset)
  const [name, setName] = useState('')
  const finalName = name.trim() || suggestedName

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">把当前的姓名、绰号、其他替换和规则勾选存成方案，换一张卡（比如同一角色的其他版本）时直接载入。同名方案会被覆盖。</p>
      <div className="flex gap-2">
        <Input className="h-7" value={name} placeholder={suggestedName || '方案名称'} onChange={(e) => setName(e.target.value)} />
        <Button size="sm" disabled={!finalName} onClick={() => savePreset({ ...current, name: finalName })}>
          保存当前方案
        </Button>
      </div>
      {presets.length === 0 ? (
        <p className="text-xs text-muted-foreground">还没有保存的方案。</p>
      ) : (
        <div className="flex flex-col rounded-lg border">
          {presets.map((p) => (
            <div key={p.id} className="flex items-center gap-2 border-b px-3 py-1.5 text-sm last:border-b-0">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{p.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {p.config.oldFull || '（无）'} → {p.config.newFull || '（无）'}
                  {p.config.nicknames.filter((n) => n.to).length > 0 && ` · ${p.config.nicknames.filter((n) => n.to).length} 个绰号`}
                  {p.config.others.filter((n) => n.to).length > 0 && ` · ${p.config.others.filter((n) => n.to).length} 个其他替换`}
                </span>
              </span>
              <Button size="xs" variant="outline" onClick={() => onLoad(p)}>
                载入
              </Button>
              <Button size="icon-xs" variant="ghost" aria-label="删除方案" onClick={() => deletePreset(p.id)}>
                <Trash2Icon />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const KIND_HINTS: Partial<Record<RuleKind, string>> = {
  名字: '不带姓单独出现的名字；单字名容易误伤，默认不勾',
  姓氏称谓: '按「称谓词表」派生',
  名字称谓: '按「称谓词表」派生，双字名还会用末字（阿丰、丰哥、丰丰）',
}

/** 这几类是手填的，没命中也显示，方便发现写错 */
const ALWAYS_SHOWN: RuleKind[] = ['全名', '绰号', '其他']

export function RuleList(props: {
  rules: RenameRule[]
  /** 勾选的规则是实际会替换的处数，没勾的是单独出现的次数 */
  counts: Map<string, number>
  rawCounts: Map<string, number>
  isOn: (rule: RenameRule) => boolean
  targetOf: (rule: RenameRule) => string
  onToggle: (rule: RenameRule, on: boolean) => void
  onTarget: (rule: RenameRule, to: string | undefined) => void
}) {
  const { rules, counts, rawCounts, isOn, targetOf } = props
  const [showAll, setShowAll] = useState(false)
  const visible = rules.filter((r) => showAll || ALWAYS_SHOWN.includes(r.kind) || (rawCounts.get(r.id) ?? 0) > 0)
  const hidden = rules.length - visible.length

  if (rules.length === 0) {
    return <p className="text-sm text-muted-foreground">填好原姓名和新姓名（或绰号、其他替换）后，这里会列出要替换的各种叫法。</p>
  }

  return (
    <div className="flex flex-col gap-2">
      {RULE_KINDS.map((kind) => {
        const list = visible.filter((r) => r.kind === kind)
        if (list.length === 0) return null
        return (
          <div key={kind} className="flex flex-col gap-1">
            <span className="text-xs font-medium">
              {kind}
              {KIND_HINTS[kind] && <span className="ml-2 font-normal text-muted-foreground">{KIND_HINTS[kind]}</span>}
            </span>
            {list.map((rule) => {
              const on = isOn(rule)
              const count = counts.get(rule.id) ?? 0
              const raw = rawCounts.get(rule.id) ?? 0
              const target = targetOf(rule)
              return (
                <div key={rule.id} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={on} onCheckedChange={(v) => props.onToggle(rule, v === true)} />
                  <span className={cn('w-28 shrink-0 truncate', !on && 'text-muted-foreground line-through')} title={rule.from}>
                    {rule.from}
                  </span>
                  <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <Input className="h-7 w-36 min-w-0" value={target} disabled={!on} onChange={(e) => props.onTarget(rule, e.target.value)} />
                  <span className={cn('shrink-0 text-xs', count === 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
                    {raw === 0 ? '卡里没有' : count === 0 ? '都在更长的叫法里' : `${count} 处`}
                  </span>
                  {kind === '全名' && (
                    <Button size="xs" variant="ghost" disabled={!on} onClick={() => props.onTarget(rule, target === '{{char}}' ? undefined : '{{char}}')}>
                      {target === '{{char}}' ? '改回新姓名' : '用 {{char}}'}
                    </Button>
                  )}
                  {target !== rule.to && kind !== '全名' && (
                    <Button size="xs" variant="ghost" onClick={() => props.onTarget(rule, undefined)}>
                      还原
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
      {(hidden > 0 || showAll) && (
        <Button size="xs" variant="ghost" className="self-start text-muted-foreground" onClick={() => setShowAll((v) => !v)}>
          {showAll ? '隐藏卡里没出现的叫法' : `另有 ${hidden} 个派生叫法卡里没出现，点击显示`}
        </Button>
      )}
    </div>
  )
}
