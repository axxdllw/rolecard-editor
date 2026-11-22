/**
 * 卡的原件：导入时自动存一份，编辑页可以对比改动、单处或整卡还原。
 */
import type { CharacterCardV3 } from '@/core/card/types'
import { db, type CardOriginalRecord } from '@/db/db'

export function getOriginal(cardId: string): Promise<CardOriginalRecord | undefined> {
  return db.originals.get(cardId)
}

/** 导入（或覆盖导入）时保存原件；覆盖导入时新文件就是新的原件 */
export async function saveImportOriginal(cardId: string, card: CharacterCardV3, fileName: string): Promise<void> {
  await db.originals.put({
    cardId,
    card: structuredClone(card),
    kind: 'import',
    avatarSaved: false,
    avatar: null,
    fileName,
    createdAt: Date.now(),
  })
}

/** 没有原件的卡：把编辑器里当前的版本记为原件 */
export async function saveBaseline(cardId: string, card: CharacterCardV3): Promise<void> {
  const record = await db.cards.get(cardId)
  if (!record) return
  await db.originals.put({
    cardId,
    card: structuredClone(card),
    kind: 'baseline',
    avatarSaved: false,
    avatar: null,
    fileName: record.fileName,
    createdAt: Date.now(),
  })
}

/** 复制卡时连原件一起复制，副本也能和原件对比 */
export async function copyOriginal(fromId: string, toId: string): Promise<void> {
  const original = await db.originals.get(fromId)
  if (original) await db.originals.put({ ...original, cardId: toId })
}

export async function deleteOriginals(cardIds: string[]): Promise<void> {
  await db.originals.bulkDelete(cardIds)
}

/**
 * 换头像或移除头像。原件还没存头像时，先把现在的头像存进原件，保证还原时能找回导入时的头像。
 */
export async function setCardAvatar(cardId: string, avatar: Blob | null): Promise<void> {
  await db.transaction('rw', db.cards, db.originals, async () => {
    const record = await db.cards.get(cardId)
    if (!record) return
    const original = await db.originals.get(cardId)
    if (original && !original.avatarSaved) {
      await db.originals.update(cardId, { avatarSaved: true, avatar: record.avatar })
    }
    await db.cards.update(cardId, { avatar, updatedAt: Date.now() })
  })
}

/** 原件的头像：没单独存过时就是卡当前的头像 */
export function originalAvatar(original: CardOriginalRecord, currentAvatar: Blob | null): Blob | null {
  return original.avatarSaved ? original.avatar : currentAvatar
}
