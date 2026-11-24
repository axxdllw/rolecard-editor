/**
 * 卡库全文搜索：输入防抖后交给 Worker 搜索。
 * Worker 全局只建一个，从编辑页返回卡库时索引还在，不用重建。
 */
import { useEffect, useMemo, useState } from 'react'
import type { CardMatch } from '@/core/search/fullText'
import type { CardRecord } from '@/db/db'
import type { FullTextRequest, FullTextResponse } from './fullTextWorker'

let worker: Worker | null = null
let seq = 0
const listeners = new Set<(res: FullTextResponse) => void>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./fullTextWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<FullTextResponse>) => listeners.forEach((fn) => fn(event.data))
    worker.onerror = (event) => {
      listeners.forEach((fn) => fn({ seq, ok: false, message: event.message || '全文搜索出错' }))
    }
  }
  return worker
}

export interface FullTextState {
  /** 还没搜过或关键词为空时为 null */
  results: CardMatch[] | null
  /** 正在输入或在等 Worker 返回 */
  pending: boolean
  error: string | null
  /** 当前结果对应的关键词 */
  searched: string
}

const DEBOUNCE_MS = 250

interface Answer {
  key: string
  results: CardMatch[] | null
  error: string | null
  searched: string
}

/**
 * @param enabled 关闭时不建 Worker、不搜索
 * @param only 只在这些卡里搜；不填搜全部
 */
export function useFullTextSearch(cards: CardRecord[] | undefined, query: string, enabled: boolean, only?: string[]): FullTextState {
  const [debounced, setDebounced] = useState(query)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  const text = debounced.trim()
  const versions = useMemo(() => cards?.map((c): [string, number] => [c.id, c.updatedAt]), [cards])
  const onlyKey = only ? only.join(',') : '*'
  // 这次请求的标识；收到的结果标识不同说明还在等
  const requestKey = useMemo(
    () => [text, onlyKey, versions?.map(([id, v]) => `${id}@${v}`).join(',') ?? ''].join('|'),
    [text, onlyKey, versions],
  )
  const [answer, setAnswer] = useState<Answer>({ key: '', results: null, error: null, searched: '' })

  useEffect(() => {
    if (!enabled || !versions) return
    const mySeq = ++seq
    const listener = (res: FullTextResponse) => {
      if (res.seq !== mySeq) return
      setAnswer(
        res.ok
          ? { key: requestKey, results: text ? res.results : null, error: null, searched: text }
          : { key: requestKey, results: null, error: res.message, searched: text },
      )
    }
    listeners.add(listener)
    const request: FullTextRequest = {
      seq: mySeq,
      cards: versions,
      only: onlyKey === '*' ? undefined : onlyKey.split(',').filter(Boolean),
      query: text,
    }
    getWorker().postMessage(request)
    return () => {
      listeners.delete(listener)
    }
  }, [enabled, versions, text, onlyKey, requestKey])

  const typing = query.trim() !== text
  return {
    results: enabled ? answer.results : null,
    pending: enabled && (typing || answer.key !== requestKey),
    error: answer.error,
    searched: answer.searched,
  }
}
