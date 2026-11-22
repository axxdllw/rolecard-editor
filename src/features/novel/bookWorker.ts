/**
 * 在 Web Worker 里解析电子书，几十 MB 的书也不会卡住页面。
 */
import { parseBook, parseBookInArchive } from '@/core/book'
import { BookError } from '@/core/book/types'

export type BookWorkerRequest =
  | { id: number; kind: 'parse'; bytes: ArrayBuffer; fileName: string }
  | { id: number; kind: 'entry'; bytes: ArrayBuffer; entryPath: string }

export type BookWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { book: boolean; kind?: string; message: string } }

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<BookWorkerRequest>) => void) | null
  postMessage: (message: BookWorkerResponse) => void
}

ctx.onmessage = (event) => {
  const req = event.data
  try {
    const bytes = new Uint8Array(req.bytes)
    const result = req.kind === 'parse' ? parseBook(bytes, req.fileName) : parseBookInArchive(bytes, req.entryPath)
    ctx.postMessage({ id: req.id, ok: true, result })
  } catch (error) {
    const isBook = error instanceof BookError
    ctx.postMessage({
      id: req.id,
      ok: false,
      error: { book: isBook, kind: isBook ? error.kind : undefined, message: error instanceof Error ? error.message : String(error) },
    })
  }
}
