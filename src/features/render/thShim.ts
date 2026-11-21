/**
 * 酒馆助手前端界面的模拟环境（对照酒馆助手 4.7 的 iframe 模板 createSrcContent 和 predefine.js）。
 *
 * 前端代码块放进 sandbox iframe（不给 allow-same-origin），卡片脚本读不到本应用的数据。
 * 酒馆助手的 iframe 与酒馆同源，脚本常直接用 window.parent.xxx；这里把 window.parent
 * （可替换属性）换成一个假父窗口，带上 TavernHelper、SillyTavern、Mvu 等模拟实现。
 *
 * earlyShim / mainShim 会被序列化成字符串注入 iframe，不能引用外部变量。
 */
import { replaceVhInContent } from '@/core/render/frontend'

/** 酒馆助手暴露的接口名（取自酒馆助手 4.7 的 @types），没有专门模拟的统一记日志并返回 Promise */
const API_NAMES = (
  'appendInexistentScriptButtons builtin createCharacter createChatMessages createLorebook createLorebookEntries createOrReplaceCharacter ' +
  'createOrReplacePreset createOrReplaceWorldbook createPreset createWorldbook createWorldbookEntries deleteCharacter deleteChatMessages ' +
  'deleteLorebook deleteLorebookEntries deletePreset deleteVariable deleteWorldbook deleteWorldbookEntries errorCatched eventClearAll ' +
  'eventClearEvent eventClearListener eventEmit eventEmitAndWait eventMakeFirst eventMakeLast eventOn eventOnButton eventOnce ' +
  'eventRemoveListener formatAsDisplayedMessage formatAsTavernRegexedString generate generateRaw getAllEnabledScriptButtons ' +
  'getAllVariables getAudioList getAudioSettings getButtonEvent getCharAvatarPath getCharData getCharLorebooks getCharWorldbookNames ' +
  'getCharacter getCharacterNames getChatHistoryBrief getChatHistoryDetail getChatLorebook getChatMessages getChatWorldbookName ' +
  'getCurrentCharPrimaryLorebook getCurrentCharacterName getCurrentMessageId getExtensionInstallationInfo getExtensionStatus ' +
  'getExtensionType getGlobalWorldbookNames getIframeName getLastMessageId getLoadedPresetName getLorebookEntries getLorebookSettings ' +
  'getLorebooks getMessageId getModelList getOrCreateChatLorebook getOrCreateChatWorldbook getPreset getPresetNames getScriptButtons ' +
  'getScriptId getScriptInfo getScriptName getTavernHelperExtensionId getTavernHelperVersion getTavernRegexes getTavernVersion ' +
  'getVariables getWorldbook getWorldbookNames importRawCharacter importRawChat importRawPreset importRawTavernRegex importRawWorldbook ' +
  'initializeGlobal injectPrompts insertAudioList insertOrAssignVariables insertVariables installExtension isAdmin ' +
  'isCharacterTavernRegexesEnabled isInstalledExtension isPresetNormalPrompt isPresetPlaceholderPrompt isPresetSystemPrompt loadPreset ' +
  'pauseAudio playAudio rebindCharWorldbooks rebindChatWorldbook rebindGlobalWorldbooks refreshOneMessage registerMacroLike ' +
  'reinstallExtension reloadIframe renamePreset replaceAudioList replaceCharacter replaceLorebookEntries replacePreset ' +
  'replaceScriptButtons replaceScriptInfo replaceTavernRegexes replaceVariables replaceWorldbook retrieveDisplayedMessage ' +
  'rotateChatMessages setAudioSettings setChatLorebook setChatMessages setCurrentCharLorebooks setLorebookEntries setLorebookSettings ' +
  'setPreset stopAllGeneration stopGenerationById substitudeMacros triggerSlash uninjectPrompts uninstallExtension ' +
  'unregisterMacroLike updateCharacterWith updateExtension updateLorebookEntriesWith updatePresetWith updateScriptButtonsWith ' +
  'updateTavernRegexesWith updateVariablesWith updateWorldbookWith waitGlobalInitialized'
).split(' ')

/** 会改动聊天或触发生成的接口：预览里只记日志不执行 */
const NOT_EXECUTED = [
  'triggerSlash',
  'createChatMessages',
  'setChatMessages',
  'deleteChatMessages',
  'rotateChatMessages',
  'generate',
  'generateRaw',
  'stopAllGeneration',
  'stopGenerationById',
  'refreshOneMessage',
  'injectPrompts',
  'uninjectPrompts',
]

