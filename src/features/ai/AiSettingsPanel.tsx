/**
 * 设置页的“AI 接口”：管理多个接口配置（OpenAI 兼容 / Claude / Gemini），测试连接、获取模型列表。
 */
import { EyeIcon, EyeOffIcon, LoaderIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { confirm } from '@/components/confirm'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { listModels, streamChat } from '@/core/ai/client'
import { AiError, DEFAULT_BASE_URL, type AiProfile, type AiProviderKind, type ReasoningEffort } from '@/core/ai/types'
import { PROVIDER_LABELS, useAiSettings } from '@/lib/aiSettings'
import { cn } from '@/lib/utils'

const KINDS: AiProviderKind[] = ['openai', 'anthropic', 'gemini']

function errorText(error: unknown): string {
  if (error instanceof AiError) return error.message
  return error instanceof Error ? error.message : String(error)
}

function ProfileForm({ profile }: { profile: AiProfile }) {
  const { updateProfile, removeProfile } = useAiSettings()
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState<'models' | 'test' | null>(null)
  const [testOutput, setTestOutput] = useState('')
  const abort = useRef<AbortController | null>(null)
  const ids = useId()
  const update = (patch: Partial<Omit<AiProfile, 'id'>>) => updateProfile(profile.id, patch)

  const fetchModels = async () => {
    setBusy('models')
    try {
      const list = await listModels(profile)
      setModels(list)
      toast.success(list.length ? `连接正常，获取到 ${list.length} 个模型` : '连接正常，但接口没有返回模型列表，请手动填写模型名')
    } catch (error) {
      toast.error(`获取模型列表失败：${errorText(error)}`)
    } finally {
      setBusy(null)
    }
  }

  const test = async () => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setBusy('test')
    setTestOutput('')
    try {
      await streamChat(profile, {
        messages: [{ role: 'user', content: '用一句话介绍你自己（20 字以内）。' }],
        signal: controller.signal,
        onText: (_delta, full) => setTestOutput(full),
      })
      toast.success('对话测试成功')
    } catch (error) {
      setTestOutput('')
      toast.error(`对话测试失败：${errorText(error)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t pt-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-name`}>名称</Label>
          <Input id={`${ids}-name`} value={profile.name} onChange={(e) => update({ name: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>接口类型</Label>
          <Select value={profile.kind} onValueChange={(v) => update({ kind: v as AiProviderKind })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {PROVIDER_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={`${ids}-url`}>接口地址</Label>
          <Input
            id={`${ids}-url`}
            value={profile.baseUrl}
            placeholder={`留空使用官方地址 ${DEFAULT_BASE_URL[profile.kind]}`}
            onChange={(e) => update({ baseUrl: e.target.value })}
          />
          {profile.kind === 'openai' && <p className="text-xs text-muted-foreground">填到 /v1 为止，例如 https://api.deepseek.com/v1，不要带 /chat/completions。</p>}
          {profile.kind === 'anthropic' && (
            <p className="text-xs text-muted-foreground">
              用 Claude 官方 API 时留空，key 在 Claude 控制台申请（按量计费，Pro/Max 订阅不提供 API key）。用中转站或其他厂商的 Anthropic 格式接口时填它的地址，带不带 /v1 都行。
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={`${ids}-key`}>API key</Label>
          <div className="flex gap-2">
            <Input
              id={`${ids}-key`}
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              value={profile.apiKey}
              onChange={(e) => update({ apiKey: e.target.value })}
            />
            <Button variant="outline" size="icon" onClick={() => setShowKey(!showKey)} aria-label={showKey ? '隐藏' : '显示'}>
              {showKey ? <EyeOffIcon /> : <EyeIcon />}
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-model`}>模型</Label>
          <Input id={`${ids}-model`} list={`${ids}-models`} value={profile.model} placeholder="模型名，可点右边获取列表" onChange={(e) => update({ model: e.target.value })} />
          <datalist id={`${ids}-models`}>
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-max`}>最大输出 token（可不填）</Label>
          <Input
            id={`${ids}-max`}
            type="number"
            min={1}
            value={profile.maxTokens ?? ''}
            placeholder={profile.kind === 'anthropic' ? '默认 64000' : '默认由接口决定'}
            onChange={(e) => update({ maxTokens: e.target.value ? Number(e.target.value) || undefined : undefined })}
          />
        </div>
        {profile.kind === 'openai' && (
          <div className="flex flex-col gap-1.5">
            <Label>思考强度</Label>
            <Select
              value={profile.reasoningEffort ?? 'default'}
              onValueChange={(v) => update({ reasoningEffort: v === 'default' ? undefined : (v as ReasoningEffort) })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">不传（由模型决定）</SelectItem>
                <SelectItem value="low">低（快、省）</SelectItem>
                <SelectItem value="medium">中</SelectItem>
                <SelectItem value="high">高</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">思考模型才支持；模型不认这个参数时会报错，改回“不传”即可</p>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={fetchModels} disabled={busy !== null}>
          {busy === 'models' && <LoaderIcon className="animate-spin" />} 获取模型列表
        </Button>
        <Button variant="outline" size="sm" onClick={test} disabled={busy !== null}>
          {busy === 'test' && <LoaderIcon className="animate-spin" />} 测试对话
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto text-destructive"
          onClick={async () => {
            if (await confirm({ title: `删除接口「${profile.name}」？`, confirmText: '删除', destructive: true })) removeProfile(profile.id)
          }}
        >
          <Trash2Icon /> 删除
        </Button>
      </div>
      {testOutput && <p className="rounded-md bg-muted px-3 py-2 text-sm">{testOutput}</p>}
    </div>
  )
}

export function AiSettingsPanel() {
  const { profiles, activeId, addProfile, setActive } = useAiSettings()
  const [editing, setEditing] = useState<string | null>(null)
  const active = activeId ?? profiles[0]?.id ?? null

  return (
    <div className="flex flex-col gap-3">
      {profiles.length === 0 && <p className="text-sm text-muted-foreground">还没有设置 AI 接口。添加一个后，编辑页的字段旁会出现 AI 按钮。</p>}
      {profiles.map((p) => (
        <div key={p.id} className={cn('flex flex-col gap-2 rounded-lg border p-3', p.id === active && 'border-primary/50')}>
          <div className="flex items-center gap-2">
            <input
              type="radio"
              name="ai-active"
              className="size-4 accent-primary"
              checked={p.id === active}
              onChange={() => setActive(p.id)}
              aria-label={`使用 ${p.name}`}
            />
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setEditing(editing === p.id ? null : p.id)}>
              <span className="truncate font-medium">{p.name || '未命名'}</span>
              <Badge variant="secondary" className="shrink-0">
                {PROVIDER_LABELS[p.kind]}
              </Badge>
              <span className="truncate text-xs text-muted-foreground">{p.model || '未选模型'}</span>
              {!p.apiKey && <span className="shrink-0 text-xs text-amber-600">未填 key</span>}
            </button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(editing === p.id ? null : p.id)}>
              {editing === p.id ? '收起' : '编辑'}
            </Button>
          </div>
          {editing === p.id && <ProfileForm profile={p} />}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <PlusIcon /> 添加接口
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {KINDS.map((k) => (
              <DropdownMenuItem key={k} onClick={() => setEditing(addProfile(k))}>
                {PROVIDER_LABELS[k]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="text-xs text-muted-foreground">
        API key 只保存在这个浏览器里，不会进备份文件；请求由浏览器直接发到你填的接口地址。有些接口不允许浏览器直接访问（跨域），连不上时可以换一个支持跨域的中转地址。
      </p>
    </div>
  )
}
