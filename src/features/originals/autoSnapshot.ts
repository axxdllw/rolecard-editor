/**
 * 大改之前自动存一个版本（整卡还原、AI 全部应用、批量替换和改名）。
 */
import type { CardDoc } from '@/features/editor/cardDoc'
import { useCardDoc } from '@/features/editor/cardDoc'
import { saveSnapshot } from '@/services/snapshots'

/**
 * 把编辑器里当前的卡存成自动版本。要在修改之前同步调用：这里先同步取出当前的卡（Immer 状态不会被原地修改），
 * 之后的修改不影响存进去的内容。存失败只在控制台提示，不挡住后面的修改。
 */
export function snapshotBeforeChange(reason: string): void {
  const doc = useCardDoc.getState().doc as (CardDoc & { id?: string }) | null
  if (!doc?.id) return
  saveSnapshot(doc.id, doc.card, 'auto', reason).catch((error) => console.error('自动存版本失败', error))
}
