/**
 * 侧栏 AI 助手面板：与当前角色卡多轮对话，流式输出回复，逐条对比并应用 card-edit 修改提案。
 */
import type { Draft } from 'immer'
import {
  AlertTriangleIcon,
  CheckIcon,
  LoaderIcon,
  RotateCwIcon,
  SendHorizontalIcon,
  SquareIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { confirm } from '@/components/confirm'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { streamChat } from '@/core/ai/client'
import {
  applyEdit,
  buildAssistantRequest,
  parseAssistantReply,
  previewEdit,
  type AssistantEdit,
  type AssistantTurn,
} from '@/core/ai/tasks/assistant'
import { AiError } from '@/core/ai/types'
import type { CharacterCardV3 } from '@/core/card/types'
import { entryTitle } from '@/core/lorebook/entry'
import { uuid } from '@/core/util/id'
import type { AssistantChatMessage } from '@/db/db'
import { updateCard, useCardDoc, type CardDoc } from '@/features/editor/cardDoc'
import { useFocusEntry } from '@/features/editor/focusEntry'
import { useActiveAiProfile } from '@/lib/aiSettings'
import { cn } from '@/lib/utils'
import { clearAssistantChat, getAssistantChat, saveAssistantChat } from '@/services/assistantChats'
import { AssistantProposal } from './AssistantProposal'

export interface AssistantPanelProps {
  cardId: string
  onClose?: () => void
  className?: string
}

const EXAMPLE_PROMPTS = [
  '检查描述、性格和开场白有没有矛盾',
  '把性格写得更立体一些',
  '根据描述补几条世界书条目',
  '开场白太长了，帮我精简',
] as const

/** 过滤发给模型的历史：去掉带 error 的助手消息及其对应的那条用户消息 */
function toHistoryTurns(messages: AssistantChatMessage[]): AssistantTurn[] {
  const turns: AssistantTurn[] = []
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      if (msg.error || !msg.content.trim()) {
        if (turns.length > 0 && turns[turns.length - 1].role === 'user') {
          turns.pop()
        }
        continue
      }
      turns.push({ role: 'assistant', content: msg.content })
    } else {
      turns.push({ role: 'user', content: msg.content })
    }
  }
  return turns
}

/** add_entry 新增世界书条目后补齐列表用的 entryKeys，保证世界书编辑器正常选中和撤销 */
function syncEntryKeys(draft: Draft<CardDoc>) {
  const count = draft.card.data.character_book?.entries.length ?? 0
  while (draft.entryKeys.length < count) {
    draft.entryKeys.push(uuid())
  }
}

interface AssistantReplyViewProps {
  message: AssistantChatMessage
  card: CharacterCardV3 | undefined
  isStreaming: boolean
  canRetry: boolean
  onApplyOne: (editKey: string, edit: AssistantEdit) => void
  onApplyAll: (items: Array<{ key: string; edit: AssistantEdit }>) => void
  onDismiss: (editKey: string) => void
  onRestore: (editKey: string) => void
  onRetry: () => void
}

