/**
 * Anthropic Messages 格式适配器（官方 SDK，浏览器直连）。
 *
 * SDK 只是 Anthropic 格式的客户端，接口地址可以换：Claude 官方 API（用控制台申请的 API key，按量计费），
 * 以及提供 Anthropic 格式的中转站和厂商都能用。Claude 订阅（Pro/Max）不提供 API key，不能用在这里。
 *
 * - 浏览器里用 SDK 必须开 dangerouslyAllowBrowser：本应用是用户自带 key、只在本机使用，key 不会发给第三方。
 * - 新模型不接受 temperature 等采样参数，也不允许关掉思考，这里都不传，用模型默认值。
 * - 直连官方地址时开启服务端兜底（server-side fallback）：模型因安全分类拒绝时，由接口自动换模型重试。
 *   中转站不一定支持 beta 参数，所以只在官方地址上开。
 * - 中转站和其他厂商按“经典”Anthropic 格式发：SDK 新版默认把 key 放在 Authorization: Bearer、API 版本头是新日期，
 *   而中转大多只认 x-api-key 和 anthropic-version: 2023-06-01。所以非官方地址同时带上 x-api-key（Bearer 也保留，两种都认），
 *   版本头改回 2023-06-01，并去掉 SDK 自带的 X-Stainless-* 统计请求头（有的中转跨域只放行固定几个请求头）。
 * - 地址末尾多写的 /v1、/v1/messages 会自动去掉（SDK 自己会拼 /v1/messages）。
 */
import type Anthropic from '@anthropic-ai/sdk'
import { httpError, isAbortError, networkError } from '../errors'
import {
  AiError,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  DEFAULT_BASE_URL,
  resolveBaseUrl,
  type AiFinishReason,
  type AiProfile,
  type AiProvider,
  type AiRequest,
  type AiResult,
} from '../types'

/** 支持服务端兜底的模型（见 Anthropic 文档的 refusal fallback） */
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])

/** 中转站普遍支持的 API 版本 */
const CLASSIC_API_VERSION = '2023-06-01'

/** SDK 默认带的统计请求头，对中转站置空（null 表示不发送） */
const STAINLESS_HEADERS = [
  'X-Stainless-Lang',
  'X-Stainless-Package-Version',
  'X-Stainless-OS',
  'X-Stainless-Arch',
  'X-Stainless-Runtime',
  'X-Stainless-Runtime-Version',
  'X-Stainless-Retry-Count',
  'X-Stainless-Timeout',
]

/** SDK 的 baseURL：去掉用户多写的 /v1、/v1/messages */
export function anthropicBaseUrl(profile: Pick<AiProfile, 'kind' | 'baseUrl'>): string {
  return resolveBaseUrl(profile).replace(/\/v1(\/messages)?$/, '')
}

function isOfficial(profile: AiProfile): boolean {
  return anthropicBaseUrl(profile) === DEFAULT_BASE_URL.anthropic
}

async function createClient(profile: AiProfile): Promise<Anthropic> {
  const { default: AnthropicClient } = await import('@anthropic-ai/sdk')
  const key = profile.apiKey.trim()
  const relayHeaders = {
    ...Object.fromEntries(STAINLESS_HEADERS.map((h) => [h, null])),
    'x-api-key': key,
    'anthropic-version': CLASSIC_API_VERSION,
  }
  return new AnthropicClient({
    apiKey: key,
    baseURL: anthropicBaseUrl(profile),
    dangerouslyAllowBrowser: true,
    maxRetries: 1,
    ...(isOfficial(profile) ? {} : { defaultHeaders: relayHeaders }),
  })
}

function mapStopReason(reason: string | null | undefined): AiFinishReason {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop'
  if (reason === 'max_tokens') return 'length'
  if (reason === 'refusal') return 'refusal'
  return 'other'
}

/** 流式事件里用得到的部分（正式版和 beta 版的事件类型结构相同） */
interface StreamEvent {
  type: string
  delta?: { type?: string; text?: string; stop_reason?: string | null }
}

/** 拼出正文；结束原因在 message_delta 事件里 */
async function consumeEvents(events: AsyncIterable<StreamEvent>, request: AiRequest): Promise<AiResult> {
  let full = ''
  let stopReason: string | null | undefined
  for await (const event of events) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
      full += event.delta.text
      request.onText?.(event.delta.text, full)
    } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
      stopReason = event.delta.stop_reason
    }
  }
  return { text: full, finishReason: mapStopReason(stopReason ?? 'end_turn') }
}

async function toAiError(error: unknown): Promise<AiError> {
  if (error instanceof AiError) return error
  if (isAbortError(error)) return new AiError('aborted', '已取消')
  const { APIError, APIUserAbortError, APIConnectionError } = await import('@anthropic-ai/sdk')
  if (error instanceof APIUserAbortError) return new AiError('aborted', '已取消')
  if (error instanceof APIConnectionError) return networkError(error)
  if (error instanceof APIError && typeof error.status === 'number') {
    return httpError(error.status, JSON.stringify(error.error ?? { message: error.message }))
  }
  return networkError(error)
}

export const anthropicProvider: AiProvider = {
  async stream(profile: AiProfile, request: AiRequest): Promise<AiResult> {
    const client = await createClient(profile)
    const model = profile.model.trim()
    const base = {
      model,
      max_tokens: profile.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
      ...(request.system ? { system: request.system } : {}),
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    }
    try {
      // 用 create({ stream: true }) 逐个读事件，而不是 messages.stream()：后者会额外带一个
      // x-stainless-helper-method 请求头，没法去掉，中转站跨域时可能被拦
      const events =
        isOfficial(profile) && FALLBACK_MODELS.has(model)
          ? await client.beta.messages.create(
              { ...base, stream: true, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
              { signal: request.signal },
            )
          : await client.messages.create({ ...base, stream: true }, { signal: request.signal })
      return await consumeEvents(events, request)
    } catch (error) {
      throw await toAiError(error)
    }
  },

  async listModels(profile: AiProfile, signal?: AbortSignal): Promise<string[]> {
    const client = await createClient(profile)
    try {
      const ids: string[] = []
      for await (const model of client.models.list({ limit: 100 }, { signal })) ids.push(model.id)
      return ids
    } catch (error) {
      throw await toAiError(error)
    }
  },
}
