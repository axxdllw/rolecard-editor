import { useMemo } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import type { SearchHit } from '@/core/search/search'

export interface PlannedHit {
  hit: SearchHit
  replacement: string
  /** 分组标题；不填时按位置分组（角色字段、世界书……） */
  group?: string
}

export function HitList({ hits, selected, onToggle }: { hits: PlannedHit[]; selected: Set<string>; onToggle: (ids: string[], on: boolean) => void }) {
  const grouped = useMemo(() => {
    const map = new Map<string, PlannedHit[]>()
    for (const h of hits) {
      const key = h.group ?? h.hit.group
      map.set(key, [...(map.get(key) ?? []), h])
    }
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
