/**
 * 本地数据库（IndexedDB，通过 Dexie）。
 * 卡片原样保存完整的 V3 JSON，头像以 PNG Blob 保存。
 */
import Dexie, { type EntityTable } from 'dexie'
import type { CharacterCardV3, Lorebook } from '@/core/card/types'

export interface CardStats {
  entries: number
  enabledEntries: number
  greetings: number
  regex: number
  /** 每轮都会发送的固定内容字数 */
  constantChars: number
  /** 固定内容的 token 估算；分词器还没加载时为 null */
  constantTokens: number | null
}

export interface CardRecord {
  id: string
  card: CharacterCardV3
  /** PNG 头像；从 JSON 导入或新建的卡可能没有 */
  avatar: Blob | null
  /** 冗余字段：角色名，用于搜索和排序 */
  name: string
  /** 本地标签，只在卡库里用，不写进卡 */
  localTags: string[]
  /** 来源备注 */
  note: string
  sourceUrl: string
  sourceFormat: 'png' | 'json' | 'charx' | 'new' | 'copy'
  fileName: string
  stats: CardStats
  createdAt: number
  updatedAt: number
}

export interface LorebookRecord {
  id: string
  name: string
  book: Lorebook
  note: string
  entryCount: number
  createdAt: number
  updatedAt: number
}

export const db = new Dexie('role-card-editor') as Dexie & {
  cards: EntityTable<CardRecord, 'id'>
  lorebooks: EntityTable<LorebookRecord, 'id'>
}

db.version(1).stores({
  cards: 'id, name, createdAt, updatedAt, *localTags',
  lorebooks: 'id, name, updatedAt',
})
