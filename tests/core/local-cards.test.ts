import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { parseCharx, type ParsedCharx } from '../../src/core/card/charx'
import {
  CardParseError,
  parseCardJson,
  parseCardPng,
  serializeCardJson,
  writeCardPng,
  type ParsedCard,
  type ParsedPngCard,
} from '../../src/core/card/io'
import { syncLegacyMirror } from '../../src/core/card/mirror'
import type { CharacterCardV3, JsonObject } from '../../src/core/card/types'
import { decodeTextChunk, getTextEntries, readChunks, type PngChunk } from '../../src/core/png/png'
import { base64ToUtf8 } from '../../src/core/util/base64'
import { loadLocalCards, plainPng } from '../sample'

type JsonDiffKind = 'missing' | 'extra' | 'type' | 'value' | 'length'

interface JsonDiff {
  path: string
  kind: JsonDiffKind
}

interface AllowedPaths {
  exact: Set<string>
  prefixes: Set<string>
}

const TEXT_CHUNK_TYPES = new Set(['tEXt', 'zTXt', 'iTXt'])
const CARD_TEXT_KEYWORDS = new Set(['chara', 'ccv3'])
const EXTRA_STRING_MIRRORS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'] as const

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function jsonType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function formatKey(parent: string, key: string): string {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`
}

/** 递归深比较两个 JSON 值，只记录路径与差异类型，绝不包含任何字段内容 */
function collectDiffs(actual: unknown, expected: unknown, path: string, out: JsonDiff[]): void {
  const actualType = jsonType(actual)
  const expectedType = jsonType(expected)
  if (actualType !== expectedType) {
    out.push({ path, kind: 'type' })
    return
  }

  if (actualType === 'array') {
    const a = actual as unknown[]
    const e = expected as unknown[]
    if (a.length !== e.length) {
      out.push({ path, kind: 'length' })
      return
    }
    for (let i = 0; i < a.length; i++) {
      collectDiffs(a[i], e[i], `${path}[${i}]`, out)
    }
    return
  }

  if (actualType === 'object') {
    const a = actual as JsonObject
    const e = expected as JsonObject
    const keys = new Set([...Object.keys(a), ...Object.keys(e)])
    for (const key of keys) {
      const hasA = Object.hasOwn(a, key)
      const hasE = Object.hasOwn(e, key)
      const childPath = formatKey(path, key)
      if (!hasA) {
        out.push({ path: childPath, kind: 'missing' })
      } else if (!hasE) {
        out.push({ path: childPath, kind: 'extra' })
      } else {
        collectDiffs(a[key], e[key], childPath, out)
      }
    }
    return
  }

  if (actual !== expected) {
    out.push({ path, kind: 'value' })
  }
}

function diffJson(actual: unknown, expected: unknown): JsonDiff[] {
  const out: JsonDiff[] = []
  collectDiffs(actual, expected, '$', out)
  return out
}

function formatDiffs(diffs: JsonDiff[]): string {
  const shown = diffs.slice(0, 20).map((d) => `${d.path} (${d.kind})`)
  if (diffs.length > 20) shown.push(`... 共 ${diffs.length} 处差异`)
  return shown.join(', ')
}

function isPathAllowed(path: string, allowed: AllowedPaths): boolean {
  if (allowed.exact.has(path)) return true
  for (const prefix of allowed.prefixes) {
    if (path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`)) {
      return true
    }
  }
  return false
}

function rawPngCardJson(png: Uint8Array, keyword: 'ccv3' | 'chara'): JsonObject {
  const entry = getTextEntries(readChunks(png)).find((e) => e.keyword.toLowerCase() === keyword)
  if (!entry) throw new Error(`PNG 缺少 ${keyword} 块`)
  return JSON.parse(stripBom(base64ToUtf8(entry.text))) as JsonObject
}

function rawCharxCardJson(bytes: Uint8Array): JsonObject {
  const files = unzipSync(bytes)
  const cardPath = Object.keys(files).find((p) => p === 'card.json' || p.endsWith('/card.json'))
  if (!cardPath) throw new Error('CharX 缺少 card.json')
  return JSON.parse(stripBom(strFromU8(files[cardPath]))) as JsonObject
}

