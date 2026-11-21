/**
 * 依赖体检结果跳转到编辑页对应的位置。
 */
import { useDeferredValue, useMemo } from 'react'
import type { CharacterCardV3 } from '@/core/card/types'
import { analyzeDependencies, type CardTextField, type DepLocation } from '@/core/deps/deps'

export type EditorTab = 'character' | 'worldbook' | 'regex'

const FIELD_PATHS: Record<CardTextField, string[]> = {
  description: ['data', 'description'],
  personality: ['data', 'personality'],
  scenario: ['data', 'scenario'],
  first_mes: ['data', 'first_mes'],
  mes_example: ['data', 'mes_example'],
  creator_notes: ['data', 'creator_notes'],
  system_prompt: ['data', 'system_prompt'],
  post_history_instructions: ['data', 'post_history_instructions'],
  depth_prompt: ['data', 'extensions', 'depth_prompt', 'prompt'],
}

// 以下锚点 id 要和编辑页里的一致：TextField、GreetingsSection、ExtensionsSection

function fieldAnchor(path: string[]): string {
  return `field-${path.join('-')}`
}

function greetingAnchor(group: boolean, index: number): string {
  return `${group ? 'group-greeting' : 'greeting'}-${index}`
}

const OTHER_EXTENSIONS_ANCHOR = 'other-extensions'

export function jumpTarget(loc: DepLocation): { tab: EditorTab; anchor?: string } {
  switch (loc.type) {
    case 'field':
      return { tab: 'character', anchor: fieldAnchor(FIELD_PATHS[loc.field]) }
    case 'greeting':
      return { tab: 'character', anchor: greetingAnchor(loc.group, loc.index) }
    case 'entry':
      return { tab: 'worldbook' }
    case 'regex':
      return { tab: 'regex' }
    case 'script':
    case 'extension':
      return { tab: 'character', anchor: OTHER_EXTENSIONS_ANCHOR }
  }
}

const FLASH_CLASSES = ['ring-2', 'ring-primary', 'ring-offset-4', 'ring-offset-background', 'rounded-md']

/**
 * 等元素渲染出来、弹出面板的滚动锁解除后，滚过去并闪一下。
 * 面板关闭动画期间 body 带着 data-scroll-locked，这时滚动不起作用。
 */
export function revealAnchor(id: string): void {
  let tries = 0
  const tick = () => {
    const el = document.getElementById(id)
    if (!el || document.body.hasAttribute('data-scroll-locked')) {
      if (tries++ < 120) requestAnimationFrame(tick)
      return
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add(...FLASH_CLASSES)
    setTimeout(() => el.classList.remove(...FLASH_CLASSES), 1600)
  }
  requestAnimationFrame(tick)
}

/** 编辑时延后计算，不拖慢输入 */
export function useDependencyReport(card: CharacterCardV3 | undefined) {
  const deferred = useDeferredValue(card)
  return useMemo(() => (deferred ? analyzeDependencies(deferred) : null), [deferred])
}
