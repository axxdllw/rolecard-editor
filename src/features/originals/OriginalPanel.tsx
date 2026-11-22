/**
 * 与原件对比：编辑页标题下的状态标签 + 侧边面板。
 * 原件是导入时自动存的那一版；改动可以单处还原，也可以整卡还原（都能撤销）。
 */
import type { Draft } from 'immer'
import { CheckIcon, ChevronRightIcon, HistoryIcon, PencilIcon, RotateCcwIcon, SaveIcon, Trash2Icon, XIcon } from 'lucide-react'
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { CardAvatar } from '@/components/CardAvatar'
import { confirm } from '@/components/confirm'
import { TextDiffView } from '@/components/TextDiffView'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { compareCards, isRestorable, restoreChange, type CardChange, type CardChangeGroup } from '@/core/card/compare'
import type { CharacterCardV3 } from '@/core/card/types'
import { uuid } from '@/core/util/id'
import type { CardOriginalRecord, CardSnapshotRecord } from '@/db/db'
import { useLive } from '@/db/useLive'
import { formatTime } from '@/lib/format'
import { useIsDesktop } from '@/lib/useMediaQuery'
import { cn } from '@/lib/utils'
import { updateCard } from '@/features/editor/cardDoc'
import { originalAvatar, saveBaseline, setCardAvatar } from '@/services/originals'
import { AUTO_KEEP, countSnapshots, deleteAutoSnapshots, deleteSnapshot, listSnapshots, renameSnapshot, saveSnapshot } from '@/services/snapshots'
import { snapshotBeforeChange } from './autoSnapshot'
import type { OriginalState } from './useOriginalState'

const GROUP_ORDER: CardChangeGroup[] = ['角色字段', '开场白', '世界书', '正则', '酒馆助手脚本', '扩展数据', '其他']

const KIND_TEXT: Record<CardChange['kind'], string> = {
  changed: '改动',
  added: '新增',
  removed: '删除',
  reordered: '顺序',
}

export function OriginalSummary({ cardId, state, onOpen }: { cardId: string; state: OriginalState; onOpen: () => void }) {
  const { original, changes, avatarChanged } = state
  const versions = useLive(() => countSnapshots(cardId), [cardId])
  if (original === undefined) return null
  const count = (changes?.length ?? 0) + (avatarChanged ? 1 : 0)
  const text =
    original === null ? (versions ? `${versions} 个版本` : '未记原件') : count === 0 ? '与原件一致' : `相对原件改了 ${count} 处`
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`版本与对比：存版本，看相对原件或某个版本改了哪些地方，可以单处或整卡还原${versions ? `（已存 ${versions} 个版本）` : ''}`}
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

/** 版本与对比：原件和各个版本快照列成一列，选一个和当前对比，可以单处或整卡还原 */
export function OriginalSheet({ open, onOpenChange, ...rest }: OriginalSheetProps) {
  const isDesktop = useIsDesktop()
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isDesktop ? 'right' : 'bottom'}
        className={cn('gap-4 overflow-y-auto p-4', isDesktop ? 'data-[side=right]:sm:max-w-xl' : 'data-[side=bottom]:h-[85svh]')}
      >
        <SheetHeader className="p-0">
          <SheetTitle>版本与对比</SheetTitle>
          <SheetDescription>
            选一个版本和现在对比，改动可以单处还原，也可以整卡还原，都能撤销。整卡还原、AI 全部应用、批量替换之前会自动存一个版本。
          </SheetDescription>
        </SheetHeader>
        {/* 关闭时不挂载，免得每次编辑都在后台算差异 */}
        {open && <VersionSheetBody {...rest} />}
      </SheetContent>
    </Sheet>
  )
}

interface CompareBase {
  /** 'original' 或版本快照的 id */
  key: string
  title: string
  card: CharacterCardV3
}

function snapshotTitle(s: CardSnapshotRecord): string {
  return s.label || (s.kind === 'manual' ? '未命名版本' : '自动存的版本')
}

