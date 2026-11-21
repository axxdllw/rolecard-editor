/**
 * 卡片里的酒馆助手角色脚本（对照酒馆助手 4.7 的 type/scripts.ts 和 type/backward.ts）。
 *
 * 新格式：extensions.tavern_helper = { scripts: (Script | ScriptFolder)[], variables }，也可能存成 [key, value][]。
 * 旧格式：extensions.TavernHelper_scripts = [{ type: 'script', value }, { type: 'folder', value: [...] }]，
 * 变量在 extensions.TavernHelper_characterScriptVariables。
 */
import type { JsonObject } from '../card/types'

export interface HelperScriptButton {
  name: string
  visible: boolean
}

export interface HelperScript {
  id: string
  name: string
  content: string
  info: string
  button: { enabled: boolean; buttons: HelperScriptButton[] }
  data: Record<string, unknown>
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readSettings(ext: JsonObject): JsonObject | undefined {
  const raw = ext.tavern_helper
  if (Array.isArray(raw)) {
    return Object.fromEntries(raw.filter((p): p is [string, unknown] => Array.isArray(p) && typeof p[0] === 'string'))
  }
  return isObject(raw) ? raw : undefined
}

function readButtons(list: unknown): HelperScriptButton[] {
  if (!Array.isArray(list)) return []
  return list.filter(isObject).map((b) => ({ name: String(b.name ?? ''), visible: b.visible !== false }))
}

function toScript(item: JsonObject, index: number, legacy: boolean): HelperScript {
  const button = isObject(item.button) ? item.button : undefined
  return {
    id: typeof item.id === 'string' && item.id ? item.id : `script-${index}`,
    name: String(item.name ?? ''),
    content: String(item.content ?? ''),
    info: String(item.info ?? ''),
    button: legacy
      ? { enabled: true, buttons: readButtons(item.buttons) }
      : { enabled: button?.enabled !== false, buttons: readButtons(button?.buttons) },
    data: isObject(item.data) ? (item.data as Record<string, unknown>) : {},
  }
}

/** 启用的角色脚本，按卡里的顺序；文件夹关闭时里面的脚本都不运行 */
export function enabledHelperScripts(ext: JsonObject | undefined): HelperScript[] {
  if (!ext) return []
  const settings = readSettings(ext)
  const result: HelperScript[] = []
  if (settings && Array.isArray(settings.scripts)) {
    const walk = (list: unknown[]) => {
      for (const item of list) {
        if (!isObject(item)) continue
        if (item.type === 'folder' || Array.isArray(item.scripts)) {
          if (item.enabled === true && Array.isArray(item.scripts)) walk(item.scripts)
        } else if (item.enabled === true) {
          result.push(toScript(item, result.length, false))
        }
      }
    }
    walk(settings.scripts)
    return result
  }
  if (Array.isArray(ext.TavernHelper_scripts)) {
    for (const item of ext.TavernHelper_scripts) {
      if (!isObject(item)) continue
      // 旧格式的文件夹总是启用的，value 是脚本数组
      const values = item.type === 'folder' && Array.isArray(item.value) ? item.value : [isObject(item.value) ? item.value : item]
      for (const value of values) {
        if (isObject(value) && value.enabled === true) result.push(toScript(value, result.length, true))
      }
    }
  }
  return result
}

/** 角色卡变量（getVariables({ type: 'character' }) 读到的内容） */
export function helperCharacterVariables(ext: JsonObject | undefined): Record<string, unknown> {
  if (!ext) return {}
  const settings = readSettings(ext)
  if (settings && isObject(settings.variables)) return settings.variables as Record<string, unknown>
  const legacy = ext.TavernHelper_characterScriptVariables
  return isObject(legacy) ? (legacy as Record<string, unknown>) : {}
}

/** 是否带 MVU 变量框架（MagVarUpdate）：预览要等它初始化完变量再模拟对话 */
export function usesMvu(scripts: HelperScript[]): boolean {
  return scripts.some((s) => /MagVarUpdate/i.test(s.content))
}
