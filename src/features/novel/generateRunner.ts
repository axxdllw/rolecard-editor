/**
 * 生成卡的调度：合成世界书条目（分批、限并发）和写卡的各字段同时进行，结果存进小说项目（novel.result）。
 * 放在全局 store 里，切到别的页面也不会中断。
 */
import { create } from 'zustand'
import { streamChat } from '@/core/ai/client'
import { AiError, type AiProfile } from '@/core/ai/types'
import { batchItems, buildConsolidateRequest, dropSharedKeys, parseConsolidated, toGeneratedEntries, type ConsolidateItem } from '@/core/novel/consolidate'
import { buildNovelCardRequest, parseNovelCard, type NovelCardDraft } from '@/core/novel/generate'
import type { Prepared } from '@/core/novel/prepare'
import { runPool } from '@/core/util/pool'
import { db, type NovelGeneratedResult, type NovelRecord } from '@/db/db'

export type GenerateScope = 'all' | 'card' | 'entries' | 'failed'

interface GenerateRunnerState {
  novelId: string | null
  running: boolean
  /** 合成条目：总批数 / 已完成批数 */
  batches: number
  batchesDone: number
  /** 写卡：idle 没在写，running 在写，done 写完，error 出错 */
  card: 'idle' | 'running' | 'done' | 'error'
  /** 写卡时已收到的字数 */
  received: number
  error: string | null
  /**
   * 开始生成。scope：all 全部重来；card 只重写卡的字段；entries 只重新合成条目；failed 只重试上次失败的条目。
   */
  start: (args: {
    novel: NovelRecord
    prepared: Prepared
    profile: AiProfile
    style: { label: string; skeleton?: string }
    /** 时间点说明，如“第 30 章（某某章标题）之后” */
    timePoint: string
    scope: GenerateScope
  }) => Promise<void>
  stop: () => void
}

let controller: AbortController | null = null

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
      if (e instanceof AiError && (e.kind === 'aborted' || e.kind === 'auth' || e.kind === 'not_found' || e.kind === 'bad_request' || e.kind === 'refusal')) throw e
      if (signal.aborted) throw e
      await new Promise((r) => setTimeout(r, e instanceof AiError && e.kind === 'rate_limit' ? 20000 : 2000))
    }
  }
  throw lastError
}

