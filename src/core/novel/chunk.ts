/**
 * 小说分块：把用户选中的章节切成大小相近的块，另外可以从没选中的章节里均匀抽样几块。
 * 块尽量在章节边界切开；单章太长时在段落边界切。块的 id 只由起止位置决定，
 * 选的范围往后追加时，前面的块 id 不变，已经抽取过的结果可以直接复用。
 */
import type { ChunkPlan, NovelChapter } from './types'

export interface ChunkOptions {
  /** 每块大约多少字 */
  chunkChars: number
  /** 从没选中的章节里均匀抽样多少块（0 不抽样） */
  sampleCount: number
}

/** 块大小的下限，防止误设得太小导致请求数爆炸 */
export const MIN_CHUNK_CHARS = 2000

/** 切块时允许超出的比例：剩下不多就并进当前块，不另起一块 */
const OVERSHOOT = 0.2
/** 当前块已经填到这个比例时，下一章放不下就另起一块，不把章节切开 */
const CLOSE_RATIO = 0.5
/** 段落边界对齐时最多往回找这么多字 */
const SNAP_RANGE = 2000

interface Span {
  chapterStart: number
  startOffset: number
  chapterEnd: number
  endOffset: number
  chars: number
}

function spanId(span: Span): string {
  return `${span.chapterStart}:${span.startOffset}-${span.chapterEnd}:${span.endOffset}`
}

/** 把一段连续章节（下标升序且相邻）切块 */
function packRun(run: number[], lengths: number[], chunkChars: number): Span[] {
  const spans: Span[] = []
  let cur: Span | null = null
  const close = () => {
    if (cur && cur.chars > 0) spans.push(cur)
    cur = null
  }

  for (const ch of run) {
    const len = lengths[ch]
    let pos = 0
    while (pos < len) {
      const filled: number = cur ? (cur as Span).chars : 0
      const cap = chunkChars - filled
      const rest = len - pos
      if (rest <= cap + chunkChars * OVERSHOOT) {
        // 这一章剩下的都放进当前块
        if (!cur) cur = { chapterStart: ch, startOffset: pos, chapterEnd: ch, endOffset: len, chars: 0 }
        cur.chapterEnd = ch
        cur.endOffset = len
        cur.chars += rest
        pos = len
        if (cur.chars >= chunkChars * (1 - OVERSHOOT / 2)) close()
      } else if (cur && filled >= chunkChars * CLOSE_RATIO) {
        // 当前块已经比较满了，下一章另起一块，不把章节切开
        close()
      } else {
        // 把这一章切一段填满当前块
        if (!cur) cur = { chapterStart: ch, startOffset: pos, chapterEnd: ch, endOffset: pos, chars: 0 }
        cur.chapterEnd = ch
        cur.endOffset = pos + cap
        cur.chars += cap
        pos += cap
        close()
      }
    }
  }
  close()
  return spans
}

/** 连续的下标分成一段一段 */
function toRuns(indices: number[]): number[][] {
  const runs: number[][] = []
  for (const i of indices) {
    const last = runs[runs.length - 1]
    if (last && last[last.length - 1] === i - 1) last.push(i)
    else runs.push([i])
  }
  return runs
}