function isCardTextChunk(chunk: PngChunk): boolean {
  if (chunk.type !== 'tEXt') return false
  return CARD_TEXT_KEYWORDS.has(decodeTextChunk(chunk.data).keyword.toLowerCase())
}

function firstByteDiff(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return i
  }
  return a.length === b.length ? -1 : len
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, message: string): void {
  const diffAt = firstByteDiff(actual, expected)
  if (diffAt !== -1) {
    expect.fail(`${message}（实际长度 ${actual.length}，期望长度 ${expected.length}，首个差异偏移 ${diffAt}）`)
  }
}

function compareChunkLists(actual: PngChunk[], expected: PngChunk[], label: string): void {
  if (actual.length !== expected.length) {
    expect.fail(`${label}：块数量不一致（实际 ${actual.length}，期望 ${expected.length}）`)
  }
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i]
    const e = expected[i]
    if (a.type !== e.type) {
      expect.fail(`${label}：第 ${i} 个块类型不一致（实际 ${a.type}，期望 ${e.type}）`)
    }
    const diffAt = firstByteDiff(a.data, e.data)
    if (diffAt !== -1) {
      expect.fail(
        `${label}：第 ${i} 个块（${a.type}）字节不一致（实际长度 ${a.data.length}，期望长度 ${e.data.length}，首个差异偏移 ${diffAt}）`,
      )
    }
  }
}

/**
 * 按 warnings 和 sourceSpec 精确推导 normalizeToV3（及写回 chara 块时的 toV2Json）允许改动的路径，
 * 不写死放宽其他任何字段。
 */
function deriveNormalizeAllowedPaths(
  origJson: JsonObject,
  parsed: ParsedCard,
  targetChunk: 'ccv3' | 'chara',
): AllowedPaths {
  const exact = new Set<string>()
  const prefixes = new Set<string>()
  const { sourceSpec, warnings } = parsed

  // V1 转 V3：会写入 spec/spec_version，并生成整个 data 对象，顶层 V1 字段仍需原样保留
  if (sourceSpec === 'v1') {
    exact.add('$.spec')
    exact.add('$.spec_version')
    prefixes.add('$.data')
    return { exact, prefixes }
  }

  // spec：仅在跨规范块或原 spec 无法识别（按 V2 处理）时允许变动
  const hasUnknownSpecWarning = warnings.some((w) => /^未知的规范标识 .*，已按 V2 处理$/.test(w))
  if (
    hasUnknownSpecWarning ||
    (sourceSpec === 'v2' && targetChunk === 'ccv3') ||
    (sourceSpec === 'v3' && targetChunk === 'chara')
  ) {
    exact.add('$.spec')
  }

  // spec_version：仅在实际会被改写的情况下允许变动
  if (
    (sourceSpec === 'v2' && targetChunk === 'ccv3' && origJson.spec_version !== '3.0') ||
    (sourceSpec === 'v2' && targetChunk === 'chara' && origJson.spec_version !== '2.0') ||
    (sourceSpec === 'v3' && targetChunk === 'chara' && origJson.spec_version !== '2.0') ||
    (sourceSpec === 'v3' && targetChunk === 'ccv3' && typeof origJson.spec_version !== 'string')
  ) {
    exact.add('$.spec_version')
  }

  // 补全的必填字段：严格按 warnings 逐项推导
  for (const warning of warnings) {
    const match = warning.match(/^补全了缺失的字段 (.+)$/)
    if (match) {
      exact.add(formatKey('$.data', match[1]))
    }
  }

  // V2 → V3 静默补全 group_only_greetings（不产生 warning），仅当原值缺失或为 null 时允许
  if (sourceSpec === 'v2') {
    const origData = isJsonObject(origJson.data) ? origJson.data : undefined
    if (origData && origData.group_only_greetings == null) {
      exact.add('$.data.group_only_greetings')
    }
  }

  return { exact, prefixes }
}

/**
 * 推导修改 data.name 并调用 syncLegacyMirror 后允许变化的顶层镜像路径。
 * 除 data.name 和顶层 name 外，仅当原卡其他顶层镜像字段本来就与 data 不一致时，才允许其被同步对齐。
 */
