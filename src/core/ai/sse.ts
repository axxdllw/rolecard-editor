/**
 * Server-Sent Events 解析：把响应体按事件拆开。
 * 兼容 \n 和 \r\n 换行、一个事件多行 data、注释行（: 开头）。
 */

export interface SseEvent {
  event?: string
  data: string
}

export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event: string | undefined
  let data: string[] = []

  const flush = (): SseEvent | null => {
    if (data.length === 0) {
      event = undefined
      return null
    }
    const out: SseEvent = { data: data.join('\n') }
    if (event !== undefined) out.event = event
    event = undefined
    data = []
    return out
  }

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      const { value, done } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(buffer[index] === '\r' ? index + 2 : index + 1)
        if (line === '') {
          const out = flush()
          if (out) yield out
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        let value = colon < 0 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'data') data.push(value)
        else if (field === 'event') event = value
      }
      if (done) break
    }
    if (buffer) {
      // 最后一行没有换行结尾
      const line = buffer
      buffer = ''
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    const out = flush()
    if (out) yield out
  } finally {
    reader.releaseLock()
  }
}
