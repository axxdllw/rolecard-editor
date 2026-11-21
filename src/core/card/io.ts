/**
 * 角色卡导入导出。
 *
 * - 导入：PNG（优先读 ccv3，失败再读 chara）或 JSON；V1/V2/V3 统一转成 V3。
 * - 导出：PNG 同时写 chara（V2 标识）和 ccv3（V3）两个块；JSON 直接输出 V3。
 * - 无损：整张卡原样保存，未知字段全部保留，只补全缺失的必填字段。
 */
import { encodeChunks, getTextEntries, readChunks, replaceTextEntries } from '../png/png'
import { base64ToUtf8, utf8ToBase64 } from '../util/base64'
import type { CardDataV3, CardSpec, CharacterCardV3, JsonObject } from './types'

export class CardParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CardParseError'
  }
}

export interface ParsedCard {
  /** 统一后的 V3 卡，保留原始 JSON 的全部字段 */
  card: CharacterCardV3
  /** 原始数据的规范版本 */
  sourceSpec: CardSpec
  /** 导入时自动补全或兜底处理的地方，需要提示给用户 */
  warnings: string[]
}

export interface ParsedPngCard extends ParsedCard {
  /** 原始 PNG 字节；导出时只替换其中的文本块 */
  image: Uint8Array
  /** 实际读取的是哪个文本块 */
  chunkKey: 'ccv3' | 'chara'
}

const CARD_KEYWORDS = ['ccv3', 'chara'] as const

const STRING_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
  'creator',
  'character_version',
] as const

const ARRAY_FIELDS = ['alternate_greetings', 'tags', 'group_only_greetings'] as const

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function detectSpec(json: unknown): CardSpec {
  if (!isObject(json)) {
    throw new CardParseError('角色卡数据不是 JSON 对象')
  }
  if (json.spec === 'chara_card_v3') return 'v3'
  if (json.spec === 'chara_card_v2') return 'v2'
  // 有 data 但没有可识别的 spec：按 V2 处理
  if (isObject(json.data)) return 'v2'
  if (typeof json.name === 'string') return 'v1'
  throw new CardParseError('无法识别的角色卡格式')
}

/**
 * 只补全缺失（undefined / null）的必填字段，类型不对的字段不动，避免丢数据。
 * 返回被补全的字段名。
 */
function fillRequiredFields(data: JsonObject): string[] {
  const filled: string[] = []
  for (const key of STRING_FIELDS) {
    if (data[key] == null) {
      data[key] = ''
      filled.push(key)
    }
  }
  for (const key of ARRAY_FIELDS) {
    if (data[key] == null) {
      data[key] = []
      filled.push(key)
    }
  }
  if (data.extensions == null) {
    data.extensions = {}
    filled.push('extensions')
  }
  return filled
}

function fromV1(src: JsonObject, warnings: string[]): CharacterCardV3 {
  const str = (value: unknown) => (typeof value === 'string' ? value : '')
  const extensions: JsonObject = {}
  if (src.talkativeness !== undefined) extensions.talkativeness = src.talkativeness
  if (src.fav !== undefined) extensions.fav = src.fav

  const data: CardDataV3 = {
    name: str(src.name),
    description: str(src.description),
    personality: str(src.personality),
    scenario: str(src.scenario),
    first_mes: str(src.first_mes),
    mes_example: str(src.mes_example),
    creator_notes: str(src.creatorcomment ?? src.creator_notes),
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: Array.isArray(src.tags) ? src.tags.filter((t): t is string => typeof t === 'string') : [],
    creator: str(src.creator),
    character_version: str(src.character_version),
    extensions,
    group_only_greetings: [],
  }
  warnings.push('这是 V1 格式的旧卡，已转换为 V3')
  // 顶层 V1 字段原样保留，作为旧程序的兼容镜像
  return { ...src, spec: 'chara_card_v3', spec_version: '3.0', data }
}

