import { afterEach, describe, expect, it, vi } from 'vitest'
import { geminiProvider } from '../../src/core/ai/providers/gemini'
import { openaiProvider } from '../../src/core/ai/providers/openai'
import { readSse, type SseEvent } from '../../src/core/ai/sse'
import { AiError, type AiProfile } from '../../src/core/ai/types'

const encoder = new TextEncoder()

/** 按指定片段逐块推送，用于验证跨块拆行与换行符混用 */
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

function makeSseResponse(chunks: string[], status = 200): Response {
  return new Response(makeStream(chunks), {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]

function stubFetch(handler: (req: { url: string; init: FetchInit }) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: FetchInit }> = []
  const fn = vi.fn(async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init })
    return await handler({ url, init })
  })
  vi.stubGlobal('fetch', fn)
  return { fn, calls }
}

function readJsonBody(init: FetchInit): Record<string, unknown> {
  expect(typeof init?.body).toBe('string')
  return JSON.parse(init?.body as string) as Record<string, unknown>
}

async function catchAiError(promise: Promise<unknown>): Promise<AiError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AiError)
    return error as AiError
  }
  throw new Error('预期抛出 AiError，但调用成功了')
}

function makeOpenAiProfile(overrides: Partial<AiProfile> = {}): AiProfile {
  return {
    id: 'p-openai',
    name: 'OpenAI 测试',
    kind: 'openai',
    baseUrl: 'https://proxy.example.com/v1/',
    apiKey: '  sk-test-key  ',
    model: 'gpt-4o-mini',
    ...overrides,
  }
}

function makeGeminiProfile(overrides: Partial<AiProfile> = {}): AiProfile {
  return {
    id: 'p-gemini',
    name: 'Gemini 测试',
    kind: 'gemini',
    baseUrl: '',
    apiKey: '  AIza-test-key  ',
    model: 'models/gemini-2.5-pro',
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readSse', () => {
  it('支持多行 data、注释行、跨块拆行与 \\r\\n 混用', async () => {
    const stream = makeStream([
      ': keep-alive 注释行\r\n',
      'event: message\n',
      'data: 第一',
      '行\r\ndata: 第二行\n\r\n',
      ': 另一条注释\n',
      'data: 只有一行\n\n',
    ])

    const events: SseEvent[] = []
    for await (const ev of readSse(stream)) events.push(ev)

    expect(events).toEqual([
      { event: 'message', data: '第一行\n第二行' },
      { data: '只有一行' },
    ])
  })

  it('末尾没有换行符时也能产出最后一条事件', async () => {
    const stream = makeStream(['data: 第一条\n\n', 'data: 末尾无换行'])

    const events: SseEvent[] = []
    for await (const ev of readSse(stream)) events.push(ev)

    expect(events).toEqual([{ data: '第一条' }, { data: '末尾无换行' }])
  })
})

