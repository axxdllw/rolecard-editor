/**
 * 酒馆助手 iframe 的文档模板（对照酒馆助手 4.7 的 panel/render/iframe.ts、panel/script/iframe.ts 和 iframe/*.js）。
 *
 * 前端界面和角色脚本的 iframe 都放在预览宿主页（hostFrame）里，与宿主页同源、与编辑器不同源：
 * 和酒馆里一样通过 window.parent 拿到 TavernHelper、SillyTavern、Mvu、jQuery，但读不到编辑器的数据。
 *
 * 下面几个函数会被序列化成字符串注入 iframe，不能引用外部变量。
 */
import { replaceVhInContent } from '@/core/render/frontend'

const CDN = 'https://testingcf.jsdelivr.net'

/** 楼层界面自带的库（酒馆助手 third_party_message.html）；lodash、toastr 由 predefine 从宿主页拿 */
const MESSAGE_LIBRARIES = [
  `<link rel="stylesheet" href="${CDN}/npm/@fortawesome/fontawesome-free/css/all.min.css" />`,
  `<script src="${CDN}/gh/N0VI028/JS-Slash-Runner/lib/tailwindcss.min.js"></script>`,
  `<script src="${CDN}/npm/jquery/dist/jquery.min.js"></script>`,
  `<script src="${CDN}/npm/jquery-ui/dist/jquery-ui.min.js"></script>`,
  `<link rel="stylesheet" href="${CDN}/npm/jquery-ui/themes/base/theme.min.css" />`,
  `<script src="${CDN}/npm/jquery-ui-touch-punch"></script>`,
  `<script src="${CDN}/npm/vue/dist/vue.runtime.global.prod.min.js"></script>`,
  `<script src="${CDN}/npm/vue-router/dist/vue-router.global.prod.min.js"></script>`,
].join('\n')

/** 脚本 iframe 自带的库（酒馆助手 third_party_script.html） */
const SCRIPT_LIBRARIES = [
  `<script src="${CDN}/npm/vue/dist/vue.runtime.global.prod.min.js"></script>`,
  `<script src="${CDN}/npm/vue-router/dist/vue-router.global.prod.min.js"></script>`,
].join('\n')

/** 最先运行：存储替身（不透明源下 localStorage 会抛错）、报错转发给宿主页 */
function childPrelude() {
  const w = window as unknown as Record<string, unknown>
  const host = window.parent as unknown as Record<string, unknown>
  const storage = host.__rceStorage as Record<string, Storage> | undefined
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      void w[name]
    } catch {
      try {
        Object.defineProperty(window, name, { value: storage?.[name], configurable: true })
      } catch {
        // 替换失败时保持原样
      }
    }
  }
  const label = () => (window.frameElement as HTMLElement | null)?.dataset.label || window.name || '前端'
  const send = (level: string, args: unknown[]) => {
    try {
      ;(host.__rceLog as (source: string, level: string, args: unknown[]) => void)(label(), level, args)
    } catch {
      // 宿主页不可用时忽略
    }
  }
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      send(level, args)
      original(...args)
    }
  }
  window.addEventListener(
    'error',
    (e) => {
      const target = e.target as HTMLElement | null
      if (target && target !== (window as unknown as HTMLElement) && 'tagName' in target) {
        send('error', [`资源加载失败：${target.getAttribute('src') ?? target.getAttribute('href') ?? ''}`])
        return
      }
      send('error', [`${e.message}${e.lineno ? `（第 ${e.lineno} 行）` : ''}`])
    },
    true,
  )
  window.addEventListener('unhandledrejection', (e) => send('error', ['未处理的 Promise 异常：', e.reason]))
}

