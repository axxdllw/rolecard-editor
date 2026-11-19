import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  applyReplacements,
  collectTextSlots,
  compileQuery,
  detectNameCandidates,
  findInSlots,
  replacementFor,
  type SearchHit,
  type SearchQuery,
  type TextSlot,
} from '@/core/search/search'
import { updateCard, useCardDoc } from '@/features/editor/cardDoc'
import { cn } from '@/lib/utils'

const GROUPS: TextSlot['group'][] = ['角色字段', '开场白', '世界书', '正则', '扩展']
const MAX_HITS = 3000

interface PlannedHit {
  hit: SearchHit
  replacement: string
}

function HitList({ hits, selected, onToggle }: { hits: PlannedHit[]; selected: Set<string>; onToggle: (ids: string[], on: boolean) => void }) {
  const grouped = useMemo(() => {
    const map = new Map<string, PlannedHit[]>()
    for (const h of hits) map.set(h.hit.group, [...(map.get(h.hit.group) ?? []), h])
    return [...map.entries()]
  }, [hits])

  return (
    <div className="flex flex-col gap-3">
      {grouped.map(([group, list]) => {
        const ids = list.map((h) => h.hit.id)
        const allOn = ids.every((id) => selected.has(id))
        return (
          <div key={group} className="rounded-lg border">
            <label className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-sm font-medium">
              <Checkbox checked={allOn} onCheckedChange={(v) => onToggle(ids, v === true)} />
              {group}
              <span className="text-xs font-normal text-muted-foreground">{list.length} 处</span>
            </label>
            <div className="max-h-72 overflow-y-auto">
              {list.map(({ hit, replacement }) => (
                <label key={hit.id} className="flex cursor-pointer items-start gap-2 border-b px-3 py-1.5 text-xs last:border-b-0 hover:bg-muted/40" style={{ contentVisibility: 'auto' }}>
                  <Checkbox className="mt-0.5" checked={selected.has(hit.id)} onCheckedChange={(v) => onToggle([hit.id], v === true)} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-muted-foreground">{hit.label}</span>
                    <span className="break-all">
                      <span className="text-muted-foreground">…{hit.before}</span>
                      <del className="bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300">{hit.match}</del>
                      <ins className="bg-emerald-100 text-emerald-800 no-underline dark:bg-emerald-950 dark:text-emerald-300">{replacement}</ins>
                      <span className="text-muted-foreground">{hit.after}…</span>
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function useApply(onDone: () => void) {
  return (planned: PlannedHit[], selected: Set<string>, extra?: { newName?: string }, label = '批量替换') => {
    const chosen = planned.filter((p) => selected.has(p.hit.id))
    let count = 0
    updateCard(
      (d) => {
        count = applyReplacements(d.card, chosen.map((p) => ({ hit: p.hit, text: p.replacement })))
        if (extra?.newName) d.card.data.name = extra.newName
      },
      { label },
    )
    toast.success(`已替换 ${count} 处`, { description: '可以按 Ctrl+Z 撤销整批替换' })
    onDone()
  }
}

function FindReplaceTab({ onDone }: { onDone: () => void }) {
  const card = useCardDoc((s) => s.doc?.card)
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [useRegex, setUseRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [groups, setGroups] = useState<Set<string>>(new Set(GROUPS))
  const [planned, setPlanned] = useState<PlannedHit[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const apply = useApply(onDone)

  const search = () => {
    if (!card) return
    const query: SearchQuery = { text: find, useRegex, caseSensitive }
    const regex = compileQuery(query)
    if (typeof regex === 'string') {
      setError(regex)
      return
    }
    setError(null)
    const slots = collectTextSlots(card).filter((s) => groups.has(s.group))
    const hits = findInSlots(slots, regex).slice(0, MAX_HITS)
    const plan = hits.map((hit) => ({ hit, replacement: replacementFor(hit, query, replace) }))
    setPlanned(plan)
    setSelected(new Set(plan.map((p) => p.hit.id)))
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <Input placeholder="查找" value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
        <Input placeholder="替换为（可以填 {{char}}、{{user}}）" value={replace} onChange={(e) => setReplace(e.target.value)} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <label className="flex items-center gap-1.5">
          <Checkbox checked={useRegex} onCheckedChange={(v) => setUseRegex(v === true)} />
          正则（替换里可用 $1）
        </label>
        <label className="flex items-center gap-1.5">
          <Checkbox checked={caseSensitive} onCheckedChange={(v) => setCaseSensitive(v === true)} />
          区分大小写
        </label>
        <span className="text-muted-foreground">范围：</span>
        {GROUPS.map((g) => (
          <label key={g} className="flex items-center gap-1.5">
            <Checkbox
              checked={groups.has(g)}
              onCheckedChange={(v) =>
                setGroups((prev) => {
                  const next = new Set(prev)
                  if (v) next.add(g)
                  else next.delete(g)
                  return next
                })
              }
            />
            {g}
          </label>
        ))}
        <Button size="sm" className="ml-auto" onClick={search} disabled={!find}>
          查找
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {planned && (
        <>
          <p className="text-sm text-muted-foreground">
            找到 {planned.length} 处{planned.length >= MAX_HITS ? '（只显示前 3000 处）' : ''}，已选 {selected.size} 处。取消勾选的地方不会被替换。
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <HitList
              hits={planned}
              selected={selected}
              onToggle={(ids, on) =>
                setSelected((prev) => {
                  const next = new Set(prev)
                  ids.forEach((id) => (on ? next.add(id) : next.delete(id)))
                  return next
                })
              }
            />
          </div>
          <DialogFooter>
            <Button disabled={selected.size === 0} onClick={() => apply(planned, selected, undefined, `替换「${find}」`)}>
              替换选中的 {selected.size} 处
            </Button>
          </DialogFooter>
        </>
      )}
    </div>
  )
}

interface CandidateState {
  name: string
  source: string
  enabled: boolean
  target: string
}

function RenameTab({ onDone }: { onDone: () => void }) {
  const card = useCardDoc((s) => s.doc?.card)
  const initial = useMemo(() => (card ? detectNameCandidates(card) : []), [card])
  const [candidates, setCandidates] = useState<CandidateState[]>(() => initial.map((c, i) => ({ ...c, enabled: i === 0, target: '' })))
  const [mainName, setMainName] = useState('')
  const [extra, setExtra] = useState('')
  const [planned, setPlanned] = useState<PlannedHit[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const apply = useApply(onDone)

  const scan = () => {
    if (!card) return
    const list = [...candidates]
    if (extra.trim()) list.push({ name: extra.trim(), source: '手动添加', enabled: true, target: mainName })
    const active = list.filter((c) => c.enabled && c.name)
    const slots = collectTextSlots(card).filter((s) => s.path.join('.') !== 'data.name')
    const plan: PlannedHit[] = []
    const taken = new Set<string>()
    // 长的名字先匹配，避免“弗洛洛姐姐”里的“弗洛洛”被重复计算
    for (const c of [...active].sort((a, b) => b.name.length - a.name.length)) {
      const regex = compileQuery({ text: c.name, useRegex: false, caseSensitive: true })
      if (typeof regex === 'string') continue
      for (const hit of findInSlots(slots, regex, `${c.name}|`)) {
        const spanKey = `${hit.slotIndex}`
        const overlaps = [...taken].some((t) => {
          const [slot, s, e] = t.split(':').map(Number)
          return String(slot) === spanKey && hit.start < e && hit.end > s
        })
        if (overlaps) continue
        taken.add(`${hit.slotIndex}:${hit.start}:${hit.end}`)
        plan.push({ hit, replacement: c.target || mainName || c.name })
      }
    }
    plan.sort((a, b) => a.hit.slotIndex - b.hit.slotIndex || a.hit.start - b.hit.start)
    setPlanned(plan)
    setSelected(new Set(plan.map((p) => p.hit.id)))
  }

  const update = (i: number, patch: Partial<CandidateState>) => setCandidates((prev) => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)))

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="rename-main">新的角色名</Label>
        <Input id="rename-main" value={mainName} placeholder="会写进卡片的 name 字段" onChange={(e) => setMainName(e.target.value)} />
      </div>
      <div className="flex flex-col gap-2">
        <Label>要替换的旧名字（自动从角色名和描述里识别）</Label>
        {candidates.map((c, i) => (
          <div key={c.name} className="flex flex-wrap items-center gap-2">
            <Checkbox checked={c.enabled} onCheckedChange={(v) => update(i, { enabled: v === true })} />
            <span className="min-w-20 font-medium">{c.name}</span>
            <span className="text-xs text-muted-foreground">{c.source}</span>
            <span className="text-muted-foreground">→</span>
            <Input
              className="h-7 w-44"
              value={c.target}
              placeholder={mainName || '新名字'}
              disabled={!c.enabled}
              onChange={(e) => update(i, { target: e.target.value })}
            />
            <Button size="xs" variant="ghost" disabled={!c.enabled} onClick={() => update(i, { target: '{{char}}' })}>
              用 {'{{char}}'}
            </Button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">其他叫法：</span>
          <Input className="h-7 w-44" value={extra} placeholder="例如昵称、简称" onChange={(e) => setExtra(e.target.value)} />
        </div>
        <p className="text-xs text-muted-foreground">
          替换成 {'{{char}}'} 后，以后再改名只需要改角色名。长名字优先匹配，例如“弗洛洛姐姐”不会被拆开替换。
        </p>
      </div>
      <Button className="self-start" onClick={scan} disabled={!mainName.trim() && !candidates.some((c) => c.enabled && c.target)}>
        扫描全卡
      </Button>
      {planned && (
        <>
          <p className="text-sm text-muted-foreground">
            找到 {planned.length} 处，已选 {selected.size} 处。{mainName.trim() && `角色名会改为「${mainName.trim()}」。`}
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <HitList
              hits={planned}
              selected={selected}
              onToggle={(ids, on) =>
                setSelected((prev) => {
                  const next = new Set(prev)
                  ids.forEach((id) => (on ? next.add(id) : next.delete(id)))
                  return next
                })
              }
            />
          </div>
          <DialogFooter>
            <Button onClick={() => apply(planned, selected, { newName: mainName.trim() || undefined }, '改名')}>
              替换选中的 {selected.size} 处{mainName.trim() ? '并改名' : ''}
            </Button>
          </DialogFooter>
        </>
      )}
    </div>
  )
}

/** 快捷修改：改名向导 + 全局查找替换 */
export function QuickEditDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [tab, setTab] = useState('rename')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90svh] min-w-0 flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>快捷修改</DialogTitle>
          <DialogDescription>扫描整张卡（字段、开场白、世界书、正则、角色注释），逐条确认后替换，整批可以一键撤销。</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab} className={cn('flex min-h-0 flex-1 flex-col')}>
          <TabsList>
            <TabsTrigger value="rename">改名向导</TabsTrigger>
            <TabsTrigger value="replace">查找替换</TabsTrigger>
          </TabsList>
          <TabsContent value="rename" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
            {open && <RenameTab onDone={() => onOpenChange(false)} />}
          </TabsContent>
          <TabsContent value="replace" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
            {open && <FindReplaceTab onDone={() => onOpenChange(false)} />}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