function AssistantReplyView({
  message,
  card,
  isStreaming,
  canRetry,
  onApplyOne,
  onApplyAll,
  onDismiss,
  onRestore,
  onRetry,
}: AssistantReplyViewProps) {
  const segments = useMemo(() => parseAssistantReply(message.content), [message.content])

  return (
    <div className="flex flex-col gap-2">
      {isStreaming && !message.content && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <LoaderIcon className="size-3.5 animate-spin" />
          <span>思考中…</span>
        </div>
      )}

      {segments.map((seg, segIndex) => {
        if (seg.type === 'text') {
          return (
            <div key={segIndex} className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {seg.text}
            </div>
          )
        }

        if (seg.type === 'pending') {
          return (
            <div key={segIndex} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {isStreaming ? (
                <>
                  <LoaderIcon className="size-3.5 animate-spin" />
                  <span>正在写修改提案…</span>
                </>
              ) : (
                <>
                  <AlertTriangleIcon className="size-3.5 text-amber-600 dark:text-amber-400" />
                  <span>这段修改提案没有生成完整，可以让助手重新给一次</span>
                </>
              )}
            </div>
          )
        }

        if (seg.type === 'broken') {
          return (
            <div key={segIndex} className="flex items-start gap-1.5 rounded-md border border-amber-300/70 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:border-amber-800 dark:text-amber-400">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>这段修改提案格式有误，没法解析，可以让助手重新给一次</span>
            </div>
          )
        }

        const pendingItems: Array<{ key: string; edit: AssistantEdit }> = []
        seg.edits.forEach((edit, editIndex) => {
          const key = `${segIndex}:${editIndex}`
          if (!message.editStates?.[key]) {
            pendingItems.push({ key, edit })
          }
        })

        return (
          <div key={segIndex} className="flex flex-col gap-2">
            {seg.edits.map((edit, editIndex) => {
              const key = `${segIndex}:${editIndex}`
              return (
                <AssistantProposal
                  key={key}
                  edit={edit}
                  card={card}
                  status={message.editStates?.[key]}
                  onApply={() => onApplyOne(key, edit)}
                  onDismiss={() => onDismiss(key)}
                  onRestore={() => onRestore(key)}
                />
              )
            })}
            {seg.dropped > 0 && (
              <p className="text-xs text-muted-foreground">有 {seg.dropped} 条提案格式不对，已忽略</p>
            )}
            {pendingItems.length >= 2 && (
              <div className="flex justify-end">
                <Button size="sm" variant="outline" onClick={() => onApplyAll(pendingItems)}>
                  <CheckIcon /> 全部应用（{pendingItems.length}）
                </Button>
              </div>
            )}
          </div>
        )
      })}

      {message.error && (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <p className="break-words">{message.error}</p>
          <Button size="xs" variant="outline" disabled={!canRetry} onClick={onRetry}>
            <RotateCwIcon /> 重试
          </Button>
        </div>
      )}
    </div>
  )
}