function deriveMirrorAllowedPaths(origCard: CharacterCardV3): {
  allowed: AllowedPaths
  syncedMirrors: string[]
} {
  const exact = new Set<string>(['$.data.name'])
  const prefixes = new Set<string>()
  const syncedMirrors: string[] = []

  if (typeof origCard.name === 'string') {
    exact.add('$.name')
  }

  const origData = origCard.data
  for (const key of EXTRA_STRING_MIRRORS) {
    if (typeof origCard[key] === 'string' && typeof origData[key] === 'string' && origCard[key] !== origData[key]) {
      exact.add(`$.${key}`)
      syncedMirrors.push(key)
    }
  }

  if (typeof origCard.creatorcomment === 'string' && origCard.creatorcomment !== origData.creator_notes) {
    prefixes.add('$.creatorcomment')
    syncedMirrors.push('creatorcomment')
  }

  if (Array.isArray(origCard.tags) && Array.isArray(origData.tags)) {
    const top = origCard.tags as unknown[]
    if (top.length !== origData.tags.length || top.some((t, i) => t !== origData.tags[i])) {
      prefixes.add('$.tags')
      syncedMirrors.push('tags')
    }
  }

  const origExt = isJsonObject(origData.extensions) ? origData.extensions : {}
  if (
    'talkativeness' in origCard &&
    origExt.talkativeness !== undefined &&
    origCard.talkativeness !== origExt.talkativeness
  ) {
    prefixes.add('$.talkativeness')
    syncedMirrors.push('talkativeness')
  }
  if ('fav' in origCard && origExt.fav !== undefined && origCard.fav !== origExt.fav) {
    prefixes.add('$.fav')
    syncedMirrors.push('fav')
  }

  return { allowed: { exact, prefixes }, syncedMirrors }
}

/** 校验导出的 chara 块（V2）与 ccv3 块除 spec/spec_version 外完全一致 */
function assertCharaMatchesCcv3(exportedPng: Uint8Array): void {
  const exportedChara = rawPngCardJson(exportedPng, 'chara')
  const exportedCcv3 = rawPngCardJson(exportedPng, 'ccv3')
  if (exportedChara.spec !== 'chara_card_v2') {
    expect.fail('[b] 导出的 chara 块 $.spec 不是 chara_card_v2')
  }
  if (exportedChara.spec_version !== '2.0') {
    expect.fail('[b] 导出的 chara 块 $.spec_version 不是 2.0')
  }
  if (exportedCcv3.spec !== 'chara_card_v3') {
    expect.fail('[b] 导出的 ccv3 块 $.spec 不是 chara_card_v3')
  }
  if (typeof exportedCcv3.spec_version !== 'string') {
    expect.fail('[b] 导出的 ccv3 块 $.spec_version 不是字符串')
  }

  const diffs = diffJson(exportedChara, exportedCcv3).filter(
    (d) => d.path !== '$.spec' && d.path !== '$.spec_version',
  )
  if (diffs.length > 0) {
    expect.fail(`[b] 导出的 chara 与 ccv3 存在差异：${formatDiffs(diffs)}`)
  }
}

