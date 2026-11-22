/**
 * OpenAI 兼容接口适配器（/chat/completions，浏览器直连）。
 *
 * - 适用于 OpenAI、DeepSeek、OpenRouter 及各类兼容中转站。
 * - 不传 temperature，使用服务端或模型默认值；也不传 stream_options，避免部分中转站报错。
 * - 思考模型返回的 delta.reasoning_content 不会混入正文结果。
 */
import { extractErrorMessage, httpError, networkError } from '../errors'
import { readSse } from '../sse'
import {
  AiError,
  resolveBaseUrl,
  type AiFinishReason,
  type AiProfile,
  type AiProvider,
  type AiRequest,
  type AiResult,
} from '../types'

interface OpenAiStreamChoice {
  delta?: {
    content?: unknown
    reasoning_content?: unknown
  }
  finish_reason?: unknown
}

interface OpenAiStreamChunk {
  choices?: unknown
  error?: unknown
}

interface OpenAiModelListResponse {
  data?: unknown
}

/** 接口地址：用户误填到 /chat/completions 时去掉，后面统一再拼 */
function openaiBaseUrl(profile: AiProfile): string {
  return resolveBaseUrl(profile).replace(/\/chat\/completions$/, '')
}

function mapFinishReason(reason: string): AiFinishReason {
  if (reason === 'stop') return 'stop'
  if (reason === 'length') return 'length'
  if (reason === 'content_filter') return 'refusal'
  return 'other'
}

export const openaiProvider: AiProvider = {
  async stream(profile: AiProfile, request: AiRequest): Promise<AiResult> {
    const url = `${openaiBaseUrl(profile)}/chat/completions`
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
    if (request.system) {
      messages.push({ role: 'system', content: request.system })
    }
    for (const m of request.messages) {
      messages.push({ role: m.role, content: m.content })
    }

    const body: Record<string, unknown> = {
      model: profile.model.trim(),
      messages,
      stream: true,
    }
    if (profile.maxTokens != null && profile.maxTokens > 0) {
      body.max_tokens = profile.maxTokens
    }
    if (request.json) {
      body.response_format = { type: 'json_object' }
    }

    let full = ''
    let finishReason: AiFinishReason | undefined

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${profile.apiKey.trim()}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      })

      if (!response.ok) {
        const text = await response.text()
        throw httpError(response.status, text)
      }

      if (!response.body) {
        return { text: '', finishReason: 'stop' }
      }

      for await (const event of readSse(response.body, request.signal)) {
        const raw = event.data.trim()
        if (!raw) continue
        if (raw === '[DONE]') break

        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          // 忽略无法解析的片段（例如中转站夹带的非 JSON 提示）
          continue
        }
        if (!parsed || typeof parsed !== 'object') continue

        const chunk = parsed as OpenAiStreamChunk
        if (chunk.error !== undefined && chunk.error !== null) {
          const detail = extractErrorMessage(raw)
          throw new AiError('server', detail || '接口返回错误', {
            detail: detail || undefined,
          })
        }

        const choice = Array.isArray(chunk.choices)
          ? (chunk.choices[0] as OpenAiStreamChoice | undefined)
          : undefined
        if (!choice) continue

        const content = choice.delta?.content
        if (typeof content === 'string' && content.length > 0) {
          full += content
          request.onText?.(content, full)
        }

        if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason)
        }
      }

      return { text: full, finishReason: finishReason ?? 'stop' }
    } catch (error) {
      throw networkError(error)
    }
  },

  async listModels(profile: AiProfile, signal?: AbortSignal): Promise<string[]> {
    const url = `${openaiBaseUrl(profile)}/models`
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${profile.apiKey.trim()}`,
        },
        signal,
      })

      if (!response.ok) {
        const text = await response.text()
        throw httpError(response.status, text)
      }

      const payload = (await response.json()) as OpenAiModelListResponse
      if (!Array.isArray(payload.data)) return []

      const ids: string[] = []
      for (const item of payload.data) {
        if (item && typeof item === 'object') {
          const id = (item as { id?: unknown }).id
          if (typeof id === 'string' && id) ids.push(id)
        }
      }
      return ids
    } catch (error) {
      throw networkError(error)
    }
  },
}
