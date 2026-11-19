/**
 * 角色卡数据结构（Character Card V3）。
 *
 * 原则：所有接口都带索引签名，未知字段原样保留，导入导出不丢数据。
 * 规范参考：https://github.com/kwaroran/character-card-spec-v3
 */

export type JsonObject = Record<string, unknown>

export interface LorebookEntry {
  keys: string[]
  content: string
  /** ST 的大部分条目设置在这里：position(0-6)、depth、role、selectiveLogic、递归、分组等 */
  extensions: JsonObject
  enabled: boolean
  insertion_order: number
  case_sensitive?: boolean
  use_regex?: boolean
  constant?: boolean
  name?: string
  priority?: number
  id?: number | string
  comment?: string
  selective?: boolean
  secondary_keys?: string[]
  /** 规范只有两个值，不可信；ST 的真实位置看 extensions.position */
  position?: 'before_char' | 'after_char' | string
  [key: string]: unknown
}

export interface Lorebook {
  name?: string
  description?: string
  scan_depth?: number
  token_budget?: number
  recursive_scanning?: boolean
  extensions: JsonObject
  entries: LorebookEntry[]
  [key: string]: unknown
}

export interface CardAsset {
  type: string
  uri: string
  name: string
  ext: string
  [key: string]: unknown
}

export interface CardDataV3 {
  name: string
  description: string
  personality: string
  scenario: string
  first_mes: string
  mes_example: string
  creator_notes: string
  system_prompt: string
  post_history_instructions: string
  alternate_greetings: string[]
  tags: string[]
  creator: string
  character_version: string
  /** ST 私有字段：talkativeness、fav、world、depth_prompt、regex_scripts 等 */
  extensions: JsonObject
  character_book?: Lorebook
  // —— V3 新增 ——
  group_only_greetings: string[]
  assets?: CardAsset[]
  nickname?: string
  creator_notes_multilingual?: Record<string, string>
  source?: string[]
  creation_date?: number
  modification_date?: number
  [key: string]: unknown
}

export interface CharacterCardV3 {
  spec: 'chara_card_v3'
  spec_version: string
  data: CardDataV3
  /** ST 导出时顶层还会保留一份 V1 平铺字段（name、description 等），原样保留 */
  [key: string]: unknown
}

export type CardSpec = 'v1' | 'v2' | 'v3'