/** 校验改 data.name 并同步镜像字段后导出再导入：仅允许预期字段变化 */
function assertRenameRoundtrip(
  origCard: CharacterCardV3,
  roundtrip: (edited: CharacterCardV3) => CharacterCardV3,
): void {
  const edited = structuredClone(origCard)
  const nextName =
    edited.data.name === '__local_card_test_name__' ? '__local_card_test_name_2__' : '__local_card_test_name__'
  edited.data.name = nextName
  syncLegacyMirror(edited)

  const reparsed = roundtrip(edited)

  if (reparsed.data.name !== nextName) {
    expect.fail('[f] 改名后 $.data.name 未更新')
  }
  if (typeof origCard.name === 'string') {
    if (reparsed.name !== nextName) {
      expect.fail('[f] 改名后顶层镜像 $.name 未同步更新')
    }
  } else if (Object.hasOwn(reparsed, 'name') !== Object.hasOwn(origCard, 'name')) {
    expect.fail('[f] 改名后意外增删了顶层 $.name')
  }

  const { allowed, syncedMirrors } = deriveMirrorAllowedPaths(origCard)
  for (const key of syncedMirrors) {
    if (key === 'creatorcomment') {
      const diffs = diffJson(reparsed.creatorcomment, reparsed.data.creator_notes)
      if (diffs.length > 0) expect.fail('[f] 顶层镜像 $.creatorcomment 同步结果与 $.data.creator_notes 不一致')
    } else if (key === 'tags') {
      const diffs = diffJson(reparsed.tags, reparsed.data.tags)
      if (diffs.length > 0) expect.fail('[f] 顶层镜像 $.tags 同步结果与 $.data.tags 不一致')
    } else if (key === 'talkativeness' || key === 'fav') {
      const ext = isJsonObject(reparsed.data.extensions) ? reparsed.data.extensions : {}
      const diffs = diffJson(reparsed[key], ext[key])
      if (diffs.length > 0) expect.fail(`[f] 顶层镜像 $.${key} 同步结果与 $.data.extensions.${key} 不一致`)
    } else if (reparsed[key] !== reparsed.data[key]) {
      expect.fail(`[f] 顶层镜像 $.${key} 同步结果与 $.data.${key} 不一致`)
    }
  }

  const unexpectedDiffs = diffJson(reparsed, origCard).filter((d) => !isPathAllowed(d.path, allowed))
  if (unexpectedDiffs.length > 0) {
    expect.fail(`[f] 改 data.name 后存在预期外的字段变化：${formatDiffs(unexpectedDiffs)}`)
  }
}

type ParsedEntry =
  | { label: string; kind: 'png'; bytes: Uint8Array; parsed: ParsedPngCard }
  | { label: string; kind: 'charx'; bytes: Uint8Array; parsed: ParsedCharx }

interface FailedEntry {
  label: string
  error: unknown
}

// —— 加载并预分类本机测试卡（用 LOCAL_CARD_DIR 指定目录，未设置或不存在时整组跳过） ——

const localCards = loadLocalCards()
const parsedCards: ParsedEntry[] = []
const failedCards: FailedEntry[] = []

for (const item of localCards) {
  try {
    if (item.kind === 'png') {
      parsedCards.push({ label: item.label, kind: 'png', bytes: item.bytes, parsed: parseCardPng(item.bytes) })
    } else {
      parsedCards.push({ label: item.label, kind: 'charx', bytes: item.bytes, parsed: parseCharx(item.bytes) })
    }
  } catch (error) {
    failedCards.push({ label: item.label, error })
  }
}

