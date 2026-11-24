import { useMemo, useState } from 'react'
import { ArrowLeftRightIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DialogFooter } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { CharacterCardV3 } from '@/core/card/types'
import {
  countRuleHits,
  deriveRules,
  hasNameSeparator,
  planRename,
  splitName,
  splitNameAt,
  type Gender,
  type RenameConfig,
  type RenameRule,
} from '@/core/search/rename'
import { collectTextSlots, detectNameCandidates } from '@/core/search/search'
import { useCardDoc } from '@/features/editor/cardDoc'
import { toggleIds, useApply } from './applyPlan'
import { HitList, type PlannedHit } from './HitList'
import { NameBox, PairList, PresetPanel, RuleList, VocabPanel } from './renameParts'
import { useRenameStore, type RenamePreset } from './renameStore'

const GENDERS: Array<[Gender, string]> = [
  ['any', '不限'],
  ['male', '男'],
  ['female', '女'],
]

function initialConfig(card: CharacterCardV3 | undefined): RenameConfig {
  const oldFull = card?.data.name ?? ''
  const split = splitName(oldFull)
  // 自动识别到的其他叫法先列进绰号清单，填上新叫法才会替换
  const nicknames = card
    ? detectNameCandidates(card)
        .filter((c) => c.name !== oldFull)
        .map((c) => ({ from: c.name, to: '' }))
    : []
  return { oldFull, newFull: '', oldSurname: split.surname, oldGiven: split.given, newSurname: '', newGiven: '', gender: 'any', nicknames, others: [] }
}

const canShift = (full: string) => full.trim().length > 1 && !hasNameSeparator(full)

