/**
 * AI 接口的公共类型。浏览器直接调用各家接口，API key 只存在本地。
 *
 * - openai：OpenAI 兼容接口（/chat/completions），DeepSeek、OpenRouter、各种中转站都用这个
 * - anthropic：Anthropic Messages 格式（官方 SDK 调用）：Claude 官方 API，以及提供 Anthropic 格式的中转站和厂商
 * - gemini：Google Gemini 原生接口（generateContent）
 */

export type AiProviderKind = 'openai' | 'anthropic' | 'gemini'

export interface AiProfile {
  id: string
  /** 显示名，如“DeepSeek”“中转站 A” */
  name: string
  kind: AiProviderKind
  /** 接口地址；留空时用官方地址（见 DEFAULT_BASE_URL） */
  baseUrl: string
  apiKey: string
  model: string
  /** 最大输出 token；不填时 openai/gemini 不传，anthropic 用 DEFAULT_ANTHROPIC_MAX_TOKENS */
  maxTokens?: number
  /** 思考强度；不填时不传，由模型决定。目前只对 OpenAI 兼容接口生效（reasoning_effort） */
  reasoningEffort?: ReasoningEffort
}

export type ReasoningEffort = 'low' | 'medium' | 'high'

export const DEFAULT_BASE_URL: Record<AiProviderKind, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
}

/** 新建接口时预填的模型；openai 兼容和 gemini 各家模型名差别大，留空让用户从模型列表里选 */
export const DEFAULT_MODEL: Record<AiProviderKind, string> = {
  openai: '',
  anthropic: 'claude-opus-5-5',
  gemini: '',
}

export const DEFAULT_ANTHROPIC_MAX_TOKENS = 64000

export interface AiMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AiRequest {
  system?: string
  messages: AiMessage[]
  /** 要求只输出 JSON：openai 传 response_format，gemini 传 responseMimeType，anthropic 只靠提示词 */
  json?: boolean
  /** 这次请求的思考强度，覆盖接口设置里的（比如小说抽取默认用低强度省钱） */
  reasoningEffort?: ReasoningEffort
  signal?: AbortSignal
  /** 每收到一段文本调用一次；full 是到目前为止的全文 */
  onText?: (delta: string, full: string) => void
}

export type AiFinishReason = 'stop' | 'length' | 'refusal' | 'other'

export interface AiResult {
  text: string
  finishReason: AiFinishReason
}

export type AiErrorKind =
  | 'auth' // key 无效或没权限（401/403）
  | 'not_found' // 地址或模型名不对（404）
  | 'rate_limit' // 限流或额度用完（429）
  | 'bad_request' // 请求参数不被接受（400/422）
  | 'server' // 服务端出错（5xx）
  | 'network' // 连不上：地址错、断网，或接口不允许浏览器跨域访问
  | 'refusal' // 模型拒绝回答
  | 'aborted' // 用户取消
  | 'empty' // 没有返回任何内容
  | 'bad_output' // 返回了内容，但格式不对（比如要 JSON 却解析不出来）
  | 'unknown'

export class AiError extends Error {
  readonly kind: AiErrorKind
  readonly status?: number
  /** 服务端返回的原始错误信息（截断），方便排查 */
  readonly detail?: string

  constructor(kind: AiErrorKind, message: string, options: { status?: number; detail?: string } = {}) {
    super(message)
    this.name = 'AiError'
    this.kind = kind
    this.status = options.status
    this.detail = options.detail
  }
}

export interface AiProvider {
  /** 流式生成，结束后返回全文 */
  stream(profile: AiProfile, request: AiRequest): Promise<AiResult>
  /** 列出可用模型 id（用于设置页选择模型、测试连接） */
  listModels(profile: AiProfile, signal?: AbortSignal): Promise<string[]>
}

/** 去掉地址末尾的斜杠；空地址用官方地址 */
export function resolveBaseUrl(profile: Pick<AiProfile, 'kind' | 'baseUrl'>): string {
  const url = profile.baseUrl.trim() || DEFAULT_BASE_URL[profile.kind]
  return url.replace(/\/+$/, '')
}
