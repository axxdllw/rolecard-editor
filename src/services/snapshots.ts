/**
 * 卡的版本快照：手动“存一个版本”，或者整卡还原、AI 全部应用、批量替换之前自动存一份。
 * 只存卡片数据，不存头像（头像的还原由原件负责）。自动版本每张卡只留最近 AUTO_KEEP 个。
 */
import type { CharacterCardV3 } from '@/core/card/types'
import { jsonEqual } from '@/core/mvu/diff'
import { uuid } from '@/core/util/id'
import { db, type CardSnapshotRecord } from '@/db/db'

export const AUTO_KEEP = 20

export function countSnapshots(cardId: string): Promise<number> {
  return db.snapshots.where('cardId').equals(cardId).count()
}

/** 一张卡的所有版本，新的在前 */
export async function listSnapshots(cardId: string): Promise<CardSnapshotRecord[]> {
  const list = await db.snapshots.where('cardId').equals(cardId).toArray()
  return list.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 存一个版本。自动版本和最近一个版本内容相同时不重复存，返回 null。
 * 存完自动版本后，超出 AUTO_KEEP 的旧自动版本会被删掉。
 */
export async function saveSnapshot(
  cardId: string,
  card: CharacterCardV3,
  kind: CardSnapshotRecord['kind'],
  label = '',
): Promise<CardSnapshotRecord | null> {
  return db.transaction('rw', db.snapshots, async () => {
    const list = await listSnapshots(cardId)
    if (kind === 'auto' && list[0] && jsonEqual(list[0].card, card)) return null
    const record: CardSnapshotRecord = {
      id: uuid(),
      cardId,
      card: structuredClone(card),
      kind,
      label: label.trim(),
      createdAt: Date.now(),
    }
    await db.snapshots.add(record)
    if (kind === 'auto') {
      const stale = list.filter((s) => s.kind === 'auto').slice(AUTO_KEEP - 1)
      if (stale.length > 0) await db.snapshots.bulkDelete(stale.map((s) => s.id))
    }
    return record
  })
}

export async function renameSnapshot(id: string, label: string): Promise<void> {
  await db.snapshots.update(id, { label: label.trim() })
}

export async function deleteSnapshot(id: string): Promise<void> {
  await db.snapshots.delete(id)
}

/** 删掉一张卡的全部自动版本（手动版本保留） */
export async function deleteAutoSnapshots(cardId: string): Promise<void> {
  await db.snapshots
    .where('cardId')
    .equals(cardId)
    .filter((s) => s.kind === 'auto')
    .delete()
}

/** 删卡时一起删掉它的所有版本 */
export async function deleteSnapshotsOfCards(cardIds: string[]): Promise<void> {
  await db.snapshots.where('cardId').anyOf(cardIds).delete()
}
