/**
 * 汇总去重：把各块抽取出的人物/地点/组织/名词按名字和别名合并成一个个对象，并应用用户在“整理”步骤里的修改。
 *
 * 合并规则：
 * - 同类、名字相同（规范化后）的一定合并；
 * - 别名能把两个名字连起来：某条的别名正好是另一条的名字，或者这个别名只被一个名字用过；
 * - 泛称（“大人”“师兄”“陈大人”这类多人共用的）不用来合并；
 * - 用户手动合并的一定合并，手动拆出的名字不再通过别名合并。
 * 用户的修改都记在“名字键”（kind:规范化名字）上，抽取结果增加、代表名字变化后仍然有效。
 */
import type {
  ChunkResult,
  EntityKind,
  EntityMention,
  ExtractedCharacter,
  ExtractedItem,
  ExtractedTerm,
  MergedEntity,
  ReviewOverrides,
} from './types'

/** 规范化名字：全半角统一、去空白和间隔点、拉丁字母小写 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[\s·•・‧]/g, '')
    .toLowerCase()
}

export function nameKey(kind: EntityKind, name: string): string {
  return `${kind}:${normalizeName(name)}`
}

/** 多人共用的称呼，不能用来判断是同一个人 */
const GENERIC_TERMS = new Set(
  (
    '大人 将军 公子 小姐 姑娘 先生 老爷 夫人 太太 少爷 少主 主人 主公 陛下 殿下 王爷 娘娘 皇上 圣上 大王 ' +
    '师父 师傅 师尊 师兄 师姐 师弟 师妹 师叔 师伯 徒弟 弟子 前辈 晚辈 道友 长老 掌门 宗主 ' +
    '大哥 二哥 三哥 大姐 二姐 哥哥 姐姐 弟弟 妹妹 父亲 母亲 爹 娘 爸爸 妈妈 爷爷 奶奶 叔叔 阿姨 ' +
    '老者 老人 少年 少女 青年 男子 女子 汉子 妇人 孩子 小孩 老头 老太 掌柜 小二 伙计 店家 老板 ' +
    '老师 同学 医生 大夫 郎中 侍卫 丫鬟 丫头 仆人 管家 士兵 将士 官员 大臣 皇帝 太子 公主 ' +
    '他 她 它 我 你 某人 那人 此人 对方 众人 小子 丫头片子 美人 佳人 恩公 恩人 贵人 客人 客官'
  ).split(/\s+/),
)

/** 姓氏/单字 + 称谓，如“陈大人”“韩师兄”“马太守”，同一本书里往往不止一个人这么叫 */
const SURNAME_TITLE =
  /^.{1,2}(大人|将军|公子|小姐|姑娘|先生|老爷|夫人|太太|少爷|大哥|大姐|兄|弟|姐|妹|哥|叔|伯|婶|姨|爷|老|师兄|师姐|师弟|师妹|师父|师傅|师叔|前辈|道友|掌柜|太守|刺史|校尉|都尉|都督|主簿|主记|从事|大师|真人|长老|宗主|阁下|同学|老师|总|董|经理|队长|局长|医生|大夫|捕头|县令|知县|知府|大夫人|二爷|三爷)$/

/** 单字或纯泛称（“大人”“师兄”） */
export function isGenericTerm(text: string): boolean {
  const n = normalizeName(text)
  return [...n].length < 2 || GENERIC_TERMS.has(n)
}

/** 姓加客套称呼（“冯大人”“马将军”“柳姑娘”），做世界书关键词会在提到同姓的人时误触发；“马太守”“黄祭酒”这种带具体官职的不算 */
const SURNAME_HONORIFIC =
  /^.{1,2}(大人|先生|公子|小姐|姑娘|老爷|夫人|太太|少爷|大哥|大姐|兄|弟|姐|妹|哥|叔|伯|婶|姨|爷|老|前辈|道友|阁下|将军|师兄|师姐|师弟|师妹)$/

export function isHonorificKey(text: string): boolean {
  return SURNAME_HONORIFIC.test(normalizeName(text))
}

