import { ChevronDownIcon, ChevronRightIcon, LoaderIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { CardAvatar } from '@/components/CardAvatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { parseTerms, splitHighlights, type CardMatch, type SlotMatch } from '@/core/search/fullText'
import type { CardRecord } from '@/db/db'

/** 每张卡默认列出几处命中，其余点「展开」 */
const COLLAPSED_SLOTS = 3
/** 一次显示多少张卡，命中很多时分批渲染 */
const CARDS_PER_PAGE = 30

function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {splitHighlights(text, terms).map((part, i) =>
        part.hit ? (
          <mark key={i} className="rounded-sm bg-amber-200 px-0.5 text-inherit dark:bg-amber-500/40">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  )
}

function SlotRow({ slot, terms, onOpen }: { slot: SlotMatch; terms: string[]; onOpen: () => void }) {
  const { before, match, after } = slot.snippet
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none active:bg-muted"
    >
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{slot.label}</span>
        {slot.count > 1 && <span className="shrink-0">{slot.count} 处</span>}
      </span>
      <span className="line-clamp-3 text-sm break-all sm:line-clamp-2">
        <Highlighted text={before + match + after} terms={terms} />
      </span>
    </button>
  )
}

function CardGroup({
  match,
  record,
  terms,
  onOpen,
}: {
  match: CardMatch
  record: CardRecord | undefined
  terms: string[]
  onOpen: (slot: SlotMatch | null) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? match.slots : match.slots.slice(0, COLLAPSED_SLOTS)
  const hidden = match.slots.length - shown.length
  const unlisted = match.slotCount - match.slots.length

  return (
    <section className="overflow-hidden rounded-xl border bg-card" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 220px' }}>
      <button
        type="button"
        onClick={() => onOpen(null)}
        className="flex w-full items-center gap-3 border-b bg-muted/30 px-3 py-2 text-left hover:bg-muted/60"
      >
        <CardAvatar blob={record?.avatar ?? null} name={match.name} className="h-10 w-7 shrink-0 rounded text-sm" />
        <span className="min-w-0 flex-1 truncate font-medium">{match.name || '未命名'}</span>
        <Badge variant="secondary" className="shrink-0">
          {match.total} 处
        </Badge>
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
      </button>
      <div className="divide-y">
        {shown.map((slot) => (
          <SlotRow key={slot.slotIndex} slot={slot} terms={terms} onOpen={() => onOpen(slot)} />
        ))}
      </div>
      {(hidden > 0 || (expanded && unlisted > 0)) && (
        <div className="border-t px-3 py-1.5 text-xs text-muted-foreground">
          {hidden > 0 ? (
            <button type="button" className="flex items-center gap-1 py-1 hover:text-foreground" onClick={() => setExpanded(true)}>
              <ChevronDownIcon className="size-3.5" /> 展开其余 {hidden} 处位置
            </button>
          ) : (
            <span>还有 {unlisted} 处位置没有列出，打开卡片后可用「快捷修改」查看全部</span>
          )}
        </div>
      )}
    </section>
  )
}

export function FullTextResults({
  results,
  searched,
  pending,
  error,
  records,
  onOpen,
}: {
  results: CardMatch[] | null
  searched: string
  pending: boolean
  error: string | null
  records: Map<string, CardRecord>
  onOpen: (cardId: string, slot: SlotMatch | null) => void
}) {
  const terms = useMemo(() => parseTerms(searched), [searched])
  const total = results?.reduce((sum, r) => sum + r.total, 0) ?? 0
  const [limit, setLimit] = useState({ results, count: CARDS_PER_PAGE })
  // 换了一批结果就从头分页
  if (limit.results !== results) setLimit({ results, count: CARDS_PER_PAGE })

  if (error) return <p className="py-10 text-center text-sm text-destructive">全文搜索出错：{error}</p>
  if (!results) {
    return (
      <p className="flex items-center justify-center gap-2 py-10 text-center text-sm text-muted-foreground">
        {pending ? <LoaderIcon className="size-4 shrink-0 animate-spin" /> : null}
        输入关键词，在所有卡的描述、开场白、示例对话、世界书和正则里查找。多个词用空格分开。
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        {results.length > 0 ? `${results.length} 张卡里找到 ${total} 处` : `没有卡包含「${searched}」`}
        {pending && <LoaderIcon className="size-3.5 animate-spin" />}
      </p>
      {results.slice(0, limit.count).map((match) => (
        <CardGroup key={match.id} match={match} record={records.get(match.id)} terms={terms} onOpen={(slot) => onOpen(match.id, slot)} />
      ))}
      {results.length > limit.count && (
        <Button variant="outline" className="self-center" onClick={() => setLimit({ results, count: limit.count + CARDS_PER_PAGE })}>
          再显示 {Math.min(CARDS_PER_PAGE, results.length - limit.count)} 张（还有 {results.length - limit.count} 张）
        </Button>
      )}
    </div>
  )
}
