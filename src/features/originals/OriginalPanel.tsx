/**
 * 与原件对比：编辑页标题下的状态标签 + 侧边面板。
 * 原件是导入时自动存的那一版；改动可以单处还原，也可以整卡还原（都能撤销）。
 */
import type { Draft } from 'immer'
import { ChevronRightIcon, HistoryIcon, RotateCcwIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { CardAvatar } from '@/components/CardAvatar'
import { confirm } from '@/components/confirm'
import { TextDiffView } from '@/components/TextDiffView'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { isRestorable, restoreChange, type CardChange, type CardChangeGroup } from '@/core/card/compare'
import type { CharacterCardV3 } from '@/core/card/types'
import { uuid } from '@/core/util/id'
import { formatTime } from '@/lib/format'
import { useIsDesktop } from '@/lib/useMediaQuery'
import { cn } from '@/lib/utils'
import { updateCard } from '@/features/editor/cardDoc'
import { originalAvatar, saveBaseline, setCardAvatar } from '@/services/originals'
import type { OriginalState } from './useOriginalState'

const GROUP_ORDER: CardChangeGroup[] = ['角色字段', '开场白', '世界书', '正则', '酒馆助手脚本', '扩展数据', '其他']

const KIND_TEXT: Record<CardChange['kind'], string> = {
  changed: '改动',
  added: '新增',
  removed: '删除',
  reordered: '顺序',
}

export function OriginalSummary({ state, onOpen }: { state: OriginalState; onOpen: () => void }) {
  const { original, changes, avatarChanged } = state
  if (original === undefined) return null
  const count = (changes?.length ?? 0) + (avatarChanged ? 1 : 0)
  const text = original === null ? '未记原件' : count === 0 ? '与原件一致' : `相对原件改了 ${count} 处`
  return (
    <button
      type="button"
      onClick={onOpen}
      title="与原件对比：看改了哪些地方，可以单处或整卡还原"
      className={cn(
        'flex shrink-0 items-center gap-1 rounded-md px-1 text-xs hover:bg-muted hover:text-foreground',
        count > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground',
      )}
    >
      <HistoryIcon className="size-3" />
      {text}
    </button>
  )
}

function isPrimitive(value: unknown): boolean {
  return value === null || typeof value !== 'object'
}

function truncate(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}\n…（还有 ${text.length - max} 字）` : text
}

/** 值的预览：文本直接显示，带 content 的对象（世界书条目、脚本）显示 content，其余显示 JSON */
function preview(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const content = (value as Record<string, unknown>).content
    if (typeof content === 'string') return content
  }
  return JSON.stringify(value, null, 2) ?? String(value)
}

function Block({ tone, title, text }: { tone: 'del' | 'ins'; title: string; text: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{title}</span>
      <div
        className={cn(
          'max-h-60 overflow-y-auto whitespace-pre-wrap break-words border-l-2 px-2 text-sm',
          tone === 'del' ? 'border-red-500 bg-red-500/5' : 'border-green-600 bg-green-500/5',
        )}
      >
        {truncate(text) || '（空）'}
      </div>
    </div>
  )
}

function ChangeDetail({ change }: { change: CardChange }) {
  const { kind, before, after } = change
  if (kind === 'reordered') {
    return (
      <div className="flex flex-col gap-1 text-sm">
        <p>
          <span className="text-muted-foreground">原来：</span>
          {(before as string[]).join(' → ')}
        </p>
        <p>
          <span className="text-muted-foreground">现在：</span>
          {(after as string[]).join(' → ')}
        </p>
      </div>
    )
  }
  if (kind === 'added') return <Block tone="ins" title="新增的内容" text={preview(after)} />
  if (kind === 'removed') return <Block tone="del" title="原件里的内容" text={preview(before)} />
  if (typeof before === 'string' && typeof after === 'string') return <TextDiffView before={before} after={after} />
  if (Array.isArray(before) && Array.isArray(after) && before.every(isPrimitive) && after.every(isPrimitive)) {
    // 按现在的顺序列出，新增的标绿；删掉的标红放在最后
    const removed = before.filter((v) => !after.includes(v))
    return (
      <div className="flex flex-wrap gap-1">
        {after.map((v, i) =>
          before.includes(v) ? (
            <Badge key={`k${i}`} variant="secondary">
              {String(v)}
            </Badge>
          ) : (
            <Badge key={`a${i}`} variant="outline" className="border-green-600/50 text-green-700 dark:text-green-400">
              {String(v)}
            </Badge>
          ),
        )}
        {removed.map((v, i) => (
          <Badge key={`d${i}`} variant="outline" className="border-red-500/50 text-red-700 line-through dark:text-red-400">
            {String(v)}
          </Badge>
        ))}
        {removed.length === 0 && after.every((v) => before.includes(v)) && <span className="text-xs text-muted-foreground">只是顺序变了</span>}
      </div>
    )
  }
  if (isPrimitive(before) && isPrimitive(after)) {
    return (
      <p className="text-sm">
        <span className="text-red-700 line-through dark:text-red-400">{JSON.stringify(before)}</span>
        {' → '}
        <span className="text-green-700 dark:text-green-400">{JSON.stringify(after)}</span>
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <Block tone="del" title="原件" text={preview(before)} />
      <Block tone="ins" title="现在" text={preview(after)} />
    </div>
  )
}

function ChangeItem({ change }: { change: CardChange }) {
  const restorable = isRestorable(change)
  return (
    <Collapsible className="rounded-lg border">
      <div className="flex items-center gap-1 pr-1">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 p-2 text-left text-sm">
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <span className="truncate">{change.label}</span>
          <Badge variant="secondary" className="shrink-0">
            {KIND_TEXT[change.kind]}
          </Badge>
        </CollapsibleTrigger>
        {restorable && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => {
              updateCard((d) => void restoreChange(d.card as CharacterCardV3, change), { label: `还原「${change.label}」` })
              toast(`已还原「${change.label}」，可以撤销`, { id: 'restore', duration: 1500 })
            }}
          >
            <RotateCcwIcon /> 还原
          </Button>
        )}
      </div>
      <CollapsibleContent className="border-t p-2">
        <ChangeDetail change={change} />
      </CollapsibleContent>
    </Collapsible>
  )
}

const PAGE = 100

function ChangeList({ changes }: { changes: CardChange[] }) {
  const [limit, setLimit] = useState(PAGE)
  const shown = changes.slice(0, limit)
  const groups = GROUP_ORDER.map((g) => ({ group: g, items: shown.filter((c) => c.group === g) })).filter((g) => g.items.length > 0)
  return (
    <div className="flex flex-col gap-4">
      {groups.map(({ group, items }) => (
        <section key={group} className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium">
            {group} <span className="text-xs font-normal text-muted-foreground">{items.length}</span>
          </h3>
          {items.map((c) => (
            <ChangeItem key={`${c.kind}|${(c.path ?? c.originalPath ?? []).join('.')}`} change={c} />
          ))}
        </section>
      ))}
      {changes.length > limit && (
        <Button variant="outline" size="sm" onClick={() => setLimit(limit + PAGE)}>
          还有 {changes.length - limit} 处，继续显示
        </Button>
      )}
    </div>
  )
}

interface OriginalSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  cardId: string
  card: CharacterCardV3
  state: OriginalState
  avatar: Blob | null
  onAvatarChange: (avatar: Blob | null) => void
}

export function OriginalSheet({ open, onOpenChange, cardId, card, state, avatar, onAvatarChange }: OriginalSheetProps) {
  const isDesktop = useIsDesktop()
  const { original, changes, avatarChanged } = state

  const restoreAvatar = async () => {
    if (!original) return
    const blob = originalAvatar(original, avatar)
    await setCardAvatar(cardId, blob)
    onAvatarChange(blob)
  }

  const restoreAll = async () => {
    if (!original) return
    const ok = await confirm({
      title: '整卡还原到原件？',
      description: avatarChanged
        ? '卡片内容会变回原件（可以撤销）；头像也会换回原来的（头像不在撤销记录里）。'
        : '卡片内容会变回原件，之后可以撤销。',
      confirmText: '还原',
      destructive: true,
    })
    if (!ok) return
    const restored = structuredClone(original.card)
    updateCard(
      (d) => {
        d.card = restored as Draft<CharacterCardV3>
        d.entryKeys = (restored.data.character_book?.entries ?? []).map(() => uuid())
      },
      { label: '整卡还原到原件' },
    )
    if (avatarChanged) await restoreAvatar()
    toast.success('已还原到原件，可以撤销')
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isDesktop ? 'right' : 'bottom'}
        className={cn('gap-4 overflow-y-auto p-4', isDesktop ? 'data-[side=right]:sm:max-w-xl' : 'data-[side=bottom]:h-[85svh]')}
      >
        <SheetHeader className="p-0">
          <SheetTitle>与原件对比</SheetTitle>
          <SheetDescription>
            {original
              ? `${original.kind === 'import' ? '原件是导入时的版本' : '原件是手动记下的版本'}（${formatTime(original.createdAt)}${original.fileName ? `，${original.fileName}` : ''}）。改动可以单处还原，也可以整卡还原，都能撤销。`
              : '导入的卡会自动保存一份原件，用来对比改动和还原。'}
          </SheetDescription>
        </SheetHeader>

        {original === null && (
          <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed p-3 text-sm">
            <p>这张卡没有原件：可能是新建的卡，或者是在这个功能上线前导入的。</p>
            <p className="text-muted-foreground">可以把现在的版本记为原件，之后的改动就能对比和还原。</p>
            <Button
              size="sm"
              onClick={async () => {
                await saveBaseline(cardId, card)
                toast.success('已把当前版本记为原件')
              }}
            >
              <HistoryIcon /> 把当前版本记为原件
            </Button>
          </div>
        )}

        {original && changes && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">{changes.length + (avatarChanged ? 1 : 0) === 0 ? '和原件完全一致。' : `共 ${changes.length + (avatarChanged ? 1 : 0)} 处改动`}</span>
              {(changes.length > 0 || avatarChanged) && (
                <Button variant="outline" size="sm" className="ml-auto" onClick={restoreAll}>
                  <RotateCcwIcon /> 整卡还原
                </Button>
              )}
            </div>
            {avatarChanged && (
              <section className="flex flex-col gap-1.5">
                <h3 className="text-sm font-medium">头像</h3>
                <div className="flex items-center gap-3 rounded-lg border p-2">
                  <CardAvatar blob={original.avatar} name={card.data.name} className="h-15 w-10 rounded-md border" />
                  <span className="text-muted-foreground">→</span>
                  <CardAvatar blob={avatar} name={card.data.name} className="h-15 w-10 rounded-md border" />
                  <Button variant="ghost" size="sm" className="ml-auto" onClick={restoreAvatar}>
                    <RotateCcwIcon /> 还原头像
                  </Button>
                </div>
              </section>
            )}
            <ChangeList changes={changes} />
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
