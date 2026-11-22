/**
 * 助手单条修改提案卡片：实时预览原文与修改后的差异，支持应用、忽略、折叠查看与恢复。
 */
import { AlertTriangleIcon, CheckIcon, ChevronRightIcon, RotateCcwIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { TextDiffView } from '@/components/TextDiffView'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  ASSISTANT_FIELD_LABELS,
  AssistantEditError,
  previewEdit,
  type AssistantEdit,
  type EditPreview,
} from '@/core/ai/tasks/assistant'
import type { CharacterCardV3 } from '@/core/card/types'
import { cn } from '@/lib/utils'

export interface AssistantProposalProps {
  edit: AssistantEdit
  card: CharacterCardV3 | undefined
  status?: 'applied' | 'dismissed'
  onApply: () => void
  onDismiss: () => void
  onRestore: () => void
}

/** 预览失败或已应用后无法再按原文匹配时的兜底标题 */
function fallbackEditLabel(edit: AssistantEdit): string {
  switch (edit.op) {
    case 'set':
    case 'replace':
      switch (edit.target.kind) {
        case 'field':
          return ASSISTANT_FIELD_LABELS[edit.target.field]
        case 'greeting':
          return `备选开场白 ${edit.target.index + 1}`
        case 'entry':
          return `世界书条目「${edit.target.title}」`
      }
    case 'add_greeting':
      return '新备选开场白'
    case 'add_entry':
      return `新世界书条目「${edit.entry.comment || edit.entry.keys[0] || '未命名'}」`
    case 'entry_meta':
      return `世界书条目「${edit.title}」`
  }
}

function formatAppliedEntry(edit: Extract<AssistantEdit, { op: 'add_entry' }>): string {
  const name = edit.entry.comment || edit.entry.keys[0] || '（未命名）'
  const keys = edit.entry.keys.length > 0 ? edit.entry.keys.join('、') : '（无）'
  const keyLine = edit.entry.constant ? `关键词：${keys}（常驻）` : `关键词：${keys}`
  return `名称：${name}\n${keyLine}\n\n${edit.entry.content}`
}

function formatAppliedEntryMeta(edit: Extract<AssistantEdit, { op: 'entry_meta' }>): string {
  const lines: string[] = []
  if (edit.comment !== undefined) lines.push(`名称：${edit.comment}`)
  if (edit.keys !== undefined) lines.push(`关键词：${edit.keys.length > 0 ? edit.keys.join('、') : '（无）'}`)
  return lines.join('\n')
}

export function AssistantProposal({ edit, card, status, onApply, onDismiss, onRestore }: AssistantProposalProps) {
  const [expandedForStatus, setExpandedForStatus] = useState<'applied' | 'dismissed' | null>(null)

  const previewResult = useMemo<
    { ok: true; preview: EditPreview } | { ok: false; error: string }
  >(() => {
    if (!card) return { ok: false, error: '当前没有打开的角色卡' }
    try {
      return { ok: true, preview: previewEdit(card, edit) }
    } catch (e) {
      if (e instanceof AssistantEditError) {
        return { ok: false, error: e.message }
      }
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }, [card, edit])

  // 已应用的提案按当前卡片重算会变（如“第 N 条”），用提案本身的固定标题
  const label = previewResult.ok && status !== 'applied' ? previewResult.preview.label : fallbackEditLabel(edit)

  // 已应用 / 已忽略状态：默认折叠成一行，可点开查看
  if (status === 'applied' || status === 'dismissed') {
    const isExpanded = expandedForStatus === status
    const toggleExpand = () => setExpandedForStatus((prev) => (prev === status ? null : status))

    return (
      <div className="rounded-lg border bg-muted/20">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5">
          <button
            type="button"
            onClick={toggleExpand}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium hover:text-foreground"
            aria-expanded={isExpanded}
          >
            <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', isExpanded && 'rotate-90')} />
            <span className="truncate">{label}</span>
          </button>
          {status === 'applied' ? (
            <Badge variant="secondary" className="shrink-0 text-emerald-700 dark:text-emerald-400">
              <CheckIcon /> 已应用
            </Badge>
          ) : (
            <Badge variant="outline" className="shrink-0 text-muted-foreground">
              已忽略
            </Badge>
          )}
          <Button
            size="xs"
            variant="ghost"
            title={status === 'applied' ? '撤销了这处修改后，可以恢复成未处理再应用一次' : '恢复成未处理'}
            onClick={() => {
              setExpandedForStatus(null)
              onRestore()
            }}
          >
            <RotateCcwIcon /> 恢复
          </Button>
        </div>

        {isExpanded && (
          <div className="flex flex-col gap-2 border-t px-2.5 py-2">
            {edit.reason && <p className="text-xs text-muted-foreground">{edit.reason}</p>}
            <div className="max-h-72 overflow-auto rounded-md border bg-background p-1.5">
              {status === 'applied' ? (
                edit.op === 'replace' ? (
                  <TextDiffView before={edit.find} after={edit.replace} />
                ) : edit.op === 'set' || edit.op === 'add_greeting' ? (
                  <div className="whitespace-pre-wrap break-words px-1 text-sm leading-relaxed">{edit.value}</div>
                ) : edit.op === 'add_entry' ? (
                  <div className="whitespace-pre-wrap break-words px-1 text-sm leading-relaxed">{formatAppliedEntry(edit)}</div>
                ) : (
                  <div className="whitespace-pre-wrap break-words px-1 text-sm leading-relaxed">{formatAppliedEntryMeta(edit)}</div>
                )
              ) : previewResult.ok ? (
                previewResult.preview.isNew ? (
                  <div className="whitespace-pre-wrap break-words px-1 text-sm leading-relaxed">{previewResult.preview.after}</div>
                ) : (
                  <TextDiffView before={previewResult.preview.before} after={previewResult.preview.after} />
                )
              ) : (
                <p className="flex items-start gap-1.5 px-1 py-0.5 text-xs text-destructive">
                  <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                  <span>{previewResult.error}</span>
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  // 未处理提案：完整展示对比和操作按钮
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-2.5">
      <div className="flex flex-col gap-0.5">
        <div className="text-xs font-medium text-foreground">{label}</div>
        {edit.reason && <p className="text-xs text-muted-foreground">{edit.reason}</p>}
      </div>

      <div className="max-h-72 overflow-auto rounded-md border bg-muted/20 p-1.5">
        {previewResult.ok ? (
          previewResult.preview.isNew ? (
            <div className="whitespace-pre-wrap break-words px-1 text-sm leading-relaxed">{previewResult.preview.after}</div>
          ) : (
            <TextDiffView before={previewResult.preview.before} after={previewResult.preview.after} />
          )
        ) : (
          <p className="flex items-start gap-1.5 px-1 py-0.5 text-xs text-destructive">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>{previewResult.error}</span>
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          忽略
        </Button>
        <Button size="sm" disabled={!previewResult.ok} onClick={onApply}>
          <CheckIcon /> 应用
        </Button>
      </div>
    </div>
  )
}
