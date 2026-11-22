/**
 * AI 调用入口：按接口类型分派到对应的适配器。适配器按需加载，不用 AI 时不占首屏体积。
 */
import { AiError, type AiProfile, type AiProvider, type AiProviderKind, type AiRequest, type AiResult } from './types'

const loaders: Record<AiProviderKind, () => Promise<AiProvider>> = {
  openai: () => import('./providers/openai').then((m) => m.openaiProvider),
  anthropic: () => import('./providers/anthropic').then((m) => m.anthropicProvider),
  gemini: () => import('./providers/gemini').then((m) => m.geminiProvider),
}

function checkProfile(profile: AiProfile) {
  if (!profile.apiKey.trim()) throw new AiError('auth', '还没填 API key')
  if (!profile.model.trim()) throw new AiError('bad_request', '还没选模型')
}

export async function streamChat(profile: AiProfile, request: AiRequest): Promise<AiResult> {
  checkProfile(profile)
  const provider = await loaders[profile.kind]()
  const result = await provider.stream(profile, request)
  if (result.finishReason === 'refusal') {
    throw new AiError('refusal', '模型拒绝了这个请求，可以换个说法或换个模型再试', { finishReason: result.rawFinishReason })
  }
  if (!result.text.trim()) throw new AiError('empty', '模型没有返回内容')
  return result
}

export async function listModels(profile: AiProfile, signal?: AbortSignal): Promise<string[]> {
  if (!profile.apiKey.trim()) throw new AiError('auth', '还没填 API key')
  const provider = await loaders[profile.kind]()
  const models = await provider.listModels(profile, signal)
  return [...new Set(models)].sort((a, b) => a.localeCompare(b))
}