export function RenameTab({ onDone }: { onDone: () => void }) {
  const card = useCardDoc((s) => s.doc?.card)
  const vocab = useRenameStore((s) => s.vocab)
  const [config, setConfig] = useState<RenameConfig>(() => initialConfig(card))
  const [toggles, setToggles] = useState<Record<string, boolean>>({})
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [updateName, setUpdateName] = useState(true)
  const [section, setSection] = useState('names')
  const [planned, setPlanned] = useState<{ key: string; hits: PlannedHit[] } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const apply = useApply(onDone)

  const cardName = card?.data.name ?? ''
  const newFull = config.newFull.trim()
  const renamesCard = config.oldFull.trim() === cardName && newFull !== '' && newFull !== cardName
  const writesName = updateName && renamesCard

  // 要直接改 name 字段时不在 name 里查找，免得重复替换
  const slots = useMemo(() => (card ? collectTextSlots(card).filter((s) => !(writesName && s.path.join('.') === 'data.name')) : []), [card, writesName])
  const rules = useMemo(() => deriveRules(config, vocab), [config, vocab])
  /** 每个叫法单独出现的次数，用来判断要不要列出来 */
  const rawCounts = useMemo(() => countRuleHits(slots, rules), [slots, rules])

  const isOn = (r: RenameRule) => toggles[r.id] ?? r.defaultOn
  const targetOf = (r: RenameRule) => overrides[r.id] ?? r.to

  // 按勾选的规则实时扫描（长叫法优先），规则旁边显示的是真正会替换的处数
  const { active, live } = useMemo(() => {
    const active = rules
      .filter((r) => (toggles[r.id] ?? r.defaultOn) && (rawCounts.get(r.id) ?? 0) > 0 && (overrides[r.id] ?? r.to).trim() !== '')
      .map((r) => ({ ...r, to: overrides[r.id] ?? r.to }))
    return { active, live: planRename(slots, active) }
  }, [rules, rawCounts, toggles, overrides, slots])
  const counts = useMemo(() => {
    const map = new Map(rawCounts)
    for (const r of active) map.set(r.id, 0)
    for (const { rule } of live) map.set(rule.id, (map.get(rule.id) ?? 0) + 1)
    return map
  }, [rawCounts, active, live])

  const planKey = JSON.stringify([active.map((r) => [r.from, r.to]), writesName])
  const hits = planned?.key === planKey ? planned.hits : null

  const patch = (p: Partial<RenameConfig>) => setConfig((c) => ({ ...c, ...p }))

  const setOldFull = (v: string) => {
    const s = splitName(v)
    patch({ oldFull: v, oldSurname: s.surname, oldGiven: s.given })
  }

  const setNewFull = (v: string) =>
    setConfig((c) => {
      let s = splitName(v)
      // 原名手动调过拆分点（如“宫水|三叶”）时，新名沿用同样的姓氏字数
      const manual = c.oldSurname !== splitName(c.oldFull).surname && c.oldFull.startsWith(c.oldSurname)
      if (manual && canShift(v) && canShift(c.oldFull) && s.surname.length < 2) s = splitNameAt(v, [...c.oldSurname].length)
      return { ...c, newFull: v, newSurname: s.surname, newGiven: s.given }
    })

  const shift = (side: 'old' | 'new', delta: number) =>
    setConfig((c) => {
      const full = side === 'old' ? c.oldFull : c.newFull
      const surname = side === 'old' ? c.oldSurname : c.newSurname
      const s = splitNameAt(full, [...surname].length + delta)
      return side === 'old' ? { ...c, oldSurname: s.surname, oldGiven: s.given } : { ...c, newSurname: s.surname, newGiven: s.given }
    })

  const swap = () => {
    const flip = (pairs: RenameConfig['nicknames']) => pairs.map((p) => ({ from: p.to, to: p.from }))
    setConfig((c) => ({
      ...c,
      oldFull: c.newFull,
      newFull: c.oldFull,
      oldSurname: c.newSurname,
      newSurname: c.oldSurname,
      oldGiven: c.newGiven,
      newGiven: c.oldGiven,
      nicknames: flip(c.nicknames),
      others: flip(c.others),
    }))
    setToggles({})
    setOverrides({})
  }

  const loadPreset = (p: RenamePreset) => {
    setConfig(p.config)
    setToggles(p.toggles)
    setOverrides(p.overrides)
    setSection('names')
  }

  const scan = () => {
    const order = new Map(active.map((r, i) => [r.id, i]))
    const list = [...live]
      .sort((a, b) => order.get(a.rule.id)! - order.get(b.rule.id)! || a.hit.slotIndex - b.hit.slotIndex || a.hit.start - b.hit.start)
      .map(({ hit, rule }) => ({ hit, replacement: rule.to, group: `${rule.kind} · ${rule.from} → ${rule.to}` }))
    setPlanned({ key: planKey, hits: list })
    setSelected(new Set(list.map((p) => p.hit.id)))
  }

  return (
    <div className="flex shrink-0 flex-col gap-3">
      <Tabs value={section} onValueChange={setSection}>
        <TabsList variant="line">
          <TabsTrigger value="names">姓名绰号</TabsTrigger>
          <TabsTrigger value="titles">称谓词表</TabsTrigger>
          <TabsTrigger value="others">其他替换{config.others.some((p) => p.from && p.to) ? ` (${config.others.filter((p) => p.from && p.to).length})` : ''}</TabsTrigger>
          <TabsTrigger value="presets">匹配方案</TabsTrigger>
        </TabsList>

        <TabsContent value="names" className="flex flex-col gap-3 pt-2">
          <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <NameBox
              title="原姓名"
              full={config.oldFull}
              surname={config.oldSurname}
              given={config.oldGiven}
              placeholder="卡里现在的名字"
              canShift={canShift(config.oldFull)}
              onFull={setOldFull}
              onSurname={(v) => patch({ oldSurname: v })}
              onGiven={(v) => patch({ oldGiven: v })}
              onShift={(d) => shift('old', d)}
            />
            <Button size="icon-sm" variant="ghost" className="justify-self-center" title="对调原名和新名（撤回另一张卡的改名时用）" onClick={swap}>
              <ArrowLeftRightIcon />
            </Button>
            <NameBox
              title="新姓名"
              full={config.newFull}
              surname={config.newSurname}
              given={config.newGiven}
              placeholder="要改成的名字"
              canShift={canShift(config.newFull)}
              onFull={setNewFull}
              onSurname={(v) => patch({ newSurname: v })}
              onGiven={(v) => patch({ newGiven: v })}
              onShift={(d) => shift('new', d)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">性别</span>
              <ToggleGroup type="single" variant="outline" size="sm" value={config.gender} onValueChange={(v) => v && patch({ gender: v as Gender })}>
                {GENDERS.map(([value, label]) => (
                  <ToggleGroupItem key={value} value={value} className="px-3">
                    {label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </span>
            {renamesCard && (
              <label className="flex items-center gap-1.5">
                <Checkbox checked={updateName} onCheckedChange={(v) => setUpdateName(v === true)} />
                同时把角色名（name 字段）改为「{newFull}」
              </label>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>绰号 / 其他叫法</Label>
            <p className="text-xs text-muted-foreground">自动识别到的叫法已经列出来了，填上新叫法才会替换。昵称、英文名、外号都可以加在这里。</p>
            <PairList pairs={config.nicknames} onChange={(nicknames) => patch({ nicknames })} fromPlaceholder="原绰号" toPlaceholder="新绰号（留空不替换）" />
          </div>
        </TabsContent>

        <TabsContent value="titles" className="pt-2">
          <VocabPanel />
        </TabsContent>

        <TabsContent value="others" className="flex flex-col gap-1.5 pt-2">
          <p className="text-xs text-muted-foreground">和改名一起替换的其他词：老家、学校、组织、口头禅等。多个词有包含关系时，长的优先。</p>
          <PairList pairs={config.others} onChange={(others) => patch({ others })} fromPlaceholder="原文" toPlaceholder="替换为" />
        </TabsContent>

        <TabsContent value="presets" className="pt-2">
          <PresetPanel
            current={{ config, toggles, overrides }}
            suggestedName={config.oldFull && newFull ? `${config.oldFull} → ${newFull}` : ''}
            onLoad={loadPreset}
          />
        </TabsContent>
      </Tabs>

      <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">替换规则</span>
          {active.length > 0 && (
            <span className="text-xs text-muted-foreground">
              已选 {active.length} 条，共 {live.length} 处
            </span>
          )}
        </div>
        <RuleList
          rules={rules}
          counts={counts}
          rawCounts={rawCounts}
          isOn={isOn}
          targetOf={targetOf}
          onToggle={(rule, on) => setToggles((t) => ({ ...t, [rule.id]: on }))}
          onTarget={(rule, to) =>
            setOverrides((o) => {
              const next = { ...o }
              if (to === undefined) delete next[rule.id]
              else next[rule.id] = to
              return next
            })
          }
        />
      </div>

      <Button className="self-start" onClick={scan} disabled={active.length === 0 && !writesName}>
        扫描全卡
      </Button>
      {planned && !hits && <p className="text-xs text-muted-foreground">规则有改动，重新扫描一下。</p>}
      {hits && (
        <>
          <p className="text-sm text-muted-foreground">
            找到 {hits.length} 处，已选 {selected.size} 处。长的叫法优先匹配，不会被短的拆开。
            {writesName && `角色名会改为「${newFull}」。`}
          </p>
          <div>
            <HitList hits={hits} selected={selected} onToggle={(ids, on) => setSelected((prev) => toggleIds(prev, ids, on))} />
          </div>
          <DialogFooter>
            <Button disabled={selected.size === 0 && !writesName} onClick={() => apply(hits, selected, { newName: writesName ? newFull : undefined }, '改名')}>
              替换选中的 {selected.size} 处{writesName ? '并改名' : ''}
            </Button>
          </DialogFooter>
        </>
      )}
    </div>
  )
}