function VersionSheetBody({ cardId, card, state, avatar, onAvatarChange }: Omit<OriginalSheetProps, 'open' | 'onOpenChange'>) {
  const { original, changes: originalChanges, avatarChanged } = state
  const snapshots = useLive(() => listSnapshots(cardId), [cardId])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const deferredCard = useDeferredValue(card)

  // 没选过时默认和原件比；没有原件时和最近的版本比。选中的版本被删掉后也回到默认
  const bases: CompareBase[] = [
    ...(original ? [{ key: 'original', title: '原件', card: original.card }] : []),
    ...(snapshots ?? []).map((s) => ({ key: s.id, title: snapshotTitle(s), card: s.card })),
  ]
  const base = bases.find((b) => b.key === selectedKey) ?? bases[0] ?? null
  const isOriginal = base?.key === 'original'
  const baseCard = base && !isOriginal ? base.card : null
  const snapshotChanges = useMemo(() => (baseCard ? compareCards(baseCard, deferredCard) : null), [baseCard, deferredCard])
  const changes = isOriginal ? originalChanges : snapshotChanges
  const showAvatar = isOriginal && avatarChanged
  const total = (changes?.length ?? 0) + (showAvatar ? 1 : 0)

  const restoreAvatar = async () => {
    if (!original) return
    const blob = originalAvatar(original, avatar)
    await setCardAvatar(cardId, blob)
    onAvatarChange(blob)
  }

  const restoreAll = async () => {
    if (!base) return
    const ok = await confirm({
      title: isOriginal ? '整卡还原到原件？' : `整卡还原到「${base.title}」？`,
      description: showAvatar
        ? '卡片内容会变回原件（可以撤销）；头像也会换回原来的（头像不在撤销记录里）。还原前会自动存一个版本。'
        : '卡片内容会变回这个版本，之后可以撤销。还原前会自动存一个版本。',
      confirmText: '还原',
      destructive: true,
    })
    if (!ok) return
    snapshotBeforeChange(isOriginal ? '整卡还原到原件之前' : `还原到 ${base.title} 之前`)
    // 还原后新存的自动版本排到最前面，固定选中刚还原到的这个版本，免得对比对象跳走
    setSelectedKey(base.key)
    const restored = structuredClone(base.card)
    updateCard(
      (d) => {
        d.card = restored as Draft<CharacterCardV3>
        d.entryKeys = (restored.data.character_book?.entries ?? []).map(() => uuid())
      },
      { label: isOriginal ? '整卡还原到原件' : `整卡还原到「${base.title}」` },
    )
    if (showAvatar) await restoreAvatar()
    toast.success('已还原，可以撤销')
  }

  return (
    <div className="flex flex-col gap-4">
      <VersionList
        cardId={cardId}
        card={card}
        original={original}
        snapshots={snapshots}
        selectedKey={base?.key ?? null}
        onSelect={setSelectedKey}
      />

      {base && changes && (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">
              {total === 0 ? (
                <>
                  现在和「{base.title}」<span className="font-medium">完全一致</span>。
                </>
              ) : (
                <>
                  现在相对「{base.title}」改了 <span className="font-medium">{total}</span> 处
                </>
              )}
            </span>
            {total > 0 && (
              <Button variant="outline" size="sm" className="ml-auto" onClick={restoreAll}>
                <RotateCcwIcon /> 整卡还原
              </Button>
            )}
          </div>
          {showAvatar && original && (
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
          <ChangeList key={base.key} changes={changes} />
        </section>
      )}
    </div>
  )
}

interface VersionListProps {
  cardId: string
  card: CharacterCardV3
  original: CardOriginalRecord | null | undefined
  snapshots: CardSnapshotRecord[] | undefined
  selectedKey: string | null
  onSelect: (key: string) => void
}

function VersionList({ cardId, card, original, snapshots, selectedKey, onSelect }: VersionListProps) {
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const autoCount = snapshots?.filter((s) => s.kind === 'auto').length ?? 0

  const save = async () => {
    const record = await saveSnapshot(cardId, card, 'manual', name)
    setName('')
    if (record) {
      onSelect(record.id)
      toast.success('已存一个版本')
    }
  }

  const remove = async (s: CardSnapshotRecord) => {
    const ok = await confirm({
      title: `删除版本「${snapshotTitle(s)}」？`,
      description: '删除后不能恢复，卡片现在的内容不受影响。',
      confirmText: '删除',
      destructive: true,
    })
    if (!ok) return
    await deleteSnapshot(s.id)
    toast('已删除这个版本', { id: 'snapshot-delete', duration: 1500 })
  }

  const removeAuto = async () => {
    const ok = await confirm({
      title: `删除全部 ${autoCount} 个自动版本？`,
      description: '手动存的版本和原件不受影响。删除后不能恢复。',
      confirmText: '删除',
      destructive: true,
    })
    if (!ok) return
    await deleteAutoSnapshots(cardId)
    toast('已删除自动版本', { id: 'snapshot-delete', duration: 1500 })
  }

  const commitRename = async () => {
    if (!editing) return
    await renameSnapshot(editing.id, editing.text)
    setEditing(null)
  }

  return (
    <section className="flex flex-col gap-2">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="版本名（可不填），例如：改人设前" aria-label="版本名" />
        <Button type="submit" className="shrink-0">
          <SaveIcon /> 存一个版本
        </Button>
      </form>

      <div className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-lg border p-1">
        {original === null && (
          <div className="flex flex-col items-start gap-2 rounded-md border border-dashed p-2.5 text-sm">
            <p>这张卡没有原件：可能是新建的卡，或者是在这个功能上线前导入的。可以把现在的版本记为原件，之后的改动就能对比和还原。</p>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await saveBaseline(cardId, card)
                onSelect('original')
                toast.success('已把当前版本记为原件')
              }}
            >
              <HistoryIcon /> 把当前版本记为原件
            </Button>
          </div>
        )}
        {original && (
          <VersionRow
            selected={selectedKey === 'original'}
            onSelect={() => onSelect('original')}
            title="原件"
            badge={original.kind === 'import' ? '导入时' : '手动记的'}
            meta={`${formatTime(original.createdAt)}${original.fileName ? ` · ${original.fileName}` : ''}`}
          />
        )}
        {snapshots?.map((s) =>
          editing?.id === s.id ? (
            <form
              key={s.id}
              className="flex gap-1 p-1"
              onSubmit={(e) => {
                e.preventDefault()
                void commitRename()
              }}
            >
              <Input autoFocus value={editing.text} onChange={(e) => setEditing({ id: s.id, text: e.target.value })} aria-label="新的版本名" />
              <Button type="submit" size="icon" variant="ghost" aria-label="保存名字">
                <CheckIcon />
              </Button>
              <Button type="button" size="icon" variant="ghost" aria-label="取消改名" onClick={() => setEditing(null)}>
                <XIcon />
              </Button>
            </form>
          ) : (
            <VersionRow
              key={s.id}
              selected={selectedKey === s.id}
              onSelect={() => onSelect(s.id)}
              title={snapshotTitle(s)}
              badge={s.kind === 'manual' ? '手动' : '自动'}
              meta={`${formatTime(s.createdAt)} · 世界书 ${s.card.data.character_book?.entries.length ?? 0} 条`}
              actions={
                <>
                  <Button size="icon" variant="ghost" className="size-7" aria-label="改名" onClick={() => setEditing({ id: s.id, text: s.label })}>
                    <PencilIcon />
                  </Button>
                  <Button size="icon" variant="ghost" className="size-7" aria-label="删除这个版本" onClick={() => void remove(s)}>
                    <Trash2Icon />
                  </Button>
                </>
              }
            />
          ),
        )}
        {original !== null && snapshots?.length === 0 && (
          <p className="p-2 text-xs text-muted-foreground">还没有存过版本。改大段内容之前可以先存一个，方便对比和找回。</p>
        )}
      </div>
      {autoCount > 0 && (
        <p className="text-xs text-muted-foreground">
          自动版本每张卡只留最近 {AUTO_KEEP} 个，更早的会自动删掉。
          <button type="button" className="ml-1 text-primary hover:underline" onClick={() => void removeAuto()}>
            删除全部自动版本
          </button>
        </p>
      )}
    </section>
  )
}

interface VersionRowProps {
  selected: boolean
  onSelect: () => void
  title: string
  badge: string
  meta: string
  actions?: ReactNode
}

function VersionRow({ selected, onSelect, title, badge, meta, actions }: VersionRowProps) {
  return (
    <div className={cn('flex items-center gap-1 rounded-md pr-1', selected ? 'bg-primary/10' : 'hover:bg-muted')}>
      <button type="button" onClick={onSelect} aria-pressed={selected} className="flex min-w-0 flex-1 flex-col items-start gap-0.5 p-2 text-left">
        <span className="flex w-full min-w-0 items-center gap-1.5 text-sm">
          <span className={cn('size-2 shrink-0 rounded-full border', selected ? 'border-primary bg-primary' : 'border-muted-foreground/50')} />
          <span className="truncate font-medium">{title}</span>
          <Badge variant="secondary" className="shrink-0">
            {badge}
          </Badge>
        </span>
        <span className="w-full truncate pl-3.5 text-xs text-muted-foreground">{meta}</span>
      </button>
      {actions}
    </div>
  )
}
