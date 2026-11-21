/**
 * 预览宿主页：仿酒馆默认深色主题显示消息，运行酒馆助手的角色脚本和前端界面。
 *
 * 宿主页用 data: 地址加载，是一个独立的不透明源：
 * - 给 allow-same-origin，里面的子 iframe（srcdoc）继承同一个源，能像在酒馆里一样互相访问；
 * - 编辑器与它不同源，卡片脚本读不到编辑器的数据；
 * - 宿主页和编辑器页都用 CSP 的 frame-src 限制只能加载 data: 框架，防止脚本把框架导航回编辑器的地址。
 */
import { hostRuntime, type HostConfig } from './hostRuntime'

/** 宿主页 iframe 的 sandbox（子 iframe 不设 sandbox，继承这一组） */
export const HOST_SANDBOX = 'allow-scripts allow-same-origin allow-modals allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads'

const CDN = 'https://testingcf.jsdelivr.net'

/** 宿主页（相当于酒馆页面）上的库：脚本 iframe 通过 window.parent 使用 */
const HOST_LIBRARIES = [
  `<link rel="stylesheet" href="${CDN}/npm/@fortawesome/fontawesome-free/css/all.min.css" />`,
  `<link rel="stylesheet" href="${CDN}/npm/toastr/build/toastr.min.css" />`,
  `<script src="${CDN}/npm/jquery/dist/jquery.min.js"></script>`,
  `<script src="${CDN}/npm/jquery-ui/dist/jquery-ui.min.js"></script>`,
  `<script src="${CDN}/npm/lodash/lodash.min.js"></script>`,
  `<script src="${CDN}/npm/toastr/build/toastr.min.js"></script>`,
].join('\n')

/** 酒馆助手暴露的接口名（取自酒馆助手 4.7 的 @types），没有专门模拟的统一记日志并返回空结果 */
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
  'rotateChatMessages setAudioSettings setChatMessages setCurrentCharLorebooks setLorebookEntries setLorebookSettings ' +
  'setPreset stopAllGeneration stopGenerationById substitudeMacros triggerSlash uninjectPrompts uninstallExtension ' +
  'unregisterMacroLike updateCharacterWith updateExtension updateLorebookEntriesWith updatePresetWith updateScriptButtonsWith ' +
  'updateTavernRegexesWith updateVariablesWith updateWorldbookWith waitGlobalInitialized'
).split(' ')

/** 会触发生成、执行命令或改动酒馆其他数据的接口：预览里只记日志不执行 */
const NOT_EXECUTED = [
  'triggerSlash',
  'triggerSlashWithResult',
  'generate',
  'generateRaw',
  'stopAllGeneration',
  'stopGenerationById',
  'injectPrompts',
  'uninjectPrompts',
  'rotateChatMessages',
  'createWorldbookEntries',
  'deleteWorldbookEntries',
  'createLorebookEntries',
  'deleteLorebookEntries',
  'replaceTavernRegexes',
  'updateTavernRegexesWith',
  'rebindCharWorldbooks',
  'rebindChatWorldbook',
]

