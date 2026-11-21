/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 预览宿主页的运行时：一个迷你“酒馆页面”（对照酒馆 1.16 和酒馆助手 4.7 的源码）。
 *
 * 宿主页用 data: 地址加载（不透明源），里面的前端界面和角色脚本 iframe 都与它同源，
 * 和在酒馆里一样通过 window.parent 共享 TavernHelper、SillyTavern、Mvu、jQuery；
 * 编辑器与它不同源，卡片脚本读不到编辑器的数据。
 *
 * hostRuntime 会被序列化成字符串注入宿主页，不能引用外部变量。
 */

export interface HostScript {
  id: string
  name: string
  info: string
  button: { enabled: boolean; buttons: Array<{ name: string; visible: boolean }> }
  data: Record<string, unknown>
  /** 完整的 iframe 文档 */
  doc: string
}

export interface HostMessage {
  name: string
  isUser: boolean
  /** 收到时的正文（已跑过“收到时”的正则），即酒馆 chat[i].mes */
  mes: string
  /** 显示用 HTML，前端代码块位置是 <div class="TH-render" data-th-index="n"> */
  html: string
  /** 前端代码块的完整 iframe 文档 */
  frontends: string[]
  avatar: string | null
}

export interface HostSession {
  seq: number
  charName: string
  userName: string
  charAvatar: string | null
  /** getCharData 返回的角色（酒馆角色对象：v1 字段加 data） */
  card: Record<string, unknown>
  /** 角色卡自带的世界书（酒馆世界书格式） */
  world: { name: string; entries: Record<string, unknown> } | null
  characterVariables: Record<string, unknown>
  /** 楼层变量初始值；seedAll 时每层都放一份（没有 MVU 时由预览代为提供） */
  seed: Record<string, unknown> | null
  seedAll: boolean
  scripts: HostScript[]
  /** 带 MVU：等它初始化完变量再模拟后续楼层 */
  mvu: boolean
  messages: HostMessage[]
  /** 上一个宿主页留下的扩展设置（MVU 的设置等），只在第一次会话时使用 */
  extensionSettings: Record<string, unknown> | null
}

export interface HostConfig {
  apiNames: string[]
  notExecuted: string[]
  tavernEvents: Record<string, string>
  iframeEvents: Record<string, string>
  thVersion: string
  stVersion: string
  libs: { zod: string; yaml: string }
}