/** 不能用来判断是同一个人的称呼：纯泛称，或者“陈大人”“韩师兄”这种姓加称谓 */
export function isGenericAlias(alias: string): boolean {
  return isGenericTerm(alias) || SURNAME_TITLE.test(normalizeName(alias))
}

const KIND_FIELD: Record<EntityKind, 'characters' | 'places' | 'organizations' | 'terms'> = {
  character: 'characters',
  place: 'places',
  organization: 'organizations',
  term: 'terms',
}

const KINDS: EntityKind[] = ['character', 'place', 'organization', 'term']

class UnionFind {
  private parent = new Map<string, string>()

  find(x: string): string {
    let root = x
    while (true) {
      const p = this.parent.get(root)
      if (p === undefined || p === root) break
      root = p
    }
    // 路径压缩
    let cur = x
    while (cur !== root) {
      const next = this.parent.get(cur) ?? root
      this.parent.set(cur, root)
      cur = next
    }
    if (!this.parent.has(root)) this.parent.set(root, root)
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(rb, ra)
  }
}

interface RawMention {
  kind: EntityKind
  key: string
  mention: EntityMention
}

function itemImportance(kind: EntityKind, item: ExtractedItem): number {
  return kind === 'character' ? (item as ExtractedCharacter).importance : 0
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>()
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best = ''
  let bestCount = 0
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v
      bestCount = c
    }
  }
  return best
}

/**
 * 合并所有块的抽取结果。返回全部对象（包括用户删掉的，用 isHidden 判断），
 * 人物在前，同类按权重从高到低排。
 */
