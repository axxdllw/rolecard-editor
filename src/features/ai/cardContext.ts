/**
 * 给 AI 改写准备的角色卡上下文：取当前卡的主要设定字段，排除正在改的那个。
 */
import type { RewriteContext } from '@/core/ai/tasks/rewrite'
import type { CharacterCardV3 } from '@/core/card/types'

const CONTEXT_FIELDS: Array<[key: string, label: string]> = [
  ['description', '角色描述'],
  ['personality', '性格'],
  ['scenario', '场景'],
  ['first_mes', '主开场白'],
]

/** excludeKey：正在改的字段在 data 下的键名（如 description），不放进上下文 */
export function cardRewriteContext(card: CharacterCardV3 | undefined, excludeKey?: string): RewriteContext | undefined {
  if (!card) return undefined
  const data = card.data
  return {
    name: data.name,
    fields: CONTEXT_FIELDS.filter(([key]) => key !== excludeKey).map(([key, label]) => ({
      label,
      text: typeof data[key] === 'string' ? (data[key] as string) : '',
    })),
  }
}
