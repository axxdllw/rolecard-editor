/**
 * token 估算（o200k 分词器，按需加载）。只用于估算，界面上标注“约”。
 */
import { useEffect, useState, useSyncExternalStore } from 'react'

type Counter = (text: string) => number

let counter: Counter | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

export function loadTokenizer(): Promise<void> {
  loading ??= import('gpt-tokenizer/encoding/o200k_base').then((mod) => {
    counter = (text) => mod.countTokens(text)
    listeners.forEach((l) => l())
  })
  return loading
}

/** 分词器未加载时返回 null，并在后台开始加载 */
export function countTokens(text: string): number | null {
  if (!counter) {
    void loadTokenizer()
    return null
  }
  return text ? counter(text) : 0
}

const cache = new Map<string, number>()

/** 带缓存的计数，适合列表里大量条目反复计算；分词器未就绪时返回 null */
export function cachedTokens(text: string): number | null {
  const hit = cache.get(text)
  if (hit !== undefined) return hit
  const n = countTokens(text)
  if (n === null) return null
  if (cache.size > 5000) cache.clear()
  cache.set(text, n)
  return n
}

export function countTokensSync(text: string): number {
  return countTokens(text) ?? Math.ceil(text.length / 2)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTokenizerReady(): boolean {
  const ready = useSyncExternalStore(subscribe, () => counter !== null)
  useEffect(() => {
    if (!ready) void loadTokenizer()
  }, [ready])
  return ready
}

/** 带防抖的 token 计数 hook */
export function useTokenCount(text: string, delay = 300): number | null {
  const ready = useTokenizerReady()
  const [value, setValue] = useState<number | null>(null)
  useEffect(() => {
    if (!ready) return
    const timer = setTimeout(() => setValue(countTokens(text)), delay)
    return () => clearTimeout(timer)
  }, [text, ready, delay])
  return value
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return '…'
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