export function hostRuntime(cfg: HostConfig) {
  type Any = any
  type Fn = (...args: Any[]) => Any
  const w = window as Any
  const _ = w._
  const $ = w.$
  const hostLog = (level: string, ...args: unknown[]) => w.__rceLog('预览', level, args)
  const postUp = (data: unknown) => {
    try {
      window.parent.postMessage(data, '*')
    } catch (e) {
      console.warn('无法发送给编辑器', e)
    }
  }
  const clone = (v: Any): Any => _.cloneDeep(v)
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  const waitUntil = async (cond: () => boolean, timeout = 5000, interval = 50) => {
    const start = Date.now()
    for (;;) {
      try {
        if (cond()) return
      } catch {
        // 条件里读不到数据时当作未满足
      }
      if (Date.now() - start > timeout) throw new Error('timeout')
      await sleep(interval)
    }
  }
  const getOrSet = <K, V>(map: Map<K, V>, key: K, make: () => V): V => {
    if (!map.has(key)) map.set(key, make())
    return map.get(key) as V
  }
  const tavern_events = cfg.tavernEvents
  const iframe_events = cfg.iframeEvents

  // ---------------- 事件总线（酒馆 lib/eventemitter.js） ----------------
  const events: Record<string, Fn[]> = {}
  const autoFireArgs = new Map<string, unknown[]>()
  const AUTO_FIRE = new Set([tavern_events.APP_READY])
  const fireIfDone = (event: string, listener: Fn) => {
    if (AUTO_FIRE.has(event) && autoFireArgs.has(event)) listener.apply(eventSource, autoFireArgs.get(event)!)
  }
  const eventSource = {
    on(event: string, listener: Fn) {
      ;(events[event] ??= []).push(listener)
      fireIfDone(event, listener)
    },
    makeFirst(event: string, listener: Fn) {
      const list = (events[event] ??= [])
      const i = list.indexOf(listener)
      if (i > -1) list.splice(i, 1)
      list.unshift(listener)
      fireIfDone(event, listener)
    },
    makeLast(event: string, listener: Fn) {
      const list = (events[event] ??= [])
      const i = list.indexOf(listener)
      if (i > -1) list.splice(i, 1)
      list.push(listener)
      fireIfDone(event, listener)
    },
    removeListener(event: string, listener: Fn) {
      const list = events[event]
      if (!list) return
      const i = list.indexOf(listener)
      if (i > -1) list.splice(i, 1)
    },
    async emit(event: string, ...args: unknown[]) {
      for (const listener of [...(events[event] ?? [])]) {
        try {
          await listener.apply(eventSource, args)
        } catch (e) {
          hostLog('error', `事件 ${event} 的监听器出错：`, e)
        }
      }
      if (AUTO_FIRE.has(event)) autoFireArgs.set(event, args)
    },
    emitAndWait(event: string, ...args: unknown[]) {
      for (const listener of [...(events[event] ?? [])]) {
        try {
          listener.apply(eventSource, args)
        } catch (e) {
          hostLog('error', `事件 ${event} 的监听器出错：`, e)
        }
      }
      if (AUTO_FIRE.has(event)) autoFireArgs.set(event, args)
    },
    once(event: string, listener: Fn) {
      const g = function (this: Any, ...args: Any[]) {
        eventSource.removeListener(event, g)
        return listener.apply(this, args)
      }
      eventSource.on(event, g)
    },
  }
  /** 等其中任一事件触发，超时返回 false */
  const waitForEvent = (names: string[], timeout: number) =>
    new Promise<boolean>((resolve) => {
      const done = (result: boolean) => {
        clearTimeout(timer)
        for (const name of names) eventSource.removeListener(name, onEvent)
        resolve(result)
      }
      const timer = setTimeout(() => done(false), timeout)
      const onEvent = () => done(true)
      for (const name of names) eventSource.on(name, onEvent)
    })

  // ---------------- 状态 ----------------
  const chat: Any[] = []
  let chatId = ''
  let chatMetadata: Any = { variables: {} }
  let session: HostSession | null = null
  let extensionSettings: Any = { variables: { global: {} } }
  let characterVariables: Any = {}
  let presetVariables: Any = {}
  let worldEntries: Record<string, Any> = {}
  let bookName: string | null = null
  const lorebookSettings: Any = {
    selected_global_lorebooks: [],
    scan_depth: 2,
    context_percentage: 100,
    budget_cap: 0,
    min_activations: 0,
    max_depth: 0,
    max_recursion_steps: 0,
    insertion_strategy: 'character_first',
    include_names: false,
    recursive: true,
    case_sensitive: false,
    match_whole_words: false,
    use_group_scoring: false,
    overflow_alert: false,
  }
  const scriptRuntimes = new Map<string, Any>()
  const macroLikes: Any[] = []
  const variableSchemas: Any = {}

  const scheduleState = _.debounce(() => {
    try {
      const latest = chat.at(-1)
      const variables = latest?.variables?.[latest?.swipe_id ?? 0] ?? {}
      postUp({ type: 'rce-state', messageId: chat.length - 1, variables: JSON.parse(JSON.stringify(variables)) })
    } catch (e) {
      hostLog('warn', '变量无法序列化：', e)
    }
  }, 200)
  const saveSettings = _.debounce(() => {
    try {
      postUp({ type: 'rce-settings', extensionSettings: JSON.parse(JSON.stringify(extensionSettings)) })
    } catch {
      // 有函数等无法序列化的内容时不保存
    }
  }, 500)

  // ---------------- iframe 身份（酒馆助手 function/util.ts） ----------------
  function getIframeName(this: Any): string {
    const frame = this.frameElement as Element | null
    const cached = this.__TH_IFRAME_ID || this.name
    if (frame?.id) {
      this.__TH_IFRAME_ID = frame.id
      if (!this.name) this.name = frame.id
      return frame.id
    }
    if (cached) return cached
    throw new TypeError('frameElement is null while resolving iframe id')
  }
  function getScriptId(this: Any): string {
    const name = getIframeName.call(this)
    if (!name.startsWith('TH-script--')) throw new Error('你只能在脚本 iframe 内获取 getScriptId!')
    return name.replace(/TH-script--.+--/, '')
  }
  function getMessageId(name: string): number {
    const match = name.match(/^TH-message--(\d+)--\d+(_\d+)?$/)
    if (!match) throw Error(`获取 ${name} 所在楼层 id 时出错: 不要对全局脚本 iframe 调用 getMessageId!`)
    return parseInt(match[1])
  }
  function getCurrentMessageId(this: Any): number {
    return getMessageId(getIframeName.call(this))
  }

  // ---------------- 宏（只做常用的几个） ----------------
  function substitudeMacros(text: unknown): string {
    return String(text ?? '')
      .replace(/\{\{\/\/[\s\S]*?\}\}/g, '')
      .replace(/\{\{char\}\}/gi, session?.charName ?? '')
      .replace(/\{\{user\}\}/gi, session?.userName ?? '')
      .replace(/\{\{lastMessageId\}\}/gi, String(chat.length - 1))
      .replace(/\{\{lastMessage\}\}/gi, chat.at(-1)?.mes ?? '')
      .replace(/\{\{newline\}\}/gi, '\n')
  }
  const getLastMessageId = () => chat.length - 1

  // ---------------- 变量（酒馆助手 function/variables.ts） ----------------
  function getVariablesWithoutClone(option: Any): Any {
    switch (option.type) {
      case 'message': {
        const latest = option.message_id === undefined || option.message_id === 'latest'
        const id = latest ? -1 : option.message_id
        if (!_.inRange(id, -chat.length, chat.length)) {
          throw Error(`提供的消息楼层号 '${option.message_id}' 超出了范围 [${-chat.length}, ${chat.length})`)
        }
        const m = latest ? chat.filter((c) => !c.is_system).at(id) : chat.at(id)
        return m?.variables?.[m?.swipe_id ?? 0] ?? {}
      }
      case 'chat':
        return _.get(chatMetadata, 'variables', {})
      case 'character':
        return characterVariables
      case 'preset':
        return presetVariables
      case 'global':
        return extensionSettings.variables.global
      case 'script':
        if (!option.script_id) throw Error('获取变量失败, 未指定 script_id')
        return scriptRuntimes.get(option.script_id)?.data ?? {}
      case 'extension':
        return _.get(extensionSettings, option.extension_id, {})
    }
    return {}
  }
  const getVariables = (option: Any = { type: 'chat' }) => clone(getVariablesWithoutClone(option))
  function replaceVariables(variables: Any, option: Any = { type: 'chat' }) {
    switch (option.type) {
      case 'message': {
        const id = option.message_id === undefined || option.message_id === 'latest' ? -1 : option.message_id
        if (!_.inRange(id, -chat.length, chat.length)) {
          throw Error(`提供的消息楼层号 '${option.message_id}' 超出了范围 (${-chat.length}, ${chat.length})`)
        }
        const m = chat.at(id)
        if (!_.has(m, 'variables')) _.set(m, 'variables', _.times(m.swipes?.length ?? 1, _.constant({})))
        if (_.isPlainObject(m.variables)) m.variables = _.range(0, m.swipes?.length ?? 1).map((i: number) => m.variables[i] ?? {})
        _.set(m, ['variables', _.get(m, 'swipe_id', 0)], variables)
        break
      }
      case 'chat':
        _.set(chatMetadata, 'variables', variables)
        break
      case 'character':
        characterVariables = variables
        break
      case 'preset':
        presetVariables = variables
        break
      case 'global':
        _.set(extensionSettings.variables, 'global', variables)
        saveSettings()
        break
      case 'script': {
        if (!option.script_id) throw Error('保存变量失败, 未指定 script_id')
        const s = scriptRuntimes.get(option.script_id)
        if (s) s.data = variables
        break
      }
      case 'extension':
        _.set(extensionSettings, option.extension_id, variables)
        saveSettings()
        break
    }
    scheduleState()
  }
  function updateVariablesWith(updater: Fn, option: Any = { type: 'chat' }) {
    const result = updater(getVariables(option))
    if (result && typeof result.then === 'function') {
      return result.then((r: Any) => {
        replaceVariables(r, option)
        return r
      })
    }
    replaceVariables(result, option)
    return result
  }
  const keepArrays = (_l: unknown, r: unknown) => (Array.isArray(r) ? r : undefined)
  const insertOrAssignVariables = (variables: Any, option: Any = { type: 'chat' }) =>
    updateVariablesWith((old: Any) => _.mergeWith(old, variables, keepArrays), option)
  const insertVariables = (variables: Any, option: Any = { type: 'chat' }) =>
    updateVariablesWith((old: Any) => _.mergeWith({}, variables, old, keepArrays), option)
  function deleteVariable(path: string, option: Any = { type: 'chat' }) {
    let deleted = false
    const variables = updateVariablesWith((old: Any) => {
      deleted = _.unset(old, path)
      return old
    }, option)
    return { variables, delete_occurred: deleted }
  }
  const scriptOption = (self: Any, option: Any) => (option?.type === 'script' ? { type: 'script', script_id: getScriptId.call(self) } : option)
  function _getAllVariables(this: Any) {
    const isMessage = getIframeName.call(this).startsWith('TH-message')
    let result = _({})
    result = result.assign(getVariablesWithoutClone({ type: 'global' }), getVariablesWithoutClone({ type: 'character' }))
    if (!isMessage) result = result.assign(getVariablesWithoutClone({ type: 'script', script_id: getScriptId.call(this) }))
    result = result.assign(getVariablesWithoutClone({ type: 'chat' }))
    if (isMessage) {
      result = result.assign(...chat.slice(0, getCurrentMessageId.call(this) + 1).map((m: Any) => m?.variables?.[m?.swipe_id ?? 0]))
    }
    return clone(result.value())
  }

  // ---------------- 事件接口（酒馆助手 function/event.ts） ----------------
  const wrapperMaps = new Map<string, Map<string, Map<Fn, Fn>>>()
  const NUMERIC_FIRST_ARG = new Set([
    tavern_events.MESSAGE_SWIPED,
    tavern_events.MESSAGE_SENT,
    tavern_events.MESSAGE_RECEIVED,
    tavern_events.MESSAGE_EDITED,
    tavern_events.MESSAGE_UPDATED,
    tavern_events.USER_MESSAGE_RENDERED,
    tavern_events.CHARACTER_MESSAGE_RENDERED,
  ])
  function listenerMap(self: Any, event: string) {
    const byEvent = getOrSet(wrapperMaps, getIframeName.call(self), () => new Map<string, Map<Fn, Fn>>())
    return getOrSet(byEvent, event, () => new Map<Fn, Fn>())
  }
  function registerWrapper(self: Any, event: string, listener: Fn, once = false): Fn {
    const map = listenerMap(self, event)
    return getOrSet(map, listener, () => {
      const wrapper = (...args: Any[]) => {
        if (!listenerMap(self, event).has(listener)) {
          eventSource.removeListener(event, wrapper)
          return
        }
        if (NUMERIC_FIRST_ARG.has(event)) {
          args[0] = parseInt(args[0])
          if (isNaN(args[0])) return
        }
        const result = listener(...args)
        if (once) _eventRemoveListener.call(self, event, listener)
        return result
      }
      return wrapper
    })
  }
  const stopper = (self: Any, event: string, listener: Fn) => ({ stop: () => _eventRemoveListener.call(self, event, listener) })
  function _eventOn(this: Any, event: string, listener: Fn) {
    eventSource.on(event, registerWrapper(this, event, listener))
    return stopper(this, event, listener)
  }
  function _eventMakeLast(this: Any, event: string, listener: Fn) {
    eventSource.makeLast(event, registerWrapper(this, event, listener))
    return stopper(this, event, listener)
  }
  function _eventMakeFirst(this: Any, event: string, listener: Fn) {
    eventSource.makeFirst(event, registerWrapper(this, event, listener))
    return stopper(this, event, listener)
  }
  function _eventOnce(this: Any, event: string, listener: Fn) {
    eventSource.once(event, registerWrapper(this, event, listener, true))
    return stopper(this, event, listener)
  }
  async function _eventEmit(this: Any, event: string, ...args: Any[]) {
    await eventSource.emit(event, ...args)
  }
  function _eventEmitAndWait(this: Any, event: string, ...args: Any[]) {
    eventSource.emitAndWait(event, ...args)
  }
  function _eventRemoveListener(this: Any, event: string, listener: Fn) {
    const map = listenerMap(this, event)
    const wrapper = map.get(listener)
    if (wrapper) {
      map.delete(listener)
      eventSource.removeListener(event, wrapper)
    }
  }
  function _eventClearEvent(this: Any, event: string) {
    listenerMap(this, event).forEach((_w, listener) => _eventRemoveListener.call(this, event, listener))
  }
  function _eventClearListener(this: Any, listener: Fn) {
    getOrSet(wrapperMaps, getIframeName.call(this), () => new Map<string, Map<Fn, Fn>>()).forEach((_l, event) => _eventRemoveListener.call(this, event, listener))
  }
  function _eventClearAll(this: Any) {
    getOrSet(wrapperMaps, getIframeName.call(this), () => new Map<string, Map<Fn, Fn>>()).forEach((listeners, event) => {
      listeners.forEach((_w, listener) => _eventRemoveListener.call(this, event, listener))
    })
  }

  // ---------------- 全局对象（酒馆助手 function/global.ts） ----------------
  function initializeGlobal(global: string, value: unknown) {
    _.set(window, global, value)
    void eventSource.emit(`global_${global}_initialized`)
  }
  function _initializeGlobal(this: Any, global: string, value: unknown) {
    _.set(window, global, value)
    void _eventEmit.call(this, `global_${global}_initialized`)
  }
  const mvuReady = async (global: string) => {
    if (global !== 'Mvu') return
    try {
      await waitUntil(() => _.has(getVariablesWithoutClone({ type: 'message', message_id: 0 }), 'stat_data'))
    } catch {
      // 只是作为保险，超时就不等了
    }
  }
  async function waitGlobalInitialized(global: string) {
    if (_.has(window, global)) return
    await new Promise<void>((resolve) => eventSource.once(`global_${global}_initialized`, () => resolve()))
  }
  async function _waitGlobalInitialized(this: Any, global: string) {
    const define = () => Object.defineProperty(this, global, { get: () => _.get(window, global), configurable: true })
    if (_.has(window, global)) {
      define()
      await mvuReady(global)
      return
    }
    await new Promise<void>((resolve) => {
      _eventOnce.call(this, `global_${global}_initialized`, async () => {
        define()
        await mvuReady(global)
        resolve()
      })
    })
  }

  // ---------------- 脚本按钮（酒馆助手 function/script.ts） ----------------
  function getStringHash(str: string, seed = 0) {
    let h1 = 0xdeadbeef ^ seed
    let h2 = 0x41c6ce57 ^ seed
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i)
      h1 = Math.imul(h1 ^ ch, 2654435761)
      h2 = Math.imul(h2 ^ ch, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return 4294967296 * (2097151 & h2) + (h1 >>> 0)
  }
  const getButtonId = (scriptId: string, name: string) => `${scriptId}_${getStringHash(name)}`
  const currentScript = (self: Any) => scriptRuntimes.get(getScriptId.call(self))
  function _getButtonEvent(this: Any, name: string) {
    return getButtonId(String(getScriptId.call(this)), name)
  }
  function _getScriptButtons(this: Any) {
    return clone(currentScript(this)?.button.buttons ?? [])
  }
  function _replaceScriptButtons(this: Any, p1: Any, p2?: Any) {
    const script = currentScript(this)
    if (!script) return
    const next = typeof p1 === 'string' ? p2 : p1
    if (!_.isEqual(script.button.buttons, next)) {
      script.button.buttons = clone(next)
      renderButtons()
    }
  }
  function _updateScriptButtonsWith(this: Any, updater: Fn) {
    const result = updater(_getScriptButtons.call(this))
    if (result && typeof result.then === 'function') {
      return result.then((r: Any) => {
        _replaceScriptButtons.call(this, r)
        return r
      })
    }
    _replaceScriptButtons.call(this, result)
    return result
  }
  function _appendInexistentScriptButtons(this: Any, p1: Any, p2?: Any) {
    const added = typeof p1 === 'string' ? p2 : p1
    return _updateScriptButtonsWith.call(this, (buttons: Any[]) => [...buttons, ...added.filter((b: Any) => !buttons.some((x) => x.name === b.name))])
  }
  function getAllEnabledScriptButtons() {
    const result: Any = {}
    for (const s of scriptRuntimes.values()) {
      if (!s.button.enabled) continue
      const visible = s.button.buttons.filter((b: Any) => b.visible)
      if (visible.length) result[s.id] = visible.map((b: Any) => ({ button_id: getButtonId(s.id, b.name), button_name: b.name }))
    }
    return result
  }

  // ---------------- 聊天消息（酒馆助手 function/chat_message.ts） ----------------
  function stringToRange(input: string, min: number, max: number) {
    const clamp = (v: number) => _.clamp(v < 0 ? max + v + 1 : v, min, max)
    let start: number
    let end: number
    if (/^(-?\d+)$/.test(input)) {
      start = end = clamp(Number(input))
    } else {
      const match = input.match(/^(-?\d+)-(-?\d+)$/)
      if (!match) return null
      ;[start, end] = _.sortBy([match[1], match[2]].map(Number).map(clamp))
    }
    if (isNaN(start) || isNaN(end)) return null
    return { start, end }
  }
  const roleOf = (m: Any) => (m.extra?.type === 'narrator' ? (m.is_user ? 'unknown' : 'system') : m.is_user ? 'user' : 'assistant')
  function getChatMessages(range: string | number, { role = 'all', hide_state = 'all', include_swipes = false }: Any = {}) {
    const r = stringToRange(substitudeMacros(range.toString()), 0, chat.length - 1)
    if (!r) return []
    const result: Any[] = []
    for (let id = r.start; id <= r.end; id++) {
      const m = chat[id]
      if (!m) continue
      const messageRole = roleOf(m)
      if (role !== 'all' && messageRole !== role) continue
      if (hide_state !== 'all' && (hide_state === 'hidden') !== !!m.is_system) continue
      const swipeId = m.swipe_id ?? 0
      const length = (m.swipes ?? [m.mes]).length
      const swipes = _.range(0, length).map((i: number) => (m.swipes ?? [m.mes])[i] ?? '')
      const swipesData = _.range(0, length).map((i: number) => (m.variables ?? [{}])[i] ?? {})
      const swipesInfo = _.range(0, length).map((i: number) => (m.swipe_info ?? [m.extra ?? {}])[i] ?? {})
      if (include_swipes) {
        result.push({ message_id: id, name: m.name, role: messageRole, is_hidden: !!m.is_system, swipe_id: swipeId, swipes, swipes_data: swipesData, swipes_info: swipesInfo })
      } else {
        result.push({
          message_id: id,
          name: m.name,
          role: messageRole,
          is_hidden: !!m.is_system,
          message: m.mes ?? '',
          data: swipesData[swipeId],
          extra: swipesInfo[swipeId],
          swipe_id: swipeId,
          swipes,
          swipes_data: swipesData,
        })
      }
    }
    return clone(result)
  }
  const editedNotified = new Set<number>()
  function noteEdited(id: number) {
    if (editedNotified.has(id)) return
    editedNotified.add(id)
    hostLog('info', `脚本修改了第 ${id} 楼的正文，预览暂不按新正文重新排版`)
  }
  const normalizeId = (id: number) => (id < 0 ? chat.length + id : id)
  async function setChatMessages(list: Any[], _options: Any = {}) {
    const merged = _(list)
      .map((m: Any) => ({ ...m, message_id: normalizeId(m.message_id) }))
      .sortBy('message_id')
      .groupBy('message_id')
      .map((group: Any[]) => group.reduce((a, b) => ({ ...a, ...b }), {}))
      .value()
    for (const patch of merged) {
      const m = chat[patch.message_id]
      if (!m) continue
      if (_.isPlainObject(m.variables)) m.variables = _.range(0, m.swipes?.length ?? 1).map((i: number) => m.variables[i] ?? {})
      if (patch.name !== undefined) m.name = patch.name
      if (patch.role !== undefined) {
        m.is_user = patch.role === 'user'
        if (patch.role === 'system') _.set(m, 'extra.type', 'narrator')
        else _.unset(m, 'extra.type')
      }
      if (patch.is_hidden !== undefined) m.is_system = patch.is_hidden
      if (_.has(patch, 'message') || _.has(patch, 'data')) {
        if (patch.message !== undefined && patch.message !== m.mes) {
          m.mes = patch.message
          if (m.swipes) m.swipes[m.swipe_id ?? 0] = patch.message
          noteEdited(patch.message_id)
        }
        if (patch.data !== undefined) {
          if (m.variables === undefined) m.variables = _.times(m.swipes?.length ?? 1, _.constant({}))
          _.set(m, ['variables', m.swipe_id ?? 0], patch.data)
        }
        if (patch.extra !== undefined) m.extra = patch.extra
      } else if (patch.swipe_id !== undefined || patch.swipes !== undefined || patch.swipes_data !== undefined) {
        const length = _.max([patch.swipes?.length, patch.swipes_data?.length, patch.swipes_info?.length]) ?? m.swipes?.length ?? 1
        const swipes = patch.swipes ?? m.swipes ?? [m.mes]
        const data = patch.swipes_data ?? m.variables ?? [{}]
        m.swipe_id = _.clamp(patch.swipe_id ?? m.swipe_id ?? 0, 0, length - 1)
        m.swipes = _.range(0, length).map((i: number) => swipes[i] ?? '')
        m.variables = _.range(0, length).map((i: number) => data[i] ?? {})
        m.mes = m.swipes[m.swipe_id]
      }
    }
    scheduleState()
  }
  async function setChatMessage(fields: Any, messageId: number) {
    const values = typeof fields === 'string' ? { message: fields } : fields
    await setChatMessages([{ message_id: messageId, ...values }])
  }
  function makeChatMessage(source: { name: string; isUser: boolean; mes: string }, variables: Any) {
    return {
      name: source.name,
      is_user: source.isUser,
      is_system: false,
      send_date: new Date().toISOString(),
      mes: source.mes,
      extra: {},
      swipe_id: 0,
      swipes: [source.mes],
      swipe_info: [{}],
      variables: [variables ? clone(variables) : {}],
    }
  }
  async function createChatMessages(list: Any[], { insert_at, insert_before = 'end' }: Any = {}) {
    let at = insert_at ?? insert_before
    at = at === 'end' ? chat.length : _.clamp(at < 0 ? chat.length + at : at, 0, chat.length)
    const created = list.map((m: Any) => {
      const message = makeChatMessage(
        { name: m.name ?? (m.role === 'user' ? session?.userName : session?.charName) ?? '', isUser: m.role === 'user', mes: m.message ?? '' },
        m.data ?? {},
      )
      if (m.is_hidden) message.is_system = true
      return message
    })
    chat.splice(at, 0, ...created)
    hostLog('info', `卡片新建了 ${created.length} 条消息（只更新数据，预览不显示）`)
    scheduleState()
  }
  async function deleteChatMessages(ids: number[]) {
    const set = new Set(ids.map(normalizeId))
    for (let i = chat.length - 1; i >= 0; i--) if (set.has(i)) chat.splice(i, 1)
    hostLog('info', `卡片删除了消息：${[...set].join(', ')}（只更新数据，预览不显示）`)
    scheduleState()
  }

  // ---------------- 世界书（酒馆助手 function/lorebook_entry.ts、worldbook.ts） ----------------
  const POSITION_NAMES: Record<number, string> = {
    0: 'before_character_definition',
    1: 'after_character_definition',
    5: 'before_example_messages',
    6: 'after_example_messages',
    2: 'before_author_note',
    3: 'after_author_note',
  }
  const LOGIC_NAMES: Record<number, string> = { 0: 'and_any', 1: 'not_all', 2: 'not_any', 3: 'and_all' }
  const sortedEntries = () => _.sortBy(Object.values(worldEntries), 'displayIndex')
  const checkBook = (name: string) => {
    if (!bookName || name !== bookName) throw Error(`未能找到世界书 '${name}'`)
  }
  const toLorebookEntry = (e: Any) => ({
    uid: e.uid,
    display_index: e.displayIndex,
    comment: e.comment,
    enabled: !e.disable,
    type: e.constant ? 'constant' : e.vectorized ? 'vectorized' : 'selective',
    position: POSITION_NAMES[e.position] ?? (e.role === 1 ? 'at_depth_as_user' : e.role === 2 ? 'at_depth_as_assistant' : 'at_depth_as_system'),
    depth: e.position === 4 ? e.depth : null,
    order: e.order,
    probability: e.probability,
    key: e.key,
    keys: e.key,
    logic: LOGIC_NAMES[e.selectiveLogic],
    filter: e.keysecondary,
    filters: e.keysecondary,
    scan_depth: e.scanDepth ?? 'same_as_global',
    case_sensitive: e.caseSensitive ?? 'same_as_global',
    match_whole_words: e.matchWholeWords ?? 'same_as_global',
    use_group_scoring: e.useGroupScoring ?? 'same_as_global',
    automation_id: e.automationId || null,
    exclude_recursion: e.excludeRecursion,
    prevent_recursion: e.preventRecursion,
    delay_until_recursion: e.delayUntilRecursion,
    content: e.content,
    group: e.group,
    group_prioritized: e.groupOverride,
    group_weight: e.groupWeight,
    sticky: e.sticky || null,
    cooldown: e.cooldown || null,
    delay: e.delay || null,
  })
  const toWorldbookEntry = (e: Any) => ({
    uid: e.uid,
    name: e.comment,
    enabled: !e.disable,
    strategy: {
      type: e.constant ? 'constant' : e.vectorized ? 'vectorized' : 'selective',
      keys: e.key ?? [],
      keys_secondary: { logic: LOGIC_NAMES[e.selectiveLogic] ?? 'and_any', keys: e.keysecondary ?? [] },
      scan_depth: e.scanDepth ?? 'same_as_global',
    },
    position: {
      type: e.position === 4 ? 'at_depth' : (POSITION_NAMES[e.position] ?? 'after_character_definition'),
      role: ({ 0: 'system', 1: 'user', 2: 'assistant' } as Record<number, string>)[e.role ?? 0],
      depth: e.depth,
      order: e.order,
    },
    content: e.content,
    probability: e.useProbability === false ? 100 : e.probability,
    recursion: {
      prevent_incoming: !!e.excludeRecursion,
      prevent_outgoing: !!e.preventRecursion,
      delay_until: typeof e.delayUntilRecursion === 'number' && e.delayUntilRecursion > 0 ? e.delayUntilRecursion : null,
    },
    effect: {
      sticky: e.sticky > 0 ? e.sticky : null,
      cooldown: e.cooldown > 0 ? e.cooldown : null,
      delay: e.delay > 0 ? e.delay : null,
    },
    extra: e.extra,
  })
  let worldbookWriteNoted = false
  const noteWorldbookWrite = () => {
    if (worldbookWriteNoted) return
    worldbookWriteNoted = true
    hostLog('info', '卡片在预览中修改了世界书（只改预览里的副本，不写回卡片）')
  }
  /** 把新接口的条目（WorldbookEntry）写回酒馆格式，只处理常用字段 */
  function applyWorldbookEntries(list: Any[], replaceAll: boolean) {
    const next: Record<string, Any> = replaceAll ? {} : { ...worldEntries }
    list.forEach((entry: Any, index: number) => {
      const uid = entry.uid ?? (_.max(Object.values(next).map((e: Any) => e.uid)) ?? -1) + 1
      const base = clone(worldEntries[uid] ?? { uid, key: [], keysecondary: [], comment: '', content: '', disable: false, order: 100, position: 1, depth: 4 })
      if (entry.name !== undefined) base.comment = entry.name
      if (entry.comment !== undefined) base.comment = entry.comment
      if (entry.enabled !== undefined) base.disable = !entry.enabled
      if (entry.content !== undefined) base.content = entry.content
      if (entry.strategy?.type !== undefined) {
        base.constant = entry.strategy.type === 'constant'
        base.vectorized = entry.strategy.type === 'vectorized'
      }
      if (entry.strategy?.keys !== undefined) base.key = entry.strategy.keys.map(String)
      if (entry.keys !== undefined) base.key = entry.keys.map(String)
      if (entry.position?.order !== undefined) base.order = entry.position.order
      if (replaceAll) base.displayIndex = index
      next[String(uid)] = base
    })
    worldEntries = next
    noteWorldbookWrite()
  }
  async function getLorebookEntries(name: string, { filter = 'none' }: Any = {}) {
    checkBook(name)
    let list = sortedEntries().map(toLorebookEntry)
    if (filter !== 'none') {
      list = list.filter((e: Any) =>
        Object.entries(filter).every(([k, v]) => (typeof e[k] === 'string' && typeof v === 'string' ? e[k].includes(v) : _.isEqual(e[k], v))),
      )
    }
    return clone(list)
  }
  async function getWorldbook(name: string) {
    checkBook(name)
    return clone(sortedEntries().map(toWorldbookEntry))
  }
  async function replaceWorldbook(name: string, list: Any[]) {
    checkBook(name)
    applyWorldbookEntries(list, true)
  }
  async function updateWorldbookWith(name: string, updater: Fn) {
    await replaceWorldbook(name, await updater(await getWorldbook(name)))
    return getWorldbook(name)
  }
  async function setLorebookEntries(name: string, list: Any[]) {
    checkBook(name)
    applyWorldbookEntries(list, false)
  }
  const charLorebooks = () => ({ primary: bookName, additional: [] as string[] })
  function loadWorldInfo(name: string) {
    return Promise.resolve(name === bookName ? { entries: clone(worldEntries) } : null)
  }

  // ---------------- 弹窗（酒馆 popup.js 的最小实现） ----------------
  const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 }
  const POPUP_RESULT: Any = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null, CUSTOM1: 1001, CUSTOM2: 1002, CUSTOM3: 1003 }
  function callGenericPopup(content: Any, type = POPUP_TYPE.TEXT, inputValue = '', options: Any = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div')
      overlay.className = 'rce-popup'
      const box = document.createElement('div')
      box.className = 'rce-popup-box'
      const body = document.createElement('div')
      body.className = 'rce-popup-body'
      if (typeof content === 'string') body.innerHTML = content
      else if (content?.jquery) body.append(...content.toArray())
      else if (content?.nodeType) body.append(content)
      box.append(body)
      let input: HTMLInputElement | HTMLTextAreaElement | null = null
      if (type === POPUP_TYPE.INPUT) {
        input = document.createElement(options.rows > 1 ? 'textarea' : 'input')
        input.value = inputValue ?? ''
        box.append(input)
      }
      const finish = (result: number | null) => {
        overlay.remove()
        if (type === POPUP_TYPE.INPUT) resolve(result !== null && result >= 1 ? input!.value : result === 0 ? false : null)
        else resolve(result)
      }
      const actions = document.createElement('div')
      actions.className = 'rce-popup-actions'
      const button = (text: string, result: number | null) => {
        const b = document.createElement('button')
        b.textContent = text
        b.onclick = () => finish(result)
        actions.append(b)
      }
      if (type !== POPUP_TYPE.DISPLAY) {
        if (options.okButton !== false) button(typeof options.okButton === 'string' ? options.okButton : type === POPUP_TYPE.CONFIRM ? '是' : '确定', 1)
        if (type === POPUP_TYPE.CONFIRM || type === POPUP_TYPE.INPUT || options.cancelButton) {
          button(typeof options.cancelButton === 'string' ? options.cancelButton : type === POPUP_TYPE.CONFIRM ? '否' : '取消', 0)
        }
      }
      button('关闭', null)
      box.append(actions)
      overlay.append(box)
      document.body.append(overlay)
    })
  }

  // ---------------- 其余接口 ----------------
  const notedStubs = new Set<string>()
  const stub = (name: string) => () => {
    if (!notedStubs.has(name)) {
      notedStubs.add(name)
      hostLog('warn', `调用了预览未模拟的接口 ${name}，已返回空结果`)
    }
    return Promise.resolve(undefined)
  }
  const notExecuted = (name: string) => (...args: Any[]) => {
    const preview = args
      .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })()))
      .join(', ')
      .slice(0, 300)
    hostLog('info', `卡片调用了 ${name}(${preview})，预览中不执行`)
    return Promise.resolve('')
  }
  function errorCatched(fn: Fn) {
    const onError = (error: Any) => {
      w.toastr?.error(String(error?.stack ?? error?.message ?? error), String(error?.name ?? 'Error'))
      hostLog('error', error)
      throw error
    }
    return (...args: Any[]) => {
      try {
        const result = fn(...args)
        return result && typeof result.then === 'function' ? result.then(undefined, onError) : result
      } catch (error) {
        return onError(error)
      }
    }
  }
  function _errorCatched(this: Any, fn: Fn) {
    const name = getIframeName.call(this)
    const onError = (error: Any) => {
      w.toastr?.error(String(error?.stack ?? error?.message ?? error), `[${name}] ${error?.name ?? 'Error'}`)
      w.__rceLog(name, 'error', [error])
      throw error
    }
    return (...args: Any[]) => {
      try {
        const result = fn(...args)
        return result && typeof result.then === 'function' ? result.then(undefined, onError) : result
      } catch (error) {
        return onError(error)
      }
    }
  }
  const defaultPreset = () => ({
    settings: {
      max_context: 2000000,
      max_completion_tokens: 8192,
      reply_count: 1,
      should_stream: false,
      temperature: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      top_p: 1,
      repetition_penalty: 1,
      min_p: 0,
      top_k: 0,
      top_a: 0,
      seed: -1,
      squash_system_messages: false,
      reasoning_effort: 'auto',
      request_thoughts: false,
      request_images: false,
      enable_function_calling: false,
      enable_web_search: false,
      allow_sending_images: 'disabled',
      allow_sending_videos: false,
      character_name_prefix: 'none',
      wrap_user_messages_in_quotes: false,
    },
    prompts: [],
    prompts_unused: [],
    extensions: {},
  })
  const builtin = {
    addOneMessage: () => {},
    copyText: (text: string) => navigator.clipboard?.writeText(text),
    duringGenerating: () => false,
    getImageTokenCost: async () => 0,
    getVideoTokenCost: async () => 0,
    parseRegexFromString: (input: string) => {
      const match = String(input).match(/^\/([\w\W]+?)\/([gimsuy]*)$/)
      if (!match) return null
      try {
        return new RegExp(match[1], match[2])
      } catch {
        return null
      }
    },
    promptManager: {},
    reloadAndRenderChatWithoutEvents: async () => {},
    reloadChatWithoutEvents: async () => {},
    reloadEditor: () => {},
    reloadEditorDebounced: () => {},
    renderMarkdown: (text: string) => text,
    renderPromptManager: () => {},
    renderPromptManagerDebounced: () => {},
    saveSettings: async () => saveSettings(),
    uuidv4: () => crypto.randomUUID(),
  }
  const toastrWrapped = () => {
    const toastr = w.toastr
    if (!toastr || toastr.__rceWrapped) return
    toastr.__rceWrapped = true
    toastr.options = { ...(toastr.options ?? {}), positionClass: 'toast-top-center', preventDuplicates: true, timeOut: 3000 }
    for (const level of ['info', 'success', 'warning', 'error']) {
      const original = toastr[level]
      if (typeof original !== 'function') continue
      toastr[level] = (...args: Any[]) => {
        hostLog(level === 'error' ? 'error' : 'info', `toastr.${level}：${args.filter((a) => typeof a === 'string').join(' ').replace(/<[^>]+>/g, '').slice(0, 300)}`)
        return original.apply(toastr, args)
      }
    }
  }

  // ---------------- 酒馆的 getContext（st-context.js 的常用部分） ----------------
  const character = () => {
    const card = (session?.card ?? {}) as Any
    return { ...card, name: session?.charName ?? '', avatar: 'preview.png', chat: chatId }
  }
  const getContext = () => {
    const ch = character()
    return {
      chat,
      characters: [ch],
      characterId: 0,
      this_chid: 0,
      groupId: null,
      groups: [],
      name1: session?.userName ?? '',
      name2: session?.charName ?? '',
      chatId,
      getCurrentChatId: () => chatId,
      chatMetadata,
      extensionSettings,
      eventSource,
      eventTypes: tavern_events,
      event_types: tavern_events,
      mainApi: 'openai',
      onlineStatus: 'no_connection',
      maxContext: 2000000,
      chatCompletionSettings: {},
      powerUserSettings: {},
      tags: [],
      tagMap: {},
      getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
      saveChat: async () => {},
      saveChatConditional: async () => {},
      saveMetadata: async () => {},
      saveMetadataDebounced: () => {},
      saveSettingsDebounced: () => saveSettings(),
      substituteParams: substitudeMacros,
      substituteParamsExtended: substitudeMacros,
      callGenericPopup,
      callPopup: (content: Any, type: string) => callGenericPopup(content, type === 'confirm' ? POPUP_TYPE.CONFIRM : POPUP_TYPE.TEXT),
      POPUP_TYPE,
      POPUP_RESULT,
      getCurrentLocale: () => 'zh-cn',
      getCharacterCardFields: () => ({
        name: ch.name,
        description: ch.description ?? '',
        personality: ch.personality ?? '',
        scenario: ch.scenario ?? '',
        persona: '',
        mesExamples: ch.mes_example ?? '',
        system: '',
        jailbreak: '',
        version: '',
        charDepthPrompt: '',
        creatorNotes: ch.creator_notes ?? ch.creatorcomment ?? '',
      }),
      registerMacro: () => {},
      unregisterMacro: () => {},
      ToolManager: { isToolCallingSupported: () => false, registerFunctionTool: () => {}, unregisterFunctionTool: () => {}, tools: [] },
      registerFunctionTool: () => {},
      unregisterFunctionTool: () => {},
      isToolCallingSupported: () => false,
      getChatCompletionModel: () => '',
      loadWorldInfo,
      getTokenCountAsync: async (text: string) => Math.ceil(String(text ?? '').length / 2),
      executeSlashCommandsWithOptions: async (text: string) => {
        hostLog('info', `卡片执行斜杠命令：${String(text).slice(0, 200)}，预览中不执行`)
        return { pipe: '' }
      },
      registerSlashCommand: () => {},
      SlashCommandParser: { addCommandObject: () => {}, commands: {} },
      renderExtensionTemplateAsync: async () => '',
      uuidv4: builtin.uuidv4,
      accountStorage: w.__rceStorage.localStorage,
    }
  }
  Object.defineProperty(w, 'SillyTavern', { get: () => ({ ...getContext(), getContext }), configurable: true })

  // ---------------- TavernHelper ----------------
  const impl: Record<string, unknown> = {
    builtin,
    tavern_events,
    iframe_events,
    getVariables,
    replaceVariables,
    updateVariablesWith,
    insertOrAssignVariables,
    insertVariables,
    deleteVariable,
    registerVariableSchema: (schema: unknown, { type }: Any) => {
      variableSchemas[type] = schema
    },
    initializeGlobal,
    waitGlobalInitialized,
    substitudeMacros,
    getLastMessageId,
    getMessageId,
    errorCatched,
    getChatMessages,
    setChatMessages,
    setChatMessage,
    createChatMessages,
    deleteChatMessages,
    retrieveDisplayedMessage: (id: number) => $(`#chat > .mes[mesid="${normalizeId(id)}"] .mes_text`),
    formatAsDisplayedMessage: (text: string) => text,
    refreshOneMessage: async () => {},
    getCharData: () => clone(session?.card ?? null),
    getCharAvatarPath: () => session?.charAvatar ?? '',
    getCurrentCharacterName: () => session?.charName ?? null,
    getCharacterNames: () => [session?.charName ?? ''],
    getChatHistoryBrief: () => [],
    getChatHistoryDetail: () => ({}),
    getLorebooks: () => (bookName ? [bookName] : []),
    getWorldbookNames: () => (bookName ? [bookName] : []),
    getGlobalWorldbookNames: () => [],
    rebindGlobalWorldbooks: async () => {},
    getCharLorebooks: charLorebooks,
    getCharWorldbookNames: charLorebooks,
    getCurrentCharPrimaryLorebook: () => bookName,
    getChatLorebook: () => null,
    getChatWorldbookName: () => null,
    getLorebookSettings: () => clone(lorebookSettings),
    setLorebookSettings: (settings: Any) => {
      Object.assign(lorebookSettings, settings)
    },
    getLorebookEntries,
    setLorebookEntries,
    getWorldbook,
    replaceWorldbook,
    updateWorldbookWith,
    getAllEnabledScriptButtons,
    getPreset: () => defaultPreset(),
    getPresetNames: () => ['预览'],
    getLoadedPresetName: () => '预览',
    default_preset: defaultPreset(),
    isPresetNormalPrompt: (p: Any) => !!p && !p.id?.startsWith?.('chat'),
    isPresetSystemPrompt: () => false,
    isPresetPlaceholderPrompt: () => false,
    registerMacroLike: (regex: RegExp, replace: Fn) => {
      macroLikes.push({ regex, replace })
    },
    unregisterMacroLike: (regex: RegExp) => {
      const i = macroLikes.findIndex((m) => String(m.regex) === String(regex))
      if (i > -1) macroLikes.splice(i, 1)
    },
    getTavernHelperVersion: () => cfg.thVersion,
    getFrontendVersion: () => cfg.thVersion,
    getTavernVersion: () => cfg.stVersion,
    isAdmin: () => false,
    getTavernHelperExtensionId: () => 'JS-Slash-Runner',
    getExtensionType: () => null,
    isInstalledExtension: () => false,
    getTavernRegexes: () => [],
    isCharacterTavernRegexesEnabled: () => true,
    formatAsTavernRegexedString: (text: string) => text,
    playAudio: () => {},
    pauseAudio: () => {},
    getAudioList: () => [],
    getAudioSettings: () => ({}),
  }
  for (const name of cfg.notExecuted) impl[name] = notExecuted(name)
  const bind: Record<string, Fn> = {
    _eventOn,
    _eventOnButton: function (this: Any, name: string, listener: Fn) {
      _eventOn.call(this, _getButtonEvent.call(this, name), listener)
    },
    _eventMakeLast,
    _eventMakeFirst,
    _eventOnce,
    _eventEmit,
    _eventEmitAndWait,
    _eventRemoveListener,
    _eventClearEvent,
    _eventClearListener,
    _eventClearAll,
    _initializeGlobal,
    _waitGlobalInitialized,
    _registerMacroLike: function (this: Any, regex: RegExp, replace: Fn) {
      macroLikes.push({ regex, replace })
    },
    _getButtonEvent,
    _getScriptButtons,
    _replaceScriptButtons,
    _updateScriptButtonsWith,
    _appendInexistentScriptButtons,
    _getScriptName: function (this: Any) {
      return currentScript(this)?.name ?? ''
    },
    _getScriptInfo: function (this: Any) {
      return currentScript(this)?.info ?? ''
    },
    _replaceScriptInfo: function (this: Any, info: string) {
      const s = currentScript(this)
      if (s) s.info = info
    },
    _getVariables: function (this: Any, option: Any = { type: 'chat' }) {
      return getVariables(scriptOption(this, option))
    },
    _getAllVariables,
    _replaceVariables: function (this: Any, variables: Any, option: Any = { type: 'chat' }) {
      return replaceVariables(variables, scriptOption(this, option))
    },
    _updateVariablesWith: function (this: Any, updater: Fn, option: Any = { type: 'chat' }) {
      return updateVariablesWith(updater, scriptOption(this, option))
    },
    _insertOrAssignVariables: function (this: Any, variables: Any, option: Any = { type: 'chat' }) {
      return insertOrAssignVariables(variables, scriptOption(this, option))
    },
    _insertVariables: function (this: Any, variables: Any, option: Any = { type: 'chat' }) {
      return insertVariables(variables, scriptOption(this, option))
    },
    _deleteVariable: function (this: Any, path: string, option: Any = { type: 'chat' }) {
      return deleteVariable(path, scriptOption(this, option))
    },
    _reloadIframe: function (this: Any) {
      this.location.reload()
    },
    _errorCatched,
    _getIframeName: getIframeName,
    _getScriptId: getScriptId,
    _getCurrentMessageId: getCurrentMessageId,
  }
  const bound = new Set(Object.keys(bind).map((k) => k.replace('_', '')))
  for (const name of cfg.apiNames) if (!(name in impl) && !bound.has(name)) impl[name] = stub(name)
  w.TavernHelper = {
    _th_impl: {
      _init: () => {},
      _log: (name: string, level: string, message: unknown) => w.__rceLog(name, level, [message]),
      _clearLog: () => {},
      writeExtensionField: async (_id: unknown, key: string) => hostLog('info', `卡片尝试写入扩展字段 ${key}，预览中不执行`),
    },
    _bind: bind,
    ...impl,
  }
  w.tavern_events = tavern_events
  w.iframe_events = iframe_events

  // ---------------- 页面：消息、脚本、按钮 ----------------
  const chatEl = document.getElementById('chat')!
  const emptyEl = document.getElementById('empty')!
  const framesEl = document.getElementById('rce-script-frames')!
  const buttonsEl = document.getElementById('rce-buttons')!
  let pinLast = false
  const alignLast = () => (chatEl.lastElementChild as HTMLElement | null)?.scrollIntoView({ block: 'start' })
  for (const type of ['wheel', 'touchmove', 'keydown', 'mousedown']) {
    window.addEventListener(type, () => (pinLast = false), { passive: true })
  }
  new ResizeObserver(() => {
    if (pinLast) alignLast()
  }).observe(chatEl)

  function renderMessage(index: number) {
    const source = session!.messages[index]
    const el = document.createElement('div')
    el.className = 'mes'
    el.setAttribute('mesid', String(index))
    el.setAttribute('ch_name', source.name)
    el.setAttribute('is_user', String(source.isUser))
    el.setAttribute('is_system', 'false')
    const avatarWrap = document.createElement('div')
    avatarWrap.className = 'mesAvatarWrapper'
    if (source.avatar) {
      const img = document.createElement('img')
      img.className = 'avatar'
      img.src = source.avatar
      img.alt = source.name
      avatarWrap.append(img)
    } else {
      const fallback = document.createElement('div')
      fallback.className = 'avatar'
      fallback.textContent = [...(source.name.trim() || '?')][0]
      avatarWrap.append(fallback)
    }
    const idEl = document.createElement('div')
    idEl.className = 'mesIDDisplay'
    idEl.textContent = `#${index}`
    avatarWrap.append(idEl)
    const block = document.createElement('div')
    block.className = 'mes_block'
    const name = document.createElement('div')
    name.className = 'ch_name'
    name.textContent = source.name
    const text = document.createElement('div')
    text.className = 'mes_text'
    text.innerHTML = source.html
    block.append(name, text)
    el.append(avatarWrap, block)
    for (const holder of Array.from(text.querySelectorAll<HTMLElement>('.TH-render[data-th-index]'))) {
      const k = Number(holder.dataset.thIndex)
      const doc = source.frontends[k]
      if (doc === undefined) continue
      const frame = document.createElement('iframe')
      frame.id = frame.name = `TH-message--${index}--${k}`
      frame.dataset.label = `#${index} 前端${source.frontends.length > 1 ? ` ${k + 1}` : ''}`
      frame.setAttribute('frameborder', '0')
      frame.srcdoc = doc
      holder.append(frame)
    }
    const existing = chatEl.querySelector(`:scope > .mes[mesid="${index}"]`)
    if (existing) existing.replaceWith(el)
    else chatEl.append(el)
    emptyEl.hidden = true
    if (pinLast) alignLast()
  }

  function renderButtons() {
    buttonsEl.replaceChildren()
    for (const s of scriptRuntimes.values()) {
      if (!s.button.enabled) continue
      for (const b of s.button.buttons) {
        if (!b.visible) continue
        const el = document.createElement('button')
        el.className = 'rce-btn'
        el.textContent = b.name
        el.title = `脚本「${s.name}」的按钮`
        el.onclick = () => {
          hostLog('info', `点击了「${s.name}」的按钮「${b.name}」`)
          void eventSource.emit(getButtonId(s.id, b.name))
        }
        buttonsEl.append(el)
      }
    }
    buttonsEl.hidden = buttonsEl.childElementCount === 0
  }

  async function startScripts(list: HostScript[]) {
    const loads: Promise<void>[] = []
    // 酒馆助手设置面板里的脚本列表：MVU 靠 #tavern_helper div[data-script-id] 判断自己是不是首选实例
    const panel = document.getElementById('tavern_helper')!
    for (const s of list) {
      scriptRuntimes.set(s.id, { id: s.id, name: s.name, info: s.info, button: clone(s.button), data: clone(s.data) })
      const item = document.createElement('div')
      item.dataset.scriptId = s.id
      panel.append(item)
      const frame = document.createElement('iframe')
      frame.id = frame.name = `TH-script--${s.name}--${s.id}`
      frame.dataset.label = `脚本「${s.name}」`
      loads.push(new Promise((resolve) => frame.addEventListener('load', () => resolve(), { once: true })))
      frame.srcdoc = s.doc
      framesEl.append(frame)
    }
    renderButtons()
    await Promise.race([Promise.all(loads), sleep(20000)])
  }

  // ---------------- 会话：重放一段聊天 ----------------
  let pending: HostSession | null = null
  let running = false
  let scriptsStarted = false

  async function runSession(s: HostSession) {
    const first = !session
    session = s
    worldEntries = clone(s.world?.entries ?? {})
    bookName = s.world?.name ?? null
    characterVariables = clone(s.characterVariables)
    if (first && s.extensionSettings) extensionSettings = clone(s.extensionSettings)
    extensionSettings.variables ??= {}
    extensionSettings.variables.global ??= {}
    toastrWrapped()

    // 新开一段聊天：清空楼层（iframe 卸载时会清掉自己的事件监听）
    pinLast = false
    chatEl.replaceChildren()
    emptyEl.hidden = s.messages.length > 0
    editedNotified.clear()
    chat.length = 0
    chatId = `preview-${s.seq}`
    chatMetadata = { variables: {} }
    const seedFor = (i: number) => (s.seed && (i === 0 || s.seedAll) ? s.seed : null)
    if (s.messages.length) chat.push(makeChatMessage(s.messages[0], seedFor(0)))

    // MVU 收到 CHAT_CHANGED 后会重新初始化变量，等它完成再模拟后面的楼层
    const scripted = s.scripts.length > 0
    // 新版 MVU 的事件名是 mag_variable_initialized，旧版拼成了 mag_variable_initiailized
    const initialized = s.mvu ? waitForEvent(['mag_variable_initialized', 'mag_variable_initiailized'], first ? 20000 : 6000) : null
    if (!scriptsStarted) {
      scriptsStarted = true
      await eventSource.emit(tavern_events.APP_READY)
      if (scripted) await startScripts(s.scripts)
    } else {
      await eventSource.emit(tavern_events.CHAT_CHANGED, chatId)
    }
    if (initialized && !(await initialized)) hostLog('warn', 'MVU 没有在预期时间内完成变量初始化')
    if (s.mvu) await waitUntil(() => (events[tavern_events.MESSAGE_RECEIVED]?.length ?? 0) > 0, 3000).catch(() => {})
    if (scripted) await sleep(100)
    if (pending) return

    if (s.messages.length) {
      pinLast = s.messages.length > 1
      renderMessage(0)
    }
    for (let i = 1; i < s.messages.length; i++) {
      const m = s.messages[i]
      if (m.isUser) {
        chat.push(makeChatMessage(m, seedFor(i)))
        await eventSource.emit(tavern_events.MESSAGE_SENT, i)
        renderMessage(i)
        await eventSource.emit(tavern_events.USER_MESSAGE_RENDERED, i)
      } else {
        await eventSource.emit(tavern_events.GENERATION_STARTED, 'normal', {}, false)
        chat.push(makeChatMessage(m, seedFor(i)))
        await eventSource.emit(tavern_events.MESSAGE_RECEIVED, i, 'normal')
        renderMessage(i)
        await eventSource.emit(tavern_events.CHARACTER_MESSAGE_RENDERED, i, 'normal')
        await eventSource.emit(tavern_events.GENERATION_ENDED, i)
      }
      if (pending) return
    }
    if (pinLast) alignLast()
    else window.scrollTo(0, 0)
    scheduleState()
  }

  async function loop() {
    running = true
    while (pending) {
      const s = pending
      pending = null
      try {
        await runSession(s)
      } catch (e) {
        hostLog('error', '预览运行出错：', e)
      }
    }
    running = false
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return
    const data = e.data as { type?: string; session?: HostSession } | null
    if (data?.type === 'rce-session' && data.session) {
      pending = data.session
      if (!running) void loop()
    }
  })

  let viewportHeight = window.innerHeight
  window.addEventListener('resize', () => {
    if (window.innerHeight === viewportHeight) return
    viewportHeight = window.innerHeight
    for (const frame of Array.from(document.querySelectorAll('iframe'))) {
      frame.contentWindow?.postMessage({ type: 'TH_UPDATE_VIEWPORT_HEIGHT' }, '*')
    }
  })

  // zod、yaml 只有 ES 模块版本，加载完再通知编辑器（酒馆助手把它们挂在 window.z、window.YAML）
  const load = new Function('u', 'return import(u)') as (url: string) => Promise<Any>
  void Promise.allSettled([
    load(cfg.libs.zod).then((m) => {
      w.z = m
    }),
    load(cfg.libs.yaml).then((m) => {
      w.YAML = m.default ?? m
    }),
  ]).then((results) => {
    for (const r of results) if (r.status === 'rejected') hostLog('error', '加载库失败：', r.reason)
    postUp({ type: 'rce-ready' })
  })
}
