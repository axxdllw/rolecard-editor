import {
  ArrowLeftIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  FileJsonIcon,
  ImageIcon,
  LoaderIcon,
  MonitorPlayIcon,
  Redo2Icon,
  Undo2Icon,
  WandSparklesIcon,
} from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { CardAvatar } from '@/components/CardAvatar'
import { CropDialog } from '@/components/CropDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { JsonObject, Lorebook } from '@/core/card/types'
import type { DepLocation } from '@/core/deps/deps'
import { countScripts } from '@/core/tavern-helper/scripts'
import { db, type CardRecord } from '@/db/db'
import { DependencySheet, DependencySummary } from '@/features/deps/DependencyPanel'
import { jumpTarget, revealAnchor, useDependencyReport } from '@/features/deps/jump'
import { OriginalSheet, OriginalSummary } from '@/features/originals/OriginalPanel'
import { useOriginalState } from '@/features/originals/useOriginalState'
import { PromptPreview } from '@/features/preview/PromptPreview'
import { QuickEditDialog } from '@/features/quick-edit/QuickEditDialog'
import { RegexPanel } from '@/features/regex/RegexPanel'
import { WorldbookEditor } from '@/features/worldbook/WorldbookEditor'
import { downloadBlob, pickFiles } from '@/lib/files'
import { useSettings } from '@/lib/settings'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { cn } from '@/lib/utils'
import { cardFileBase, duplicateCard, exportCardJson, exportCardPng, saveCard } from '@/services/cards'
import { setCardAvatar } from '@/services/originals'
import { makeCardDoc, updateCardBook, useCardDoc, type CardDoc } from './cardDoc'
import { CharacterTab } from './CharacterTab'
import { useAutosave, type SaveStatus } from './autosave'

const EMPTY_KEYS: string[] = []

// 渲染预览依赖 showdown、DOMPurify 等，打开时才加载
const RenderPanel = lazy(() => import('@/features/render/RenderPanel'))
// 脚本编辑带 JavaScript 语法和接口清单，切到脚本页才加载
const ScriptsPanel = lazy(() => import('@/features/scripts/ScriptsPanel'))

interface LoadedDoc extends CardDoc {
  id: string
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  if (status === 'saving' || status === 'pending')
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <LoaderIcon className="size-3 animate-spin" /> 保存中
      </span>
    )
  if (status === 'error') return <span className="text-xs text-destructive">保存失败</span>
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <CheckIcon className="size-3" /> 已保存
    </span>
  )
}

function useUndoShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const key = e.key.toLowerCase()
      const { undo, redo } = useCardDoc.getState()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        const label = undo()
        if (label) toast(`已撤销：${label}`, { id: 'undo', duration: 1500 })
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault()
        const label = redo()
        if (label) toast(`已重做：${label}`, { id: 'undo', duration: 1500 })
      } else if (key === 's') {
        e.preventDefault()
        toast('改动会自动保存，不需要手动保存', { id: 'save-hint', duration: 1500 })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

function Editor({ record }: { record: CardRecord }) {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'character'
  // 从世界书库点进来的，返回时回到世界书库
  const location = useLocation()
  const fromLorebooks = (location.state as { from?: string } | null)?.from === '/lorebooks'
  const [avatar, setAvatar] = useState<Blob | null>(record.avatar)
  const [cropSource, setCropSource] = useState<Blob | null>(null)
  const [quickOpen, setQuickOpen] = useState(false)
  const [depsOpen, setDepsOpen] = useState(false)
  const [originalOpen, setOriginalOpen] = useState(false)
  // 依赖体检跳到世界书条目或正则时，交给对应面板去选中
  const [focus, setFocus] = useState<{ loc: DepLocation; nonce: number } | null>(null)
  const card = useCardDoc((s) => s.doc?.card)
  const depReport = useDependencyReport(card)
  const originalState = useOriginalState(record.id, card, avatar)
  const entryKeys = useCardDoc((s) => s.doc?.entryKeys ?? EMPTY_KEYS)
  const canUndo = useCardDoc((s) => s.past.length > 0)
  const canRedo = useCardDoc((s) => s.future.length > 0)
  const status = useAutosave(useCardDoc, async (doc) => {
    await saveCard((doc as LoadedDoc).id, doc.card)
  })
  useUndoShortcuts()
  const renderOpen = useSettings((s) => s.renderPanelOpen)
  const setRenderOpen = (open: boolean) => useSettings.getState().set({ renderPanelOpen: open })
  const wide = useMediaQuery('(min-width: 1280px)')
  const split = renderOpen && wide

  const changeAvatar = async () => {
    const [file] = await pickFiles('image/png,image/jpeg,image/webp,image/gif')
    if (file) setCropSource(file)
  }

  const exportAs = async (format: 'png' | 'json') => {
    if (!card) return
    try {
      if (format === 'png') downloadBlob(await exportCardPng({ card, avatar }), `${cardFileBase({ card })}.png`, 'image/png')
      else downloadBlob(exportCardJson({ card }), `${cardFileBase({ card })}.json`, 'application/json')
    } catch (error) {
      toast.error(`导出失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const jumpTo = (loc: DepLocation) => {
    const target = jumpTarget(loc)
    setDepsOpen(false)
    setParams({ tab: target.tab }, { replace: true, state: location.state })
    setFocus((prev) => ({ loc, nonce: (prev?.nonce ?? 0) + 1 }))
    if (target.anchor) revealAnchor(target.anchor)
  }

  if (!card) return null
  const book = card.data.character_book as Lorebook | undefined
  const regexCount = Array.isArray((card.data.extensions as JsonObject)?.regex_scripts) ? ((card.data.extensions as JsonObject).regex_scripts as unknown[]).length : 0
  const scriptCount = countScripts((card.data.extensions ?? {}) as JsonObject)

  return (
    <div className={cn('mx-auto flex w-full flex-1 flex-col gap-3 p-4', split ? 'max-w-[1800px]' : 'max-w-6xl')}>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" asChild aria-label={fromLorebooks ? '返回世界书库' : '返回卡库'}>
          <Link to={fromLorebooks ? '/lorebooks' : '/'}>
            <ArrowLeftIcon />
          </Link>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="h-15 w-10 shrink-0 overflow-hidden rounded-md border" aria-label="头像">
              <CardAvatar blob={avatar} name={card.data.name} className="size-full text-base" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={changeAvatar}>
              <ImageIcon /> 更换头像
            </DropdownMenuItem>
            {avatar && (
              <DropdownMenuItem
                onClick={async () => {
                  setAvatar(null)
                  await setCardAvatar(record.id, null)
                }}
              >
                移除头像
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-lg font-semibold">{card.data.name || '未命名'}</h1>
          <div className="flex items-center gap-2">
            <SaveIndicator status={status} />
            {record.sourceFormat === 'copy' && <Badge variant="secondary">副本</Badge>}
            <DependencySummary report={depReport} onOpen={() => setDepsOpen(true)} />
            <OriginalSummary state={originalState} onOpen={() => setOriginalOpen(true)} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" disabled={!canUndo} onClick={() => useCardDoc.getState().undo()} aria-label="撤销">
                <Undo2Icon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>撤销（Ctrl+Z）</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" disabled={!canRedo} onClick={() => useCardDoc.getState().redo()} aria-label="重做">
                <Redo2Icon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>重做（Ctrl+Y）</TooltipContent>
          </Tooltip>
          <Button variant={renderOpen ? 'secondary' : 'outline'} onClick={() => setRenderOpen(!renderOpen)} aria-pressed={renderOpen}>
            <MonitorPlayIcon /> 渲染预览
          </Button>
          <Button variant="outline" onClick={() => setQuickOpen(true)}>
            <WandSparklesIcon /> 快捷修改
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>
                <DownloadIcon /> 导出
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => exportAs('png')}>
                <ImageIcon /> 导出 PNG（ST 可直接导入）
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportAs('json')}>
                <FileJsonIcon /> 导出 JSON
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={async () => {
                  const id = await duplicateCard(record.id)
                  if (id) {
                    toast.success('已复制一份')
                    navigate(`/card/${id}`)
                  }
                }}
              >
                <CopyIcon /> 复制一份并打开
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className={cn('flex flex-1 flex-col gap-4', split && 'grid grid-cols-[minmax(0,1fr)_minmax(420px,42%)] items-start')}>
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setFocus(null)
            setParams({ tab: v }, { replace: true, state: location.state })
          }}
          className="flex min-w-0 flex-1 flex-col gap-3"
        >
          <TabsList className="sticky top-12 z-20 w-full justify-start overflow-x-auto overflow-y-hidden sm:w-fit">
            <TabsTrigger value="character">角色</TabsTrigger>
            <TabsTrigger value="worldbook">
              世界书 <span className="text-xs text-muted-foreground">{book?.entries.length ?? 0}</span>
            </TabsTrigger>
            <TabsTrigger value="regex">
              正则 <span className="text-xs text-muted-foreground">{regexCount}</span>
            </TabsTrigger>
            <TabsTrigger value="scripts">
              脚本 <span className="text-xs text-muted-foreground">{scriptCount}</span>
            </TabsTrigger>
            <TabsTrigger value="preview">提示词预览</TabsTrigger>
          </TabsList>
          <TabsContent value="character">
            <CharacterTab avatar={avatar} />
          </TabsContent>
          <TabsContent value="worldbook" className="flex flex-col">
            <WorldbookEditor
              book={book}
              keys={entryKeys}
              update={updateCardBook}
              mode="card"
              focus={focus?.loc.type === 'entry' ? { index: focus.loc.index, nonce: focus.nonce } : undefined}
            />
          </TabsContent>
          <TabsContent value="regex">
            <RegexPanel focus={focus?.loc.type === 'regex' ? { index: focus.loc.index, nonce: focus.nonce } : undefined} />
          </TabsContent>
          <TabsContent value="scripts">
            <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">加载脚本编辑器…</p>}>
              <ScriptsPanel />
            </Suspense>
          </TabsContent>
          <TabsContent value="preview">
            <PromptPreview card={card} />
          </TabsContent>
        </Tabs>
        {split && (
          <aside className="sticky top-14 flex h-[calc(100svh-9.5rem)] min-h-[480px] flex-col rounded-xl border bg-card p-3">
            <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">加载预览…</p>}>
              <RenderPanel cardId={record.id} avatar={avatar} onClose={() => setRenderOpen(false)} className="flex-1" />
            </Suspense>
          </aside>
        )}
      </div>
      {!wide && (
        <Sheet open={renderOpen} onOpenChange={setRenderOpen}>
          <SheetContent side="right" showCloseButton={false} className="w-full p-3 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
            <SheetTitle className="sr-only">渲染预览</SheetTitle>
            <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">加载预览…</p>}>
              <RenderPanel cardId={record.id} avatar={avatar} onClose={() => setRenderOpen(false)} className="flex-1" />
            </Suspense>
          </SheetContent>
        </Sheet>
      )}

      <QuickEditDialog open={quickOpen} onOpenChange={setQuickOpen} />
      <DependencySheet open={depsOpen} onOpenChange={setDepsOpen} report={depReport} onJump={jumpTo} />
      <OriginalSheet
        open={originalOpen}
        onOpenChange={setOriginalOpen}
        cardId={record.id}
        card={card}
        state={originalState}
        avatar={avatar}
        onAvatarChange={setAvatar}
      />
      <CropDialog
        source={cropSource}
        onCancel={() => setCropSource(null)}
        onDone={async (png) => {
          setCropSource(null)
          setAvatar(png)
          await setCardAvatar(record.id, png)
          toast.success('头像已更换')
        }}
      />
    </div>
  )
}

export default function CardEditorPage() {
  const { id = '' } = useParams()
  const [record, setRecord] = useState<CardRecord | null | undefined>(undefined)
  const [readyId, setReadyId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setReadyId(null)
    void db.cards.get(id).then((r) => {
      if (cancelled) return
      setRecord(r ?? null)
      if (r) {
        const doc: LoadedDoc = { ...makeCardDoc(r.card), id: r.id }
        useCardDoc.getState().load(doc)
        setReadyId(r.id)
      }
    })
    return () => {
      cancelled = true
    }
  }, [id])

  if (record === null) {
    return (
      <div className="flex flex-col items-center gap-3 p-10">
        <p>找不到这张卡，可能已经被删除。</p>
        <Button asChild variant="outline">
          <Link to="/">回到卡库</Link>
        </Button>
      </div>
    )
  }
  if (!record || readyId !== id) return <div className="p-10 text-center text-sm text-muted-foreground">加载中…</div>
  return <Editor key={id} record={record} />
}
