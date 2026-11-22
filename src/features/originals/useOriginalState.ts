/**
 * 当前卡的原件和相对原件的改动。
 */
import { useDeferredValue, useMemo } from 'react'
import { compareCards, type CardChange } from '@/core/card/compare'
import type { CharacterCardV3 } from '@/core/card/types'
import type { CardOriginalRecord } from '@/db/db'
import { useLive } from '@/db/useLive'
import { getOriginal } from '@/services/originals'

/** 原件记录：undefined 表示还在读，null 表示没有原件 */
export function useCardOriginal(cardId: string): CardOriginalRecord | null | undefined {
  return useLive(async () => (await getOriginal(cardId)) ?? null, [cardId])
}

export interface OriginalState {
  original: CardOriginalRecord | null | undefined
  changes: CardChange[] | null
  /** 头像换过（只在换头像时存过原头像才知道） */
  avatarChanged: boolean
}

export function useOriginalState(cardId: string, card: CharacterCardV3 | undefined, avatar: Blob | null): OriginalState {
  const original = useCardOriginal(cardId)
  const deferred = useDeferredValue(card)
  const changes = useMemo(() => (original && deferred ? compareCards(original.card, deferred) : null), [original, deferred])
  const avatarChanged = !!original?.avatarSaved && !sameBlob(original.avatar, avatar)
  return { original, changes, avatarChanged }
}

function sameBlob(a: Blob | null, b: Blob | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.size === b.size && a.type === b.type
}