/** 酒馆事件名（酒馆助手 function/event.ts 的 tavern_events） */
const TAVERN_EVENTS: Record<string, string> = {
  APP_READY: 'app_ready',
  EXTRAS_CONNECTED: 'extras_connected',
  MESSAGE_SWIPED: 'message_swiped',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_EDITED: 'message_edited',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_FILE_EMBEDDED: 'message_file_embedded',
  MESSAGE_REASONING_EDITED: 'message_reasoning_edited',
  MESSAGE_REASONING_DELETED: 'message_reasoning_deleted',
  MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
  MORE_MESSAGES_LOADED: 'more_messages_loaded',
  IMPERSONATE_READY: 'impersonate_ready',
  CHAT_CHANGED: 'chat_id_changed',
  GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
  GENERATION_STARTED: 'generation_started',
  GENERATION_STOPPED: 'generation_stopped',
  GENERATION_ENDED: 'generation_ended',
  SD_PROMPT_PROCESSING: 'sd_prompt_processing',
  EXTENSIONS_FIRST_LOAD: 'extensions_first_load',
  EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
  SETTINGS_LOADED: 'settings_loaded',
  SETTINGS_UPDATED: 'settings_updated',
  MOVABLE_PANELS_RESET: 'movable_panels_reset',
  SETTINGS_LOADED_BEFORE: 'settings_loaded_before',
  SETTINGS_LOADED_AFTER: 'settings_loaded_after',
  CHATCOMPLETION_SOURCE_CHANGED: 'chatcompletion_source_changed',
  CHATCOMPLETION_MODEL_CHANGED: 'chatcompletion_model_changed',
  OAI_PRESET_CHANGED_BEFORE: 'oai_preset_changed_before',
  OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after',
  OAI_PRESET_EXPORT_READY: 'oai_preset_export_ready',
  OAI_PRESET_IMPORT_READY: 'oai_preset_import_ready',
  WORLDINFO_SETTINGS_UPDATED: 'worldinfo_settings_updated',
  WORLDINFO_UPDATED: 'worldinfo_updated',
  CHARACTER_EDITOR_OPENED: 'character_editor_opened',
  CHARACTER_EDITED: 'character_edited',
  CHARACTER_PAGE_LOADED: 'character_page_loaded',
  USER_MESSAGE_RENDERED: 'user_message_rendered',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  FORCE_SET_BACKGROUND: 'force_set_background',
  CHAT_DELETED: 'chat_deleted',
  CHAT_CREATED: 'chat_created',
  GENERATE_BEFORE_COMBINE_PROMPTS: 'generate_before_combine_prompts',
  GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
  GENERATE_AFTER_DATA: 'generate_after_data',
  WORLD_INFO_ACTIVATED: 'world_info_activated',
  TEXT_COMPLETION_SETTINGS_READY: 'text_completion_settings_ready',
  CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
  CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
  CHARACTER_FIRST_MESSAGE_SELECTED: 'character_first_message_selected',
  CHARACTER_DELETED: 'characterDeleted',
  CHARACTER_DUPLICATED: 'character_duplicated',
  CHARACTER_RENAMED: 'character_renamed',
  CHARACTER_RENAMED_IN_PAST_CHAT: 'character_renamed_in_past_chat',
  SMOOTH_STREAM_TOKEN_RECEIVED: 'stream_token_received',
  STREAM_TOKEN_RECEIVED: 'stream_token_received',
  STREAM_REASONING_DONE: 'stream_reasoning_done',
  FILE_ATTACHMENT_DELETED: 'file_attachment_deleted',
  WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate',
  OPEN_CHARACTER_LIBRARY: 'open_character_library',
  ONLINE_STATUS_CHANGED: 'online_status_changed',
  IMAGE_SWIPED: 'image_swiped',
  CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
  CONNECTION_PROFILE_CREATED: 'connection_profile_created',
  CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
  CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
  TOOL_CALLS_PERFORMED: 'tool_calls_performed',
  TOOL_CALLS_RENDERED: 'tool_calls_rendered',
  CHARACTER_MANAGEMENT_DROPDOWN: 'charManagementDropdown',
  SECRET_WRITTEN: 'secret_written',
  SECRET_DELETED: 'secret_deleted',
  SECRET_ROTATED: 'secret_rotated',
  SECRET_EDITED: 'secret_edited',
  PRESET_CHANGED: 'preset_changed',
  PRESET_DELETED: 'preset_deleted',
  PRESET_RENAMED: 'preset_renamed',
  PRESET_RENAMED_BEFORE: 'preset_renamed_before',
  MAIN_API_CHANGED: 'main_api_changed',
  WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
  WORLDINFO_SCAN_DONE: 'worldinfo_scan_done',
  MEDIA_ATTACHMENT_DELETED: 'media_attachment_deleted',
}

const IFRAME_EVENTS: Record<string, string> = {
  MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started',
  MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
  GENERATION_STARTED: 'js_generation_started',
  STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
  STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
  GENERATION_ENDED: 'js_generation_ended',
}