export default function AssistantPanel({ cardId, onClose, className }: AssistantPanelProps) {
  const profile = useActiveAiProfile()
  const card = useCardDoc((s) => s.doc?.card)
  const focusIndex = useFocusEntry((s) => s.index)

  const [messages, setMessages] = useState<AssistantChatMessage[]>([])
  const [loadedCardId, setLoadedCardId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [fullLorebook, setFullLorebook] = useState(false)
  const [streamingId, setStreamingId] = useState<string | null>(null)

  // 记录用户是否手动去掉了当前聚焦条目；聚焦条目变化时自动恢复附带
  const [prevFocus, setPrevFocus] = useState<number | null>(focusIndex)
  const [focusDismissed, setFocusDismissed] = useState(false)
  if (focusIndex !== prevFocus) {
    setPrevFocus(focusIndex)
    setFocusDismissed(false)
  }

  const messagesRef = useRef<AssistantChatMessage[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const streaming = streamingId !== null
  const loaded = loadedCardId === cardId

  // 加载该卡的对话记录（异步回调里 setState，避免 effect 内同步 setState）
  useEffect(() => {
    let cancelled = false
    autoScrollRef.current = true
    void getAssistantChat(cardId).then((record) => {
      if (cancelled) return
      const next = record?.messages ?? []
      messagesRef.current = next
      setMessages(next)
      setLoadedCardId(cardId)
    })
    return () => {
      cancelled = true
    }
  }, [cardId])

  // 卸载或切卡时中止正在进行的请求
  useEffect(() => () => abortRef.current?.abort(), [cardId])

  // 新消息或流式输出时自动滚到底；用户往上翻时保持位置不动
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !autoScrollRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    autoScrollRef.current = distance <= 48
  }

  const updateMessages = useCallback(
    (updater: (prev: AssistantChatMessage[]) => AssistantChatMessage[], persist = false) => {
      const next = updater(messagesRef.current)
      messagesRef.current = next
      setMessages(next)
      if (persist) {
        void saveAssistantChat(cardId, next)
      }
      return next
    },
    [cardId],
  )

  const entries = card?.data.character_book?.entries
  const validFocusEntry =
    focusIndex !== null && entries && focusIndex >= 1 && focusIndex <= entries.length
      ? { index: focusIndex, title: entryTitle(entries[focusIndex - 1], focusIndex - 1) }
      : null
  const activeFocusEntry = validFocusEntry && !focusDismissed ? validFocusEntry : null
  const focusEntryIndex = activeFocusEntry?.index

  const runAssistantTurn = useCallback(
    async (historySource: AssistantChatMessage[], userText: string, assistantId: string) => {
      if (!profile) return
      const currentCard = useCardDoc.getState().doc?.card
      if (!currentCard) return

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setStreamingId(assistantId)

      let latestText = ''
      try {
        const request = buildAssistantRequest({
          card: currentCard,
          history: toHistoryTurns(historySource),
          message: userText,
          focusEntry: focusEntryIndex,
          fullLorebook,
        })
        const result = await streamChat(profile, {
          ...request,
          signal: controller.signal,
          onText: (_delta, full) => {
            latestText = full
            if (!messagesRef.current.some((m) => m.id === assistantId)) return
            updateMessages(
              (prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: full } : m)),
              false,
            )
          },
        })
        if (abortRef.current === controller) {
          abortRef.current = null
          setStreamingId(null)
        }
        if (!messagesRef.current.some((m) => m.id === assistantId)) return
        updateMessages(
          (prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: result.text } : m)),
          true,
        )
      } catch (e) {
        if (abortRef.current === controller) {
          abortRef.current = null
          setStreamingId(null)
        }
        // 对话若在生成期间已被清空，不再写回
        if (!messagesRef.current.some((m) => m.id === assistantId)) return

        if (e instanceof AiError && e.kind === 'aborted') {
          if (latestText.trim()) {
            updateMessages(
              (prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: latestText } : m)),
              true,
            )
          } else {
            updateMessages((prev) => prev.filter((m) => m.id !== assistantId), true)
          }
          return
        }

        const errText = e instanceof Error ? e.message : String(e)
        updateMessages(
          (prev) => prev.map((m) => (m.id === assistantId ? { ...m, error: errText } : m)),
          true,
        )
      }
    },
    [profile, focusEntryIndex, fullLorebook, updateMessages],
  )

  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text || !profile || streaming || !loaded) return
    if (!useCardDoc.getState().doc?.card) return

    const historySource = messagesRef.current
    const now = Date.now()
    const userMsg: AssistantChatMessage = { id: uuid(), role: 'user', content: text, createdAt: now }
    const assistantMsg: AssistantChatMessage = { id: uuid(), role: 'assistant', content: '', createdAt: now + 1 }

    autoScrollRef.current = true
    setInput('')
    updateMessages((prev) => [...prev, userMsg, assistantMsg], false)
    void runAssistantTurn(historySource, text, assistantMsg.id)
  }, [input, profile, streaming, loaded, updateMessages, runAssistantTurn])

  const handleRetry = useCallback(
    (errorMsgId: string) => {
      if (!profile || streaming) return
      const list = messagesRef.current
      const errIdx = list.findIndex((m) => m.id === errorMsgId)
      if (errIdx <= 0) return
      const prevUser = list[errIdx - 1]
      if (prevUser.role !== 'user') return

      const historySource = list.slice(0, errIdx - 1)
      const nextAssistant: AssistantChatMessage = {
        id: uuid(),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
      }
      autoScrollRef.current = true
      updateMessages(
        (prev) => prev.map((m) => (m.id === errorMsgId ? nextAssistant : m)),
        false,
      )
      void runAssistantTurn(historySource, prevUser.content, nextAssistant.id)
    },
    [profile, streaming, updateMessages, runAssistantTurn],
  )

  const handleClear = async () => {
    const ok = await confirm({
      title: '清空这张卡的助手对话？',
      description: '已应用到卡片里的修改不会被撤销。',
      confirmText: '清空',
      destructive: true,
    })
    if (!ok) return
    abortRef.current?.abort()
    abortRef.current = null
    setStreamingId(null)
    messagesRef.current = []
    setMessages([])
    await clearAssistantChat(cardId)
  }

  const handleApplyOne = useCallback(
    (messageId: string, editKey: string, edit: AssistantEdit) => {
      const currentCard = useCardDoc.getState().doc?.card
      if (!currentCard) return
      let label: string
      try {
        label = previewEdit(currentCard, edit).label
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
        return
      }
      try {
        updateCard(
          (d) => {
            applyEdit(d.card as CharacterCardV3, edit)
            syncEntryKeys(d)
          },
          { label: `AI 助手：${label}` },
        )
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
        return
      }
      updateMessages(
        (prev) =>
          prev.map((m) =>
            m.id === messageId
              ? { ...m, editStates: { ...m.editStates, [editKey]: 'applied' } }
              : m,
          ),
        true,
      )
      toast.success('已应用，可撤销')
    },
    [updateMessages],
  )

  const handleApplyAll = useCallback(
    (messageId: string, items: Array<{ key: string; edit: AssistantEdit }>) => {
      const currentCard = useCardDoc.getState().doc?.card
      if (!currentCard || items.length === 0) return

      // 先在副本上试跑一遍，得出准确可应用的条数用于撤销标签
      const probe = structuredClone(currentCard)
      let expectedApplied = 0
      for (const item of items) {
        try {
          applyEdit(probe, item.edit)
          expectedApplied++
        } catch {
          // 跳过失败项
        }
      }
      if (expectedApplied === 0) {
        toast.error(`有 ${items.length} 条提案没能应用，请查看各条原因`)
        return
      }

      const appliedKeys: string[] = []
      let failedCount = 0
      updateCard(
        (d) => {
          for (const item of items) {
            try {
              applyEdit(d.card as CharacterCardV3, item.edit)
              syncEntryKeys(d)
              appliedKeys.push(item.key)
            } catch {
              failedCount++
            }
          }
        },
        { label: `AI 助手：应用 ${expectedApplied} 处修改` },
      )

      if (appliedKeys.length > 0) {
        updateMessages(
          (prev) =>
            prev.map((m) => {
              if (m.id !== messageId) return m
              const nextStates = { ...m.editStates }
              for (const key of appliedKeys) nextStates[key] = 'applied'
              return { ...m, editStates: nextStates }
            }),
          true,
        )
      }

      if (failedCount === 0) {
        toast.success(`已应用 ${appliedKeys.length} 处修改，可撤销`)
      } else if (appliedKeys.length > 0) {
        toast.warning(`已应用 ${appliedKeys.length} 处修改，另有 ${failedCount} 条没能应用`)
      } else {
        toast.error(`有 ${failedCount} 条提案没能应用`)
      }
    },
    [updateMessages],
  )

  const handleSetEditState = useCallback(
    (messageId: string, editKey: string, state: 'dismissed' | undefined) => {
      updateMessages(
        (prev) =>
          prev.map((m) => {
            if (m.id !== messageId) return m
            const nextStates = { ...m.editStates }
            if (state) nextStates[editKey] = state
            else delete nextStates[editKey]
            return {
              ...m,
              editStates: Object.keys(nextStates).length > 0 ? nextStates : undefined,
            }
          }),
        true,
      )
    },
    [updateMessages],
  )

  const fillExample = (text: string) => {
    setInput(text)
    textareaRef.current?.focus()
  }

  return (
    <div className={cn('flex min-h-0 flex-col gap-2', className)}>
      {/* 顶栏 */}
      <div className="flex shrink-0 items-center gap-2 border-b pb-2">
        <span className="shrink-0 font-medium">AI 助手</span>
        {profile && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {profile.name} · {profile.model || '未选模型'}
          </span>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon-sm"
          title="清空对话"
          aria-label="清空对话"
          disabled={messages.length === 0}
          onClick={() => void handleClear()}
        >
          <Trash2Icon />
        </Button>
        {onClose && (
          <Button variant="ghost" size="icon-sm" aria-label="关闭助手" onClick={onClose}>
            <XIcon />
          </Button>
        )}
      </div>

      {/* 消息列表 */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-0.5 py-1"
      >
        {!profile && messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-start justify-center gap-3 px-2 text-sm">
            <p>还没设置 AI 接口。到设置页添加一个（支持 OpenAI 兼容接口、Claude、Gemini），填上自己的 API key 就能用。</p>
            <Button size="sm" asChild onClick={onClose}>
              <Link to="/settings">去设置</Link>
            </Button>
          </div>
        ) : !loaded ? (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">加载对话…</div>
        ) : messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-start justify-center gap-3 px-2">
            <p className="text-sm leading-relaxed text-muted-foreground">
              和 AI 聊这张卡：找矛盾、出主意、改字段、补世界书。需要改卡时它会给出修改提案，你确认后才写入。
            </p>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <Button
                  key={prompt}
                  variant="outline"
                  size="sm"
                  className="h-auto whitespace-normal py-1.5 text-left text-xs font-normal"
                  onClick={() => fillExample(prompt)}
                >
                  {prompt}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, idx) =>
            msg.role === 'user' ? (
              <div key={msg.id} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground">
                  {msg.content}
                </div>
              </div>
            ) : (
              <div key={msg.id} className="min-w-0">
                <AssistantReplyView
                  message={msg}
                  card={card}
                  isStreaming={streamingId === msg.id}
                  canRetry={!streaming && !!profile && idx > 0 && messages[idx - 1]?.role === 'user'}
                  onApplyOne={(editKey, edit) => handleApplyOne(msg.id, editKey, edit)}
                  onApplyAll={(items) => handleApplyAll(msg.id, items)}
                  onDismiss={(editKey) => handleSetEditState(msg.id, editKey, 'dismissed')}
                  onRestore={(editKey) => handleSetEditState(msg.id, editKey, undefined)}
                  onRetry={() => handleRetry(msg.id)}
                />
              </div>
            ),
          )
        )}
      </div>

      {/* 已有历史但接口被移除时的提示 */}
      {!profile && messages.length > 0 && (
        <div className="flex shrink-0 items-center justify-between gap-2 rounded-lg border bg-muted/40 px-2.5 py-2 text-xs">
          <span>还没设置 AI 接口，无法继续发送。</span>
          <Button size="xs" asChild onClick={onClose}>
            <Link to="/settings">去设置</Link>
          </Button>
        </div>
      )}

      {/* 底部输入区 */}
      <div className="flex shrink-0 flex-col gap-2 border-t pt-2">
        <div className="flex flex-wrap items-center gap-2">
          {activeFocusEntry && (
            <Badge variant="secondary" className="max-w-full gap-1 pr-1 font-normal">
              <span className="truncate">附带条目：「{activeFocusEntry.title}」</span>
              <button
                type="button"
                onClick={() => setFocusDismissed(true)}
                className="rounded-full p-0.5 hover:bg-muted-foreground/20"
                aria-label="本次不附带该条目"
              >
                <XIcon className="size-3" />
              </button>
            </Badge>
          )}
          <div className="flex-1" />
          <Label className="flex cursor-pointer items-center gap-1.5 text-xs font-normal text-muted-foreground">
            <Switch size="sm" checked={fullLorebook} onCheckedChange={setFullLorebook} />
            带上整本世界书
          </Label>
        </div>

        <div className="flex items-end gap-2">
          <Textarea
            ref={textareaRef}
            rows={2}
            value={input}
            disabled={!profile}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder={profile ? '说说你想改什么，或问问关于这张卡的想法…' : '请先在设置页配置 AI 接口'}
            className="max-h-52 min-h-10 flex-1 resize-none overflow-y-auto text-base"
          />
          {streaming ? (
            <Button
              variant="outline"
              size="icon"
              aria-label="停止生成"
              title="停止"
              onClick={() => abortRef.current?.abort()}
            >
              <SquareIcon />
            </Button>
          ) : (
            <Button
              size="icon"
              aria-label="发送"
              title="发送（Enter）"
              disabled={!profile || !loaded || !input.trim()}
              onClick={handleSend}
            >
              <SendHorizontalIcon />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
