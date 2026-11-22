/**
 * 渲染预览侧栏：按酒馆和酒馆助手的规则实时渲染当前卡片的开场白和模拟对话，
 * 并在隔离的预览宿主页里运行卡片的酒馆助手脚本（如 MVU）。
 */
import { BracesIcon, RotateCwIcon, ScrollTextIcon, Trash2Icon, XIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { JsonObject, Lorebook } from '@/core/card/types'
import { lorebookToWorld } from '@/core/lorebook/world'
import { readFloors, readMvuInit, readMvuUpdate, statData } from '@/core/mvu/records'
import { buildSampleUpdate } from '@/core/mvu/sample'
import { receiveMessage } from '@/core/render/display'
import { enabledHelperScripts, helperCharacterVariables, usesMvu } from '@/core/render/helperScripts'
import { initVariablesFromBook, inspectInitvar } from '@/core/render/initvar'
import { getRegexScripts } from '@/core/regex/regex'
import { db, type CardPreviewData } from '@/db/db'
import { useCardDoc } from '@/features/editor/cardDoc'
import { useSettings } from '@/lib/settings'
import { cn } from '@/lib/utils'
import { formatMessage } from './formatMessage'
import { HOST_SANDBOX, hostDocumentUrl } from './hostFrame'
import type { HostMessage, HostSession } from './hostRuntime'
import MvuWorkbench, { type MvuWorkbenchState } from './MvuWorkbench'
import { buildFrontendDocument, buildScriptDocument } from './thShim'

const DEFAULT_PREVIEW: CardPreviewData = { greeting: 0, exchange: false, userMessage: '', aiReply: '', variables: '', runScripts: true }
const RENDER_DELAY = 300
const MAX_LOGS = 300
const MAX_UPDATES = 20

/** 预览宿主页发来的变量数据，seq 是对应的会话编号（只保留最新一次会话的） */
type MvuState = MvuWorkbenchState & { seq: number }
const EMPTY_MVU: MvuState = { seq: -1, init: null, updates: [], floors: [] }

/** 脚本写进酒馆扩展设置的内容（如 MVU 的设置），在宿主页重建之间保留 */
let savedExtensionSettings: Record<string, unknown> | null = null

interface LogEntry {
  id: number
  level: string
  source: string
  text: string
}

/** 字符串指纹（FNV-1a） */
function hashString(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36) + text.length.toString(36)
}

/** 头像缩略图（data URL），预览页读不到本页的 blob 地址 */
function useAvatarThumb(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!blob) return
    void (async () => {
      try {
        const bitmap = await createImageBitmap(blob)
        const scale = Math.min(1, 160 / Math.max(bitmap.width, bitmap.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(bitmap.width * scale)
        canvas.height = Math.round(bitmap.height * scale)
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        if (!cancelled) setUrl(canvas.toDataURL('image/png'))
      } catch {
        if (!cancelled) setUrl(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [blob])
  return blob ? url : null
}

/** 预览数据存进卡库记录（不写进卡，随卡删除） */
function usePreviewData(cardId: string) {
  const [data, setData] = useState<CardPreviewData>(DEFAULT_PREVIEW)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(data)
  useEffect(() => {
    let cancelled = false
    void db.cards.get(cardId).then((record) => {
      if (cancelled || !record?.preview) return
      latest.current = { ...DEFAULT_PREVIEW, ...record.preview }
      setData(latest.current)
    })
    return () => {
      cancelled = true
    }
  }, [cardId])
  const update = useCallback(
    (patch: Partial<CardPreviewData>) => {
      setData((prev) => {
        const next = { ...prev, ...patch }
        latest.current = next
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => void db.cards.update(cardId, { preview: latest.current }), 500)
        return next
      })
    },
    [cardId],
  )
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current)
        void db.cards.update(cardId, { preview: latest.current })
      }
    },
    [cardId],
  )
  return [data, update] as const
}

