import { ArrowDownIcon, ArrowUpIcon, DownloadIcon, PlusIcon, Trash2Icon, UploadIcon } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { confirm } from '@/components/confirm'
import { TagInput } from '@/components/TagInput'
import { TextEditor } from '@/components/TextEditor'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { JsonObject } from '@/core/card/types'
import {
  createRegexScript,
  findRegexMatches,
  parseRegexJson,
  PLACEMENT_OPTIONS,
  runRegexScript,
  SUBSTITUTE_OPTIONS,
  validateFindRegex,
  type RegexScript,
} from '@/core/regex/regex'
import { updateCard, useCardDoc, useCardPath } from '@/features/editor/cardDoc'
import { FieldLabel } from '@/features/editor/fields'
import { downloadBlob, pickFiles, safeFileName } from '@/lib/files'
import { useSettings } from '@/lib/settings'
import { cn } from '@/lib/utils'

const EMPTY: RegexScript[] = []

function editScripts(recipe: (list: RegexScript[]) => void, label: string, key?: string) {
  updateCard((d) => {
    const ext = d.card.data.extensions as JsonObject
    if (!Array.isArray(ext.regex_scripts)) ext.regex_scripts = []
    recipe(ext.regex_scripts as RegexScript[])
  }, { label, key })
}

function TestPanel({ script }: { script: RegexScript }) {
  const charName = useCardPath<string>(['data', 'name'], '')
  const userName = useSettings((s) => s.previewUserName)
  const [input, setInput] = useState('')
  const ctx = useMemo(() => ({ char: charName, user: userName }), [charName, userName])
  const matches = useMemo(() => findRegexMatches({ ...script, disabled: false }, input, ctx), [script, input, ctx])
  const output = useMemo(() => runRegexScript({ ...script, disabled: false }, input, ctx), [script, input, ctx])

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
      <Label>实时测试</Label>
      <Textarea rows={4} placeholder="粘贴一段 AI 回复或用户输入，看替换效果" value={input} onChange={(e) => setInput(e.target.value)} />
      <div className="text-xs text-muted-foreground">
        命中 {matches.length} 处{script.disabled ? '（脚本已禁用，这里仍按启用测试）' : ''}
      </div>
      <pre className="max-h-64 overflow-auto rounded-md border bg-background p-2 text-xs whitespace-pre-wrap">{output || ' '}</pre>
    </div>
  )
}