describe('openaiProvider', () => {
  it('按约定组装请求地址、请求头与请求体（system 在最前、json、maxTokens、无 temperature）', async () => {
    const { calls } = stubFetch(() =>
      makeSseResponse(['data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n']),
    )

    await openaiProvider.stream(makeOpenAiProfile({ maxTokens: 2048 }), {
      system: '你是角色卡助手',
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！' },
      ],
      json: true,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://proxy.example.com/v1/chat/completions')
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test-key',
    })

    const body = readJsonBody(calls[0].init)
    expect(body).toEqual({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: '你是角色卡助手' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！' },
      ],
      stream: true,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
    })
    expect('temperature' in body).toBe(false)
    expect('stream_options' in body).toBe(false)
  })

  it('流式累加正文、校验 onText 参数、忽略思考内容与非法 JSON，并在 [DONE] 处结束', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"先想一下"}}]}\r\n\r\n',
      'data: 不是合法JSON\n\n',
      'data: {"choices":[{"delta":{"con',
      'tent":"你好"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"，世界"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"不会读到"}}]}\n\n',
    ]
    stubFetch(() => makeSseResponse(chunks))

    const received: Array<{ delta: string; full: string }> = []
    const result = await openaiProvider.stream(makeOpenAiProfile({ baseUrl: '' }), {
      messages: [{ role: 'user', content: '打个招呼' }],
      onText(delta, full) {
        received.push({ delta, full })
      },
    })

    expect(result).toEqual({ text: '你好，世界', finishReason: 'stop', rawFinishReason: 'stop' })
    expect(received).toEqual([
      { delta: '你好', full: '你好' },
      { delta: '，世界', full: '你好，世界' },
    ])
  })

  it('映射 finish_reason（length、content_filter、缺失时默认 stop）', async () => {
    stubFetch(() =>
      makeSseResponse(['data: {"choices":[{"delta":{"content":"截断了"},"finish_reason":"length"}]}\n\n']),
    )
    const lengthResult = await openaiProvider.stream(makeOpenAiProfile(), {
      messages: [{ role: 'user', content: '写长一点' }],
    })
    expect(lengthResult).toEqual({ text: '截断了', finishReason: 'length', rawFinishReason: 'length' })

    stubFetch(() =>
      makeSseResponse(['data: {"choices":[{"delta":{"content":""},"finish_reason":"content_filter"}]}\n\n']),
    )
    const filterResult = await openaiProvider.stream(makeOpenAiProfile(), {
      messages: [{ role: 'user', content: '测试过滤' }],
    })
    expect(filterResult).toEqual({ text: '', finishReason: 'refusal', rawFinishReason: 'content_filter' })

    stubFetch(() => makeSseResponse(['data: {"choices":[{"delta":{"content":"完毕"}}]}\n\n']))
    const defaultResult = await openaiProvider.stream(makeOpenAiProfile(), {
      messages: [{ role: 'user', content: '无原因' }],
    })
    expect(defaultResult).toEqual({ text: '完毕', finishReason: 'stop' })
  })

  it('中转站的 max_tokens、上游拦截原因和 native_finish_reason', async () => {
    stubFetch(() =>
      makeSseResponse(['data: {"choices":[{"delta":{"content":"写到一半"},"finish_reason":"max_tokens"}]}\n\n']),
    )
    const maxResult = await openaiProvider.stream(makeOpenAiProfile(), { messages: [{ role: 'user', content: 'x' }] })
    expect(maxResult).toEqual({ text: '写到一半', finishReason: 'length', rawFinishReason: 'max_tokens' })

    stubFetch(() =>
      makeSseResponse([
        'data: {"choices":[{"delta":{"content":"半句"},"finish_reason":"stop","native_finish_reason":"RECITATION"}]}\n\n',
      ]),
    )
    const nativeResult = await openaiProvider.stream(makeOpenAiProfile(), { messages: [{ role: 'user', content: 'x' }] })
    expect(nativeResult).toEqual({ text: '半句', finishReason: 'refusal', rawFinishReason: 'RECITATION' })

    stubFetch(() =>
      makeSseResponse(['data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop","native_finish_reason":"stop"}]}\n\n']),
    )
    const normal = await openaiProvider.stream(makeOpenAiProfile(), { messages: [{ role: 'user', content: 'x' }] })
    expect(normal).toEqual({ text: '好', finishReason: 'stop', rawFinishReason: 'stop' })
  })

  it('流内返回 error 对象时抛出 server 类型 AiError', async () => {
    stubFetch(() =>
      makeSseResponse(['data: {"error":{"message":"上游模型繁忙","type":"server_error"}}\n\n']),
    )

    const error = await catchAiError(
      openaiProvider.stream(makeOpenAiProfile(), {
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )

    expect(error.kind).toBe('server')
    expect(error.message).toContain('上游模型繁忙')
  })

  it('HTTP 401 转为 auth 类型 AiError 且包含服务端说明', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
          status: 401,
        }),
    )

    const error = await catchAiError(
      openaiProvider.stream(makeOpenAiProfile(), {
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )

    expect(error.kind).toBe('auth')
    expect(error.status).toBe(401)
    expect(error.message).toContain('Incorrect API key provided')
  })

  it('fetch 抛出 TypeError 时转为 network 类型 AiError', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch')
    })

    const error = await catchAiError(
      openaiProvider.stream(makeOpenAiProfile(), {
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )

    expect(error.kind).toBe('network')
  })

  it('AbortController 取消时转为 aborted 类型 AiError', async () => {
    const controller = new AbortController()
    stubFetch(
      ({ init }) =>
        new Promise<Response>((resolve, reject) => {
          const onAbort = () => reject(init?.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
          if (init?.signal?.aborted) {
            onAbort()
            return
          }
          if (!init?.signal) {
            resolve(makeSseResponse([]))
            return
          }
          init.signal.addEventListener('abort', onAbort, { once: true })
        }),
    )

    const pending = openaiProvider.stream(makeOpenAiProfile(), {
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    })
    controller.abort()

    const error = await catchAiError(pending)
    expect(error.kind).toBe('aborted')
  })

  it('listModels 请求 /models 并返回字符串模型 id', async () => {
    const { calls } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'gpt-4o' }, { id: 'deepseek-chat' }, { id: 123 }, {}],
          }),
          { status: 200 },
        ),
    )

    const models = await openaiProvider.listModels(makeOpenAiProfile())

    expect(calls[0].url).toBe('https://proxy.example.com/v1/models')
    expect(calls[0].init?.method).toBe('GET')
    expect(calls[0].init?.headers).toEqual({ Authorization: 'Bearer sk-test-key' })
    expect(models).toEqual(['gpt-4o', 'deepseek-chat'])
  })
})