function parseObject(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export interface RenderPanelProps {
  cardId: string
  avatar: Blob | null
  onClose?: () => void
  className?: string
}

export default function RenderPanel({ cardId, avatar, onClose, className }: RenderPanelProps) {
  const card = useCardDoc((s) => s.doc?.card)
  const userName = useSettings((s) => s.previewUserName)
  const [preview, updatePreview] = usePreviewData(cardId)
  const [section, setSection] = useState<'' | 'vars' | 'log'>('')
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [reloadKey, setReloadKey] = useState(0)
  const [readyKey, setReadyKey] = useState<string | null>(null)
  const [varsDraft, setVarsDraft] = useState<string | null>(null)
  const [mvuState, setMvuState] = useState<MvuState>(EMPTY_MVU)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const logId = useRef(0)
  const seq = useRef(0)
  const charAvatar = useAvatarThumb(avatar)
  const hostUrl = useMemo(() => hostDocumentUrl(), [])

  const charName = card?.data.name || '角色'
  const ext = useMemo(() => (card?.data.extensions ?? {}) as JsonObject, [card?.data.extensions])
  const greetings = useMemo(() => (card ? [card.data.first_mes ?? '', ...(card.data.alternate_greetings ?? [])] : []), [card])
  const greetingIndex = Math.min(preview.greeting, Math.max(0, greetings.length - 1))
  const allScripts = useMemo(() => enabledHelperScripts(ext), [ext])
  const runScripts = preview.runScripts !== false
  const scripts = useMemo(() => (runScripts ? allScripts : []), [runScripts, allScripts])
  const mvu = usesMvu(scripts)

  // 脚本变了就重建宿主页（脚本只在宿主页启动时加载一次）
  const hostKey = useMemo(
    () => `${reloadKey}:${hashString(JSON.stringify(scripts.map((s) => [s.id, s.name, s.content, s.button, s.data])))}`,
    [scripts, reloadKey],
  )
  const hostKeyRef = useRef(hostKey)
  useEffect(() => {
    hostKeyRef.current = hostKey
  }, [hostKey])
  const frameReady = readyKey === hostKey

  // 变量：手动改过的优先，否则取世界书里的 [initvar]
  const initVars = useMemo(() => initVariablesFromBook(card?.data.character_book as Lorebook | undefined), [card?.data.character_book])
  const characterBook = card?.data.character_book as Lorebook | undefined
  const initvarReports = useMemo(() => (mvu ? inspectInitvar(characterBook) : []), [mvu, characterBook])
  const manualVars = useMemo(() => parseObject(preview.variables), [preview.variables])

  // 组装一次会话（防抖），交给宿主页重放
  const lastSession = useRef('')
  useEffect(() => {
    if (!card || !frameReady) return
    const timer = setTimeout(() => {
      const ctx = { char: charName, user: userName }
      const regex = getRegexScripts(ext as Record<string, unknown>)
      const sources = [{ name: charName, isUser: false, text: greetings[greetingIndex] ?? '' }]
      if (preview.exchange) {
        sources.push({ name: userName, isUser: true, text: preview.userMessage }, { name: charName, isUser: false, text: preview.aiReply })
      }
      const received = sources.map((s) => receiveMessage(s, regex, ctx))
      const last = sources.length - 1
      const messages: HostMessage[] = sources.map((s, i) => {
        const formatted = formatMessage(received[i], { name: s.name, isUser: s.isUser, depth: last - i, scripts: regex, ctx })
        return {
          name: s.name,
          isUser: s.isUser,
          mes: received[i],
          html: formatted.html,
          frontends: formatted.frontends.map((content) => buildFrontendDocument(content, charAvatar)),
          avatar: s.isUser ? null : charAvatar,
        }
      })
      const book = card.data.character_book as Lorebook | undefined
      const worldName = (typeof ext.world === 'string' && ext.world) || book?.name || charName
      const cardData: Record<string, unknown> = { ...card.data }
      delete cardData.character_book
      const stat = manualVars ?? (initVars.data as Record<string, unknown>)
      const session: Omit<HostSession, 'seq'> = {
        charName,
        userName,
        charAvatar,
        card: {
          name: card.data.name,
          description: card.data.description,
          personality: card.data.personality,
          scenario: card.data.scenario,
          first_mes: card.data.first_mes,
          mes_example: card.data.mes_example,
          creatorcomment: card.data.creator_notes,
          tags: card.data.tags,
          data: cardData,
        },
        world: book?.entries?.length ? { name: worldName, entries: lorebookToWorld(book).entries as Record<string, unknown> } : null,
        characterVariables: helperCharacterVariables(ext),
        // 有 MVU 时由它从 [initvar] 初始化，手动填写的变量作为第 0 楼的初始值；没有 MVU 时每层都放一份
        seed: mvu ? (manualVars ? { stat_data: manualVars } : null) : { stat_data: stat, display_data: stat, delta_data: {} },
        seedAll: !mvu,
        scripts: scripts.map((s) => ({ ...s, doc: buildScriptDocument(s.content) })),
        mvu,
        messages,
        extensionSettings: savedExtensionSettings,
      }
      const fingerprint = hashString(JSON.stringify({ ...session, extensionSettings: null }))
      if (fingerprint === lastSession.current) return
      lastSession.current = fingerprint
      frameRef.current?.contentWindow?.postMessage({ type: 'rce-session', session: { ...session, seq: ++seq.current } }, '*')
    }, RENDER_DELAY)
    return () => clearTimeout(timer)
  }, [card, ext, charName, userName, greetings, greetingIndex, preview.exchange, preview.userMessage, preview.aiReply, manualVars, initVars, charAvatar, scripts, mvu, frameReady])

  // 只接收预览页发来的消息，内容一律当纯文本显示
  useEffect(() => {
    /** 同一会话的数据累加，新会话的数据替换旧的 */
    const acceptMvu = (rawSeq: unknown, apply: (state: MvuState) => MvuState) => {
      const seqNo = Number(rawSeq)
      if (!Number.isInteger(seqNo)) return
      setMvuState((prev) => (seqNo < prev.seq ? prev : apply(seqNo > prev.seq ? { ...EMPTY_MVU, seq: seqNo } : prev)))
    }
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return
      const data = e.data as { type?: string; level?: string; text?: string; source?: string; [k: string]: unknown } | null
      if (data?.type === 'rce-ready') {
        lastSession.current = ''
        setMvuState(EMPTY_MVU)
        setReadyKey(hostKeyRef.current)
      } else if (data?.type === 'rce-log') {
        const entry: LogEntry = { id: ++logId.current, level: String(data.level), source: String(data.source ?? ''), text: String(data.text ?? '') }
        setLogs((prev) => [...prev, entry].slice(-MAX_LOGS))
      } else if (data?.type === 'rce-state') {
        const floors = readFloors(data.floors)
        acceptMvu(data.seq, (s) => ({ ...s, floors }))
      } else if (data?.type === 'rce-mvu-init') {
        const init = readMvuInit(data.init)
        if (init) acceptMvu(data.seq, (s) => ({ ...s, init }))
      } else if (data?.type === 'rce-mvu-update') {
        const update = readMvuUpdate(data.update)
        if (update) acceptMvu(data.seq, (s) => ({ ...s, updates: [...s.updates, update].slice(-MAX_UPDATES) }))
      } else if (data?.type === 'rce-settings') {
        if (data.extensionSettings && typeof data.extensionSettings === 'object') savedExtensionSettings = data.extensionSettings as Record<string, unknown>
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const errorCount = logs.filter((l) => l.level === 'error').length
  const varsText = varsDraft ?? (preview.variables.trim() ? preview.variables : JSON.stringify(initVars.data, null, 2))
  let varsError: string | null = null
  if (varsDraft !== null) {
    try {
      JSON.parse(varsDraft)
    } catch (e) {
      varsError = e instanceof Error ? e.message : String(e)
    }
  }

  // 按最新楼层的变量（没有时用 [initvar]）生成示例命令，追加到模拟对话的 AI 回复
  const insertSample = () => {
    const latest = mvuState.floors.at(-1)
    const base = (latest && statData(latest.variables)) ?? mvuState.init?.after ?? initVars.data
    const sample = buildSampleUpdate(base)
    if (!sample) {
      toast.error('当前变量里没有数值字段，没法生成 delta 示例')
      return
    }
    const reply = preview.aiReply.trimEnd()
    updatePreview({ exchange: true, aiReply: reply ? `${reply}\n\n${sample}` : `（示例回复正文）\n\n${sample}` })
    toast.success('已在 AI 回复末尾插入示例更新命令')
  }

  if (!card) return null

  const manualEditor = (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-muted-foreground">
        {mvu ? '初始变量（可选）：填写后作为第 0 楼的 stat_data，MVU 会再合并世界书的 [initvar]。' : '前端里 getVariables / Mvu 读到的 stat_data。'}
        {initVars.sources.length > 0 ? `默认取自世界书：${initVars.sources.join('、')}` : '世界书里没有 [initvar] 条目。'}
        {initVars.errors.map((e) => (
          <span key={e} className="block text-destructive">
            {e}
          </span>
        ))}
      </p>
      <Textarea rows={8} className="max-h-64 font-mono text-xs" value={varsText} onChange={(e) => setVarsDraft(e.target.value)} />
      {varsError && <p className="text-xs text-destructive">JSON 格式错误：{varsError}</p>}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={varsDraft === null || !!varsError}
          onClick={() => {
            updatePreview({ variables: varsDraft ?? '' })
            setVarsDraft(null)
            toast.success('变量已应用')
          }}
        >
          应用
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!preview.variables && varsDraft === null}
          onClick={() => {
            updatePreview({ variables: '' })
            setVarsDraft(null)
          }}
        >
          恢复默认
        </Button>
      </div>
    </div>
  )

  return (
    <div className={cn('flex min-h-0 flex-col gap-2 overflow-y-auto', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">渲染预览</span>
        <Select value={String(greetingIndex)} onValueChange={(v) => updatePreview({ greeting: Number(v) })}>
          <SelectTrigger size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {greetings.map((_, i) => (
              <SelectItem key={i} value={String(i)}>
                {i === 0 ? '主开场白' : `备选开场白 ${i}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Label className="flex items-center gap-1.5 text-sm font-normal">
          <Switch checked={preview.exchange} onCheckedChange={(v) => updatePreview({ exchange: v })} />
          模拟对话
        </Label>
        <div className="flex-1" />
        <Button variant="ghost" size="icon-sm" title="重新加载（重新运行脚本和前端）" aria-label="重新加载" onClick={() => setReloadKey((k) => k + 1)}>
          <RotateCwIcon />
        </Button>
        {onClose && (
          <Button variant="ghost" size="icon-sm" aria-label="关闭预览" onClick={onClose}>
            <XIcon />
          </Button>
        )}
      </div>

      {preview.exchange && (
        <div className="flex flex-col gap-1.5">
          <Textarea
            rows={1}
            className="min-h-8 text-sm"
            placeholder={`${userName} 的消息`}
            value={preview.userMessage}
            onChange={(e) => updatePreview({ userMessage: e.target.value })}
          />
          <Textarea
            rows={3}
            className="max-h-40 text-sm"
            placeholder="粘贴一段 AI 回复，例如带 <UpdateVariable> 变量更新和 <StatusPlaceHolderImpl/> 的正文，看 MVU 更新变量和状态栏的效果"
            value={preview.aiReply}
            onChange={(e) => updatePreview({ aiReply: e.target.value })}
          />
        </div>
      )}

      {allScripts.length > 0 && (
        <div className="flex items-start gap-2 rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
          <p className="flex-1">
            {runScripts
              ? `正在运行 ${allScripts.length} 个酒馆助手脚本（实验）。生成回复、斜杠命令等操作只记日志不执行。`
              : `这张卡有 ${allScripts.length} 个酒馆助手脚本，已关闭运行，依赖它们的界面可能不完整。`}
          </p>
          <Label className="flex shrink-0 items-center gap-1 text-xs font-normal">
            <Switch checked={runScripts} onCheckedChange={(v) => updatePreview({ runScripts: v })} />
            运行脚本
          </Label>
        </div>
      )}

      <iframe
        key={hostKey}
        ref={frameRef}
        title="渲染预览"
        sandbox={HOST_SANDBOX}
        src={hostUrl}
        className="min-h-72 w-full flex-1 rounded-lg border bg-[#171717]"
      />

      <div className="flex items-center gap-2">
        <ToggleGroup type="single" variant="outline" size="sm" value={section} onValueChange={(v) => setSection(v as typeof section)}>
          <ToggleGroupItem value="vars">
            <BracesIcon /> 变量
          </ToggleGroupItem>
          <ToggleGroupItem value="log">
            <ScrollTextIcon /> 日志
            {logs.length > 0 && (
              <Badge variant={errorCount ? 'destructive' : 'secondary'} className="ml-1 h-4 px-1 text-[10px]">
                {logs.length}
              </Badge>
            )}
          </ToggleGroupItem>
        </ToggleGroup>
        <span className="truncate text-xs text-muted-foreground">需要联网加载前端库；脚本在与编辑器隔离的预览页里运行</span>
      </div>

      {section === 'vars' &&
        (mvu ? (
          <div className="max-h-[55svh] shrink-0 overflow-y-auto">
            <MvuWorkbench initvar={initvarReports} state={mvuState} exchange={preview.exchange} onInsertSample={insertSample} manual={manualEditor} />
          </div>
        ) : (
          manualEditor
        ))}

      {section === 'log' && (
        <div className="flex max-h-56 flex-col gap-1 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs">
          {logs.length === 0 ? (
            <span className="text-muted-foreground">还没有日志。卡片报错、被拦下的操作会显示在这里。</span>
          ) : (
            <>
              <Button variant="ghost" size="sm" className="self-end" onClick={() => setLogs([])}>
                <Trash2Icon /> 清空
              </Button>
              {logs.map((l) => (
                <div key={l.id} className={cn('break-all', l.level === 'error' ? 'text-destructive' : l.level === 'warn' ? 'text-amber-600 dark:text-amber-400' : '')}>
                  <span className="text-muted-foreground">[{l.source}]</span> {l.text}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
