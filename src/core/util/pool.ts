/**
 * 限制并发地跑一批异步任务。worker 自己处理每个任务的错误；
 * signal 中止后不再开始新任务（已经开始的由 worker 自己响应 signal）。
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0
  const lanes = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length))
  const run = async () => {
    while (next < items.length && !signal?.aborted) {
      const index = next++
      await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: lanes }, run))
}
