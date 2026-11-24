import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { setAiFetch } from './core/ai/http'

if (import.meta.env.TAURI_ENV_PLATFORM) {
  // 桌面版 AI 请求走原生 HTTP，绕开中转站的跨域限制
  setAiFetch(async (input, init) => {
    const { fetch: nativeFetch } = await import('@tauri-apps/plugin-http')
    return nativeFetch(input, init)
  })
  // 桌面版的 webview 不会自己开新窗口，外部链接交给系统浏览器
  document.addEventListener(
    'click',
    (event) => {
      const link = (event.target as Element | null)?.closest?.('a[href]')
      if (!(link instanceof HTMLAnchorElement) || !/^(https?:|mailto:)/.test(link.href)) return
      if (link.target !== '_blank' && new URL(link.href).origin === location.origin) return
      event.preventDefault()
      void import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(link.href))
    },
    true,
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
