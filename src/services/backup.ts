/**
 * 整库备份与恢复：zip 包，manifest.json 存卡片、世界书和卡的原件，头像单独存成 PNG。
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { db, type CardOriginalRecord, type CardRecord, type LorebookRecord } from '@/db/db'
import { blobToBytes, bytesToBlob } from '@/lib/image'
import { avatarFromPng } from './cards'

const APP_ID = 'role-card-editor'
// 2：加入卡的原件（originals）；恢复时兼容 1
const BACKUP_VERSION = 2

interface BackupManifest {
  app: string
  version: number
  exportedAt: string
  cards: Array<Omit<CardRecord, 'avatar'> & { avatarFile: string | null }>
  lorebooks: LorebookRecord[]
  originals?: Array<Omit<CardOriginalRecord, 'avatar'> & { avatarFile: string | null }>
}

export async function exportBackup(): Promise<{ bytes: Uint8Array; cards: number; lorebooks: number }> {
  const cards = await db.cards.toArray()
  const lorebooks = await db.lorebooks.toArray()
  const originals = await db.originals.toArray()
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {}

  const manifestCards: BackupManifest['cards'] = []
  for (const { avatar, ...rest } of cards) {
    let avatarFile: string | null = null
    if (avatar) {
      avatarFile = `avatars/${rest.id}.png`
      files[avatarFile] = [await blobToBytes(avatar), { level: 0 }]
    }
    manifestCards.push({ ...rest, avatarFile })
  }

  const manifestOriginals: NonNullable<BackupManifest['originals']> = []
  for (const { avatar, ...rest } of originals) {
    let avatarFile: string | null = null
    if (rest.avatarSaved && avatar) {
      avatarFile = `originals/${rest.cardId}.png`
      files[avatarFile] = [await blobToBytes(avatar), { level: 0 }]
    }
    manifestOriginals.push({ ...rest, avatarFile })
  }

  const manifest: BackupManifest = {
    app: APP_ID,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    cards: manifestCards,
    lorebooks,
    originals: manifestOriginals,
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest))
  return { bytes: zipSync(files), cards: cards.length, lorebooks: lorebooks.length }
}

export type RestoreMode = 'merge' | 'replace'

/**
 * 恢复备份。merge：同 id 的覆盖，其余保留；replace：先清空再恢复。
 */
export async function restoreBackup(bytes: Uint8Array, mode: RestoreMode): Promise<{ cards: number; lorebooks: number }> {
  const files = unzipSync(bytes)
  const manifestFile = files['manifest.json']
  if (!manifestFile) throw new Error('不是本应用的备份文件（缺少 manifest.json）')
  const manifest = JSON.parse(strFromU8(manifestFile)) as BackupManifest
  if (manifest.app !== APP_ID) throw new Error('不是本应用的备份文件')

  const cards: CardRecord[] = manifest.cards.map(({ avatarFile, ...rest }) => ({
    ...rest,
    // 旧备份里的头像可能还带着卡片文本，恢复时顺手去掉
    avatar: avatarFile && files[avatarFile] ? avatarFromPng(files[avatarFile]) : null,
  }))

  const originals: CardOriginalRecord[] = (manifest.originals ?? []).map(({ avatarFile, ...rest }) => ({
    ...rest,
    avatar: avatarFile && files[avatarFile] ? bytesToBlob(files[avatarFile]) : null,
  }))

  await db.transaction('rw', db.cards, db.lorebooks, db.originals, async () => {
    if (mode === 'replace') {
      await db.cards.clear()
      await db.lorebooks.clear()
      await db.originals.clear()
    }
    await db.cards.bulkPut(cards)
    await db.lorebooks.bulkPut(manifest.lorebooks)
    await db.originals.bulkPut(originals)
  })
  return { cards: cards.length, lorebooks: manifest.lorebooks.length }
}

/** 申请持久化存储，降低浏览器清理数据的风险 */
export async function requestPersistentStorage(): Promise<boolean | null> {
  if (!navigator.storage?.persist) return null
  if (await navigator.storage.persisted()) return true
  return navigator.storage.persist()
}

export async function storageStatus(): Promise<{ persisted: boolean | null; usage: number | null; quota: number | null }> {
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null
  const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : null
  return { persisted, usage: estimate?.usage ?? null, quota: estimate?.quota ?? null }
}
