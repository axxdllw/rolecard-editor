/**
 * 独立世界书库服务。
 * 库里统一按内嵌世界书（character_book）格式保存，导出时转成 ST 世界书 JSON。
 */
import type { Lorebook } from '@/core/card/types'
import { createLorebook } from '@/core/lorebook/entry'
import { lorebookToWorld, parseLorebookJson } from '@/core/lorebook/world'
import { uuid } from '@/core/util/id'
import { db, type LorebookRecord } from '@/db/db'

export async function addLorebook(book: Lorebook, name?: string, note = ''): Promise<string> {
  const now = Date.now()
  const finalName = name ?? book.name ?? '未命名世界书'
  const record: LorebookRecord = {
    id: uuid(),
    name: finalName || '未命名世界书',
    book: { ...structuredClone(book), name: finalName },
    note,
    entryCount: book.entries.length,
    createdAt: now,
    updatedAt: now,
  }
  await db.lorebooks.add(record)
  return record.id
}

export async function createEmptyLorebook(name: string): Promise<string> {
  return addLorebook(createLorebook(name), name)
}

export async function importLorebookFile(file: File): Promise<{ id: string; format: string; entries: number }> {
  const baseName = file.name.replace(/\.json$/i, '')
  const { book, format } = parseLorebookJson(await file.text(), baseName)
  const id = await addLorebook(book, book.name || baseName)
  return { id, format, entries: book.entries.length }
}

export async function saveLorebook(id: string, book: Lorebook) {
  await db.lorebooks.update(id, {
    book,
    name: book.name || '未命名世界书',
    entryCount: book.entries.length,
    updatedAt: Date.now(),
  })
}

export async function deleteLorebook(id: string) {
  await db.lorebooks.delete(id)
}

export async function duplicateLorebook(id: string): Promise<string | null> {
  const source = await db.lorebooks.get(id)
  if (!source) return null
  return addLorebook(source.book, `${source.name}（副本）`, source.note)
}

/** 导出为 ST 可直接导入的世界书 JSON */
export function exportLorebookJson(book: Lorebook): string {
  return JSON.stringify(lorebookToWorld(book), null, 2)
}