export function mergeEntities(results: ChunkResult[], overrides: ReviewOverrides): MergedEntity[] {
  const sorted = [...results].sort((a, b) => a.order - b.order)
  const splits = new Set(overrides.splits)
  const out: MergedEntity[] = []

  for (const kind of KINDS) {
    const raws: RawMention[] = []
    for (const r of sorted) {
      for (const item of r.extraction[KIND_FIELD[kind]] as ExtractedItem[]) {
        raws.push({ kind, key: nameKey(kind, item.name), mention: { chunkId: r.chunkId, order: r.order, label: r.label, item } })
      }
    }
    if (raws.length === 0) continue

    const primaryKeys = new Set(raws.map((r) => r.key))
    // 每个别名被哪些名字用过
    const aliasOwners = new Map<string, Set<string>>()
    for (const r of raws) {
      for (const alias of r.mention.item.aliases) {
        const ak = nameKey(kind, alias)
        if (ak === r.key) continue
        const owners = aliasOwners.get(ak) ?? new Set<string>()
        owners.add(r.key)
        aliasOwners.set(ak, owners)
      }
    }

    const uf = new UnionFind()
    for (const r of raws) uf.find(r.key)
    for (const r of raws) {
      if (splits.has(r.key)) continue
      for (const alias of r.mention.item.aliases) {
        const ak = nameKey(kind, alias)
        if (ak === r.key || splits.has(ak) || isGenericAlias(alias)) continue
        const isName = primaryKeys.has(ak)
        const owners = aliasOwners.get(ak)
        if (isName || (owners && owners.size === 1)) uf.union(r.key, ak)
      }
    }
    for (const [a, b] of overrides.merges) {
      if (a.startsWith(`${kind}:`) && b.startsWith(`${kind}:`)) uf.union(a, b)
    }

    // 按根分组
    const groups = new Map<string, RawMention[]>()
    for (const r of raws) {
      const root = uf.find(r.key)
      const list = groups.get(root) ?? []
      list.push(r)
      groups.set(root, list)
    }
    // 手动合并时，组里可能有只出现在 merges 里、没有对应抽取结果的键；顺带收集组里所有键
    const groupKeys = new Map<string, Set<string>>()
    const allKeys = new Set<string>([...primaryKeys, ...aliasOwners.keys()])
    for (const [a, b] of overrides.merges) {
      if (a.startsWith(`${kind}:`)) allKeys.add(a)
      if (b.startsWith(`${kind}:`)) allKeys.add(b)
    }
    for (const k of allKeys) {
      const root = uf.find(k)
      if (!groups.has(root)) continue
      const set = groupKeys.get(root) ?? new Set<string>()
      set.add(k)
      groupKeys.set(root, set)
    }

    const entities: MergedEntity[] = []
    for (const [root, members] of groups) {
      // 代表名字：出现次数最多的名字键，一样多取靠前的
      const counts = new Map<string, number>()
      for (const m of members) counts.set(m.key, (counts.get(m.key) ?? 0) + 1)
      let id = members[0].key
      for (const m of members) if ((counts.get(m.key) ?? 0) > (counts.get(id) ?? 0)) id = m.key

      const keys = [...(groupKeys.get(root) ?? new Set([id]))]
      // 名字的原始写法：出现最多的写法
      const nameForms = new Map<string, string[]>()
      const aliasCounts = new Map<string, { text: string; count: number }>()
      for (const m of members) {
        const list = nameForms.get(m.key) ?? []
        list.push(m.mention.item.name)
        nameForms.set(m.key, list)
        for (const text of [m.mention.item.name, ...m.mention.item.aliases]) {
          const nk = normalizeName(text)
          const prev = aliasCounts.get(nk)
          if (prev) prev.count++
          else aliasCounts.set(nk, { text, count: 1 })
        }
      }
      const autoName = mostCommon(nameForms.get(id) ?? [])
      const renamed = overrides.renames[id] ?? keys.map((k) => overrides.renames[k]).find((v) => v?.trim())
      const name = renamed?.trim() || autoName
      const nameNorm = normalizeName(name)
      const aliases = [...aliasCounts.entries()]
        .filter(([nk]) => nk !== nameNorm)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([, v]) => v.text)

      const mentions = members.map((m) => m.mention).sort((a, b) => a.order - b.order)
      const importance = Math.max(0, ...mentions.map((m) => itemImportance(kind, m.item)))
      // 同一块里出现两次（不同名字被合并到一起）只算一次
      const perChunk = new Map<string, number>()
      for (const m of mentions) {
        perChunk.set(m.chunkId, Math.max(perChunk.get(m.chunkId) ?? 0, kind === 'character' ? itemImportance(kind, m.item) : 1))
      }
      const weight = [...perChunk.values()].reduce((a, b) => a + b, 0)
      const gender = kind === 'character' ? mostCommon(mentions.map((m) => (m.item as ExtractedCharacter).gender)) : ''

      entities.push({ id, kind, name, keys, aliases, mentions, importance, weight, gender })
    }
    entities.sort((a, b) => b.weight - a.weight || a.mentions[0].order - b.mentions[0].order)
    out.push(...entities)
  }
  return out
}

// ---------- 用户修改 ----------

export function isHidden(entity: MergedEntity, overrides: ReviewOverrides): boolean {
  return entity.keys.some((k) => overrides.hidden.includes(k))
}

/** 默认勾选进世界书的：重要人物，以及出现在不止一块里的地点/组织/名词（只有一两块时全选） */
export function isRecommended(entity: MergedEntity, chunkCount: number): boolean {
  const chunks = new Set(entity.mentions.map((m) => m.chunkId)).size
  if (entity.kind === 'character') return entity.importance >= 3 || entity.weight >= 6
  return chunks >= 2 || chunkCount <= 2
}

export function isSelected(entity: MergedEntity, overrides: ReviewOverrides, chunkCount: number): boolean {
  if (overrides.selected === null) return isRecommended(entity, chunkCount)
  return entity.keys.some((k) => overrides.selected!.includes(k))
}

/** 勾选/取消；第一次改动时先把推荐勾选展开成具体的名字键 */
export function setSelected(
  overrides: ReviewOverrides,
  entities: MergedEntity[],
  targets: MergedEntity[],
  on: boolean,
  chunkCount: number,
): ReviewOverrides {
  const current = new Set(
    overrides.selected ?? entities.filter((e) => isRecommended(e, chunkCount)).flatMap((e) => e.keys),
  )
  for (const t of targets) {
    for (const k of t.keys) {
      if (on) current.add(k)
      else current.delete(k)
    }
  }
  return { ...overrides, selected: [...current] }
}

