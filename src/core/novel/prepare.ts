/**
 * 生成前的准备：按时间点和勾选，算出主角、要进世界书的对象、给模型的人物一览/世界观/前情。
 */
import { entityToItem, worldToItem, type ConsolidateItem } from './consolidate'
import { aliasesUpTo, collectSummaries, collectWorld, entityBrief, formatEntityNotes, isHidden, isSelected, mergeEntities } from './merge'
import type { ChunkResult, MergedEntity, ReviewOverrides } from './types'

export interface PrepareArgs {
  mode: 'character' | 'world'
  /** 全书的合并结果（没有时间点时直接用；有时间点时按时间点重新合并） */
  entities: MergedEntity[]
  overrides: ReviewOverrides
  results: ChunkResult[]
  /** 时间点：只用这个位置（chunkOrder）及之前的资料；不填用全部 */
  maxOrder?: number
  /** 单角色卡的主角（名字键） */
  mainKey: string | null
  /** 世界观总述也合成一条 */
  worldEntry: boolean
}

export interface Prepared {
  main: MergedEntity | null
  /** 要进世界书的对象（勾选的、没删的、时间点之前出现过的；单角色卡不含主角） */
  lorebook: MergedEntity[]
  /** 合成条目的请求项（含世界观） */
  items: ConsolidateItem[]
  /** 请求项 id → 来源名字键（世界观为 'world'） */
  sourceKeys: Record<string, string>
  /** 主角的资料（单角色卡） */
  mainNotes: string
  /** 主角在时间点之前用过的其他称呼 */
  mainAliases: string[]
  cast: string
  world: string
  story: string
}

/** 主角资料最多带这么多字（资料多时保留第一段和最近的） */
const MAIN_NOTES_LIMIT = 30000
/** 人物一览最多列这么多人 */
const CAST_LIMIT = 40

function appearsBefore(entity: MergedEntity, maxOrder?: number): boolean {
  return maxOrder === undefined || entity.mentions.some((m) => m.order <= maxOrder)
}

export function findEntity(entities: MergedEntity[], key: string | null): MergedEntity | null {
  if (!key) return null
  return entities.find((e) => e.keys.includes(key)) ?? null
}

export function prepareGeneration(args: PrepareArgs): Prepared {
  const { overrides, maxOrder } = args
  // 有时间点时只用时间点之前的结果重新合并：合并本身会用到后面章节的信息
  // （比如后来才揭晓“烛龙”就是狐忠），用全书的合并结果会把后面的剧情带进来
  const results = maxOrder === undefined ? args.results : args.results.filter((r) => r.order <= maxOrder)
  const entities = maxOrder === undefined ? args.entities : mergeEntities(results, overrides)
  const chunkCount = new Set(results.map((r) => r.chunkId)).size
  const visible = entities.filter((e) => !isHidden(e, overrides) && appearsBefore(e, maxOrder))
  const main = args.mode === 'character' ? findEntity(visible, args.mainKey) : null

  const lorebook = visible.filter((e) => e !== main && isSelected(e, overrides, chunkCount))
  const items: ConsolidateItem[] = []
  const sourceKeys: Record<string, string> = {}
  lorebook.forEach((e, i) => {
    const item = entityToItem(e, i, maxOrder)
    items.push(item)
    sourceKeys[item.id] = e.id
  })

  const worldLines = collectWorld(results, maxOrder)
  if (args.worldEntry && worldLines.length > 0) {
    const item = worldToItem(worldLines)
    items.push(item)
    sourceKeys[item.id] = 'world'
  }

  const cast = visible
    .filter((e) => e.kind === 'character' && e !== main)
    .slice(0, CAST_LIMIT)
    .map((e) => {
      const brief = entityBrief(e, maxOrder)
      return brief ? `${e.name}：${brief}` : e.name
    })
    .join('\n')

  return {
    main,
    lorebook,
    items,
    sourceKeys,
    mainNotes: main ? formatEntityNotes(main, { maxOrder, maxChars: MAIN_NOTES_LIMIT }) : '',
    mainAliases: main ? aliasesUpTo(main, maxOrder).slice(0, 8) : [],
    cast,
    world: worldLines.map((w) => `- ${w}`).join('\n'),
    story: collectSummaries(results, maxOrder)
      .map((s) => `【${s.label}】${s.summary}`)
      .join('\n'),
  }
}
