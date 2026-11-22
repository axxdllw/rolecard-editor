/**
 * 小说转角色卡的公共类型：分块计划、每块的抽取结果、合并后的人物/地点等对象。
 */

/** 一章（只用到标题和正文，和 core/book 的 BookChapter 结构兼容） */
export interface NovelChapter {
  title: string
  text: string
  volume?: string
}

/** 一个分块：从某章某处到某章某处的连续正文 */
export interface ChunkPlan {
  /** 由起止位置算出的稳定标识，范围不变时重新规划得到同一个 id，已抽取的结果可以复用 */
  id: string
  chapterStart: number
  /** 在起始章正文里的起点（字符下标） */
  startOffset: number
  chapterEnd: number
  /** 在结束章正文里的终点（不含） */
  endOffset: number
  /** 正文字数（不含拼进去的章节标题） */
  chars: number
  /** 给人看的位置，如“第 3～5 章”“第 12 章（2/3）” */
  label: string
  /** 来自全书均匀抽样（不在用户选的范围里） */
  sampled: boolean
}

export interface ExtractedRelation {
  name: string
  relation: string
}

export interface ExtractedCharacter {
  name: string
  aliases: string[]
  gender: string
  identity: string
  appearance: string
  personality: string
  abilities: string
  relations: ExtractedRelation[]
  facts: string[]
  quotes: string[]
  /** 1～5，这一块里的重要程度 */
  importance: number
}

export interface ExtractedPlace {
  name: string
  aliases: string[]
  description: string
  facts: string[]
}

export interface ExtractedOrganization {
  name: string
  aliases: string[]
  description: string
  members: string[]
  facts: string[]
}

export interface ExtractedTerm {
  name: string
  aliases: string[]
  category: string
  description: string
}

export interface ExtractedEvent {
  title: string
  summary: string
  characters: string[]
  place: string
  importance: number
}

/** 一块正文的抽取结果 */
export interface ChunkExtraction {
  /** 这一块的剧情概要 */
  summary: string
  characters: ExtractedCharacter[]
  places: ExtractedPlace[]
  organizations: ExtractedOrganization[]
  terms: ExtractedTerm[]
  events: ExtractedEvent[]
  /** 世界观、时代背景、规则 */
  world: string[]
}

export type EntityKind = 'character' | 'place' | 'organization' | 'term'

export const ENTITY_KIND_LABELS: Record<EntityKind, string> = {
  character: '人物',
  place: '地点',
  organization: '组织',
  term: '名词',
}

export type ExtractedItem = ExtractedCharacter | ExtractedPlace | ExtractedOrganization | ExtractedTerm

/** 一块已完成的抽取结果，合并时用 */
export interface ChunkResult {
  chunkId: string
  /** 在书里的先后（用 ChunkPlan 的起点排序得到），越小越靠前 */
  order: number
  label: string
  extraction: ChunkExtraction
}

/** 某个对象在某一块里的资料 */
export interface EntityMention<T extends ExtractedItem = ExtractedItem> {
  chunkId: string
  order: number
  label: string
  item: T
}

/** 合并后的对象（同一人物在各块里的资料合在一起） */
export interface MergedEntity {
  /** 代表名字的键（kind:规范化名字）。组里成员变化时可能改变，持久化的用户操作要记在 names 上 */
  id: string
  kind: EntityKind
  /** 显示名：用户改过名就用改的名，否则用出现最多的名字 */
  name: string
  /** 组里所有名字的键（kind:规范化名字），用户的合并/改名/删除/勾选都记在这些键上 */
  keys: string[]
  /** 其他称呼（不含 name），按出现次数排序 */
  aliases: string[]
  /** 按书中顺序 */
  mentions: EntityMention[]
  /** 各块里重要程度的最大值（只有人物有，其他为 0） */
  importance: number
  /** 排序权重：各块重要程度之和（非人物按出现块数） */
  weight: number
  /** 人物的性别（各块里出现最多的非空值） */
  gender: string
}

/** 用户在“整理”步骤里的修改，全部记在名字键上，抽取结果增加后仍然有效 */
export interface ReviewOverrides {
  /** 手动合并：[a, b] 表示 a 和 b 是同一个对象 */
  merges: Array<[string, string]>
  /** 手动拆开：这些名字键不再通过别名自动合并 */
  splits: string[]
  /** 改名：名字键 → 显示名 */
  renames: Record<string, string>
  /** 删除（不显示、不进世界书） */
  hidden: string[]
  /** 勾选进世界书的名字键；null 表示还没改过，用推荐勾选 */
  selected: string[] | null
}

export const EMPTY_OVERRIDES: ReviewOverrides = { merges: [], splits: [], renames: {}, hidden: [], selected: null }