const HOST_CONFIG: HostConfig = {
  apiNames: API_NAMES,
  notExecuted: NOT_EXECUTED,
  tavernEvents: TAVERN_EVENTS,
  iframeEvents: IFRAME_EVENTS,
  thVersion: '4.7.12',
  stVersion: '1.16.0',
  libs: { zod: `${CDN}/npm/zod@4/+esm`, yaml: `${CDN}/npm/yaml@2/+esm` },
}

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
#rce-script-frames { display: none; }
#rce-buttons { position: sticky; bottom: 0; z-index: 10; display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px; background: rgba(23, 23, 23, 0.94); border-top: 1px solid rgba(255, 255, 255, 0.08); }
#rce-buttons[hidden] { display: none; }
.rce-btn, .rce-popup-actions button { font: inherit; font-size: 13px; color: var(--SmartThemeBodyColor); background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 6px; padding: 3px 10px; cursor: pointer; }
.rce-btn:hover, .rce-popup-actions button:hover { background: rgba(255, 255, 255, 0.16); }
.rce-popup { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(0, 0, 0, 0.55); }
.rce-popup-box { display: flex; flex-direction: column; gap: 10px; max-width: min(560px, 100%); max-height: 90vh; overflow: auto; padding: 14px; background: #222; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 10px; }
.rce-popup-box input, .rce-popup-box textarea { width: 100%; padding: 6px; color: inherit; background: #111; border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 6px; }
.rce-popup-actions { display: flex; justify-content: flex-end; gap: 8px; }
`

/** 最先运行：存储替身（不透明源下 localStorage 会抛错），日志转发给编辑器 */
function hostPrelude() {
  const w = window as unknown as Record<string, unknown>
  const memory = (): Storage => {
    const map = new Map<string, string>()
    return {
      get length() {
        return map.size
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(String(k)) ?? null,
      setItem: (k: string, v: string) => void map.set(String(k), String(v)),
      removeItem: (k: string) => void map.delete(String(k)),
      clear: () => map.clear(),
    }
  }
  const storage: Record<string, Storage> = { localStorage: memory(), sessionStorage: memory() }
  w.__rceStorage = storage
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      void w[name]
    } catch {
      try {
        Object.defineProperty(window, name, { value: storage[name], configurable: true })
      } catch {
        // 替换失败时保持原样
      }
    }
  }
  const fmt = (a: unknown): string => {
    if (typeof a === 'string') return a
    if (a && typeof a === 'object' && 'message' in a && 'name' in a) {
      const e = a as { name: unknown; message: unknown }
      return `${String(e.name)}: ${String(e.message)}`
    }
    try {
      return (JSON.stringify(a) ?? String(a)).slice(0, 500)
    } catch {
      return String(a)
    }
  }
  const send = (source: string, level: string, args: unknown[]) => {
    try {
      window.parent.postMessage({ type: 'rce-log', source, level, text: args.map(fmt).join(' ').slice(0, 2000) }, '*')
    } catch {
      // 编辑器不可用时忽略
    }
  }
  w.__rceLog = send
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      send('预览', level, args)
      original(...args)
    }
  }
  window.addEventListener('error', (e) => send('预览', 'error', [`${e.message}${e.lineno ? `（第 ${e.lineno} 行）` : ''}`]))
  window.addEventListener('unhandledrejection', (e) => send('预览', 'error', ['未处理的 Promise 异常：', e.reason]))
}

function buildHostDocument(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="frame-src data:; object-src 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${CHAT_CSS}</style>
<script>(${hostPrelude.toString()})()</script>
${HOST_LIBRARIES}
</head>
<body>
<div id="chat"></div>
<div id="empty" hidden>没有可显示的消息</div>
<div id="rce-buttons" hidden></div>
<div id="rce-script-frames"></div>
<div id="extensions_settings" hidden><div id="tavern_helper"></div></div>
<div id="extensions_settings2" hidden></div>
<div id="extensionsMenu" hidden></div>
<script>(${hostRuntime.toString()})(${JSON.stringify(HOST_CONFIG).replace(/</g, '\\u003c')})</script>
</body>
</html>
`
}

/** 宿主页的 data: 地址（内容不随卡片变化，只生成一次） */
export function hostDocumentUrl(): string {
  const bytes = new TextEncoder().encode(buildHostDocument())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:text/html;charset=utf-8;base64,${btoa(binary)}`
}
