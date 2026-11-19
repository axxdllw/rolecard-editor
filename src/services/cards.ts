/**
 * 卡库服务：导入、新建、复制、保存、导出、删除。
 */
import { zipSync } from 'fflate'
import { parseCharx } from '@/core/card/charx'
import { createEmptyCard, type DescriptionTemplate } from '@/core/card/create'
import { CardParseError, parseCardJson, parseCardPng, serializeCardJson, writeCardPng, type ParsedCard } from '@/core/card/io'
import type { CharacterCardV3 } from '@/core/card/types'
import { constantPromptTexts } from '@/core/lorebook/assemble'
import { getRegexScripts } from '@/core/regex/regex'
import { uuid } from '@/core/util/id'
import { db, type CardRecord, type CardStats } from '@/db/db'
import { fileKind, safeFileName } from '@/lib/files'
import { blobToBytes, bytesToBlob, defaultAvatarPng, toPngBlob } from '@/lib/image'
import { countTokens } from '@/lib/tokens'

export function computeStats(card: CharacterCardV3): CardStats {
  const joined = constantPromptTexts(card).join('\n')
  const entries = card.data.character_book?.entries ?? []
  return {
    entries: entries.length,
    enabledEntries: entries.filter((e) => e.enabled !== false).length,
    greetings: (card.data.first_mes ? 1 : 0) + (card.data.alternate_greetings?.length ?? 0),
    regex: getRegexScripts(card.data.extensions ?? {}).length,
    constantChars: joined.length,
    constantTokens: countTokens(joined),
  }
}

export interface ImportedCard {
  parsed: ParsedCard
  avatar: Blob | null
  fileName: string
  sourceFormat: CardRecord['sourceFormat']
}

/** 读取一个角色卡文件（PNG / JSON / CharX），不写数据库 */
export async function readCardFile(file: File): Promise<ImportedCard> {
  const kind = fileKind(file)
  if (kind === 'png') {
    const bytes = new Uint8Array(await file.arrayBuffer())
    return { parsed: parseCardPng(bytes), avatar: bytesToBlob(bytes), fileName: file.name, sourceFormat: 'png' }
  }
  if (kind === 'json') {
    return { parsed: parseCardJson(await file.text()), avatar: null, fileName: file.name, sourceFormat: 'json' }
  }
  if (kind === 'charx') {
    const parsed = parseCharx(new Uint8Array(await file.arrayBuffer()))
    let avatar: Blob | null = null
    if (parsed.avatar) {
      try {
        avatar = await toPngBlob(new Blob([parsed.avatar.bytes.slice()], { type: `image/${parsed.avatar.ext}` }))
      } catch {
        parsed.warnings.push('CharX 里的头像无法读取，导出时会使用默认头像')
      }
    }
    return { parsed, avatar, fileName: file.name, sourceFormat: 'charx' }
  }
  throw new CardParseError('不支持的文件类型，请选择 PNG、JSON 或 CharX')
}

function newRecord(card: CharacterCardV3, avatar: Blob | null, meta: Partial<CardRecord>): CardRecord {
  const now = Date.now()
  return {
    id: uuid(),
    card,
    avatar,
    name: card.data.name,
    localTags: [],
    note: '',
    sourceUrl: '',
    sourceFormat: 'new',
    fileName: '',
    stats: computeStats(card),
    createdAt: now,
    updatedAt: now,
    ...meta,
  }
}

export async function findCardsByName(name: string): Promise<CardRecord[]> {
  return db.cards.where('name').equals(name).toArray()
}

/** 保存导入的卡；replaceId 有值时覆盖那张卡（保留它的本地标签和备注） */
export async function addImportedCard(imported: ImportedCard, replaceId?: string): Promise<string> {
  const { parsed, avatar, fileName, sourceFormat } = imported
  if (replaceId) {
    const existing = await db.cards.get(replaceId)
    if (existing) {
      await db.cards.put({
        ...existing,
        card: parsed.card,
        avatar: avatar ?? existing.avatar,
        name: parsed.card.data.name,
        sourceFormat,
        fileName,
        stats: computeStats(parsed.card),
        updatedAt: Date.now(),
      })
      return replaceId
    }
  }
  const record = newRecord(parsed.card, avatar, { sourceFormat, fileName })
  await db.cards.add(record)
  return record.id
}

export async function createCard(
  name: string,
  templateId: DescriptionTemplate['id'],
  avatar: Blob | null,
  descriptionOverride?: string,
): Promise<string> {
  const record = newRecord(createEmptyCard(name, templateId, descriptionOverride), avatar, { sourceFormat: 'new' })
  await db.cards.add(record)
  return record.id
}

/** 复制一张卡：卡片数据完全相同，用于修改前留原版 */
export async function duplicateCard(id: string): Promise<string | null> {
  const source = await db.cards.get(id)
  if (!source) return null
  const record = newRecord(structuredClone(source.card), source.avatar, {
    sourceFormat: 'copy',
    fileName: source.fileName,
    localTags: [...source.localTags],
    note: `复制自「${source.name}」${source.note ? `；${source.note}` : ''}`,
    sourceUrl: source.sourceUrl,
  })
  await db.cards.add(record)
  return record.id
}

export async function saveCard(id: string, card: CharacterCardV3, extra: Partial<Pick<CardRecord, 'avatar'>> = {}) {
  await db.cards.update(id, {
    card,
    name: card.data.name,
    stats: computeStats(card),
    updatedAt: Date.now(),
    ...extra,
  })
}

export async function updateCardMeta(id: string, meta: Partial<Pick<CardRecord, 'localTags' | 'note' | 'sourceUrl'>>) {
  await db.cards.update(id, { ...meta, updatedAt: Date.now() })
}

export async function deleteCards(ids: string[]) {
  await db.cards.bulkDelete(ids)
}

export function cardFileBase(record: Pick<CardRecord, 'card'>): string {
  return safeFileName(record.card.data.name, '角色卡')
}

export async function exportCardPng(record: Pick<CardRecord, 'card' | 'avatar'>): Promise<Uint8Array<ArrayBuffer>> {
  const avatar = record.avatar ? await toPngBlob(record.avatar) : await defaultAvatarPng(record.card.data.name)
  return writeCardPng(await blobToBytes(avatar), record.card)
}

export function exportCardJson(record: Pick<CardRecord, 'card'>): string {
  return serializeCardJson(record.card)
}

/** 批量导出为 zip，每张卡一个 PNG，重名时自动加序号 */
export async function exportCardsZip(records: CardRecord[]): Promise<Uint8Array> {
  const files: Record<string, [Uint8Array, { level: 0 }]> = {}
  for (const record of records) {
    const base = cardFileBase(record)
    let name = `${base}.png`
    for (let i = 2; files[name]; i++) name = `${base} (${i}).png`
    files[name] = [await exportCardPng(record), { level: 0 }]
  }
  return zipSync(files)
}
