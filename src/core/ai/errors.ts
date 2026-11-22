/**
 * 把 HTTP 错误和网络错误转成用户看得懂的 AiError。
 */
import { AiError, type AiErrorKind } from './types'

const DETAIL_LIMIT = 500

/** 从错误响应体里取出说明文字（各家格式不同：{error:{message}}、{error:"..."}、{message}） */
export function extractErrorMessage(body: string): string {
  const text = body.trim()
  if (!text) return ''
  try {
    const json = JSON.parse(text) as unknown
    const pick = (v: unknown): string => {
      if (typeof v === 'string') return v
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>
        return pick(o.message) || pick(o.error) || pick(o.msg) || pick(o.detail)
      }
      return ''
    }
    const picked = Array.isArray(json) ? pick(json[0]) : pick(json)
    if (picked) return picked.slice(0, DETAIL_LIMIT)
  } catch {
    // 不是 JSON，直接用原文
  }
  return text.slice(0, DETAIL_LIMIT)
}

export function httpError(status: number, body: string): AiError {
  const detail = extractErrorMessage(body)
  const suffix = detail ? `（${detail}）` : ''
  let kind: AiErrorKind = 'unknown'
  let message = `接口返回错误 ${status}`
  if (status === 401 || status === 403) {
    kind = 'auth'
    message = 'API key 无效或没有权限'
  } else if (status === 404) {
    kind = 'not_found'
    message = '找不到接口：检查接口地址和模型名'
  } else if (status === 429) {
    kind = 'rate_limit'
    message = '请求太频繁或额度用完了，稍后再试'
  } else if (status === 400 || status === 422) {
    kind = 'bad_request'
    message = '接口不接受这个请求（可能是模型名不对，或参数不被支持）'
  } else if (status >= 500) {
    kind = 'server'
    message = `接口服务出错（${status}），稍后再试`
  }
  return new AiError(kind, `${message}${suffix}`, { status, detail })
}

/** fetch 抛出的异常：取消、跨域或网络问题 */
export function networkError(error: unknown): AiError {
  if (error instanceof AiError) return error
  if (isAbortError(error)) return new AiError('aborted', '已取消')
  const detail = error instanceof Error ? error.message : String(error)
  return new AiError('network', '连不上接口：检查接口地址和网络；也可能是这个接口不允许浏览器直接访问（跨域），需要换一个支持跨域的地址或中转', {
    detail,
  })
}

export function isAbortError(error: unknown): boolean {
  return (error instanceof Error || (typeof error === 'object' && error !== null)) && (error as { name?: string }).name === 'AbortError'
}
