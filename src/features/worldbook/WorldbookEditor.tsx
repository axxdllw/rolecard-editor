import {
  AlertTriangleIcon,
  BookPlusIcon,
  CheckSquareIcon,
  DownloadIcon,
  LibraryIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  UploadIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { confirm } from '@/components/confirm'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { generatedToEntries } from '@/core/ai/tasks/lorebookGen'
import { createWrapperEntries, ENTRY_TEMPLATES } from '@/core/card/create'
import type { Lorebook, LorebookEntry } from '@/core/card/types'
import { collectOutletNames, createEntry, entryTitle, getDisplayIndex, getOrder, getPosition, getStrategy, POSITION_OPTIONS } from '@/core/lorebook/entry'
import { lintLorebook, type LintIssue } from '@/core/lorebook/lint'
import { parseLorebookJson } from '@/core/lorebook/world'
import { AiLorebookDialog } from '@/features/ai/AiLorebookDialog'
import { cardRewriteContext } from '@/features/ai/cardContext'
import { useCardDoc, type BookDraft } from '@/features/editor/cardDoc'
import type { UpdateOptions } from '@/features/editor/docStore'
import { downloadBlob, pickFiles, safeFileName } from '@/lib/files'
import { useSettings } from '@/lib/settings'
import { cachedTokens, countTokensSync, formatTokens, useTokenizerReady } from '@/lib/tokens'
import { useIsDesktop } from '@/lib/useMediaQuery'
import { cn } from '@/lib/utils'
import { addLorebook, exportLorebookJson, saveLorebook } from '@/services/lorebooks'
import { BatchBar } from './BatchBar'
import { PickLorebookDialog, WrapperDialog } from './dialogs'
import { EntryDetail } from './EntryDetail'
import { EntryList, type Row } from './EntryList'
import { appendEntries, duplicateEntry, editEntries, insertEntry, removeEntries, reorderDisplay } from './ops'

type Filter = 'all' | 'constant' | 'keyword' | 'disabled' | 'issues' | `pos-${number}`
type Sort = 'display' | 'order' | 'tokens' | 'title'

export interface WorldbookEditorProps {
  book: Lorebook | undefined
  keys: string[]
  update: (recipe: (d: BookDraft) => void, options?: UpdateOptions) => void
  /** card：卡片内嵌世界书；library：世界书库里的书 */
  mode: 'card' | 'library'
  /** 世界书库里的书自身的 id（合并时排除自己） */
  libraryId?: string
  headerExtra?: ReactNode
  /** 从外面跳到某个条目；nonce 变了才会再跳 */
  focus?: { index: number; nonce: number }
}

export function WorldbookEditor({ book, keys, update, mode, libraryId, headerExtra, focus }: WorldbookEditorProps) {
  const isDesktop = useIsDesktop()
  const budget = useSettings((s) => s.constantTokenBudget)
  const tokenizerReady = useTokenizerReady()
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<Sort>('display')
  const [batch, setBatch] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [lintOpen, setLintOpen] = useState(false)
  const [wrapperOpen, setWrapperOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [copyKeys, setCopyKeys] = useState<string[] | null>(null)
  const [focusNonce, setFocusNonce] = useState<number | null>(null)
  if (focus && focus.nonce !== focusNonce) {
    setFocusNonce(focus.nonce)
    const key = keys[focus.index]
    if (key) {
      setFilter('all')
      setQuery('')
      setActiveKey(key)
    }
  }

  const entries = useMemo(() => book?.entries ?? [], [book])
  const outletNames = useMemo(() => collectOutletNames(entries), [entries])

  const issues = useMemo(
    () => lintLorebook(book, { constantTokenBudget: budget, tokenCount: tokenizerReady ? countTokensSync : undefined }),
    [book, budget, tokenizerReady],
  )
  const issueKeys = useMemo(() => {
    const set = new Set<string>()
    for (const issue of issues) {
      if (issue.code === 'duplicate-key' || issue.code === 'constant-budget' || issue.code === 'outlet-usage') continue
      issue.entryIndexes.forEach((i) => keys[i] && set.add(keys[i]))
    }
    return set
  }, [issues, keys])

  const allRows: Row[] = useMemo(() => entries.map((entry, index) => ({ entry, index, key: keys[index] })), [entries, keys])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = allRows.filter(({ entry, key }) => {
      if (filter === 'constant' && getStrategy(entry) !== 'constant') return false
      if (filter === 'keyword' && getStrategy(entry) !== 'keyword') return false
      if (filter === 'disabled' && entry.enabled !== false) return false
      if (filter === 'issues' && !issueKeys.has(key)) return false
      if (filter.startsWith('pos-') && getPosition(entry) !== Number(filter.slice(4))) return false
      if (!q) return true
      return [entry.comment, entry.content, ...(entry.keys ?? []), ...(entry.secondary_keys ?? [])].join('\n').toLowerCase().includes(q)
    })
    list = [...list].sort((a, b) => {
      switch (sort) {
        case 'order':
          return getPosition(a.entry) - getPosition(b.entry) || getOrder(a.entry) - getOrder(b.entry)
        case 'tokens':
          return (cachedTokens(b.entry.content ?? '') ?? 0) - (cachedTokens(a.entry.content ?? '') ?? 0)
        case 'title':
          return entryTitle(a.entry, a.index).localeCompare(entryTitle(b.entry, b.index), 'zh')
        default:
          return getDisplayIndex(a.entry, a.index) - getDisplayIndex(b.entry, b.index)
      }
    })
    return list
  }, [allRows, query, filter, sort, issueKeys])

  const searchRef = useRef<HTMLInputElement>(null)

  const sortable = sort === 'display' && filter === 'all' && !query.trim()
  const activeIndex = activeKey ? keys.indexOf(activeKey) : -1
  const activeEntry = activeIndex >= 0 ? entries[activeIndex] : undefined

  const constantTokens = useMemo(() => {
    if (!tokenizerReady) return null
    return entries.filter((e) => e.enabled !== false && getStrategy(e) === 'constant').reduce((s, e) => s + (cachedTokens(e.content ?? '') ?? 0), 0)
  }, [entries, tokenizerReady])

  // —— 操作 ——
  const onToggle = useCallback(
    (key: string, enabled: boolean) => update((d) => editEntries(d, [key], (e) => void (e.enabled = enabled)), { label: enabled ? '启用条目' : '禁用条目' }),
    [update],
  )
  const onCheck = useCallback((key: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  const onSelect = useCallback((key: string) => setActiveKey(key), [])

  const onEditActive = useCallback(
    (edit: (entry: LorebookEntry) => void, options?: UpdateOptions) => {
      if (!activeKey) return
      update((d) => editEntries(d, [activeKey], edit), options)
    },
    [update, activeKey],
  )

  const addFromTemplate = (templateId: string) => {
    const template = ENTRY_TEMPLATES.find((t) => t.id === templateId) ?? ENTRY_TEMPLATES[0]
    let newKey = ''
    update((d) => {
      newKey = insertEntry(d, createEntry(d.book.entries as LorebookEntry[], template.init))
    }, { label: '新建条目' })
    setFilter('all')
    setQuery('')
    setActiveKey(newKey)
  }

  const removeKeys = async (targets: string[]) => {
    if (targets.length === 0) return
    const ok = await confirm({
      title: targets.length === 1 ? '删除这个条目？' : `删除选中的 ${targets.length} 个条目？`,
      description: '可以用“撤销”找回。',
      confirmText: '删除',
      destructive: true,
    })
    if (!ok) return
    update((d) => removeEntries(d, targets), { label: '删除条目' })
    setChecked(new Set())
    if (activeKey && targets.includes(activeKey)) setActiveKey(null)
  }

  const importJson = async () => {
    const [file] = await pickFiles('.json')
    if (!file) return
    try {
      const { book: incoming } = parseLorebookJson(await file.text())
      update((d) => void appendEntries(d, incoming.entries), { label: '合并世界书' })
      toast.success(`已合并 ${incoming.entries.length} 个条目`)
    } catch (error) {
      toast.error(`导入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const exportJson = () => {
    if (!book) return
    downloadBlob(exportLorebookJson(book as Lorebook), `${safeFileName(book.name || '世界书')}.json`, 'application/json')
  }

  const saveToLibrary = async () => {
    if (!book) return
    await addLorebook(book as Lorebook)
    toast.success('已保存一份到世界书库')
  }

  const copySelectedToLibrary = async (target: { record: { id: string; book: Lorebook } } | { newName: string }) => {
    const picked = entries.filter((_, i) => copyKeys?.includes(keys[i]))
    if ('newName' in target) {
      await addLorebook({ name: target.newName, entries: picked.map((e) => structuredClone(e)), extensions: {} }, target.newName)
      toast.success(`已复制 ${picked.length} 个条目到新世界书「${target.newName}」`)
    } else {
      const next = structuredClone(target.record.book)
      const temp: BookDraft = { book: next, keys: next.entries.map(() => '') }
      appendEntries(temp, picked)
      await saveLorebook(target.record.id, next)
      toast.success(`已复制 ${picked.length} 个条目`)
    }
  }

  const mergeFromLibrary = (target: { record: { book: Lorebook; name: string } } | { newName: string }) => {
    if (!('record' in target)) return
    update((d) => void appendEntries(d, target.record.book.entries), { label: '从世界书库合并' })
    toast.success(`已从「${target.record.name}」合并 ${target.record.book.entries.length} 个条目`)
  }

  const jumpToIssue = (issue: LintIssue) => {
    const key = keys[issue.entryIndexes[0]]
    if (key) {
      setFilter('all')
      setQuery('')
      setActiveKey(key)
      setLintOpen(false)
    }
  }

  const detail = activeEntry && activeKey && (
    <EntryDetail
      key={activeKey}
      entry={activeEntry}
      entryKey={activeKey}
      onEdit={onEditActive}
      onDelete={() => removeKeys([activeKey])}
      outletNames={outletNames}
      getAiContext={mode === 'card' ? () => cardRewriteContext(useCardDoc.getState().doc?.card) : undefined}
      onDuplicate={() => {
        let newKey: string | null = null
        update((d) => void (newKey = duplicateEntry(d, activeKey)), { label: '复制条目' })
        if (newKey) setActiveKey(newKey)
      }}
      extraActions={
        <Button variant="ghost" size="icon-sm" aria-label="复制到世界书库" title="复制到世界书库" onClick={() => setCopyKeys([activeKey])}>
          <LibraryIcon />
        </Button>
      }
    />
  )

  // 快捷键：/ 聚焦搜索，↑↓ 切换条目，Alt+N 新建条目（输入框里不生效）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target
      const editing = target instanceof Element && !!target.closest('input, textarea, select, [contenteditable=true], .cm-editor, [role=dialog]')
      if (e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        addFromTemplate('blank')
        return
      }
      if (editing || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (rows.length === 0) return
        e.preventDefault()
        const current = rows.findIndex((r) => r.key === activeKey)
        const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, current + 1) : Math.max(0, current - 1)
        setActiveKey(rows[next < 0 ? 0 : next].key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const warningCount = issues.filter((i) => i.severity === 'warning').length

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {headerExtra}
        <div className="relative min-w-40 flex-1">
          <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input ref={searchRef} className="pl-8" placeholder="搜索备注名、关键词、内容（按 / 聚焦）" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部条目</SelectItem>
            <SelectItem value="constant">常驻</SelectItem>
            <SelectItem value="keyword">关键词触发</SelectItem>
            <SelectItem value="disabled">已禁用</SelectItem>
            <SelectItem value="issues">有检查提示</SelectItem>
            {POSITION_OPTIONS.map((p) => (
              <SelectItem key={p.value} value={`pos-${p.value}`}>
                位置：{p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="display">显示顺序</SelectItem>
            <SelectItem value="order">位置 + 顺序</SelectItem>
            <SelectItem value="tokens">token 多→少</SelectItem>
            <SelectItem value="title">备注名</SelectItem>
          </SelectContent>
        </Select>
        <Button variant={issues.length ? 'outline' : 'ghost'} onClick={() => setLintOpen(true)}>
          <AlertTriangleIcon className={cn(warningCount > 0 && 'text-amber-500')} />
          检查
          {issues.length > 0 && <Badge variant={warningCount ? 'destructive' : 'secondary'}>{issues.length}</Badge>}
        </Button>
        <Button variant={batch ? 'secondary' : 'outline'} onClick={() => (batch ? (setBatch(false), setChecked(new Set())) : setBatch(true))}>
          <CheckSquareIcon /> 批量
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>
              <PlusIcon /> 新建
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel>条目模板</DropdownMenuLabel>
            {ENTRY_TEMPLATES.map((t) => (
              <DropdownMenuItem key={t.id} onClick={() => addFromTemplate(t.id)} className="flex-col items-start gap-0">
                <span>{t.label}</span>
                <span className="text-xs text-muted-foreground">{t.hint}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setWrapperOpen(true)} className="flex-col items-start gap-0">
              <span>包裹标签</span>
              <span className="text-xs text-muted-foreground">用一对 &lt;标签&gt; 把一组条目包起来</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setAiOpen(true)} className="flex-col items-start gap-0">
              <span className="flex items-center gap-1">
                <SparklesIcon className="size-3.5" /> AI 生成条目
              </span>
              <span className="text-xs text-muted-foreground">从设定或小说片段里整理出一批条目</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="更多">
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={importJson}>
              <UploadIcon /> 导入世界书 JSON（合并）
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setMergeOpen(true)}>
              <LibraryIcon /> 从世界书库合并
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={exportJson} disabled={!book}>
              <DownloadIcon /> 导出为 ST 世界书 JSON
            </DropdownMenuItem>
            {mode === 'card' && (
              <DropdownMenuItem onClick={saveToLibrary} disabled={!book || entries.length === 0}>
                <BookPlusIcon /> 整本保存到世界书库
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>共 {entries.length} 条，显示 {rows.length} 条</span>
        <span>
          <span className="mr-1 inline-block size-2 rounded-full bg-emerald-500" />
          常驻 {entries.filter((e) => e.enabled !== false && getStrategy(e) === 'constant').length} 条，约 {formatTokens(constantTokens)} token（每轮都发送）
        </span>
        <span>
          <span className="mr-1 inline-block size-2 rounded-full bg-sky-500" />
          关键词 {entries.filter((e) => getStrategy(e) === 'keyword').length} 条
        </span>
        {!sortable && sort === 'display' && <span>（筛选或搜索时不能拖动排序）</span>}
      </div>

      <div className={cn('grid min-h-0 flex-1 gap-4', isDesktop && 'grid-cols-[minmax(320px,2fr)_3fr]')}>
        <div className="flex min-h-[420px] flex-col overflow-hidden rounded-xl border bg-card lg:max-h-[calc(100svh-15rem)]">
          {batch && (
            <BatchBar
              count={checked.size}
              outletNames={outletNames}
              onEdit={(label, edit) => update((d) => editEntries(d, checked, edit), { label })}
              onDelete={() => removeKeys([...checked])}
              onSelectAll={() => setChecked(new Set(rows.map((r) => r.key)))}
              onClear={() => setChecked(new Set())}
              onExit={() => {
                setBatch(false)
                setChecked(new Set())
              }}
              extra={
                <Button size="xs" variant="outline" disabled={checked.size === 0} onClick={() => setCopyKeys([...checked])}>
                  复制到世界书库
                </Button>
              }
            />
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <EntryList
              rows={rows}
              activeKey={activeKey}
              checkedKeys={checked}
              batch={batch}
              sortable={sortable}
              issueKeys={issueKeys}
              onSelect={onSelect}
              onCheck={onCheck}
              onToggle={onToggle}
              onReorder={(ordered) => update((d) => reorderDisplay(d, ordered), { label: '调整条目顺序' })}
            />
          </div>
        </div>

        {isDesktop ? (
          <div className="min-w-0 rounded-xl border bg-card p-4 lg:max-h-[calc(100svh-15rem)] lg:overflow-y-auto">
            {detail || (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center text-sm text-muted-foreground">
                <p>在左边选一个条目查看和编辑</p>
                <p className="text-xs">绿色圆点是常驻条目，蓝色是关键词触发</p>
              </div>
            )}
          </div>
        ) : (
          <Sheet open={!!detail} onOpenChange={(open) => !open && setActiveKey(null)}>
            <SheetContent side="bottom" className="gap-0 overflow-y-auto rounded-t-xl p-4 data-[side=bottom]:h-[88svh]">
              <SheetHeader className="p-0 pb-3">
                <SheetTitle>编辑条目</SheetTitle>
              </SheetHeader>
              {detail}
            </SheetContent>
          </Sheet>
        )}
      </div>

      <Sheet open={lintOpen} onOpenChange={setLintOpen}>
        <SheetContent side={isDesktop ? 'right' : 'bottom'} className={cn('overflow-y-auto p-4', isDesktop ? 'sm:max-w-md' : 'data-[side=bottom]:h-[80svh]')}>
          <SheetHeader className="p-0">
            <SheetTitle>世界书检查（{issues.length}）</SheetTitle>
          </SheetHeader>
          {issues.length === 0 ? (
            <p className="text-sm text-muted-foreground">没有发现问题。</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {issues.map((issue, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => jumpToIssue(issue)}
                    className={cn(
                      'w-full rounded-lg border p-2.5 text-left text-sm hover:bg-muted',
                      issue.severity === 'warning' ? 'border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30' : '',
                    )}
                  >
                    <span className="mr-1.5 text-xs font-medium text-muted-foreground">{issue.severity === 'warning' ? '警告' : '提示'}</span>
                    {issue.message}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SheetContent>
      </Sheet>

      <WrapperDialog
        open={wrapperOpen}
        onOpenChange={setWrapperOpen}
        outletNames={outletNames}
        onCreate={(o) => {
          update((d) => {
            const [open, close] = createWrapperEntries(d.book.entries as LorebookEntry[], o.tag, {
              position: o.position,
              depth: o.depth,
              openOrder: o.openOrder,
              closeOrder: o.closeOrder,
              outletName: o.outletName,
            })
            insertEntry(d, open)
            insertEntry(d, close)
          }, { label: '添加包裹标签' })
          toast.success(`已添加 <${o.tag}> 和 </${o.tag}>`)
        }}
      />
      <AiLorebookDialog
        open={aiOpen}
        onOpenChange={setAiOpen}
        existingTitles={entries.map((e, i) => entryTitle(e, i))}
        getContext={mode === 'card' ? () => cardRewriteContext(useCardDoc.getState().doc?.card) : undefined}
        getCardSource={
          mode === 'card'
            ? () => {
                const data = useCardDoc.getState().doc?.card.data
                return [data?.description, data?.scenario].filter((t) => typeof t === 'string' && t.trim()).join('\n\n')
              }
            : undefined
        }
        onAdd={(generated) => {
          let added: string[] = []
          update((d) => void (added = appendEntries(d, generatedToEntries(generated, d.book.entries as LorebookEntry[]))), { label: 'AI 生成条目' })
          if (added[0]) setActiveKey(added[0])
          toast.success(`已添加 ${added.length} 个条目，可以撤销`)
        }}
      />
      <PickLorebookDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        title="从世界书库合并"
        description="把选中那本书的全部条目追加到这里（复制，不影响原书）。"
        excludeId={libraryId}
        confirmText="合并"
        onPick={mergeFromLibrary}
      />
      <PickLorebookDialog
        open={!!copyKeys}
        onOpenChange={(open) => !open && setCopyKeys(null)}
        title={`复制 ${copyKeys?.length ?? 0} 个条目到世界书库`}
        allowNew
        excludeId={libraryId}
        confirmText="复制"
        onPick={(t) => void copySelectedToLibrary(t)}
      />
    </div>
  )
}
