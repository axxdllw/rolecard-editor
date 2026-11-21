import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { TextEditor } from '@/components/TextEditor'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import type { JsonObject } from '@/core/card/types'
import { setCardPath, updateCard, useCardDoc, useCardPath } from './cardDoc'
import { FieldLabel, InputField, Section, TextField } from './fields'

/** 已有专门界面的扩展字段，其余的放进“其他扩展数据”JSON 编辑 */
const KNOWN_KEYS = new Set(['talkativeness', 'fav', 'world', 'depth_prompt', 'regex_scripts'])
const EMPTY_EXT: JsonObject = {}

function OtherExtensions() {
  const ext = useCardDoc((s) => (s.doc?.card.data.extensions as JsonObject | undefined) ?? EMPTY_EXT)
  const others = useMemo(() => Object.fromEntries(Object.entries(ext).filter(([k]) => !KNOWN_KEYS.has(k))), [ext])
  const serialized = useMemo(() => JSON.stringify(others, null, 2), [others])
  const [draft, setDraft] = useState(serialized)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(serialized)
    setError(null)
  }, [serialized])

  const apply = () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(draft)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError('必须是一个 JSON 对象')
      return
    }
    updateCard(
      (d) => {
        const target = d.card.data.extensions as JsonObject
        for (const key of Object.keys(target)) if (!KNOWN_KEYS.has(key)) delete target[key]
        for (const [key, value] of Object.entries(parsed as JsonObject)) {
          if (!KNOWN_KEYS.has(key)) target[key] = value
        }
      },
      { label: '修改扩展数据' },
    )
    toast.success('扩展数据已更新')
  }

  const dirty = draft !== serialized
  return (
    <div id="other-extensions" className="flex flex-col gap-1.5">
      <FieldLabel
        label={`其他扩展数据（${Object.keys(others).length} 项）`}
        hint="其他插件写进卡里的数据，例如酒馆助手脚本。这里按 JSON 原样编辑，改完点“应用”。"
        extra={
          dirty && (
            <div className="flex gap-1">
              <Button size="xs" variant="ghost" onClick={() => setDraft(serialized)}>
                还原
              </Button>
              <Button size="xs" onClick={apply}>
                应用
              </Button>
            </div>
          )
        }
      />
      <TextEditor value={draft} onChange={setDraft} language="json" minHeight={60} maxHeight={420} fullscreenTitle="其他扩展数据" />
      {error && <p className="text-xs text-destructive">JSON 有误：{error}</p>}
    </div>
  )
}

export function ExtensionsSection() {
  const depth = useCardPath<number>(['data', 'extensions', 'depth_prompt', 'depth'], 4)
  const role = useCardPath<string>(['data', 'extensions', 'depth_prompt', 'role'], 'system')
  const talkRaw = useCardPath<string | number>(['data', 'extensions', 'talkativeness'], '0.5')
  const fav = useCardPath<boolean>(['data', 'extensions', 'fav'], false)
  const talk = Number(talkRaw) || 0

  return (
    <Section id="extensions" title="ST 扩展字段" description="SillyTavern 私有的设置，其他前端可能会忽略。">
      <div className="flex flex-col gap-2 rounded-lg border p-3">
        <TextField
          path={['data', 'extensions', 'depth_prompt', 'prompt']}
          label="角色注释（Character's Note）"
          hint="每轮插进聊天记录的指定深度，常用来放需要反复强调的规则"
          minHeight={60}
        />
        <div className="flex flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm">插入深度</span>
            <Input
              type="number"
              min={0}
              className="w-20"
              value={depth}
              onChange={(e) => setCardPath(['data', 'extensions', 'depth_prompt', 'depth'], Number(e.target.value) || 0, '修改角色注释深度')}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm">消息角色</span>
            <Select value={role} onValueChange={(v) => setCardPath(['data', 'extensions', 'depth_prompt', 'role'], v, '修改角色注释角色')}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">system</SelectItem>
                <SelectItem value="user">user</SelectItem>
                <SelectItem value="assistant">assistant</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <FieldLabel label={`群聊发言频率：${talk.toFixed(2)}`} hint="talkativeness：群聊里自动轮到这个角色发言的概率" />
          <Slider
            min={0}
            max={1}
            step={0.05}
            value={[talk]}
            onValueChange={([v]) =>
              setCardPath(['data', 'extensions', 'talkativeness'], typeof talkRaw === 'string' ? String(v) : v, '修改群聊发言频率')
            }
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch id="fav" checked={fav === true} onCheckedChange={(v) => setCardPath(['data', 'extensions', 'fav'], v, '修改收藏')} />
          <label htmlFor="fav" className="text-sm">
            在 ST 里标为收藏
          </label>
        </div>
      </div>

      <InputField
        path={['data', 'extensions', 'world']}
        label="绑定的世界书名"
        hint="world：导入 ST 时自动关联的世界书文件名（外部世界书，不是卡里内嵌的那本）"
      />

      <OtherExtensions />
    </Section>
  )
}