export const useGenerateRunner = create<GenerateRunnerState>()((set, get) => ({
  novelId: null,
  running: false,
  batches: 0,
  batchesDone: 0,
  card: 'idle',
  received: 0,
  error: null,

  stop: () => controller?.abort(),

  start: async ({ novel, prepared, profile, style, timePoint, scope }) => {
    if (get().running) return
    const abort = new AbortController()
    controller = abort
    const signal = abort.signal
    const settings = novel.generate
    const effort = novel.settings.reasoningEffort === 'profile' ? undefined : novel.settings.reasoningEffort
    const prev = novel.result

    const doCard = scope === 'all' || scope === 'card'
    const doEntries = scope !== 'card'
    // 只重试失败的：只合成上次失败的对象
    const items: ConsolidateItem[] =
      scope === 'failed' && prev ? prepared.items.filter((i) => prev.failedKeys.includes(prepared.sourceKeys[i.id])) : doEntries ? prepared.items : []
    const batches = batchItems(items)

    set({ novelId: novel.id, running: true, batches: batches.length, batchesDone: 0, card: doCard ? 'running' : 'idle', received: 0, error: null })

    let draft: NovelCardDraft | null = doCard ? null : (prev?.draft ?? null)
    // 保留不需要重新合成的条目
    const redoKeys = new Set(items.map((i) => prepared.sourceKeys[i.id]))
    const entries: NovelGeneratedResult['entries'] = scope === 'card' || scope === 'failed' ? (prev?.entries ?? []).filter((e) => !redoKeys.has(e.sourceKey)) : []
    const failed = new Set<string>(scope === 'card' ? (prev?.failedKeys ?? []) : [])
    const errors: string[] = []

    const save = async () => {
      // 写卡失败或中途停止时，保留上一次写好的卡
      const result: NovelGeneratedResult = { draft: draft ?? prev?.draft ?? null, entries: [...entries], failedKeys: [...failed], createdAt: Date.now() }
      await db.novels.update(novel.id, { result, updatedAt: Date.now() })
    }

    const cardTask = async () => {
      if (!doCard) return
      try {
        const request = buildNovelCardRequest({
          mode: settings.mode,
          bookTitle: novel.title,
          author: novel.author,
          main: prepared.main ? { name: prepared.main.name, aliases: prepared.mainAliases, notes: prepared.mainNotes } : undefined,
          worldName: settings.worldName || novel.title,
          cast: prepared.cast,
          world: prepared.world,
          story: prepared.story,
          timePoint,
          userRole: settings.userRole,
          style,
          greetings: settings.greetings,
          instruction: settings.instruction,
        })
        const result = await withRetry(
          () => streamChat(profile, { ...request, reasoningEffort: effort, signal, onText: (_d, full) => set({ received: full.length }) }),
          signal,
        )
        draft = parseNovelCard(result.text)
        set({ card: 'done' })
      } catch (e) {
        if (e instanceof AiError && e.kind === 'aborted') return
        errors.push(`写卡失败：${errorMessage(e)}`)
        set({ card: 'error' })
      }
    }

    const entriesTask = async () => {
      // 先按批合成；模型漏掉的对象再单独补一次
      const missing: ConsolidateItem[] = []
      const runBatch = async (batch: ConsolidateItem[]) => {
        try {
          const request = buildConsolidateRequest({ bookTitle: novel.title, items: batch })
          const result = await withRetry(() => streamChat(profile, { ...request, reasoningEffort: effort, signal }), signal)
          const parsed = parseConsolidated(result.text, batch)
          const got = new Set(parsed.map((p) => p.id))
          for (const g of toGeneratedEntries(parsed, batch).map((g, i) => ({ ...g, sourceKey: prepared.sourceKeys[parsed[i].id] }))) {
            entries.push(g)
          }
          return batch.filter((i) => !got.has(i.id))
        } catch (e) {
          if (e instanceof AiError && (e.kind === 'auth' || e.kind === 'not_found' || e.kind === 'bad_request')) {
            errors.push(e.message)
            abort.abort()
          }
          return batch
        }
      }
      await runPool(
        batches,
        novel.settings.concurrency,
        async (batch) => {
          missing.push(...(await runBatch(batch)))
          set((s) => ({ batchesDone: s.batchesDone + 1 }))
        },
        signal,
      )
      if (signal.aborted) {
        for (const i of items) if (!entries.some((e) => e.sourceKey === prepared.sourceKeys[i.id])) failed.add(prepared.sourceKeys[i.id])
        return
      }
      // 单独补：每个对象一个请求
      await runPool(
        missing,
        novel.settings.concurrency,
        async (item) => {
          const left = await runBatch([item])
          if (left.length) failed.add(prepared.sourceKeys[item.id])
        },
        signal,
      )
    }

    try {
      await Promise.all([cardTask(), entriesTask()])
      // 条目按准备时的顺序排（人物在前，按重要程度）
      const orderOf = new Map(prepared.items.map((i, idx) => [prepared.sourceKeys[i.id], idx]))
      entries.sort((a, b) => (orderOf.get(a.sourceKey) ?? 1e9) - (orderOf.get(b.sourceKey) ?? 1e9))
      entries.splice(0, entries.length, ...dropSharedKeys(entries))
      await save()
      if (errors.length) set({ error: [...new Set(errors)].join('；') })
      else if (failed.size) set({ error: `有 ${failed.size} 个对象没合成出条目，可以单独重试` })
    } catch (e) {
      set({ error: errorMessage(e) })
    } finally {
      if (controller === abort) controller = null
      set({ running: false })
    }
  },
}))