/** 与酒馆助手相同的第三方库（酒馆助手从父窗口拿的 lodash、toastr 这里改从 CDN 加载） */
const CDN = 'https://testingcf.jsdelivr.net'
const LIBRARIES = [
  `<link rel="stylesheet" href="${CDN}/npm/@fortawesome/fontawesome-free/css/all.min.css" />`,
  `<script src="${CDN}/gh/N0VI028/JS-Slash-Runner/lib/tailwindcss.min.js"></script>`,
  `<script src="${CDN}/npm/jquery/dist/jquery.min.js"></script>`,
  `<script src="${CDN}/npm/jquery-ui/dist/jquery-ui.min.js"></script>`,
  `<link rel="stylesheet" href="${CDN}/npm/jquery-ui/themes/base/theme.min.css" />`,
  `<script src="${CDN}/npm/jquery-ui-touch-punch"></script>`,
  `<script src="${CDN}/npm/vue/dist/vue.runtime.global.prod.min.js"></script>`,
  `<script src="${CDN}/npm/vue-router/dist/vue-router.global.prod.min.js"></script>`,
  `<script src="${CDN}/npm/lodash/lodash.min.js"></script>`,
  `<link rel="stylesheet" href="${CDN}/npm/toastr/build/toastr.min.css" />`,
  `<script src="${CDN}/npm/toastr/build/toastr.min.js"></script>`,
].join('\n')

export interface PreviewChatMessage {
  message_id: number
  name: string
  role: 'user' | 'assistant'
  is_hidden: boolean
  message: string
}

export interface FrontendEnv {
  iframeName: string
  messageId: number
  lastMessageId: number
  charName: string
  userName: string
  charAvatar: string | null
  /** MVU 的 stat_data */
  variables: Record<string, unknown>
  chat: PreviewChatMessage[]
  /** getCharData 返回的卡片数据（不含世界书） */
  card: Record<string, unknown>
  viewportHeight: number
  apiNames: string[]
  notExecuted: string[]
}

/** 最先运行：记住真正的父窗口，转发报错和资源加载失败 */
function earlyShim() {
  const w = window as unknown as Record<string, unknown>
  const real = window.parent
  w.__rceRealParent = real
  const fmt = (a: unknown): string => {
    if (typeof a === 'string') return a
    if (a instanceof Error) return `${a.name}: ${a.message}`
    try {
      return (JSON.stringify(a) ?? String(a)).slice(0, 500)
    } catch {
      return String(a)
    }
  }
  const log = (level: string, ...args: unknown[]) => {
    try {
      real.postMessage({ type: 'rce-log', level, text: args.map(fmt).join(' ') }, '*')
    } catch {
      // 父窗口不可用时忽略
    }
  }
  w.__rceLog = log
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      log(level, ...args)
      original(...args)
    }
  }
  window.addEventListener(
    'error',
    (e) => {
      const target = e.target as HTMLElement | null
      if (target && target !== (window as unknown as HTMLElement) && 'tagName' in target) {
        const src = target.getAttribute('src') ?? target.getAttribute('href') ?? ''
        log('error', `资源加载失败：${src}`)
        return
      }
      log('error', `${e.message}${e.lineno ? `（第 ${e.lineno} 行）` : ''}`)
    },
    true,
  )
  window.addEventListener('unhandledrejection', (e) => log('error', '未处理的 Promise 异常：', e.reason))
}