function ScriptDetail({ script, index }: { script: RegexScript; index: number }) {
  const set = (label: string, fn: (s: RegexScript) => void, field?: string) =>
    editScripts((list) => fn(list[index]), label, field ? `regex.${script.id}.${field}` : undefined)
  const error = script.findRegex ? validateFindRegex(script.findRegex) : null
  const onReplace = useCallback(
    (v: string) => editScripts((list) => void (list[index].replaceString = v), '编辑替换内容', `regex.${script.id}.replace`),
    [index, script.id],
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Switch checked={!script.disabled} onCheckedChange={(v) => set(v ? '启用正则' : '禁用正则', (s) => void (s.disabled = !v))} aria-label="启用" />
        <Input className="flex-1 font-medium" value={script.scriptName ?? ''} onChange={(e) => set('修改正则名称', (s) => void (s.scriptName = e.target.value), 'name')} />
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel label="查找正则" hint="格式 /pattern/flags，例如 /<status>([\s\S]*?)<\/status>/g" />
        <Input
          className={cn('font-mono text-xs', error && 'border-destructive')}
          value={script.findRegex ?? ''}
          placeholder="/pattern/g"
          onChange={(e) => set('修改查找正则', (s) => void (s.findRegex = e.target.value), 'find')}
        />
        {error && <p className="text-xs text-destructive">正则有误：{error}</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel label="替换为" hint="可用 {{match}} 表示整段命中，$1、$2 表示分组；可以写 HTML（美化卡常用）" />
        <TextEditor value={script.replaceString ?? ''} onChange={onReplace} language="html" minHeight={100} maxHeight={420} fullscreenTitle={`替换内容 · ${script.scriptName}`} />
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel label="修剪字符串" hint="替换前从命中的文字里删掉这些内容" />
        <TagInput value={script.trimStrings ?? []} onChange={(v) => set('修改修剪字符串', (s) => void (s.trimStrings = v))} placeholder="回车添加" />
      </div>

      <div className="flex flex-col gap-2">
        <Label>作用范围</Label>
        <div className="flex flex-wrap gap-3">
          {PLACEMENT_OPTIONS.map((p) => (
            <label key={p.value} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                checked={script.placement?.includes(p.value)}
                onCheckedChange={(v) =>
                  set('修改作用范围', (s) => {
                    const list = new Set(s.placement ?? [])
                    if (v) list.add(p.value)
                    else list.delete(p.value)
                    s.placement = [...list].sort((a, b) => a - b)
                  })
                }
              />
              {p.label}
            </label>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ['markdownOnly', '只改显示', '只影响聊天界面的显示，不改发给模型的内容'],
            ['promptOnly', '只改提示词', '只影响发给模型的内容，不改显示'],
            ['runOnEdit', '编辑消息时运行', ''],
          ] as const
        ).map(([key, label, hint]) => (
          <label key={key} className="flex items-center gap-2 text-sm" title={hint}>
            <Checkbox checked={script[key] === true} onCheckedChange={(v) => set(`修改${label}`, (s) => void (s[key] = v === true))} />
            {label}
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1.5">
          <FieldLabel label="查找里的宏" hint="是否把查找正则里的 {{char}} 等宏替换成实际名字" />
          <Select value={String(Number(script.substituteRegex) || 0)} onValueChange={(v) => set('修改宏替换', (s) => void (s.substituteRegex = Number(v)))}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUBSTITUTE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={String(o.value)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {(['minDepth', 'maxDepth'] as const).map((key) => (
          <div key={key} className="flex w-28 flex-col gap-1.5">
            <FieldLabel label={key === 'minDepth' ? '最小深度' : '最大深度'} hint="只对这个深度范围内的消息生效，留空不限" />
            <Input
              type="number"
              placeholder="不限"
              value={script[key] ?? ''}
              onChange={(e) => set(`修改${key}`, (s) => void (s[key] = e.target.value === '' ? null : Number(e.target.value)), key)}
            />
          </div>
        ))}
      </div>

      <TestPanel script={script} />
    </div>
  )
}

export function RegexPanel() {
  const scripts = useCardDoc((s) => {
    const list = (s.doc?.card.data.extensions as JsonObject | undefined)?.regex_scripts
    return Array.isArray(list) ? (list as RegexScript[]) : EMPTY
  })
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeIndex = scripts.findIndex((s) => s.id === activeId)
  const active = activeIndex >= 0 ? scripts[activeIndex] : scripts[0]
  const index = active ? scripts.indexOf(active) : -1

  const add = () => {
    const script = createRegexScript()
    editScripts((list) => void list.push(script), '新建正则')
    setActiveId(script.id)
  }

  const importJson = async () => {
    const files = await pickFiles('.json', true)
    let count = 0
    for (const file of files) {
      try {
        const list = parseRegexJson(await file.text())
        const existing = new Set(scripts.map((s) => s.id))
        editScripts((target) => {
          for (const s of list) {
            if (existing.has(s.id)) s.id = createRegexScript().id
            target.push(s)
          }
        }, '导入正则')
        count += list.length
      } catch (error) {
        toast.error(`${file.name}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (count) toast.success(`导入了 ${count} 个正则脚本`)
  }

  const remove = async () => {
    if (!active) return
    if (!(await confirm({ title: `删除正则「${active.scriptName}」？`, description: '可以用“撤销”找回。', confirmText: '删除', destructive: true }))) return
    editScripts((list) => void list.splice(index, 1), '删除正则')
    setActiveId(null)
  }

  const move = (delta: number) => {
    const to = index + delta
    if (index < 0 || to < 0 || to >= scripts.length) return
    editScripts((list) => {
      const [item] = list.splice(index, 1)
      list.splice(to, 0, item)
    }, '调整正则顺序')
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm text-muted-foreground">正则脚本按列表顺序依次执行，跟着卡一起导入导出。</p>
        <Button variant="outline" onClick={importJson}>
          <UploadIcon /> 导入 JSON
        </Button>
        <Button onClick={add}>
          <PlusIcon /> 新建
        </Button>
      </div>

      {scripts.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">这张卡没有正则脚本</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <div className="flex flex-col overflow-hidden rounded-xl border bg-card">
            {scripts.map((s, i) => (
              <button
                key={s.id ?? i}
                type="button"
                onClick={() => setActiveId(s.id)}
                className={cn('flex items-center gap-2 border-b px-3 py-2 text-left text-sm hover:bg-muted/50', s === active && 'bg-primary/8', s.disabled && 'opacity-50')}
              >
                <span className="w-5 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                <span className="flex-1 truncate">{s.scriptName || '未命名'}</span>
                {s.findRegex && validateFindRegex(s.findRegex) && <span className="size-1.5 rounded-full bg-destructive" title="正则有误" />}
              </button>
            ))}
          </div>
          {active && (
            <div className="rounded-xl border bg-card p-4">
              <div className="mb-3 flex justify-end gap-1">
                <Button variant="ghost" size="icon-sm" onClick={() => move(-1)} disabled={index === 0} aria-label="上移">
                  <ArrowUpIcon />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={() => move(1)} disabled={index === scripts.length - 1} aria-label="下移">
                  <ArrowDownIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="导出这个正则"
                  title="导出为 ST 正则 JSON"
                  onClick={() => downloadBlob(JSON.stringify(active, null, 2), `${safeFileName(active.scriptName || 'regex')}.json`, 'application/json')}
                >
                  <DownloadIcon />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={remove} aria-label="删除">
                  <Trash2Icon />
                </Button>
              </div>
              <ScriptDetail key={active.id} script={active} index={index} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
