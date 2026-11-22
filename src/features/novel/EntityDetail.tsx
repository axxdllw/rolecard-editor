/**
 * ③ 整理步骤的对象详情面板：改名、拆出名字、勾选进世界书、删除/恢复，以及按章节块展示各段资料。
 */
import { CheckIcon, CopyIcon, RotateCcwIcon, SplitIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { entityNames, formatEntityNotes } from '@/core/novel/merge'
import {
  ENTITY_KIND_LABELS,
  type ExtractedCharacter,
  type ExtractedOrganization,
  type ExtractedPlace,
  type ExtractedTerm,
  type MergedEntity,
} from '@/core/novel/types'
import { entityChunkCount } from './novelHelpers'

export interface EntityDetailProps {
  entity: MergedEntity
  selected: boolean
  hidden: boolean
  onRename: (entity: MergedEntity, name: string) => void
  onToggleSelect: (entity: MergedEntity, on: boolean) => void
  onToggleHide: (entity: MergedEntity, hidden: boolean) => void
  onSplit: (key: string) => void
}

function MentionFields({ entity, item }: { entity: MergedEntity; item: MergedEntity['mentions'][number]['item'] }) {
  if (entity.kind === 'character') {
    const c = item as ExtractedCharacter
    return (
      <div className="flex flex-col gap-1.5 text-sm">
        {c.identity && (
          <p>
            <span className="font-medium text-muted-foreground">身份：</span>
            {c.identity}
          </p>
        )}
        {c.appearance && (
          <p>
            <span className="font-medium text-muted-foreground">外貌：</span>
            {c.appearance}
          </p>
        )}
        {c.personality && (
          <p>
            <span className="font-medium text-muted-foreground">性格：</span>
            {c.personality}
          </p>
        )}
        {c.abilities && (
          <p>
            <span className="font-medium text-muted-foreground">能力：</span>
            {c.abilities}
          </p>
        )}
        {c.relations.length > 0 && (
          <p>
            <span className="font-medium text-muted-foreground">关系：</span>
            {c.relations.map((r) => (r.relation ? `${r.name}（${r.relation}）` : r.name)).join('；')}
          </p>
        )}
        {c.facts.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-muted-foreground">经历：</span>
            <ul className="list-disc space-y-0.5 pl-4">
              {c.facts.map((fact, idx) => (
                <li key={idx}>{fact}</li>
              ))}
            </ul>
          </div>
        )}
        {c.quotes.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="font-medium text-muted-foreground">台词：</span>
            {c.quotes.map((q, idx) => (
              <blockquote key={idx} className="border-l-2 pl-2.5 text-xs text-muted-foreground">
                「{q}」
              </blockquote>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (entity.kind === 'term') {
    const t = item as ExtractedTerm
    return (
      <div className="flex flex-col gap-1.5 text-sm">
        {t.category && (
          <p>
            <span className="font-medium text-muted-foreground">类别：</span>
            {t.category}
          </p>
        )}
        {t.description && <p className="whitespace-pre-wrap">{t.description}</p>}
      </div>
    )
  }

  if (entity.kind === 'organization') {
    const o = item as ExtractedOrganization
    return (
      <div className="flex flex-col gap-1.5 text-sm">
        {o.description && <p className="whitespace-pre-wrap">{o.description}</p>}
        {o.members.length > 0 && (
          <p>
            <span className="font-medium text-muted-foreground">成员：</span>
            {o.members.join('、')}
          </p>
        )}
        {o.facts.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-4">
            {o.facts.map((fact, idx) => (
              <li key={idx}>{fact}</li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  const p = item as ExtractedPlace
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      {p.description && <p className="whitespace-pre-wrap">{p.description}</p>}
      {p.facts.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4">
          {p.facts.map((fact, idx) => (
            <li key={idx}>{fact}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function EntityDetail({
  entity,
  selected,
  hidden,
  onRename,
  onToggleSelect,
  onToggleHide,
  onSplit,
}: EntityDetailProps) {
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const displayName = nameDraft ?? entity.name
  const names = entityNames(entity)
  const chunks = entityChunkCount(entity)

  const commitName = () => {
    if (nameDraft === null) return
    const next = nameDraft.trim()
    setNameDraft(null)
    if (next !== entity.name) {
      onRename(entity, next)
    }
  }

  const copyNotes = async () => {
    try {
      await navigator.clipboard.writeText(formatEntityNotes(entity))
      setCopied(true)
      toast.success('已复制资料原文')
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('复制失败')
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 名字与操作 */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <Label htmlFor="entity-rename" className="text-xs text-muted-foreground">
            名字（清空可恢复自动命名）
          </Label>
          <Input
            id="entity-rename"
            value={displayName}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.currentTarget.blur()
              }
            }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Badge variant="secondary">{ENTITY_KIND_LABELS[entity.kind]}</Badge>
          {entity.kind === 'character' && entity.gender && <Badge variant="outline">{entity.gender}</Badge>}
          {entity.kind === 'character' && entity.importance > 0 && (
            <span className="text-amber-600 dark:text-amber-400">★{entity.importance}</span>
          )}
          <span>出现 {chunks} 段</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={selected} onCheckedChange={(v) => onToggleSelect(entity, v === true)} />
            进世界书
          </label>
          <div className="flex-1" />
          <Button size="xs" variant="outline" onClick={() => void copyNotes()}>
            {copied ? <CheckIcon /> : <CopyIcon />} 复制资料
          </Button>
          {hidden ? (
            <Button size="xs" variant="outline" onClick={() => onToggleHide(entity, false)}>
              <RotateCcwIcon /> 恢复
            </Button>
          ) : (
            <Button size="xs" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => onToggleHide(entity, true)}>
              <Trash2Icon /> 删除
            </Button>
          )}
        </div>
      </div>

      {/* 别名 */}
      {entity.aliases.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">别名与称呼</h4>
          <div className="flex flex-wrap gap-1">
            {entity.aliases.map((alias) => (
              <Badge key={alias} variant="outline" className="font-normal">
                {alias}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* 组成这个对象的名字（可拆出） */}
      {names.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <h4 className="text-xs font-medium text-muted-foreground">组成这个对象的名字</h4>
            {names.length > 1 && <span className="text-[11px] text-muted-foreground">拆出后不再自动并进来</span>}
          </div>
          <div className="flex flex-col gap-1">
            {names.map((n) => (
              <div key={n.key} className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm">
                <div className="min-w-0 truncate">
                  <span>{n.name}</span>
                  <span className="ml-1.5 text-xs text-muted-foreground">出现 {n.mentions} 次</span>
                </div>
                {names.length > 1 && (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="shrink-0"
                    title="把这个名字拆成独立对象，不再自动并进来"
                    onClick={() => onSplit(n.key)}
                  >
                    <SplitIcon /> 拆出
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <Separator />

      {/* 各段资料 */}
      <div className="flex flex-col gap-3">
        <h4 className="text-xs font-medium text-muted-foreground">各段资料（共 {entity.mentions.length} 条）</h4>
        {entity.mentions.map((m, idx) => (
          <section key={`${m.chunkId}-${idx}`} className="flex flex-col gap-1.5 rounded-lg border bg-muted/20 p-3">
            <h5 className="text-xs font-medium text-foreground">{m.label}</h5>
            <MentionFields entity={entity} item={m.item} />
          </section>
        ))}
      </div>
    </div>
  )
}
