/**
 * 小说转卡项目：导入的书、选的范围、各块抽取结果、整理和生成的设置都存在本地库里，关掉页面再回来可以接着做。
 * 正文和抽取结果不进整库备份（正文很大，可以重新导入）。
 */
import { generatedToEntries, type GeneratedEntry } from '@/core/ai/tasks/lorebookGen'
import type { ParsedBook } from '@/core/book/types'
import { createLorebook } from '@/core/lorebook/entry'
import { chunkOrder } from '@/core/novel/chunk'
import {
  EMPTY_OVERRIDES,
  type ChunkExtraction,
  type ChunkFailureOutput,
  type ChunkPlan,
  type ChunkResult,
  type NovelChapter,
} from '@/core/novel/types'
import { uuid } from '@/core/util/id'
import { addLorebook } from './lorebooks'
import { db, type NovelChunkRecord, type NovelGenerateSettings, type NovelRecord, type NovelSettings } from '@/db/db'

export const DEFAULT_NOVEL_SETTINGS: NovelSettings = {
  chunkChars: 20000,
  sampleCount: 0,
  concurrency: 3,
  reasoningEffort: 'low',
  profileId: null,
}

export const DEFAULT_GENERATE_SETTINGS: NovelGenerateSettings = {
  mode: 'character',
  mainKey: null,
  timePoint: null,
  userRole: '',
  template: 'yaml',
  greetings: 3,
  instruction: '',
  storyEntry: true,
  worldEntry: true,
  worldName: '',
}

/** 新建项目时默认选中的范围：从头开始约这么多字 */
export const DEFAULT_SELECTED_CHARS = 200000

/** 默认选前面约 20 万字（整本不到 20 万字就全选） */
export function defaultSelection(lengths: number[], maxChars = DEFAULT_SELECTED_CHARS): number[] {
  const selected: number[] = []
  let sum = 0
  for (let i = 0; i < lengths.length; i++) {
    if (sum >= maxChars) break
    selected.push(i)
    sum += lengths[i]
  }
  return selected
}

/** 读取项目时补齐以后新加的设置项 */
export function normalizeNovel(record: NovelRecord): NovelRecord {
  return {
    ...record,
    settings: { ...DEFAULT_NOVEL_SETTINGS, ...record.settings },
    generate: { ...DEFAULT_GENERATE_SETTINGS, ...record.generate },
    review: { ...EMPTY_OVERRIDES, ...record.review },
    cardIds: record.cardIds ?? [],
    warnings: record.warnings ?? [],
  }
}

export async function createNovel(book: ParsedBook, file: { name: string; size: number }): Promise<string> {
  const id = uuid()
  const now = Date.now()
  const toc = book.chapters.map((c) => ({ title: c.title, ...(c.volume ? { volume: c.volume } : {}), chars: c.text.length }))
  const record: NovelRecord = {
    id,
    title: book.title,
    author: book.author,
    format: book.format,
    fileName: file.name,
    fileSize: file.size,
    ...(book.encoding ? { encoding: book.encoding } : {}),
    warnings: book.warnings,
    toc,
    totalChars: toc.reduce((s, c) => s + c.chars, 0),
    selected: defaultSelection(toc.map((c) => c.chars)),
    settings: { ...DEFAULT_NOVEL_SETTINGS },
    review: { ...EMPTY_OVERRIDES },
    generate: { ...DEFAULT_GENERATE_SETTINGS },
    cardIds: [],
    createdAt: now,
    updatedAt: now,
  }
  await db.transaction('rw', db.novels, db.novelTexts, async () => {
    await db.novels.add(record)
    await db.novelTexts.add({ novelId: id, chapters: book.chapters })
  })
  return id
}

export async function updateNovel(id: string, patch: Partial<Omit<NovelRecord, 'id' | 'createdAt'>>): Promise<void> {
  await db.novels.update(id, { ...patch, updatedAt: Date.now() })
}

