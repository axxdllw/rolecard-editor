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

/** 渲染预览用的测试数据，只存在本地库里，不写进卡 */
export interface CardPreviewData {
  /** 选中的开场白：0 主开场白，1..N 备选开场白 */
  greeting: number
  /** 是否在开场白后面加一轮模拟对话 */
  exchange: boolean
  userMessage: string
  aiReply: string
  /** 手动改过的预览变量（JSON 文本）；为空时从世界书 [initvar] 条目生成 */
  variables: string
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
  preview?: CardPreviewData
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
