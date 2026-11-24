/**
 * AI 请求用的 fetch，默认是浏览器直连。
 *
 * 网页版在中转站不放行跨域时会失败；桌面版（Tauri）启动时用 setAiFetch 换成原生 HTTP，没有跨域限制。
 * core 不感知运行平台，由入口负责注入。
 */
let current: typeof fetch = (input, init) => fetch(input, init)

export const aiFetch: typeof fetch = (input, init) => current(input, init)

export function setAiFetch(impl: typeof fetch) {
  current = impl
}
