/**
 * 在 Web Worker 里做卡库全文搜索。卡直接从 IndexedDB 读，按 updatedAt 增量重建索引，
 * 上百张大卡也不会卡住输入。
 */
import { indexCard, searchIndexedCards, type CardMatch, type IndexedCard } from '@/core/search/fullText'
import { db } from '@/db/db'

export interface FullTextRequest {
  seq: number
  /** 卡库里所有卡和它们的版本（updatedAt）；版本变了才重新读取，不在列表里的移出索引 */
  cards: Array<[id: string, updatedAt: number]>
  /** 只在这些卡里搜（如按标签筛选后）；不填搜全部 */
  only?: string[]
  /** 为空时只同步索引，不搜索 */
  query: string
}

export type FullTextResponse =
  | { seq: number; ok: true; results: CardMatch[]; elapsed: number }
  | { seq: number; ok: false; message: string }

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<FullTextRequest>) => void) | null
  postMessage: (message: FullTextResponse) => void
}

const index = new Map<string, { version: number; card: IndexedCard }>()

async function sync(cards: FullTextRequest['cards']): Promise<void> {
  const stale = cards.filter(([id, version]) => index.get(id)?.version !== version).map(([id]) => id)
  if (stale.length > 0) {
    const records = await db.cards.bulkGet(stale)
    for (const r of records) {
      if (r) index.set(r.id, { version: r.updatedAt, card: indexCard(r.id, r.name, r.card) })
    }
  }
  const alive = new Set(cards.map(([id]) => id))
  for (const id of index.keys()) {
    if (!alive.has(id)) index.delete(id)
  }
}

function pick(only: string[] | undefined): IndexedCard[] {
  if (!only) return [...index.values()].map((e) => e.card)
  return only.flatMap((id) => {
    const entry = index.get(id)
    return entry ? [entry.card] : []
  })
}

let latest = 0
let queue = Promise.resolve()

ctx.onmessage = (event) => {
  const req = event.data
  latest = req.seq
  // 串行处理，避免两次同步同时读库；排队期间来了新请求就跳过旧的
  queue = queue.then(async () => {
    if (req.seq !== latest) return
    try {
      const t0 = performance.now()
      await sync(req.cards)
      if (req.seq !== latest) return
      const results = req.query.trim() ? searchIndexedCards(pick(req.only), req.query) : []
      ctx.postMessage({ seq: req.seq, ok: true, results, elapsed: performance.now() - t0 })
    } catch (error) {
      ctx.postMessage({ seq: req.seq, ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  })
}