/** 从没选中的章节里均匀抽样：按字数均匀取 count 个起点，每个起点往后连续取到一块大小 */
function sampleSpans(lengths: number[], selected: Set<number>, count: number, chunkChars: number): Span[] {
  if (count <= 0) return []
  const pool = lengths.map((_, i) => i).filter((i) => !selected.has(i) && lengths[i] > 0)
  const total = pool.reduce((sum, i) => sum + lengths[i], 0)
  if (total === 0) return []

  const used = new Set<number>()
  const spans: Span[] = []
  for (let k = 0; k < count; k++) {
    const target = ((k + 0.5) / count) * total
    // 找到 target 落在哪一章
    let acc = 0
    let at = pool.length - 1
    for (let p = 0; p < pool.length; p++) {
      acc += lengths[pool[p]]
      if (acc > target) {
        at = p
        break
      }
    }
    while (at < pool.length && used.has(pool[at])) at++
    if (at >= pool.length) continue

    // 从这一章开头往后连续取（遇到选中的章或已抽过的章就停）
    const first = pool[at]
    let span = null as Span | null
    for (let ch = first; ch < lengths.length; ch++) {
      if (selected.has(ch) || used.has(ch)) break
      const len = lengths[ch]
      if (len === 0) continue
      const cap: number = chunkChars - (span ? span.chars : 0)
      const fits: boolean = len <= cap + chunkChars * OVERSHOOT
      // 已经有内容时放不下整章就停；第一章就比一块还长时只取开头一块
      if (span && !fits) break
      const end: number = fits ? len : chunkChars
      if (!span) span = { chapterStart: ch, startOffset: 0, chapterEnd: ch, endOffset: end, chars: 0 }
      span.chapterEnd = ch
      span.endOffset = end
      span.chars += end
      used.add(ch)
      if (!fits || span.chars >= chunkChars * (1 - OVERSHOOT / 2)) break
    }
    if (span && span.chars > 0) spans.push(span)
  }
  return spans
}

export interface ChapterTitle {
  title: string
  volume?: string
}

const NUMBERED_HEADING = /^(第[0-9０-９零〇一二两三四五六七八九十百千万]+[章回节集话幕卷部篇])/

/** 标题的简短写法：“第三章 牺牲与阴谋”取“第三章”，没有编号的取前 10 个字 */
function shortTitle(text: string): string {
  const t = text.trim()
  const m = t.match(NUMBERED_HEADING)
  if (m) return m[1]
  // “间奏 一个益州人在武昌”“楔子：风起”取前面的“间奏”“楔子”
  const head = t.split(/[\s:：·—-]/)[0]
  if (head && [...head].length <= 10) return head
  return [...t].length > 10 ? `${[...t].slice(0, 10).join('')}…` : t
}

/** 一章的简称：有卷名时带上卷（各卷的章号常常从头数），如“第一部·第三章” */
function chapterName(ch: number, titles?: ChapterTitle[]): string {
  const t = titles?.[ch]
  if (!t?.title.trim()) return `第 ${ch + 1} 章`
  const name = shortTitle(t.title)
  return t.volume?.trim() ? `${shortTitle(t.volume)}·${name}` : name
}

/**
 * 给块起名。有章节标题时用书里的章名（“第三章～第四章”“第一部·第五章（2）”），否则按序号（“第 3～5 章”）。
 * 长章切开的几段加“（k）”。
 */
function labelSpans(spans: Array<Span & { sampled: boolean }>, lengths: number[], titles?: ChapterTitle[]): ChunkPlan[] {
  // 每章被切成几段，用来编号
  const piecesByChapter = new Map<number, Span[]>()
  for (const s of spans) {
    if (s.chapterStart === s.chapterEnd && (s.startOffset > 0 || s.endOffset < lengths[s.chapterStart])) {
      const list = piecesByChapter.get(s.chapterStart) ?? []
      list.push(s)
      piecesByChapter.set(s.chapterStart, list)
    }
  }
  return spans.map((s) => {
    let label: string
    if (s.chapterStart !== s.chapterEnd) {
      if (titles) {
        const start = chapterName(s.chapterStart, titles)
        let end = chapterName(s.chapterEnd, titles)
        // 同一卷里，结束章不再重复卷名
        const vs = titles[s.chapterStart]?.volume?.trim()
        if (vs && vs === titles[s.chapterEnd]?.volume?.trim()) end = shortTitle(titles[s.chapterEnd].title)
        label = `${start}～${end}`
      } else {
        label = `第 ${s.chapterStart + 1}～${s.chapterEnd + 1} 章`
      }
    } else {
      const base = titles ? chapterName(s.chapterStart, titles) : `第 ${s.chapterStart + 1} 章`
      const pieces = piecesByChapter.get(s.chapterStart)
      if (pieces) {
        const sorted = [...pieces].sort((a, b) => a.startOffset - b.startOffset)
        label = `${base}（${sorted.indexOf(s) + 1}）`
      } else {
        label = base
      }
    }
    return { ...s, id: spanId(s), label, sampled: s.sampled }
  })
}

