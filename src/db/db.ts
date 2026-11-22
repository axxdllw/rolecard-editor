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
  /** 是否运行卡片里的酒馆助手脚本（默认运行） */
  runScripts?: boolean
}

/** 提示词预览里“模拟聊天”的测试数据，只存在本地库里，不写进卡 */
export interface CardScanTestData {
  /** 聊天开头带哪条开场白：-1 不带，0 主开场白，1..N 备选开场白 */
  greeting: number
  /** 开场白之后的消息，从旧到新 */
  messages: Array<{ role: 'user' | 'char'; text: string }>
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
  scanTest?: CardScanTestData
  createdAt: number
  updatedAt: number
}

/**
 * 卡的原件：导入时的卡片数据，用来对比改动和还原。每张卡最多一份，以卡的 id 为主键。
 * 头像按需复制：换头像或移除头像之前才把原来的头像存进来（avatarSaved 为 true），
 * 没换过时原件头像就是卡当前的头像，不重复占空间。
 */
export interface CardOriginalRecord {
  cardId: string
  card: CharacterCardV3
  /** import：导入时自动保存；baseline：用户把当时的版本记为原件（功能上线前导入的卡、新建的卡） */
  kind: 'import' | 'baseline'
  avatarSaved: boolean
  /** avatarSaved 为 true 时是原来的头像（null 表示原来没有头像） */
  avatar: Blob | null
  fileName: string
  createdAt: number
}

/**
 * 卡的版本快照：手动存的，或者大改之前自动存的。只存卡片数据，不存头像。
 */
export interface CardSnapshotRecord {
  id: string
  cardId: string
  card: CharacterCardV3
  /** manual：手动存的；auto：整卡还原、AI 全部应用、批量替换之前自动存的 */
  kind: 'manual' | 'auto'
  /** 手动存时用户起的名字（可以为空）；自动存时是原因，如“整卡还原前” */
  label: string
  createdAt: number
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

export interface AssistantChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  /** 助手消息里各提案的处理状态，键为 `${段序号}:${提案序号}`（段序号是 parseAssistantReply 结果里的下标） */
  editStates?: Record<string, 'applied' | 'dismissed'>
  /** 这条助手回复出错时的说明；出错的回复不进入发给模型的历史 */
  error?: string
}

export interface AssistantChatRecord {
  cardId: string
  messages: AssistantChatMessage[]
  updatedAt: number
}

export const db = new Dexie('role-card-editor') as Dexie & {
  cards: EntityTable<CardRecord, 'id'>
  lorebooks: EntityTable<LorebookRecord, 'id'>
  originals: EntityTable<CardOriginalRecord, 'cardId'>
  assistantChats: EntityTable<AssistantChatRecord, 'cardId'>
  snapshots: EntityTable<CardSnapshotRecord, 'id'>
}

db.version(1).stores({
  cards: 'id, name, createdAt, updatedAt, *localTags',
  lorebooks: 'id, name, updatedAt',
})

db.version(2).stores({
  originals: 'cardId',
})

db.version(3).stores({
  assistantChats: 'cardId',
})

db.version(4).stores({
  snapshots: 'id, cardId',
})
