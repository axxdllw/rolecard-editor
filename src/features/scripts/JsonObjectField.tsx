import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { TextEditor } from '@/components/TextEditor'
import { Button } from '@/components/ui/button'
import type { JsonObject } from '@/core/card/types'
import { FieldLabel } from '@/features/editor/fields'

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function check(text: string): { value: JsonObject | null; error: string | null } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : String(e) }
  }
  return isObject(parsed) ? { value: parsed, error: null } : { value: null, error: '必须是一个 JSON 对象（{ ... }）' }
}

interface JsonObjectFieldProps {
  /** 原始值；缺失时按空对象显示 */
  value: unknown
  onApply: (value: JsonObject) => void
  label: string
  hint?: string
  fullscreenTitle: string
  extra?: ReactNode
  minHeight?: number
  maxHeight?: number
}

/** JSON 对象编辑：边输入边校验，点“应用”才写回卡片 */
export function JsonObjectField({ value, onApply, label, hint, fullscreenTitle, extra, minHeight = 60, maxHeight = 360 }: JsonObjectFieldProps) {
  const serialized = useMemo(() => JSON.stringify(value ?? {}, null, 2), [value])
  // 草稿记下它基于哪个值；外部变化（撤销等）后自动丢弃
  const [state, setState] = useState({ base: serialized, draft: serialized })
  const draft = state.base === serialized ? state.draft : serialized
  // 引用保持稳定：TextEditor 的 onChange 变了会重新配置整个编辑器
  const setDraft = useCallback((text: string) => setState({ base: serialized, draft: text }), [serialized])

  const dirty = draft !== serialized
  const result = useMemo(() => (dirty ? check(draft) : null), [dirty, draft])
  const count = isObject(value) ? Object.keys(value).length : 0

  const apply = () => {
    if (!result?.value) return
    // 只是改了格式：不写回，免得多一步撤销
    if (JSON.stringify(result.value) === JSON.stringify(value ?? {})) setDraft(serialized)
    else onApply(result.value)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel
        label={`${label}（${count} 项）`}
        hint={hint}
        extra={
          <div className="flex items-center gap-1">
            {extra}
            {dirty && (
              <>
                <Button size="xs" variant="ghost" onClick={() => setDraft(serialized)}>
                  还原
                </Button>
                <Button size="xs" onClick={apply} disabled={!result?.value}>
                  应用
                </Button>
              </>
            )}
          </div>
        }
      />
      {value !== undefined && !isObject(value) && <p className="text-xs text-amber-600">当前值不是对象，酒馆助手会当成空对象处理</p>}
      <TextEditor value={draft} onChange={setDraft} language="json" minHeight={minHeight} maxHeight={maxHeight} fullscreenTitle={fullscreenTitle} />
      {result?.error && <p className="text-xs text-destructive">JSON 有误：{result.error}</p>}
      {dirty && !result?.error && <p className="text-xs text-muted-foreground">有未应用的修改</p>}
    </div>
  )
}
