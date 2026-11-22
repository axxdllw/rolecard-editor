import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowUpToLineIcon, CodeIcon, EyeIcon, GripVerticalIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useCallback, useState } from 'react'
import { ChatPreview } from '@/components/ChatPreview'
import { confirm } from '@/components/confirm'
import { TextEditor } from '@/components/TextEditor'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSettings } from '@/lib/settings'
import { setCardPath, updateCard, useCardDoc, useCardPath } from './cardDoc'
import { AiFieldButton } from '@/features/ai/AiRewriteDialog'
import { cardRewriteContext } from '@/features/ai/cardContext'
import { FieldLabel, Section, TokenBadge } from './fields'

// zustand 选择器的兜底值必须是稳定引用，否则会无限重渲染
const EMPTY: string[] = []

function usePreviewContext() {
  const charName = useCardPath<string>(['data', 'name'], '')
  const userName = useSettings((s) => s.previewUserName)
  return { charName, userName }
}

function GreetingItem({
  id,
  index,
  text,
  preview,
  avatar,
  code,
}: {
  id: string
  index: number
  text: string
  preview: boolean
  avatar: Blob | null
  code: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const { charName, userName } = usePreviewContext()
  const onChange = useCallback(
    (v: string) => updateCard((d) => void (d.card.data.alternate_greetings[index] = v), { key: `greeting.${index}`, label: '编辑开场白' }),
    [index],
  )

  const setMain = () =>
    updateCard(
      (d) => {
        const data = d.card.data
        const main = data.first_mes
        data.first_mes = data.alternate_greetings[index]
        data.alternate_greetings[index] = main
      },
      { label: '设为主开场白' },
    )

  const remove = async () => {
    if (text.trim() && !(await confirm({ title: `删除备选开场白 ${index + 1}？`, confirmText: '删除', destructive: true }))) return
    updateCard((d) => void d.card.data.alternate_greetings.splice(index, 1), { label: '删除开场白' })
  }

  return (
    <div
      id={id}
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'relative z-10 opacity-80' : undefined}
    >
      <div className="mb-1.5 flex items-center gap-1">
        <button type="button" className="cursor-grab touch-none text-muted-foreground" aria-label="拖动排序" {...attributes} {...listeners}>
          <GripVerticalIcon className="size-4" />
        </button>
        <span className="text-sm font-medium">备选开场白 {index + 1}</span>
        <div className="flex-1" />
        <AiFieldButton
          target={() => ({
            fieldLabel: `备选开场白 ${index + 1}`,
            fieldHint: '备选开场白：用户在聊天开头可以切换到这一条',
            value: text,
            getContext: () => cardRewriteContext(useCardDoc.getState().doc?.card),
            onApply: (v) => updateCard((d) => void (d.card.data.alternate_greetings[index] = v), { label: 'AI 改写开场白' }),
          })}
        />
        <TokenBadge text={text} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={setMain} aria-label="设为主开场白">
              <ArrowUpToLineIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>设为主开场白（与当前主开场白互换）</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="icon-xs" onClick={remove} aria-label="删除">
          <Trash2Icon />
        </Button>
      </div>
      {preview ? (
        <ChatPreview text={text} charName={charName} userName={userName} avatar={avatar} />
      ) : (
        <TextEditor value={text} onChange={onChange} minHeight={100} maxHeight={420} language={code ? 'html' : 'text'} fullscreenTitle={`备选开场白 ${index + 1}`} />
      )}
    </div>
  )
}

export function GreetingsSection({ avatar }: { avatar: Blob | null }) {
  const firstMes = useCardPath<string>(['data', 'first_mes'], '')
  const greetings = useCardDoc((s) => s.doc?.card.data.alternate_greetings ?? EMPTY)
  const groupGreetings = useCardDoc((s) => s.doc?.card.data.group_only_greetings ?? EMPTY)
  const [preview, setPreview] = useState(false)
  const [code, setCode] = useState(false)
  const { charName, userName } = usePreviewContext()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const ids = greetings.map((_, i) => `greeting-${i}`)

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    updateCard((d) => {
      d.card.data.alternate_greetings = arrayMove([...d.card.data.alternate_greetings], from, to)
    }, { label: '调整开场白顺序' })
  }

  const onFirstChange = useCallback((v: string) => setCardPath(['data', 'first_mes'], v, '编辑主开场白'), [])

  return (
    <Section
      id="greetings"
      title="开场白"
      description="新建聊天时角色说的第一句话。备选开场白可以在聊天里左右切换。"
      actions={
        <div className="flex gap-1">
          <Button
            variant={code ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setCode(!code)}
            title="美化卡的开场白里常有 HTML，切换为代码高亮编辑"
          >
            <CodeIcon /> HTML
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPreview(!preview)}>
            {preview ? <PencilIcon /> : <EyeIcon />} {preview ? '编辑' : '预览'}
          </Button>
        </div>
      }
    >
      <div id="field-data-first_mes" className="flex flex-col gap-1.5">
        <FieldLabel
          label="主开场白"
          hint="first_mes：新建聊天时默认显示"
          extra={
            <div className="flex items-center gap-2">
              <AiFieldButton
                target={() => ({
                  fieldLabel: '主开场白',
                  fieldHint: 'first_mes：新建聊天时角色说的第一段话，决定开局的场景和文风',
                  value: firstMes,
                  getContext: () => cardRewriteContext(useCardDoc.getState().doc?.card, 'first_mes'),
                  onApply: (v) => setCardPath(['data', 'first_mes'], v, 'AI 改写主开场白'),
                })}
              />
              <TokenBadge text={firstMes} />
            </div>
          }
        />
        {preview ? (
          <ChatPreview text={firstMes} charName={charName} userName={userName} avatar={avatar} />
        ) : (
          <TextEditor value={firstMes} onChange={onFirstChange} minHeight={120} maxHeight={480} language={code ? 'html' : 'text'} fullscreenTitle="主开场白" />
        )}
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-4">
            {greetings.map((text, i) => (
              <GreetingItem key={ids[i]} id={ids[i]} index={i} text={text} preview={preview} avatar={avatar} code={code} />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <Button
        variant="outline"
        className="self-start"
        onClick={() => updateCard((d) => void d.card.data.alternate_greetings.push(''), { label: '添加开场白' })}
      >
        <PlusIcon /> 添加备选开场白
      </Button>

      <div className="flex flex-col gap-2 border-t pt-3">
        <FieldLabel label={`群聊专用开场白（${groupGreetings.length}）`} hint="group_only_greetings：只在群聊里使用的开场白（V3 新增）" />
        {groupGreetings.map((text, i) => (
          <div key={i} id={`group-greeting-${i}`} className="flex gap-2">
            <div className="flex-1">
              <TextEditor
                value={text}
                minHeight={60}
                maxHeight={300}
                onChange={(v) => updateCard((d) => void (d.card.data.group_only_greetings[i] = v), { key: `group-greeting.${i}` })}
              />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="删除"
              onClick={() => updateCard((d) => void d.card.data.group_only_greetings.splice(i, 1), { label: '删除群聊开场白' })}
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() =>
            updateCard((d) => {
              d.card.data.group_only_greetings ??= []
              d.card.data.group_only_greetings.push('')
            })
          }
        >
          <PlusIcon /> 添加群聊开场白
        </Button>
      </div>
    </Section>
  )
}
