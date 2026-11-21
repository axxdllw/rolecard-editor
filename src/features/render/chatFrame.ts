/**
 * 聊天层 iframe：仿酒馆默认深色主题显示消息，管理前端代码块的子 iframe。
 *
 * 编辑器通过 postMessage 推送消息；按消息比对内容，没变的消息和前端界面不重载。
 * 本层和子 iframe 都不给 allow-same-origin，卡片脚本读不到本应用的数据。
 */

export interface ChatFrameMessage {
  key: string
  /** 内容指纹：相同就不重新渲染 */
  hash: string
  index: number
  name: string
  isUser: boolean
  avatar: string | null
  html: string
  /** 每个前端代码块的完整 iframe 文档 */
  frontends: string[]
}

/** 子 iframe 的 sandbox：和聊天层一致，唯独不给 allow-same-origin */
export const FRAME_SANDBOX = 'allow-scripts allow-modals allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads'

/** 酒馆默认主题（Dark V1.0）里与消息显示相关的样式，变量值取自酒馆 style.css */
const CHAT_CSS = `
:root {
  --SmartThemeBodyColor: rgb(220, 220, 210);
  --SmartThemeEmColor: rgb(145, 145, 145);
  --SmartThemeUnderlineColor: rgb(188, 231, 207);
  --SmartThemeQuoteColor: rgb(225, 138, 36);
  --SmartThemeBlurTintColor: rgba(23, 23, 23, 1);
  --SmartThemeChatTintColor: rgba(23, 23, 23, 1);
  --SmartThemeUserMesBlurTintColor: rgba(0, 0, 0, 0.3);
  --SmartThemeBotMesBlurTintColor: rgba(60, 60, 60, 0.3);
  --SmartThemeBorderColor: rgba(0, 0, 0, 0.5);
  --mainFontSize: 15px;
  --mainFontFamily: "Noto Sans", "Microsoft YaHei", sans-serif;
  --monoFontFamily: "Noto Sans Mono", "Courier New", monospace;
  --black30a: rgba(0, 0, 0, 0.3);
  --black70a: rgba(0, 0, 0, 0.7);
  --white70a: rgba(255, 255, 255, 0.7);
  --mes-right-spacing: 30px;
  --doc-height: 100vh;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--SmartThemeChatTintColor);
  color: var(--SmartThemeBodyColor);
  font-family: var(--mainFontFamily);
  font-size: var(--mainFontSize);
}
#chat { display: flex; flex-direction: column; padding-bottom: 12px; }
#empty { padding: 40px 16px; text-align: center; color: var(--SmartThemeEmColor); }
.mes { display: flex; align-items: flex-start; padding: 10px 10px 0 10px; width: 100%; position: relative; color: var(--SmartThemeBodyColor); }
.mes + .mes { border-top: 1px solid rgba(255, 255, 255, 0.04); }
.mes q:before, .mes q:after { content: ''; }
.mesAvatarWrapper { flex: 0 0 auto; }
.avatar { width: 50px; height: 50px; border-radius: 50%; border: 1px solid var(--SmartThemeBorderColor); box-shadow: 0 0 5px rgba(0,0,0,0.5); object-fit: cover; background: #333; display: flex; align-items: center; justify-content: center; font-weight: 600; color: #ddd; }
.mesIDDisplay { font-size: 12px; color: var(--SmartThemeEmColor); text-align: center; margin-top: 4px; }
.mes_block { padding-left: 10px; width: 100%; min-width: 0; overflow-x: hidden; overflow-y: clip; }
.ch_name { font-weight: 700; display: flex; align-items: baseline; gap: 8px; }
.ch_name small { font-weight: 400; font-size: 12px; color: var(--SmartThemeEmColor); }
.mes_text {
  font-weight: 500;
  line-height: calc(var(--mainFontSize) + .5rem);
  max-width: 100%;
  overflow-wrap: anywhere;
  padding: 5px var(--mes-right-spacing) 5px 0;
}
.mes_text p { margin-top: 0; margin-bottom: 10px; }
.mes_text p:last-child { margin-bottom: 0; }
.mes_text ol, .mes_text ul { margin-top: 5px; margin-bottom: 5px; }
.mes_text table { border-spacing: 0; border-collapse: collapse; margin-bottom: 10px; }
.mes_text td, .mes_text th { border: 1px solid; border-collapse: collapse; padding: 0.25em; }
.mes_text i, .mes_text em { color: var(--SmartThemeEmColor); }
.mes_text q i, .mes_text q em { color: inherit; }
.mes_text u { color: var(--SmartThemeUnderlineColor); }
.mes_text q { color: var(--SmartThemeQuoteColor); }
.mes_text font[color] em, .mes_text font[color] i, .mes_text font[color] u, .mes_text font[color] q { color: inherit; }
.mes_text rp { display: block; }
.mes_text blockquote { border-left: 3px solid var(--SmartThemeQuoteColor); padding-left: 10px; background-color: var(--black30a); margin: 0; }
.mes_text h1, .mes_text h2, .mes_text h3, .mes_text h4, .mes_text h5, .mes_text h6 { font-weight: bold; }
.mes_text hr { opacity: 0.4; }
.mes_text img:not(.mes_img) { max-width: 100%; max-height: var(--doc-height); }
.mes_text pre code { position: relative; display: block; overflow-x: auto; padding: 1em; }
code {
  font-family: var(--monoFontFamily);
  white-space: pre-wrap;
  border: 1px solid var(--SmartThemeBorderColor);
  border-radius: 5px;
  background-color: var(--black70a);
  padding: 0 3px;
  line-height: var(--mainFontSize);
  color: var(--white70a);
}
br { display: block; margin: 2px 0; }
a { color: inherit; }
.TH-render iframe { display: block; width: 100%; border: 0; min-height: 40px; }
`

