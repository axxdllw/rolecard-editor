/**
 * ST 导出的卡在顶层保留一份 V1 平铺字段（name、description 等）。
 * 编辑 data 里的字段后，把顶层已有的镜像字段同步过去，避免两边不一致。
 * 只同步顶层本来就存在的字段，不新增字段；值相同时不赋值（减少 Immer 补丁）。
 */
import type { CharacterCardV3 } from './types'

const STRING_MIRRORS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'] as const

export function syncLegacyMirror(card: CharacterCardV3): void {
  const data = card.data
  for (const key of STRING_MIRRORS) {
    if (typeof card[key] === 'string' && typeof data[key] === 'string' && card[key] !== data[key]) {
      card[key] = data[key]
    }
  }
  if (typeof card.creatorcomment === 'string' && card.creatorcomment !== data.creator_notes) {
    card.creatorcomment = data.creator_notes
  }
  if (Array.isArray(card.tags) && Array.isArray(data.tags)) {
    const top = card.tags as unknown[]
    if (top.length !== data.tags.length || top.some((t, i) => t !== data.tags[i])) {
      card.tags = [...data.tags]
    }
  }
  const ext = data.extensions ?? {}
  if ('talkativeness' in card && ext.talkativeness !== undefined && card.talkativeness !== ext.talkativeness) {
    card.talkativeness = ext.talkativeness
  }
  if ('fav' in card && ext.fav !== undefined && card.fav !== ext.fav) {
    card.fav = ext.fav
  }
}
