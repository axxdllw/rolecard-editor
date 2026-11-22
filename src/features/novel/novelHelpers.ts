/**
 * 小说转卡界面的纯辅助函数、格式化工具和常量选项。
 */
import type { ReasoningEffort } from '@/core/ai/types'
import { DESCRIPTION_TEMPLATES, type DescriptionTemplate } from '@/core/card/create'
import type { ChunkPlan, MergedEntity } from '@/core/novel/types'
import type { NovelRecord } from '@/db/db'
import type { CustomTemplate } from '@/lib/settings'

export type NovelStep = 'range' | 'extract' | 'review' | 'generate'

export const NOVEL_STEPS: Array<{ id: NovelStep; label: string }> = [
  { id: 'range', label: '① 选范围' },
  { id: 'extract', label: '② 抽取' },
  { id: 'review', label: '③ 整理' },
  { id: 'generate', label: '④ 生成' },
]

export function isNovelStep(value: string | null): value is NovelStep {
  return value === 'range' || value === 'extract' || value === 'review' || value === 'generate'
}

/** 总字数/大段字数：用“万字”保留 1 位小数，不足 1000 字直接显示字数 */
export function formatWanChars(chars: number): string {
  if (chars < 1000) return `${chars} 字`
  return `${(chars / 10000).toFixed(1)} 万字`
}

/** 单章字数：不满 1 万显示精确字数，满 1 万用“万字” */
export function formatChapterChars(chars: number): string {
  if (chars < 10000) return `${chars.toLocaleString('zh-CN')} 字`
  return `${(chars / 10000).toFixed(1)} 万字`
}

/** token 估算：用“万 token”保留 1 位小数，不足 1000 直接显示 */
export function formatWanTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens} token`
  return `${(tokens / 10000).toFixed(1)} 万 token`
}

/** 预计抽取用时：ceil(请求数 / 并发) * 50 秒，转成“约 N 分钟” */
export function formatDurationMinutes(requests: number, concurrency: number): string {
  if (requests <= 0) return '0 分钟'
  const seconds = Math.ceil(requests / Math.max(1, concurrency)) * 50
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `约 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rem = minutes % 60
  return rem > 0 ? `约 ${hours} 小时 ${rem} 分钟` : `约 ${hours} 小时`
}

/** 书的格式标签 */
export function formatBookFormat(format: string): string {
  return (format || 'UNKNOWN').toUpperCase()
}

/** 按模板标识解析描述写法（同新建角色卡的逻辑，支持内置与自定义模板） */
export function resolveStyle(
  template: string,
  customTemplates: CustomTemplate[],
): { templateId: DescriptionTemplate['id']; label: string; skeleton: string } {
  const custom = customTemplates.find((t) => `custom:${t.id}` === template)
  if (custom) return { templateId: 'plain', label: custom.label, skeleton: custom.content }
  const builtIn = DESCRIPTION_TEMPLATES.find((t) => t.id === template) ?? DESCRIPTION_TEMPLATES[0]
  return { templateId: builtIn.id, label: builtIn.label, skeleton: builtIn.build() }
}

/** 生成时间点的文字说明 */
export function formatTimePointLabel(plan: ChunkPlan, toc: NovelRecord['toc']): string {
  const endTitle = toc[plan.chapterEnd]?.title ?? ''
  return endTitle ? `${plan.label}（${endTitle}）之后` : `${plan.label}之后`
}

/** 对象出现在多少个不同的块里 */
export function entityChunkCount(entity: MergedEntity): number {
  return new Set(entity.mentions.map((m) => m.chunkId)).size
}

export const CHUNK_CHAR_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 10000, label: '1 万字' },
  { value: 20000, label: '2 万字（默认）' },
  { value: 30000, label: '3 万字' },
  { value: 50000, label: '5 万字' },
]

export const SAMPLE_COUNT_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: '不抽样' },
  { value: 5, label: '5 块' },
  { value: 10, label: '10 块' },
  { value: 20, label: '20 块' },
]

export const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 5] as const

export const REASONING_OPTIONS: Array<{ value: 'profile' | ReasoningEffort; label: string }> = [
  { value: 'profile', label: '跟随接口设置' },
  { value: 'low', label: '低（推荐，省钱）' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

export const APPEND_CHAR_OPTIONS: Array<{ chars: number; label: string }> = [
  { chars: 100000, label: '10 万字' },
  { chars: 200000, label: '20 万字' },
  { chars: 500000, label: '50 万字' },
  { chars: 1000000, label: '100 万字' },
]

export const USER_ROLE_PRESETS = [
  '原创角色，身份在开场白里交代',
  '初来乍到的新人',
  '书中人物的旧识',
  '穿越者',
] as const