/** 聊天层的运行时（序列化后注入 iframe，不能引用外部变量） */
function chatRuntime(sandbox: string) {
  type Message = {
    key: string
    hash: string
    index: number
    name: string
    isUser: boolean
    avatar: string | null
    html: string
    frontends: string[]
  }
  const chat = document.getElementById('chat')!
  const rendered = new Map<string, { el: HTMLElement; hash: string }>()
  let viewportHeight = window.innerHeight
  let lastCount = -1
  let pinLast = false

  const postUp = (data: unknown) => window.parent.postMessage(data, '*')

  const createMessage = (m: Message): HTMLElement => {
    const el = document.createElement('div')
    el.className = 'mes'
    el.dataset.key = m.key
    const avatarWrap = document.createElement('div')
    avatarWrap.className = 'mesAvatarWrapper'
    if (m.avatar) {
      const img = document.createElement('img')
      img.className = 'avatar'
      img.src = m.avatar
      img.alt = m.name
      avatarWrap.appendChild(img)
    } else {
      const fallback = document.createElement('div')
      fallback.className = 'avatar'
      fallback.textContent = [...(m.name.trim() || '?')][0]
      avatarWrap.appendChild(fallback)
    }
    const id = document.createElement('div')
    id.className = 'mesIDDisplay'
    id.textContent = `#${m.index}`
    avatarWrap.appendChild(id)

    const block = document.createElement('div')
    block.className = 'mes_block'
    const name = document.createElement('div')
    name.className = 'ch_name'
    name.textContent = m.name
    const text = document.createElement('div')
    text.className = 'mes_text'
    text.innerHTML = m.html
    block.append(name, text)
    el.append(avatarWrap, block)

    for (const holder of Array.from(text.querySelectorAll<HTMLElement>('.TH-render[data-th-index]'))) {
      const i = Number(holder.dataset.thIndex)
      const doc = m.frontends[i]
      if (doc === undefined) continue
      const frame = document.createElement('iframe')
      frame.setAttribute('sandbox', sandbox)
      frame.setAttribute('frameborder', '0')
      frame.dataset.label = `#${m.index} 前端${m.frontends.length > 1 ? ` ${i + 1}` : ''}`
      frame.srcdoc = doc
      holder.appendChild(frame)
    }
    return el
  }

  const render = (messages: Message[]) => {
    const keep = new Set(messages.map((m) => m.key))
    for (const [key, item] of rendered) {
      if (!keep.has(key)) {
        item.el.remove()
        rendered.delete(key)
      }
    }
    let previous: Element | null = null
    for (const m of messages) {
      let item = rendered.get(m.key)
      if (!item || item.hash !== m.hash) {
        const el = createMessage(m)
        if (item) item.el.replaceWith(el)
        item = { el, hash: m.hash }
        rendered.set(m.key, item)
      }
      const expected: Element | null = previous ? previous.nextElementSibling : chat.firstElementChild
      if (expected !== item.el) chat.insertBefore(item.el, expected)
      previous = item.el
    }
    document.getElementById('empty')!.hidden = messages.length > 0
    // 首次渲染或消息条数变化时，定位到最新一条消息的开头；平时编辑保持当前滚动位置
    if (messages.length !== lastCount) {
      lastCount = messages.length
      pinLast = messages.length > 1
      if (pinLast) alignLast()
      else window.scrollTo(0, 0)
    }
  }

  // 前端界面加载完高度会变，用户还没手动滚动时保持对准最新消息
  const alignLast = () => {
    const last = chat.lastElementChild as HTMLElement | null
    if (last) last.scrollIntoView({ block: 'start' })
  }
  for (const type of ['wheel', 'touchmove', 'keydown', 'mousedown']) {
    window.addEventListener(type, () => (pinLast = false), { passive: true })
  }

  const findFrame = (source: MessageEventSource | null) =>
    Array.from(document.querySelectorAll('iframe')).find((f) => f.contentWindow === source) ?? null

  window.addEventListener('message', (e) => {
    const data = e.data as { type?: string; [k: string]: unknown } | null
    if (!data || typeof data !== 'object') return
    if (e.source === window.parent) {
      if (data.type === 'rce-render') render(data.messages as Message[])
      return
    }
    const frame = findFrame(e.source)
    if (!frame) return
    if (data.type === 'rce-frame-height') {
      const h = Number(data.height)
      if (h > 0) {
        frame.style.height = `${Math.ceil(h)}px`
        if (pinLast) alignLast()
      }
    } else if (data.type === 'rce-log') {
      const label = frame.dataset.label || '前端'
      postUp({ type: 'rce-log', level: String(data.level ?? 'info'), text: String(data.text ?? ''), source: label })
    }
  })

  window.addEventListener('resize', () => {
    if (window.innerHeight === viewportHeight) return
    viewportHeight = window.innerHeight
    for (const frame of Array.from(document.querySelectorAll('iframe'))) {
      frame.contentWindow?.postMessage({ type: 'TH_UPDATE_VIEWPORT_HEIGHT', height: viewportHeight }, '*')
    }
  })

  postUp({ type: 'rce-ready' })
}

/** 聊天层 iframe 的文档（不随内容变化，只生成一次） */
export function buildChatFrameDocument(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${CHAT_CSS}</style>
</head>
<body>
<div id="chat"></div>
<div id="empty" hidden>没有可显示的消息</div>
<script>(${chatRuntime.toString()})(${JSON.stringify(FRAME_SANDBOX)})</script>
</body>
</html>
`
}