/** 酒馆助手的 predefine.js：从宿主页拿 lodash、TavernHelper 等，_bind 里的接口绑定到本 iframe */
function predefine() {
  type AnyFn = (...args: unknown[]) => unknown
  const w = window as unknown as Record<string, unknown>
  const parent = window.parent as unknown as Record<string, unknown>
  w._ = parent._
  const _ = w._ as Record<string, AnyFn> & AnyFn
  const iframeId = window.frameElement?.id || window.name
  if (iframeId) {
    w.__TH_IFRAME_ID = iframeId
    if (!window.name) window.name = iframeId
  }
  const helper = _.get(parent, 'TavernHelper') as Record<string, unknown> & { _bind: Record<string, AnyFn> }
  let result = _(window) as unknown as { merge: (...args: unknown[]) => typeof result; value: () => unknown }
  result = result.merge(_.pick(parent, ['EjsTemplate', 'TavernHelper', 'YAML', 'showdown', 'toastr', 'z']))
  result = result.merge(_.omit(helper, '_bind'))
  result = result.merge(...Object.entries(helper._bind).map(([key, value]) => ({ [key.replace('_', '')]: value.bind(window) })))
  result.value()

  Object.defineProperty(window, 'SillyTavern', {
    get: () => {
      const st = _.get(parent, 'SillyTavern') as { getContext: () => Record<string, unknown> }
      const thImpl = w._th_impl as Record<string, unknown> | undefined
      const getContext = () => ({ ...st.getContext(), writeExtensionField: thImpl?.writeExtensionField })
      return { ...getContext(), getContext }
    },
    configurable: true,
  })
  if (_.has(parent, 'Mvu')) {
    Object.defineProperty(window, 'Mvu', { get: () => _.get(parent, 'Mvu'), set: () => {}, configurable: true })
  }
  ;((w.$ as AnyFn)(window) as { on: (event: string, fn: () => void) => void }).on('pagehide', () => {
    ;(w.eventClearAll as AnyFn)()
  })
}

/** 酒馆助手的 adjust_viewport.js：--TH-viewport-height 取宿主页高度 */
function adjustViewport() {
  const set = () => document.documentElement.style.setProperty('--TH-viewport-height', `${window.parent.innerHeight}px`)
  set()
  window.addEventListener('message', (e) => {
    if ((e.data as { type?: string } | null)?.type === 'TH_UPDATE_VIEWPORT_HEIGHT') set()
  })
}

/** 酒馆助手的 adjust_iframe_height.js：iframe 随内容撑高 */
function adjustIframeHeight() {
  let scheduled = false
  const measure = () => {
    scheduled = false
    const height = document.body?.scrollHeight ?? 0
    if (!Number.isFinite(height) || height <= 0) return
    const frame = window.frameElement as HTMLElement | null
    if (frame) frame.style.height = `${height}px`
  }
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(measure)
  }
  document.addEventListener('DOMContentLoaded', () => {
    schedule()
    new ResizeObserver(schedule).observe(document.body)
  })
  window.addEventListener('load', schedule)
}

function inline(fn: () => void): string {
  return `<script>(${fn.toString()})()</script>`
}

/** 生成一个前端代码块（楼层界面）的 iframe 文档 */
export function buildFrontendDocument(content: string, charAvatar: string | null): string {
  const avatar = charAvatar ? `url('${charAvatar}')` : 'none'
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
*,*::before,*::after{box-sizing:border-box;}
html,body{margin:0!important;padding:0;overflow:hidden!important;max-width:100%!important;}
.char_avatar,.char-avatar{background-image:${avatar}}
</style>
${inline(childPrelude)}
${MESSAGE_LIBRARIES}
${inline(predefine)}
${inline(adjustViewport)}
${inline(adjustIframeHeight)}
</head>
<body>
${replaceVhInContent(content)}
</body>
</html>
`
}

/** 生成一个角色脚本的 iframe 文档（脚本当作 ES 模块运行，jQuery 用宿主页的，操作的是宿主页） */
export function buildScriptDocument(content: string): string {
  const code = content.match(/^\s*```[^\n]*\n(.*)\n```\s*$/is)?.[1] ?? content
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${inline(childPrelude)}
${SCRIPT_LIBRARIES}
<script>window.$ = window.parent.$; window.jQuery = window.parent.jQuery;</script>
${inline(predefine)}
</head>
<body>
<script type="module">
${code}
</script>
</body>
</html>
`
}
