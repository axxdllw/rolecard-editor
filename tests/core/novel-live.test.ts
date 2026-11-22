/**
 * 小说转卡端到端（连真实接口）：只在设置了下面的环境变量时运行。
 *   NOVEL_LIVE_BOOK  一本书的路径
 *   NOVEL_LIVE_API   OpenAI 兼容接口地址，NOVEL_LIVE_KEY、NOVEL_LIVE_MODEL
 *   NOVEL_LIVE_CHARS 精读前多少字（默认 60000），NOVEL_LIVE_SAMPLES 抽样块数（默认 2）
 *   NOVEL_LIVE_MODE  character（默认）或 world
 * 输出的是模型整理的结果和统计，不打印原文。
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { streamChat } from '../../src/core/ai/client'
import type { AiProfile } from '../../src/core/ai/types'
import { isBookArchive, parseBook } from '../../src/core/book'
import { chunkOrder, chunkText, planChunks } from '../../src/core/novel/chunk'
import { batchItems, buildConsolidateRequest, dropSharedKeys, parseConsolidated, toGeneratedEntries } from '../../src/core/novel/consolidate'
import { buildExtractRequest, formatRoster, parseExtraction } from '../../src/core/novel/extract'
import { buildNovelCardRequest, parseNovelCard, toDraftCard } from '../../src/core/novel/generate'
import { mergeEntities } from '../../src/core/novel/merge'
import { prepareGeneration } from '../../src/core/novel/prepare'
import { EMPTY_OVERRIDES, type ChunkResult } from '../../src/core/novel/types'
import { runPool } from '../../src/core/util/pool'

const env = process.env
const enabled = Boolean(env.NOVEL_LIVE_BOOK && env.NOVEL_LIVE_API && env.NOVEL_LIVE_KEY && env.NOVEL_LIVE_MODEL)

describe.skipIf(!enabled)('小说转卡端到端（真实接口）', () => {
  it('解析 → 抽取 → 合并 → 合成条目 → 写卡', async () => {
    const profile: AiProfile = {
      id: 'live',
      name: 'live',
      kind: 'openai',
      baseUrl: env.NOVEL_LIVE_API!,
      apiKey: env.NOVEL_LIVE_KEY!,
      model: env.NOVEL_LIVE_MODEL!,
      reasoningEffort: 'low',
    }
    const path = env.NOVEL_LIVE_BOOK!
    const parsed = parseBook(new Uint8Array(readFileSync(path)), basename(path))
    expect(isBookArchive(parsed)).toBe(false)
    if (isBookArchive(parsed)) return
    const lengths = parsed.chapters.map((c) => c.text.length)
    console.log(`书：${parsed.format}，${parsed.chapters.length} 章，${(lengths.reduce((a, b) => a + b, 0) / 1e4).toFixed(1)} 万字`)

    // 选前 N 字
    const limit = Number(env.NOVEL_LIVE_CHARS ?? 60000)
    const selected: number[] = []
    for (let i = 0, sum = 0; i < lengths.length && sum < limit; i++) {
      selected.push(i)
      sum += lengths[i]
    }
    const plans = planChunks(lengths, selected, { chunkChars: 20000, sampleCount: Number(env.NOVEL_LIVE_SAMPLES ?? 2) })
    console.log(`计划 ${plans.length} 块：${plans.map((p) => `${p.label}${p.sampled ? '(抽样)' : ''} ${p.chars}字`).join('；')}`)

    const results: ChunkResult[] = []
    const t0 = Date.now()
    await runPool(plans, 3, async (plan) => {
      const roster = formatRoster(mergeEntities(results, EMPTY_OVERRIDES))
      const request = buildExtractRequest({ bookTitle: parsed.title, chunkLabel: plan.label, text: chunkText(parsed.chapters, plan), roster })
      const t = Date.now()
      const res = await streamChat(profile, { ...request, reasoningEffort: 'low' })
      const extraction = parseExtraction(res.text)
      results.push({ chunkId: plan.id, order: chunkOrder(plan), label: plan.label, extraction })
      console.log(`  ${plan.label}：${((Date.now() - t) / 1000).toFixed(0)} 秒，人物 ${extraction.characters.length}，地点 ${extraction.places.length}，事件 ${extraction.events.length}`)
    })
    console.log(`抽取用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`)

    const entities = mergeEntities(results, EMPTY_OVERRIDES)
    const people = entities.filter((e) => e.kind === 'character')
    console.log(`合并后：人物 ${people.length}，其他 ${entities.length - people.length}`)
    console.log(`  人物前 10：${people.slice(0, 10).map((e) => `${e.name}[${e.aliases.slice(0, 3).join('/')}] w${e.weight}`).join('，')}`)

    const mode = env.NOVEL_LIVE_MODE === 'world' ? 'world' : 'character'
    const prepared = prepareGeneration({ mode, entities, overrides: EMPTY_OVERRIDES, results, mainKey: people[0]?.id ?? null, worldEntry: true })
    const batches = batchItems(prepared.items)
    console.log(`合成 ${prepared.items.length} 条，分 ${batches.length} 批；主角：${prepared.main?.name ?? '（世界卡）'}`)

    const t1 = Date.now()
    const entries: ReturnType<typeof toGeneratedEntries> = []
    const cardPromise = streamChat(profile, {
      ...buildNovelCardRequest({
        mode,
        bookTitle: parsed.title,
        author: parsed.author,
        main: prepared.main ? { name: prepared.main.name, aliases: prepared.mainAliases, notes: prepared.mainNotes } : undefined,
        worldName: parsed.title,
        cast: prepared.cast,
        world: prepared.world,
        story: prepared.story,
        timePoint: `${plans[plans.length - 1].label}之后`,
        userRole: '原创角色，身份在开场白里交代',
        style: { label: '分段纯文本' },
        greetings: 2,
      }),
      reasoningEffort: 'low',
    })
    await runPool(batches, 3, async (batch) => {
      const res = await streamChat(profile, { ...buildConsolidateRequest({ bookTitle: parsed.title, items: batch }), reasoningEffort: 'low' })
      const got = parseConsolidated(res.text, batch)
      if (got.length < batch.length) console.log(`  有 ${batch.length - got.length} 个对象漏掉了`)
      entries.push(...toGeneratedEntries(got, batch))
    })
    const draft = parseNovelCard((await cardPromise).text)
    console.log(`合成和写卡用时 ${((Date.now() - t1) / 1000).toFixed(0)} 秒`)

    const card = toDraftCard(draft, dropSharedKeys(entries), { storyEntry: true })
    console.log(`卡：${card.name}；描述 ${card.description.length} 字，开场白 ${1 + card.alternate_greetings.length} 条，世界书 ${card.lorebook.length} 条`)
    console.log(`  描述开头：${card.description.slice(0, 200).replace(/\n/g, ' / ')}`)
    console.log(`  条目：${card.lorebook.map((e) => `${e.comment}(${e.keys.join('/')})`).join('，')}`)
    expect(card.description.length).toBeGreaterThan(100)
    expect(card.lorebook.length).toBeGreaterThan(0)
  }, 30 * 60 * 1000)
})