export function setHidden(overrides: ReviewOverrides, targets: MergedEntity[], hidden: boolean): ReviewOverrides {
  const set = new Set(overrides.hidden)
  for (const t of targets) {
    for (const k of t.keys) {
      if (hidden) set.add(k)
      else set.delete(k)
    }
  }
  return { ...overrides, hidden: [...set] }
}

/** 把几个对象合成一个（第一个的名字作为显示名，除非已经改过名） */
export function mergeOverride(overrides: ReviewOverrides, targets: MergedEntity[]): ReviewOverrides {
  if (targets.length < 2) return overrides
  const [first, ...rest] = targets
  const merges = [...overrides.merges]
  for (const t of rest) {
    if (t.kind !== first.kind) continue
    merges.push([first.id, t.id])
  }
  // 拆出过的名字，用户又手动合并了，就不再算拆出
  const restKeys = new Set(rest.flatMap((t) => t.keys))
  const splits = overrides.splits.filter((k) => !restKeys.has(k) && !first.keys.includes(k))
  const renames = { ...overrides.renames }
  if (!first.keys.some((k) => renames[k])) {
    for (const k of first.keys) renames[k] = first.name
  }
  return { ...overrides, merges, splits, renames }
}

/**
 * 从对象里拆出一个名字（连同只用这个名字的那些资料）：这个名字不再通过别名合并，相关的手动合并也撤掉。
 */
export function splitOverride(overrides: ReviewOverrides, key: string): ReviewOverrides {
  const renames = { ...overrides.renames }
  delete renames[key]
  return {
    ...overrides,
    splits: overrides.splits.includes(key) ? overrides.splits : [...overrides.splits, key],
    merges: overrides.merges.filter(([a, b]) => a !== key && b !== key),
    renames,
  }
}

export function renameOverride(overrides: ReviewOverrides, entity: MergedEntity, name: string): ReviewOverrides {
  const renames = { ...overrides.renames }
  for (const k of entity.keys) {
    if (name.trim()) renames[k] = name.trim()
    else delete renames[k]
  }
  return { ...overrides, renames }
}

/** 对象里每个名字（按出现次数）及其出现的块数，界面上“拆出”用 */
export function entityNames(entity: MergedEntity): Array<{ key: string; name: string; mentions: number }> {
  const map = new Map<string, { key: string; name: string; mentions: number }>()
  for (const m of entity.mentions) {
    const key = nameKey(entity.kind, m.item.name)
    const prev = map.get(key)
    if (prev) prev.mentions++
    else map.set(key, { key, name: m.item.name, mentions: 1 })
  }
  return [...map.values()].sort((a, b) => b.mentions - a.mentions)
}

// ---------- 时间线、世界观、剧情概要 ----------

export interface TimelineItem {
  chunkId: string
  order: number
  label: string
  title: string
  summary: string
  characters: string[]
  place: string
  importance: number
}

function upTo<T extends { order: number }>(items: T[], maxOrder?: number): T[] {
  const list = maxOrder === undefined ? items : items.filter((i) => i.order <= maxOrder)
  return [...list].sort((a, b) => a.order - b.order)
}

export function collectTimeline(results: ChunkResult[], maxOrder?: number): TimelineItem[] {
  const out: TimelineItem[] = []
  for (const r of upTo(results, maxOrder)) {
    for (const e of r.extraction.events) {
      out.push({ chunkId: r.chunkId, order: r.order, label: r.label, ...e })
    }
  }
  return out
}

