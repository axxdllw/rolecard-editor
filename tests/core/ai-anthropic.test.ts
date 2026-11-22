import { afterEach, describe, expect, it, vi } from 'vitest'
import { anthropicBaseUrl, anthropicProvider } from '../../src/core/ai/providers/anthropic'
import { AiError, type AiProfile } from '../../src/core/ai/types'

const profile = (patch: Partial<AiProfile> = {}): AiProfile => ({
  id: 'p',
  name: '测试',
  kind: 'anthropic',
  baseUrl: '',
  apiKey: ' sk-test ',
  model: 'claude-opus-5-5',
  ...patch,
})

/** 按 Anthropic 流式格式拼出 SSE 响应 */
function sseResponse(texts: string[], stopReason = 'end_turn'): Response {
  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ...texts.map((text): [string, unknown] => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }]),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 3 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

interface Captured {
  url: string
  headers: Headers
  body: Record<string, unknown>
}

function mockFetch(response: () => Response): Captured[] {
  const calls: Captured[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : {} })
    return response()
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Anthropic 格式适配器', () => {
  it('接口地址去掉多写的 /v1、/v1/messages', () => {
    expect(anthropicBaseUrl({ kind: 'anthropic', baseUrl: 'https://relay.example.com/v1/' })).toBe('https://relay.example.com')
    expect(anthropicBaseUrl({ kind: 'anthropic', baseUrl: 'https://relay.example.com/api/v1/messages' })).toBe('https://relay.example.com/api')
    expect(anthropicBaseUrl({ kind: 'anthropic', baseUrl: '' })).toBe('https://api.anthropic.com')
  })

  it('官方地址：流式拼出全文，开启服务端兜底，不传采样参数', async () => {
    const calls = mockFetch(() => sseResponse(['你', '好']))
    const deltas: string[] = []
    const result = await anthropicProvider.stream(profile(), {
      system: '系统提示',
      messages: [{ role: 'user', content: '问候' }],
      onText: (d, full) => deltas.push(`${d}|${full}`),
    })
    expect(result).toEqual({ text: '你好', finishReason: 'stop', rawFinishReason: 'end_turn' })
    expect(deltas).toEqual(['你|你', '好|你好'])
    const [call] = calls
    expect(call.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/)
    // 新版 SDK 把 API key 放在 Authorization: Bearer 里
    expect(call.headers.get('authorization')).toBe('Bearer sk-test')
    expect(call.headers.get('anthropic-dangerous-direct-browser-access')).toBe('true')
    expect(call.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01')
    expect(call.body).toMatchObject({ model: 'claude-opus-5-5', system: '系统提示', stream: true, fallbacks: 'default' })
    expect(call.body).not.toHaveProperty('temperature')
  })

  it('中转地址：按经典格式发 x-api-key 和 2023-06-01，不开兜底，不发 X-Stainless 请求头', async () => {
    const calls = mockFetch(() => sseResponse(['ok']))
    await anthropicProvider.stream(profile({ baseUrl: 'https://relay.example.com/v1', model: 'claude-sonnet-5-5' }), {
      messages: [{ role: 'user', content: 'hi' }],
    })
    const [call] = calls
    expect(call.url).toMatch(/^https:\/\/relay\.example\.com\/v1\/messages/)
    expect(call.headers.get('x-api-key')).toBe('sk-test')
    expect(call.headers.get('authorization')).toBe('Bearer sk-test')
    expect(call.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(call.headers.get('anthropic-beta')).toBeNull()
    expect([...call.headers.keys()].some((k) => k.startsWith('x-stainless'))).toBe(false)
    expect(call.body).not.toHaveProperty('fallbacks')
  })

  it('达到最大长度和拒绝的结束原因', async () => {
    mockFetch(() => sseResponse(['半句'], 'max_tokens'))
    await expect(anthropicProvider.stream(profile({ baseUrl: 'https://relay.example.com' }), { messages: [{ role: 'user', content: 'x' }] })).resolves.toEqual({
      text: '半句',
      finishReason: 'length',
      rawFinishReason: 'max_tokens',
    })
  })

  it('401 转成 auth 错误', async () => {
    mockFetch(() => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401 }))
    const error = await anthropicProvider.stream(profile(), { messages: [{ role: 'user', content: 'x' }] }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AiError)
    expect((error as AiError).kind).toBe('auth')
    expect((error as AiError).message).toContain('invalid x-api-key')
  })
})