describe('geminiProvider', () => {
  it('去掉 models/ 前缀、把 key 放请求头而非 URL，并正确映射 contents 与 systemInstruction', async () => {
    const { calls } = stubFetch(() =>
      makeSseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"收到"}]},"finishReason":"STOP"}]}\n\n',
      ]),
    )

    await geminiProvider.stream(makeGeminiProfile({ maxTokens: 4096 }), {
      system: '遵循角色设定',
      messages: [
        { role: 'user', content: '你是谁' },
        { role: 'assistant', content: '我是向导' },
        { role: 'user', content: '继续' },
      ],
      json: true,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    )
    expect(calls[0].url).not.toContain('AIza-test-key')
    expect(calls[0].init?.headers).toEqual({
      'Content-Type': 'application/json',
      'x-goog-api-key': 'AIza-test-key',
    })

    expect(readJsonBody(calls[0].init)).toEqual({
      contents: [
        { role: 'user', parts: [{ text: '你是谁' }] },
        { role: 'model', parts: [{ text: '我是向导' }] },
        { role: 'user', parts: [{ text: '继续' }] },
      ],
      systemInstruction: { parts: [{ text: '遵循角色设定' }] },
      generationConfig: {
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    })
  })

  it('不设置 maxTokens 和 json 时不传 generationConfig', async () => {
    const { calls } = stubFetch(() =>
      makeSseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n']),
    )

    await geminiProvider.stream(makeGeminiProfile({ model: 'gemini-2.5-flash' }), {
      messages: [{ role: 'user', content: 'ping' }],
    })

    const body = readJsonBody(calls[0].init)
    expect('generationConfig' in body).toBe(false)
    expect('systemInstruction' in body).toBe(false)
  })

  it('忽略 thought 片段，正确跨块累加正文并触发 onText', async () => {
    const chunks = [
      'data: {"candidates":[{"content":{"parts":[{"text":"内部思考","thought":true},{"text":"第',
      '一段"}]}}]}\r\n\r\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"第二段"}]},"finishReason":"STOP"}]}\n\n',
    ]
    stubFetch(() => makeSseResponse(chunks))

    const received: Array<{ delta: string; full: string }> = []
    const result = await geminiProvider.stream(makeGeminiProfile(), {
      messages: [{ role: 'user', content: '讲个故事' }],
      onText(delta, full) {
        received.push({ delta, full })
      },
    })

    expect(result).toEqual({ text: '第一段第二段', finishReason: 'stop', rawFinishReason: 'STOP' })
    expect(received).toEqual([
      { delta: '第一段', full: '第一段' },
      { delta: '第二段', full: '第一段第二段' },
    ])
  })

  it('SAFETY 与 promptFeedback.blockReason 映射为 refusal', async () => {
    stubFetch(() =>
      makeSseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"半句"}]},"finishReason":"SAFETY"}]}\n\n',
      ]),
    )
    const safetyResult = await geminiProvider.stream(makeGeminiProfile(), {
      messages: [{ role: 'user', content: '敏感内容' }],
    })
    expect(safetyResult).toEqual({ text: '半句', finishReason: 'refusal', rawFinishReason: 'SAFETY' })

    stubFetch(() => makeSseResponse(['data: {"promptFeedback":{"blockReason":"PROHIBITED_CONTENT"}}\n\n']))
    const blockResult = await geminiProvider.stream(makeGeminiProfile(), {
      messages: [{ role: 'user', content: '被拦截' }],
    })
    expect(blockResult).toEqual({ text: '', finishReason: 'refusal', rawFinishReason: 'PROHIBITED_CONTENT' })
  })

  it('listModels 过滤支持 generateContent 的模型、去前缀并翻页（最多 5 页）', async () => {
    let page = 0
    const { calls } = stubFetch(() => {
      page++
      if (page === 1) {
        return new Response(
          JSON.stringify({
            models: [
              { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent', 'countTokens'] },
              { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
            ],
            nextPageToken: 'tok-2',
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          models: [{ name: `models/gemini-page-${page}`, supportedGenerationMethods: ['generateContent'] }],
          nextPageToken: `tok-${page + 1}`,
        }),
        { status: 200 },
      )
    })

    const models = await geminiProvider.listModels(makeGeminiProfile())

    expect(calls).toHaveLength(5)
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000')
    expect(calls[1].url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=tok-2',
    )
    expect(calls[0].init?.headers).toEqual({ 'x-goog-api-key': 'AIza-test-key' })
    expect(models).toEqual([
      'gemini-2.5-pro',
      'gemini-page-2',
      'gemini-page-3',
      'gemini-page-4',
      'gemini-page-5',
    ])
  })
})
