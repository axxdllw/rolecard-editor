import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { collectTextSlots, compileQuery, findInSlots, replacementFor, type SearchQuery, type TextSlot } from '@/core/search/search'
import { useCardDoc } from '@/features/editor/cardDoc'
import { cn } from '@/lib/utils'
import { useApply } from './applyPlan'
import { HitList, type PlannedHit } from './HitList'
import { RenameTab } from './RenameTab'

const GROUPS: TextSlot['group'][] = ['角色字段', '开场白', '世界书', '正则', '扩展']
const MAX_HITS = 3000

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