export async function deleteNovel(id: string): Promise<void> {
  textCache.delete(id)
  await db.transaction('rw', db.novels, db.novelTexts, db.novelChunks, async () => {
    await db.novels.delete(id)
    await db.novelTexts.delete(id)
    await db.novelChunks.where('novelId').equals(id).delete()
  })
}

// 正文可能有几十 MB，只缓存最近用的一本
const textCache = new Map<string, Promise<NovelChapter[]>>()

export function getNovelText(id: string): Promise<NovelChapter[]> {
  const hit = textCache.get(id)
  if (hit) return hit
  const promise = db.novelTexts.get(id).then((r) => {
    if (!r) throw new Error('找不到这本书的正文，可能已被删除')
    return r.chapters
  })
  textCache.clear()
  textCache.set(id, promise)
  promise.catch(() => textCache.delete(id))
  return promise
}

function chunkRecordId(novelId: string, planId: string): string {
  return `${novelId}|${planId}`
}

export function listChunkRecords(novelId: string): Promise<NovelChunkRecord[]> {
  return db.novelChunks.where('novelId').equals(novelId).toArray()
}

export async function saveChunkResult(novelId: string, plan: ChunkPlan, extraction: ChunkExtraction): Promise<void> {
  await db.novelChunks.put({
    id: chunkRecordId(novelId, plan.id),
    novelId,
    planId: plan.id,
    label: plan.label,
    sampled: plan.sampled,
    chars: plan.chars,
    status: 'done',
    extraction,
    updatedAt: Date.now(),
  })
}

export async function saveChunkError(
  novelId: string,
  plan: ChunkPlan,
  error: string,
  errorOutput?: ChunkFailureOutput,
): Promise<void> {
  // 已经有成功结果的块不被后来的失败覆盖
  const prev = await db.novelChunks.get(chunkRecordId(novelId, plan.id))
  if (prev?.status === 'done') return
  await db.novelChunks.put({
    id: chunkRecordId(novelId, plan.id),
    novelId,
    planId: plan.id,
    label: plan.label,
    sampled: plan.sampled,
    chars: plan.chars,
    status: 'error',
    error,
    errorOutput,
    updatedAt: Date.now(),
  })
}

/** 清掉某些块的结果（重新抽取用） */
export async function deleteChunkRecords(novelId: string, planIds: string[]): Promise<void> {
  await db.novelChunks.bulkDelete(planIds.map((p) => chunkRecordId(novelId, p)))
}

/** 删掉不在当前计划里的旧结果 */
export async function pruneChunkRecords(novelId: string, plans: ChunkPlan[]): Promise<number> {
  const keep = new Set(plans.map((p) => p.id))
  const stale = (await listChunkRecords(novelId)).filter((r) => !keep.has(r.planId)).map((r) => r.id)
  await db.novelChunks.bulkDelete(stale)
  return stale.length
}

/** 当前计划里已完成的块 → 合并用的结果（按书中顺序） */
export function chunkResults(records: NovelChunkRecord[], plans: ChunkPlan[]): ChunkResult[] {
  const byPlan = new Map(records.map((r) => [r.planId, r]))
  const out: ChunkResult[] = []
  for (const plan of plans) {
    const r = byPlan.get(plan.id)
    if (r?.status === 'done' && r.extraction) {
      out.push({ chunkId: plan.id, order: chunkOrder(plan), label: plan.label, extraction: r.extraction })
    }
  }
  return out.sort((a, b) => a.order - b.order)
}

/** 记下用这本书建的卡 */
export async function addNovelCard(novelId: string, cardId: string): Promise<void> {
  const novel = await db.novels.get(novelId)
  if (!novel) return
  await updateNovel(novelId, { cardIds: [...(novel.cardIds ?? []), cardId] })
}

/** 把生成的条目单独存成世界书库里的一本世界书 */
export async function saveNovelLorebook(name: string, entries: GeneratedEntry[]): Promise<string> {
  const book = createLorebook(name)
  book.entries = generatedToEntries(entries, [])
  return addLorebook(book, name, '由小说转卡生成')
}
