/**
 * 当前打开的角色卡的编辑状态。
 * entryKeys 与世界书条目一一对应，给列表提供稳定的 key（不写进卡片数据）。
 */
import type { Draft } from 'immer'
import { syncLegacyMirror } from '@/core/card/mirror'
import type { CharacterCardV3, Lorebook } from '@/core/card/types'
import { createLorebook } from '@/core/lorebook/entry'
import { uuid } from '@/core/util/id'
import { getPath, setPath, type Path } from '@/core/util/path'
import { createDocStore, type UpdateOptions } from './docStore'

export interface CardDoc {
  card: CharacterCardV3
  entryKeys: string[]
}

export const useCardDoc = createDocStore<CardDoc>((draft) => {
  syncLegacyMirror(draft.card as CharacterCardV3)
})

export function makeCardDoc(card: CharacterCardV3): CardDoc {
  return { card, entryKeys: (card.data.character_book?.entries ?? []).map(() => uuid()) }
}

export function updateCard(recipe: (draft: Draft<CardDoc>) => void, options?: UpdateOptions) {
  useCardDoc.getState().update(recipe, options)
}

/** 订阅卡片上某个路径的值 */
export function useCardPath<T>(path: Path, fallback: T): T {
  return useCardDoc((s) => {
    const v = s.doc ? getPath(s.doc.card, path) : undefined
    return (v === undefined ? fallback : v) as T
  })
}

export function setCardPath(path: Path, value: unknown, label?: string) {
  updateCard((d) => setPath(d.card, path, value), { key: path.join('.'), label })
}

/** 世界书编辑器通用的草稿：书 + 与条目对应的 key */
export interface BookDraft {
  book: Draft<Lorebook>
  keys: string[]
}

/** 在卡片文档上修改内嵌世界书；卡里还没有世界书时自动创建 */
export function updateCardBook(recipe: (d: BookDraft) => void, options?: UpdateOptions) {
  updateCard((d) => {
    if (!d.card.data.character_book) {
      d.card.data.character_book = createLorebook(`${d.card.data.name} 的世界书`)
    }
    recipe({ book: d.card.data.character_book, keys: d.entryKeys })
  }, options)
}