/** 世界观条目去重（规范化后相同的只留一条） */
export function collectWorld(results: ChunkResult[], maxOrder?: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of upTo(results, maxOrder)) {
    for (const w of r.extraction.world) {
      const k = normalizeName(w).replace(/[，。、；：,.;:！!？?“”"']/g, '')
      if (!k || seen.has(k)) continue
      seen.add(k)
      out.push(w)
    }
  }
  return out
}

export function collectSummaries(results: ChunkResult[], maxOrder?: number): Array<{ label: string; order: number; summary: string }> {
  return upTo(results, maxOrder)
    .filter((r) => r.extraction.summary)
    .map((r) => ({ label: r.label, order: r.order, summary: r.extraction.summary }))
}

// ---------- 给模型看的资料 ----------

function formatMention(kind: EntityKind, item: ExtractedItem): string {
  const lines: string[] = []
  if (kind === 'character') {
    const c = item as ExtractedCharacter
    if (c.identity) lines.push(`身份：${c.identity}`)
    if (c.appearance) lines.push(`外貌：${c.appearance}`)
    if (c.personality) lines.push(`性格：${c.personality}`)
    if (c.abilities) lines.push(`能力：${c.abilities}`)
    if (c.relations.length) lines.push(`关系：${c.relations.map((r) => (r.relation ? `${r.name}（${r.relation}）` : r.name)).join('；')}`)
    for (const f of c.facts) lines.push(`- ${f}`)
    for (const q of c.quotes) lines.push(`台词：「${q}」`)
  } else if (kind === 'term') {
    const t = item as ExtractedTerm
    if (t.category) lines.push(`类别：${t.category}`)
    if (t.description) lines.push(t.description)
  } else {
    const p = item as Exclude<ExtractedItem, ExtractedCharacter | ExtractedTerm>
    if (p.description) lines.push(p.description)
    if ('members' in p && p.members.length) lines.push(`成员：${p.members.join('、')}`)
    for (const f of p.facts) lines.push(`- ${f}`)
  }
  return lines.join('\n')
}

/**
 * 把一个对象各块的资料拼成给模型看的文本（按书中顺序，每块一小节）。
 * maxOrder：只用这个位置之前的资料（时间点）；maxChars：超长时保留第一块和最近的块，省略中间。
 */
export function formatEntityNotes(entity: MergedEntity, options: { maxOrder?: number; maxChars?: number } = {}): string {
  const mentions = entity.mentions.filter((m) => options.maxOrder === undefined || m.order <= options.maxOrder)
  const blocks = mentions.map((m) => `### ${m.label}\n${formatMention(entity.kind, m.item)}`.trim())
  const maxChars = options.maxChars ?? Infinity
  const total = blocks.reduce((sum, b) => sum + b.length + 1, 0)
  if (total <= maxChars || blocks.length <= 2) return blocks.join('\n')

  // 保留第一块，再从最近的往前加，放不下的省略
  const keep: string[] = []
  let used = blocks[0].length + 1
  let i = blocks.length - 1
  for (; i >= 1; i--) {
    if (used + blocks[i].length + 1 > maxChars) break
    keep.unshift(blocks[i])
    used += blocks[i].length + 1
  }
  const skipped = i
  return [blocks[0], ...(skipped > 0 ? [`（中间省略 ${skipped} 段资料）`] : []), ...keep].join('\n')
}

/**
 * 时间点之前出现过的其他称呼（按出现次数排序，不含显示名）。
 * 后面才揭晓的身份（比如某人其实就是“烛龙”）不能提前写进条目，免得剧透。
 */
export function aliasesUpTo(entity: MergedEntity, maxOrder?: number): string[] {
  if (maxOrder === undefined) return entity.aliases
  const counts = new Map<string, { text: string; count: number }>()
  const self = normalizeName(entity.name)
  for (const m of entity.mentions) {
    if (m.order > maxOrder) continue
    for (const text of [m.item.name, ...m.item.aliases]) {
      const k = normalizeName(text)
      if (k === self) continue
      const prev = counts.get(k)
      if (prev) prev.count++
      else counts.set(k, { text, count: 1 })
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).map((v) => v.text)
}

/** 人物一句话简介：最近一块里的身份 */
export function entityBrief(entity: MergedEntity, maxOrder?: number): string {
  const mentions = entity.mentions.filter((m) => maxOrder === undefined || m.order <= maxOrder)
  for (let i = mentions.length - 1; i >= 0; i--) {
    const item = mentions[i].item
    const text =
      entity.kind === 'character'
        ? (item as ExtractedCharacter).identity
        : 'description' in item
          ? item.description
          : ''
    if (text) return text
  }
  return ''
}
