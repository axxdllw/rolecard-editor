/**
 * Google Gemini 原生接口适配器（generateContent，浏览器直连）。
 *
 * - API key 放在 x-goog-api-key 请求头里，不拼进 URL，避免泄露到日志或历史记录。
 * - 思考模型返回的 thought: true 片段不计入正文结果。
 * - 模型列表只保留支持 generateContent 的模型，并统一去掉 models/ 前缀。
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

const MAX_MODEL_PAGES = 5

const REFUSAL_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'])

interface GeminiPart {
  text?: unknown
  thought?: unknown
}

interface GeminiCandidate {
  content?: {
    parts?: unknown
  }
  finishReason?: unknown
}

interface GeminiStreamChunk {
  candidates?: unknown
  promptFeedback?: {
    blockReason?: unknown
  }
  error?: unknown
}

interface GeminiModelItem {
  name?: unknown
  supportedGenerationMethods?: unknown
}

interface GeminiModelListResponse {
  models?: unknown
  nextPageToken?: unknown
}

/** 接口地址：用户填中转地址时常常带上 /v1beta 或 /v1，去掉后再统一拼 /v1beta */
function geminiBaseUrl(profile: AiProfile): string {
  return resolveBaseUrl(profile).replace(/\/v1(beta)?$/, '')
}

/** 去掉模型名前可能自带的 models/ 前缀 */
function stripModelPrefix(model: string): string {
  return model.trim().replace(/^models\//, '')
}

function mapFinishReason(reason: string): AiFinishReason {
  if (reason === 'STOP') return 'stop'
  if (reason === 'MAX_TOKENS') return 'length'
  if (REFUSAL_REASONS.has(reason)) return 'refusal'
  return 'other'
}

export const geminiProvider: AiProvider = {
  async stream(profile: AiProfile, request: AiRequest): Promise<AiResult> {
    const model = stripModelPrefix(profile.model)
    const url = `${geminiBaseUrl(profile)}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`

    const generationConfig: Record<string, unknown> = {}
    if (profile.maxTokens != null && profile.maxTokens > 0) {
      generationConfig.maxOutputTokens = profile.maxTokens
    }
    if (request.json) {
      generationConfig.responseMimeType = 'application/json'
    }

    const body: Record<string, unknown> = {
      contents: request.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
    }
    if (request.system) {
      body.systemInstruction = { parts: [{ text: request.system }] }
    }
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig
    }

    let full = ''
    let finishReason: AiFinishReason | undefined
    let rawFinishReason: string | undefined

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': profile.apiKey.trim(),
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

        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          // 忽略非 JSON 片段
          continue
        }
        if (!parsed || typeof parsed !== 'object') continue

        const chunk = parsed as GeminiStreamChunk
        if (chunk.error !== undefined && chunk.error !== null) {
          const detail = extractErrorMessage(raw)
          throw new AiError('server', detail || '接口返回错误', {
            detail: detail || undefined,
          })
        }

        const candidate = Array.isArray(chunk.candidates)
          ? (chunk.candidates[0] as GeminiCandidate | undefined)
          : undefined
        const parts = candidate?.content?.parts
        if (Array.isArray(parts)) {
          for (const item of parts) {
            if (!item || typeof item !== 'object') continue
            const part = item as GeminiPart
            if (part.thought === true) continue
            if (typeof part.text === 'string' && part.text.length > 0) {
              full += part.text
              request.onText?.(part.text, full)
            }
          }
        }

        if (typeof candidate?.finishReason === 'string' && candidate.finishReason) {
          finishReason = mapFinishReason(candidate.finishReason)
          rawFinishReason = candidate.finishReason
        }

        const blockReason = chunk.promptFeedback?.blockReason
        if (typeof blockReason === 'string' && blockReason) {
          finishReason = 'refusal'
          rawFinishReason = blockReason
        }
      }

      return { text: full, finishReason: finishReason ?? 'stop', rawFinishReason }
    } catch (error) {
      throw networkError(error)
    }
  },

  async listModels(profile: AiProfile, signal?: AbortSignal): Promise<string[]> {
    const base = geminiBaseUrl(profile)
    const headers = { 'x-goog-api-key': profile.apiKey.trim() }
    const ids: string[] = []
    let pageToken: string | undefined

    try {
      for (let page = 0; page < MAX_MODEL_PAGES; page++) {
        const query = pageToken
          ? `pageSize=1000&pageToken=${encodeURIComponent(pageToken)}`
          : 'pageSize=1000'
        const response = await fetch(`${base}/v1beta/models?${query}`, {
          method: 'GET',
          headers,
          signal,
        })

        if (!response.ok) {
          const text = await response.text()
          throw httpError(response.status, text)
        }

        const payload = (await response.json()) as GeminiModelListResponse
        if (Array.isArray(payload.models)) {
          for (const item of payload.models) {
            if (!item || typeof item !== 'object') continue
            const model = item as GeminiModelItem
            if (
              typeof model.name === 'string' &&
              model.name &&
              Array.isArray(model.supportedGenerationMethods) &&
              model.supportedGenerationMethods.includes('generateContent')
            ) {
              ids.push(stripModelPrefix(model.name))
            }
          }
        }

        if (typeof payload.nextPageToken === 'string' && payload.nextPageToken) {
          pageToken = payload.nextPageToken
        } else {
          break
        }
      }

      return ids
    } catch (error) {
      throw networkError(error)
    }
  },
}