/**
 * 规划分块。lengths 是每章正文的字数（下标即章节序号），selected 是选中的章节下标；
 * titles 是各章标题和卷名（给块起名用，不影响切法和 id）。
 * 返回按书中顺序排好的块（选中范围的块和抽样块混在一起按位置排序）。
 */
export function planChunks(lengths: number[], selected: Iterable<number>, options: ChunkOptions, titles?: ChapterTitle[]): ChunkPlan[] {
  const chunkChars = Math.max(MIN_CHUNK_CHARS, Math.floor(options.chunkChars))
  const picked = [...new Set(selected)].filter((i) => Number.isInteger(i) && i >= 0 && i < lengths.length).sort((a, b) => a - b)
  const pickedSet = new Set(picked)

  const spans: Array<Span & { sampled: boolean }> = []
  for (const run of toRuns(picked.filter((i) => lengths[i] > 0))) {
    for (const span of packRun(run, lengths, chunkChars)) spans.push({ ...span, sampled: false })
  }
  for (const span of sampleSpans(lengths, pickedSet, Math.max(0, Math.floor(options.sampleCount)), chunkChars)) {
    spans.push({ ...span, sampled: true })
  }
  spans.sort((a, b) => a.chapterStart - b.chapterStart || a.startOffset - b.startOffset)
  return labelSpans(spans, lengths, titles)
}

/** 块在书中的先后，用来排序和定“时间点” */
export function chunkOrder(plan: Pick<ChunkPlan, 'chapterStart' | 'startOffset'>): number {
  return plan.chapterStart * 1e8 + plan.startOffset
}

/** 切点往回对齐到段落开头（换行之后）；附近没有换行就原样切。相邻两块用同一个切点，所以对齐后仍然首尾相接 */
export function snapOffset(text: string, offset: number): number {
  if (offset <= 0) return 0
  if (offset >= text.length) return text.length
  const nl = text.lastIndexOf('\n', offset - 1)
  return nl >= 0 && offset - (nl + 1) <= SNAP_RANGE ? nl + 1 : offset
}

/** 取出一块的正文：每章前面加上【章节标题】，从章节中间开始的标注“接上文” */
export function chunkText(chapters: NovelChapter[], plan: ChunkPlan): string {
  const parts: string[] = []
  for (let ch = plan.chapterStart; ch <= plan.chapterEnd; ch++) {
    const chapter = chapters[ch]
    if (!chapter) continue
    const text = chapter.text
    const start = ch === plan.chapterStart ? snapOffset(text, plan.startOffset) : 0
    const end = ch === plan.chapterEnd ? snapOffset(text, plan.endOffset) : text.length
    if (end <= start) continue
    const title = [chapter.volume, chapter.title].filter(Boolean).join(' ')
    parts.push(`【${title}${start > 0 ? '（接上文）' : ''}】\n${text.slice(start, end).trim()}`)
  }
  return parts.join('\n\n')
}

/** 中文大约每字 0.75 个 token（用测试接口实测） */
export const TOKENS_PER_CHAR = 0.75
/** 每次抽取请求的提示词和已知人物名单大约多少 token */
const EXTRACT_OVERHEAD_TOKENS = 1500

export interface ExtractionEstimate {
  requests: number
  chars: number
  /** 输入 token（约） */
  inputTokens: number
  /** 输出 token（约，不含思考） */
  outputTokens: number
}

/** 估算抽取的请求数和 token（只是量级，界面上标“约”） */
export function estimateExtraction(plans: Array<Pick<ChunkPlan, 'chars'>>): ExtractionEstimate {
  let chars = 0
  let inputTokens = 0
  let outputTokens = 0
  for (const p of plans) {
    chars += p.chars
    inputTokens += p.chars * TOKENS_PER_CHAR + EXTRACT_OVERHEAD_TOKENS
    outputTokens += 1700 + p.chars * 0.07
  }
  return { requests: plans.length, chars, inputTokens: Math.round(inputTokens), outputTokens: Math.round(outputTokens) }
}
