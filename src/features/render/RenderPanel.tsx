/**
 * 渲染预览侧栏：按酒馆和酒馆助手的规则实时渲染当前卡片的开场白和模拟对话。
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
import type { CharacterCardV3, JsonObject, Lorebook } from '@/core/card/types'
import { receiveMessage } from '@/core/render/display'
import { initVariablesFromBook } from '@/core/render/initvar'
import { getRegexScripts } from '@/core/regex/regex'
import { db, type CardPreviewData } from '@/db/db'
import { useCardDoc } from '@/features/editor/cardDoc'
import { useSettings } from '@/lib/settings'
import { cn } from '@/lib/utils'
import { buildChatFrameDocument, FRAME_SANDBOX, type ChatFrameMessage } from './chatFrame'
import { formatMessage } from './formatMessage'
import { buildFrontendDocument, type PreviewChatMessage } from './thShim'

const DEFAULT_PREVIEW: CardPreviewData = { greeting: 0, exchange: false, userMessage: '', aiReply: '', variables: '' }
const RENDER_DELAY = 300
const MAX_LOGS = 200

interface LogEntry {
  id: number
  level: string
  source: string
  text: string
}

/** 字符串指纹（FNV-1a），用来判断消息是否需要重新渲染 */
function hashString(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36) + text.length.toString(36)
}

/** 头像缩略图（data URL），沙箱里的 iframe 读不到本页的 blob 地址 */
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

/** 卡片里的酒馆助手角色脚本数量（预览不运行它们） */
function countHelperScripts(card: CharacterCardV3): number {
  const ext = (card.data.extensions ?? {}) as JsonObject
  const raw = ext.tavern_helper
  const settings = Array.isArray(raw) ? Object.fromEntries(raw as [string, unknown][]) : (raw as JsonObject | undefined)
  const scripts = (settings?.scripts ?? ext.TavernHelper_scripts) as unknown
  if (!Array.isArray(scripts)) return 0
  const count = (list: unknown[]): number =>
    list.reduce<number>((n, s) => {
      const item = s as JsonObject
      if (Array.isArray(item.scripts)) return n + count(item.scripts)
      return n + (item.enabled === false ? 0 : 1)
    }, 0)
  return count(scripts)
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
  const [frameReady, setFrameReady] = useState(false)
  const [varsDraft, setVarsDraft] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const logId = useRef(0)
  const charAvatar = useAvatarThumb(avatar)
  const chatDoc = useMemo(() => buildChatFrameDocument(), [])

  const charName = card?.data.name || '角色'
  const greetings = useMemo(() => (card ? [card.data.first_mes ?? '', ...(card.data.alternate_greetings ?? [])] : []), [card])
  const greetingIndex = Math.min(preview.greeting, Math.max(0, greetings.length - 1))
  const helperScripts = useMemo(() => (card ? countHelperScripts(card) : 0), [card])

  // 变量：手动改过的优先，否则取世界书里的 [initvar]
  const initVars = useMemo(() => initVariablesFromBook(card?.data.character_book as Lorebook | undefined), [card?.data.character_book])
  const variables = useMemo(() => {
    if (preview.variables.trim()) {
      try {
        const parsed: unknown = JSON.parse(preview.variables)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
      } catch {
        // 解析失败时退回默认值，编辑框里会提示
      }
    }
    return initVars.data as Record<string, unknown>
  }, [preview.variables, initVars])

  // 计算要显示的消息（防抖），推给聊天层
  const [messages, setMessages] = useState<ChatFrameMessage[]>([])
  useEffect(() => {
    if (!card) return
    const timer = setTimeout(() => {
      const ctx = { char: charName, user: userName }
      const scripts = getRegexScripts((card.data.extensions ?? {}) as Record<string, unknown>)
      const sources = [{ name: charName, isUser: false, text: greetings[greetingIndex] ?? '' }]
      if (preview.exchange) {
        sources.push({ name: userName, isUser: true, text: preview.userMessage }, { name: charName, isUser: false, text: preview.aiReply })
      }
      const received = sources.map((s) => receiveMessage(s, scripts, ctx))
      const last = sources.length - 1
      const chat: PreviewChatMessage[] = sources.map((s, i) => ({
        message_id: i,
        name: s.name,
        role: s.isUser ? 'user' : 'assistant',
        is_hidden: false,
        message: received[i],
      }))
      const cardData: Record<string, unknown> = { ...card.data }
      delete cardData.character_book
      const viewportHeight = frameRef.current?.clientHeight || 600
      const next = sources.map((s, i): ChatFrameMessage => {
        const formatted = formatMessage(received[i], { name: s.name, isUser: s.isUser, depth: last - i, scripts, ctx })
        const frontends = formatted.frontends.map((content, k) =>
          buildFrontendDocument(content, {
            iframeName: `TH-message--${i}--${k}`,
            messageId: i,
            lastMessageId: last,
            charName,
            userName,
            charAvatar,
            variables,
            chat,
            card: cardData,
            viewportHeight,
          }),
        )
        const hash = hashString(`${reloadKey}\n${s.name}\n${formatted.html}\n${frontends.join('\n')}`)
        return { key: `m${i}`, hash, index: i, name: s.name, isUser: s.isUser, avatar: s.isUser ? null : charAvatar, html: formatted.html, frontends }
      })
      setMessages(next)
    }, RENDER_DELAY)
    return () => clearTimeout(timer)
  }, [card, charName, userName, greetings, greetingIndex, preview.exchange, preview.userMessage, preview.aiReply, variables, charAvatar, reloadKey])

  useEffect(() => {
    if (frameReady) frameRef.current?.contentWindow?.postMessage({ type: 'rce-render', messages }, '*')
  }, [messages, frameReady])

  // 只接收聊天层发来的消息，内容一律当纯文本显示
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return
      const data = e.data as { type?: string; level?: string; text?: string; source?: string } | null
      if (data?.type === 'rce-ready') setFrameReady(true)
      else if (data?.type === 'rce-log') {
        const entry: LogEntry = { id: ++logId.current, level: String(data.level), source: String(data.source ?? ''), text: String(data.text ?? '') }
        setLogs((prev) => [...prev, entry].slice(-MAX_LOGS))
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

  if (!card) return null

  return (
    <div className={cn('flex min-h-0 flex-col gap-2', className)}>
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
        <Button variant="ghost" size="icon-sm" title="重新加载（重新运行前端脚本）" aria-label="重新加载" onClick={() => setReloadKey((k) => k + 1)}>
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
            placeholder="粘贴一段 AI 回复，例如带 <StatusPlaceHolderImpl/> 的正文，看状态栏效果"
            value={preview.aiReply}
            onChange={(e) => updatePreview({ aiReply: e.target.value })}
          />
        </div>
      )}

      {helperScripts > 0 && (
        <p className="rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
          这张卡有 {helperScripts} 个酒馆助手脚本（如 MVU、手机插件），预览里不运行它们，依赖它们的界面可能不完整。
        </p>
      )}

      <iframe
        ref={frameRef}
        title="渲染预览"
        sandbox={FRAME_SANDBOX}
        srcDoc={chatDoc}
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
        <span className="truncate text-xs text-muted-foreground">需要联网加载前端库；卡片脚本在隔离沙箱里运行</span>
      </div>

      {section === 'vars' && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">
            前端里 getVariables / Mvu 读到的 stat_data。
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
      )}

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
