/**
 * 解析电子书文件（在 Worker 里跑）。失败时抛 BookError（不支持、加密、损坏、没有正文）或普通 Error。
 */
import { BookError, type BookArchive, type BookErrorKind, type ParsedBook } from '@/core/book/types'
import type { BookWorkerRequest, BookWorkerResponse } from './bookWorker'

let seq = 0

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

function run(request: WithoutId<BookWorkerRequest>, transfer: ArrayBuffer): Promise<unknown> {
  // 每次用一个新 Worker，解析完就关掉，大文件占的内存马上释放
  const worker = new Worker(new URL('./bookWorker.ts', import.meta.url), { type: 'module' })
  const id = ++seq
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<BookWorkerResponse>) => {
      const res = event.data
      if (res.id !== id) return
      worker.terminate()
      if (res.ok) resolve(res.result)
      else reject(res.error.book ? new BookError(res.error.kind as BookErrorKind, res.error.message) : new Error(res.error.message))
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message || '解析电子书时出错'))
    }
    worker.postMessage({ ...request, id } as BookWorkerRequest, [transfer])
  })
}

export async function parseBookFile(file: File): Promise<ParsedBook | BookArchive> {
  const bytes = await file.arrayBuffer()
  return (await run({ kind: 'parse', bytes, fileName: file.name }, bytes)) as ParsedBook | BookArchive
}

/** 解析压缩包里的某一本 */
export async function parseArchiveEntry(file: File, entryPath: string): Promise<ParsedBook> {
  const bytes = await file.arrayBuffer()
  return (await run({ kind: 'entry', bytes, entryPath }, bytes)) as ParsedBook
}