/** 把任意版本的角色卡 JSON 统一成 V3，不修改传入的对象 */
export function normalizeToV3(json: unknown): ParsedCard {
  const sourceSpec = detectSpec(json)
  const warnings: string[] = []
  const src = structuredClone(json) as JsonObject

  if (sourceSpec === 'v1') {
    return { card: fromV1(src, warnings), sourceSpec, warnings }
  }

  const data = src.data
  if (!isObject(data)) {
    throw new CardParseError('角色卡缺少 data 字段')
  }
  if (sourceSpec === 'v2' && src.spec !== 'chara_card_v2') {
    warnings.push(`未知的规范标识 ${String(src.spec)}，已按 V2 处理`)
  }

  // 原地修改 spec，保持字段顺序不变
  src.spec = 'chara_card_v3'
  src.spec_version =
    sourceSpec === 'v3' && typeof src.spec_version === 'string' ? src.spec_version : '3.0'

  const filled = fillRequiredFields(data)
  for (const key of filled) {
    // V2 升级到 V3 时补 group_only_greetings 是正常行为，不提示
    if (sourceSpec === 'v2' && key === 'group_only_greetings') continue
    warnings.push(`补全了缺失的字段 ${key}`)
  }

  return { card: src as CharacterCardV3, sourceSpec, warnings }
}

export function parseCardJson(text: string): ParsedCard {
  let json: unknown
  try {
    json = JSON.parse(stripBom(text))
  } catch (error) {
    throw new CardParseError(`JSON 解析失败：${errorMessage(error)}`)
  }
  return normalizeToV3(json)
}

export function parseCardPng(bytes: Uint8Array): ParsedPngCard {
  const entries = getTextEntries(readChunks(bytes))
  const errors: string[] = []
  let found = false

  for (const key of CARD_KEYWORDS) {
    const entry = entries.find((e) => e.keyword.toLowerCase() === key)
    if (!entry) continue
    found = true
    try {
      const parsed = parseCardJson(base64ToUtf8(entry.text))
      parsed.warnings.unshift(...errors)
      return { ...parsed, image: bytes, chunkKey: key }
    } catch (error) {
      errors.push(`${key} 块解析失败：${errorMessage(error)}`)
    }
  }

  if (!found) {
    throw new CardParseError('这张 PNG 里没有角色卡数据')
  }
  throw new CardParseError(errors.join('；'))
}

/** 生成写入 chara 块的 V2 兼容版本：只改规范标识，其余字段不动 */
export function toV2Json(card: CharacterCardV3): JsonObject {
  const v2 = structuredClone(card) as JsonObject
  v2.spec = 'chara_card_v2'
  v2.spec_version = '2.0'
  return v2
}

/**
 * 去掉 PNG 里的 chara/ccv3 块，只留图像和其他块。
 * 卡库里卡片 JSON 单独存，头像不必再带一份旧卡片数据；导出时 writeCardPng 会重新写入。
 */
export function stripCardPng(image: Uint8Array): Uint8Array<ArrayBuffer> {
  return encodeChunks(replaceTextEntries(readChunks(image, { checkCrc: false }), [...CARD_KEYWORDS], []))
}

/**
 * 把角色卡写进 PNG：删除旧的 chara/ccv3 块，在 IEND 前依次写入新的 chara 和 ccv3。
 * image 必须是 PNG；JPG/WebP 头像需要先在界面层转成 PNG。
 */
export function writeCardPng(image: Uint8Array, card: CharacterCardV3): Uint8Array<ArrayBuffer> {
  const chunks = replaceTextEntries(readChunks(image), [...CARD_KEYWORDS], [
    { keyword: 'chara', text: utf8ToBase64(JSON.stringify(toV2Json(card))) },
    { keyword: 'ccv3', text: utf8ToBase64(JSON.stringify(card)) },
  ])
  return encodeChunks(chunks)
}

export function serializeCardJson(card: CharacterCardV3): string {
  return JSON.stringify(card, null, 2)
}
