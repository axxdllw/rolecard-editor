/**
 * 逐块抽取的调度：限并发地把各块发给模型，结果一块一块存进本地库。
 * 放在全局 store 里，切到别的页面（应用内）也不会中断；关闭或刷新页面会中断，已完成的块不丢。
 */
import { create } from 'zustand'
import { streamChat } from '@/core/ai/client'
import { AiError, type AiProfile } from '@/core/ai/types'
import { chunkOrder, chunkText } from '@/core/novel/chunk'
import { buildExtractRequest, failureOutput, formatRoster, parseExtraction } from '@/core/novel/extract'
import { mergeEntities } from '@/core/novel/merge'
import type { ChunkFailureOutput, ChunkPlan, ChunkResult } from '@/core/novel/types'
import { runPool } from '@/core/util/pool'
import type { NovelRecord } from '@/db/db'
import { chunkResults, getNovelText, listChunkRecords, saveChunkError, saveChunkResult } from '@/services/novels'

interface ExtractRunnerState {
  novelId: string | null
  running: boolean
  /** 正在请求的块 id */
  active: string[]
  /** 这一轮要跑的块数 / 已成功 / 已失败 */
  total: number
  succeeded: number
  failed: number
  /** 整轮停下来的原因（key 不对、模型名不对等，继续跑也没用） */
  fatal: string | null
  /**
   * 开始抽取：跳过已经成功的块。onlyIds 只跑这些块（重试失败的、重新抽取选中的）。
   * 同一时间只跑一本书；已经在跑时忽略。
   */
  start: (args: { novel: NovelRecord; plans: ChunkPlan[]; profile: AiProfile; onlyIds?: string[] }) => Promise<void>
  stop: () => void
}

let controller: AbortController | null = null

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** 继续跑也没用的错误：整轮停下 */
const FATAL_KINDS = new Set(['auth', 'not_found', 'bad_request'])

function errorMessage(error: unknown): string {
  if (error instanceof AiError) {
    if (error.kind === 'refusal') {
      if (error.finishReason && /recitation/i.test(error.finishReason)) {
        return '输出和已有的文字太像，被平台拦截了（RECITATION，常见于大段照抄原文），可以重试或换个模型'
      }
      return '模型拒绝处理这一段（可能触发了内容审核），可以换个模型再试'
    }
    // 格式问题的具体原因（截断、没写 JSON、JSON 残缺等）由 parseExtraction 给出
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

export const useExtractRunner = create<ExtractRunnerState>()((set, get) => ({
  novelId: null,
  running: false,
  active: [],
  total: 0,
  succeeded: 0,
  failed: 0,
  fatal: null,

  stop: () => controller?.abort(),

  start: async ({ novel, plans, profile, onlyIds }) => {
    if (get().running) return
    const abort = new AbortController()
    controller = abort
    const signal = abort.signal
    set({ novelId: novel.id, running: true, active: [], total: 0, succeeded: 0, failed: 0, fatal: null })

    try {
      const chapters = await getNovelText(novel.id)
      const records = await listChunkRecords(novel.id)
      const done = new Set(records.filter((r) => r.status === 'done').map((r) => r.planId))
      const only = onlyIds ? new Set(onlyIds) : null
      const todo = plans.filter((p) => !done.has(p.id) && (!only || only.has(p.id)))
      set({ total: todo.length })
      if (todo.length === 0) return

      // 已完成的结果，用来给后面的块提供“已知人物”名单
      const results: ChunkResult[] = chunkResults(records, plans)
      const effort = novel.settings.reasoningEffort === 'profile' ? undefined : novel.settings.reasoningEffort

      await runPool(
        todo,
        novel.settings.concurrency,
        async (plan) => {
          set((s) => ({ active: [...s.active, plan.id] }))
          try {
            const text = chunkText(chapters, plan)
            let lastError: unknown = null
            let lastOutput: ChunkFailureOutput | undefined
            for (let attempt = 1; attempt <= 3 && !signal.aborted; attempt++) {
              // 模型的回复和结束原因：失败时存下来给用户看
              let output = ''
              let finishReason: string | undefined
              try {
                const roster = formatRoster(mergeEntities(results, novel.review))
                const request = buildExtractRequest({ bookTitle: novel.title, chunkLabel: plan.label, text, roster })
                const result = await streamChat(profile, {
                  ...request,
                  reasoningEffort: effort,
                  signal,
                  onText: (_delta, full) => {
                    output = full
                  },
                })
                output = result.text
                finishReason = result.rawFinishReason
                const extraction = parseExtraction(result.text, result.finishReason)
                await saveChunkResult(novel.id, plan, extraction)
                results.push({ chunkId: plan.id, order: chunkOrder(plan), label: plan.label, extraction })
                set((s) => ({ succeeded: s.succeeded + 1 }))
                return
              } catch (e) {
                lastError = e
                lastOutput =
                  e instanceof AiError && (e.kind === 'bad_output' || e.kind === 'refusal')
                    ? failureOutput(output, finishReason ?? e.finishReason)
                    : undefined
                if (!(e instanceof AiError)) break
                if (e.kind === 'aborted') return
                if (FATAL_KINDS.has(e.kind)) {
                  set({ fatal: e.message })
                  abort.abort()
                  return
                }
                if (e.kind === 'refusal') break
                // 限流多等一会儿，其他错误（格式不对、断线、服务端错误）稍等重试
                await sleep(e.kind === 'rate_limit' ? 20000 * attempt : 3000, signal)
              }
            }
            if (signal.aborted) return
            await saveChunkError(novel.id, plan, errorMessage(lastError), lastOutput)
            set((s) => ({ failed: s.failed + 1 }))
          } finally {
            set((s) => ({ active: s.active.filter((id) => id !== plan.id) }))
          }
        },
        signal,
      )
    } catch (e) {
      set({ fatal: errorMessage(e) })
    } finally {
      if (controller === abort) controller = null
      set({ running: false, active: [] })
    }
  },
}))