/** 酒馆助手接口、SillyTavern、Mvu 的模拟，以及高度上报 */
function mainShim(env: FrontendEnv) {
  type AnyFn = (...args: unknown[]) => unknown
  const w = window as unknown as Record<string, unknown>
  const real = w.__rceRealParent as Window
  const log = w.__rceLog as (level: string, ...args: unknown[]) => void
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v ?? null))

  // 变量：所有类型共用一份，MVU 数据放在 stat_data / display_data 里
  const store: Record<string, unknown> = {
    stat_data: clone(env.variables),
    display_data: clone(env.variables),
    delta_data: {},
    initialized_lorebooks: {},
  }
  const getVariables = () => store
  const replaceVariables = (value: unknown) => {
    for (const key of Object.keys(store)) delete store[key]
    Object.assign(store, value)
    return store
  }
  const mergeVariables = (value: unknown) => {
    const merge = (target: Record<string, unknown>, source: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(source ?? {})) {
        const cur = target[k]
        if (cur && v && typeof cur === 'object' && typeof v === 'object' && !Array.isArray(v)) merge(cur as Record<string, unknown>, v as Record<string, unknown>)
        else target[k] = v
      }
    }
    merge(store, value as Record<string, unknown>)
    return store
  }

  // 事件总线：只在这个 iframe 里生效
  const listeners = new Map<string, AnyFn[]>()
  const eventOn = (type: unknown, fn: unknown) => {
    const key = String(type)
    listeners.set(key, [...(listeners.get(key) ?? []), fn as AnyFn])
    return { stop: () => eventRemoveListener(type, fn) }
  }
  const eventOnce = (type: unknown, fn: unknown) => {
    const wrapped: AnyFn = (...args) => {
      eventRemoveListener(type, wrapped)
      return (fn as AnyFn)(...args)
    }
    return eventOn(type, wrapped)
  }
  const eventRemoveListener = (type: unknown, fn: unknown) => {
    const key = String(type)
    listeners.set(
      key,
      (listeners.get(key) ?? []).filter((f) => f !== fn),
    )
  }
  const eventEmit = async (type: unknown, ...args: unknown[]) => {
    for (const fn of listeners.get(String(type)) ?? []) await fn(...args)
  }

  const resolveId = (id: unknown): number => {
    const n = typeof id === 'string' ? Number(id.replace('{{lastMessageId}}', String(env.lastMessageId))) : Number(id)
    if (!Number.isFinite(n)) return env.lastMessageId
    return n < 0 ? env.lastMessageId + n + 1 : n
  }
  const getChatMessages = (range: unknown) => {
    let from = 0
    let to = env.lastMessageId
    if (typeof range === 'number' || /^-?\d+$/.test(String(range).trim())) {
      from = to = resolveId(range)
    } else if (typeof range === 'string') {
      const m = range.replace(/\{\{lastMessageId\}\}/g, String(env.lastMessageId)).match(/^(-?\d+)\s*-\s*(-?\d+)$/)
      if (m) {
        from = resolveId(m[1])
        to = resolveId(m[2])
      }
    }
    return env.chat
      .filter((c) => c.message_id >= from && c.message_id <= to)
      .map((c) => ({ ...c, data: store, extra: {}, swipe_id: 0, swipes: [c.message], swipes_data: [store] }))
  }
  const substitudeMacros = (text: unknown) =>
    String(text ?? '')
      .replace(/\{\{char\}\}/gi, env.charName)
      .replace(/\{\{user\}\}/gi, env.userName)
      .replace(/\{\{lastMessageId\}\}/gi, String(env.lastMessageId))

  const warned = new Set<string>()
  const stub = (name: string): AnyFn => () => {
    if (!warned.has(name)) {
      warned.add(name)
      log('warn', `调用了预览未模拟的接口 ${name}，已返回空结果`)
    }
    return Promise.resolve(undefined)
  }
  const notExecuted = (name: string): AnyFn => (...args) => {
    const preview = args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(', ')
      .slice(0, 300)
    log('info', `卡片调用了 ${name}(${preview})，预览中不执行`)
    return Promise.resolve('')
  }

  const impl: Record<string, unknown> = {
    getVariables,
    getAllVariables: getVariables,
    replaceVariables,
    insertOrAssignVariables: mergeVariables,
    insertVariables: mergeVariables,
    updateVariablesWith: (updater: unknown) => {
      const next = (updater as AnyFn)(store)
      return next && next !== store ? replaceVariables(next) : store
    },
    deleteVariable: () => ({ variables: store, delete_occurred: false }),
    getCurrentMessageId: () => env.messageId,
    getLastMessageId: () => env.lastMessageId,
    getMessageId: () => env.messageId,
    getIframeName: () => env.iframeName,
    getChatMessages,
    getCharData: () => env.card,
    getCharAvatarPath: () => env.charAvatar ?? '',
    getCurrentCharacterName: () => env.charName,
    getCharacterNames: () => [env.charName],
    substitudeMacros,
    formatAsDisplayedMessage: (text: unknown) => String(text ?? ''),
    formatAsTavernRegexedString: (text: unknown) => String(text ?? ''),
    eventOn,
    eventOnce,
    eventMakeFirst: eventOn,
    eventMakeLast: eventOn,
    eventOnButton: (name: unknown, fn: unknown) => eventOn(`button:${String(name)}`, fn),
    eventRemoveListener,
    eventEmit,
    eventEmitAndWait: eventEmit,
    eventClearEvent: (type: unknown) => listeners.delete(String(type)),
    eventClearListener: (fn: unknown) => {
      for (const [k, list] of listeners) listeners.set(k, list.filter((f) => f !== fn))
    },
    eventClearAll: () => listeners.clear(),
    waitGlobalInitialized: async (name: unknown) => w[String(name)],
    initializeGlobal: (name: unknown, value: unknown) => {
      w[String(name)] = value
    },
    errorCatched:
      (fn: unknown): AnyFn =>
      (...args) => {
        try {
          const result = (fn as AnyFn)(...args)
          if (result && typeof (result as Promise<unknown>).catch === 'function') {
            ;(result as Promise<unknown>).catch((e) => log('error', e))
          }
          return result
        } catch (e) {
          log('error', e)
          return undefined
        }
      },
    getTavernHelperVersion: () => '4.7.12',
    getTavernVersion: () => '1.16.0',
    isAdmin: () => false,
    reloadIframe: () => location.reload(),
  }
  for (const name of env.notExecuted) impl[name] = notExecuted(name)
  for (const name of env.apiNames) if (!(name in impl)) impl[name] = stub(name)
  Object.assign(w, impl)
  w.TavernHelper = { ...impl }

  // 事件名常量：值就是小写的键名（与酒馆一致）
  const lowerKeys = () => new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? k.toLowerCase() : undefined) })
  w.tavern_events = lowerKeys()
  w.iframe_events = lowerKeys()

  w.Mvu = {
    events: {
      VARIABLE_INITIALIZED: 'mag_variable_initiailized',
      VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
      COMMAND_PARSED: 'mag_command_parsed',
      VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
      BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
    },
    getMvuData: getVariables,
    replaceMvuData: async (data: unknown) => {
      replaceVariables(data)
    },
    parseMessage: async (_message: unknown, old: unknown) => old,
    isDuringExtraAnalysis: () => false,
  }

  const chatForSt = env.chat.map((c) => ({ name: c.name, is_user: c.role === 'user', mes: c.message, extra: {}, variables: [store] }))
  const context = {
    name1: env.userName,
    name2: env.charName,
    characterId: 0,
    this_chid: 0,
    characters: [{ name: env.charName, avatar: env.charAvatar ?? '', data: env.card, ...env.card }],
    chat: chatForSt,
    chatMetadata: {},
    extensionSettings: {},
    eventSource: { on: eventOn, once: eventOnce, emit: eventEmit, removeListener: eventRemoveListener },
    eventTypes: w.tavern_events,
    event_types: w.tavern_events,
    substituteParams: substitudeMacros,
    getRequestHeaders: () => ({}),
  }
  w.SillyTavern = { ...context, getContext: () => context }

  // 假父窗口：卡片里 window.parent.xxx 的写法也能拿到模拟接口
  const fakeParent: Record<string, unknown> = {
    ...impl,
    TavernHelper: w.TavernHelper,
    SillyTavern: w.SillyTavern,
    Mvu: w.Mvu,
    tavern_events: w.tavern_events,
    iframe_events: w.iframe_events,
    $: w.$,
    jQuery: w.jQuery,
    _: w._,
    toastr: w.toastr,
    document,
    innerHeight: env.viewportHeight,
    innerWidth: window.innerWidth,
    postMessage: (message: unknown) => real.postMessage(message, '*'),
  }
  fakeParent.window = fakeParent
  fakeParent.parent = fakeParent
  try {
    Object.defineProperty(window, 'parent', { value: fakeParent, configurable: true, writable: true })
  } catch (e) {
    log('warn', '无法替换 window.parent：', e)
  }

  // toastr 提示同时记进日志
  const toastr = w.toastr as Record<string, AnyFn> | undefined
  if (toastr) {
    for (const level of ['info', 'success', 'warning', 'error']) {
      const original = toastr[level]
      if (typeof original !== 'function') continue
      toastr[level] = (...args) => {
        log('info', `toastr.${level}：${args.filter((a) => typeof a === 'string').join(' ')}`)
        return original.apply(toastr, args)
      }
    }
  }

  // min-height 的 vh 换成预览区高度（与酒馆助手的 --TH-viewport-height 一致）
  const setViewport = (h: number) => document.documentElement.style.setProperty('--TH-viewport-height', `${h}px`)
  setViewport(env.viewportHeight)
  window.addEventListener('message', (e) => {
    if (e.source !== real || (e.data as { type?: string })?.type !== 'TH_UPDATE_VIEWPORT_HEIGHT') return
    const h = Number((e.data as { height?: number }).height)
    if (h > 0) {
      setViewport(h)
      fakeParent.innerHeight = h
    }
  })

  // 内容高度变化时上报，由聊天层调整 iframe 高度
  let scheduled = false
  const report = () => {
    scheduled = false
    const height = document.body?.scrollHeight ?? 0
    if (height > 0) real.postMessage({ type: 'rce-frame-height', height }, '*')
  }
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(report)
  }
  document.addEventListener('DOMContentLoaded', () => {
    schedule()
    new ResizeObserver(schedule).observe(document.body)
  })
  window.addEventListener('load', schedule)
}

/** 把 JSON 安全地嵌进 <script> */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

export type FrontendEnvInput = Omit<FrontendEnv, 'apiNames' | 'notExecuted'>

/** 生成一个前端代码块的 iframe 文档 */
export function buildFrontendDocument(content: string, input: FrontendEnvInput): string {
  const env: FrontendEnv = { ...input, apiNames: API_NAMES, notExecuted: NOT_EXECUTED }
  const avatar = env.charAvatar ? `url('${env.charAvatar}')` : 'none'
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
<script>(${earlyShim.toString()})()</script>
${LIBRARIES}
<script>(${mainShim.toString()})(${scriptJson(env)})</script>
</head>
<body>
${replaceVhInContent(content)}
</body>
</html>
`
}