describe.skipIf(localCards.length === 0)('本机测试卡无损往返', () => {
  if (parsedCards.length > 0) {
    describe('可解析的卡', () => {
      for (const entry of parsedCards) {
        it(
          entry.label,
          () => {
            if (entry.kind === 'png') {
              const { bytes, parsed } = entry
              const exported = writeCardPng(parsed.image, parsed.card)

              // a. 原读取块（ccv3 优先）与导出后同块的 JSON 深比较一致，仅允许 normalizeToV3 / toV2Json 推导出的路径变化
              const origJson = rawPngCardJson(bytes, parsed.chunkKey)
              const exportedSameChunkJson = rawPngCardJson(exported, parsed.chunkKey)
              const allowed = deriveNormalizeAllowedPaths(origJson, parsed, parsed.chunkKey)
              const unexpectedDiffs = diffJson(exportedSameChunkJson, origJson).filter(
                (d) => !isPathAllowed(d.path, allowed),
              )
              if (unexpectedDiffs.length > 0) {
                expect.fail(`[a] 原 ${parsed.chunkKey} 块与导出块存在预期外差异：${formatDiffs(unexpectedDiffs)}`)
              }

              // b. 导出的 chara 块（V2）与 ccv3 块除 spec/spec_version 外完全一致
              assertCharaMatchesCcv3(exported)

              // c. PNG 非文本块逐字节保留、顺序不变；非 chara/ccv3 文本块（含其他 tEXt 及所有 zTXt/iTXt）按现有行为逐字节保留、顺序不变
              const origChunks = readChunks(bytes)
              const exportedChunks = readChunks(exported)
              compareChunkLists(
                exportedChunks.filter((c) => !TEXT_CHUNK_TYPES.has(c.type)),
                origChunks.filter((c) => !TEXT_CHUNK_TYPES.has(c.type)),
                '[c] 非文本 PNG 块',
              )
              compareChunkLists(
                exportedChunks.filter((c) => TEXT_CHUNK_TYPES.has(c.type) && !isCardTextChunk(c)),
                origChunks.filter((c) => TEXT_CHUNK_TYPES.has(c.type) && !isCardTextChunk(c)),
                '[c] 非 chara/ccv3 文本块',
              )
              const cardTextKeywords = exportedChunks
                .filter(isCardTextChunk)
                .map((c) => decodeTextChunk(c.data).keyword)
              expect(cardTextKeywords).toEqual(['chara', 'ccv3'])
              const iendIndex = exportedChunks.findIndex((c) => c.type === 'IEND')
              expect(iendIndex).toBe(exportedChunks.length - 1)
              expect(iendIndex).toBeGreaterThanOrEqual(2)
              expect(isCardTextChunk(exportedChunks[iendIndex - 2])).toBe(true)
              expect(isCardTextChunk(exportedChunks[iendIndex - 1])).toBe(true)

              // d. 再导入再导出，结果逐字节相同（幂等）
              const reparsedPng = parseCardPng(exported)
              const exportedAgain = writeCardPng(reparsedPng.image, reparsedPng.card)
              assertBytesEqual(exportedAgain, exported, '[d] 再导入再导出结果不一致')

              // e. 导出 JSON 再 parseCardJson，与卡深比较一致
              const reparsedJson = parseCardJson(serializeCardJson(parsed.card))
              const jsonDiffs = diffJson(reparsedJson.card, parsed.card)
              if (jsonDiffs.length > 0) {
                expect.fail(`[e] JSON 导出再导入不一致：${formatDiffs(jsonDiffs)}`)
              }

              // f. 改 data.name 后导出再导入：仅 data.name 及镜像字段变化，其他全部不变
              assertRenameRoundtrip(parsed.card, (edited) => parseCardPng(writeCardPng(parsed.image, edited)).card)
            } else {
              const { bytes, parsed } = entry
              const exported = writeCardPng(plainPng, parsed.card)

              // a. CharX 原始 card.json 与规范化后写入 ccv3 的 JSON 深比较一致
              const origJson = rawCharxCardJson(bytes)
              const exportedCcv3 = rawPngCardJson(exported, 'ccv3')
              const allowed = deriveNormalizeAllowedPaths(origJson, parsed, 'ccv3')
              const unexpectedDiffs = diffJson(exportedCcv3, origJson).filter((d) => !isPathAllowed(d.path, allowed))
              if (unexpectedDiffs.length > 0) {
                expect.fail(`[a] 原 card.json 与导出 ccv3 存在预期外差异：${formatDiffs(unexpectedDiffs)}`)
              }

              // b. 导出的 chara 块（V2）与 ccv3 块除 spec/spec_version 外完全一致
              assertCharaMatchesCcv3(exported)

              // d. 导出 PNG 再导入再导出，结果逐字节相同（幂等）
              const reparsedPng = parseCardPng(exported)
              const exportedAgain = writeCardPng(reparsedPng.image, reparsedPng.card)
              assertBytesEqual(exportedAgain, exported, '[d] 再导入再导出结果不一致')

              // e. 导出 JSON 再 parseCardJson，与卡深比较一致
              const reparsedJson = parseCardJson(serializeCardJson(parsed.card))
              const jsonDiffs = diffJson(reparsedJson.card, parsed.card)
              if (jsonDiffs.length > 0) {
                expect.fail(`[e] JSON 导出再导入不一致：${formatDiffs(jsonDiffs)}`)
              }

              // f. 改 data.name 后导出再导入：仅 data.name 及镜像字段变化，其他全部不变
              assertRenameRoundtrip(parsed.card, (edited) => parseCardJson(serializeCardJson(edited)).card)
            }
          },
          60_000,
        )
      }
    })
  }

  if (failedCards.length > 0) {
    describe('解析失败的卡', () => {
      for (const entry of failedCards) {
        it(entry.label, () => {
          if (!(entry.error instanceof CardParseError)) {
            const actualType = entry.error instanceof Error ? entry.error.name : typeof entry.error
            expect.fail(`期望抛出 CardParseError，实际为 ${actualType}`)
          }
        })
      }
    })
  }
})
