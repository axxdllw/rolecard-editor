import { toast } from 'sonner'
import { applyReplacements } from '@/core/search/search'
import { updateCard } from '@/features/editor/cardDoc'
import { snapshotBeforeChange } from '@/features/originals/autoSnapshot'
import type { PlannedHit } from './HitList'

export function toggleIds(prev: Set<string>, ids: string[], on: boolean): Set<string> {
  const next = new Set(prev)
  ids.forEach((id) => (on ? next.add(id) : next.delete(id)))
  return next
}

export function useApply(onDone: () => void) {
  return (planned: PlannedHit[], selected: Set<string>, extra?: { newName?: string }, label = '批量替换') => {
    const chosen = planned.filter((p) => selected.has(p.hit.id))
    let count = 0
    snapshotBeforeChange(`${label}之前`)
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
