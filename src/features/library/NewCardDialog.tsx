import { ImageIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { CardAvatar } from '@/components/CardAvatar'
import { CropDialog } from '@/components/CropDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { DraftCard, DraftFieldKey } from '@/core/ai/tasks/draftCard'
import { DESCRIPTION_TEMPLATES, type DescriptionTemplate } from '@/core/card/create'
import { AiDraftSection } from '@/features/ai/AiDraftSection'
import { pickFiles } from '@/lib/files'
import { useSettings } from '@/lib/settings'
import { createCard, createCardFromDraft } from '@/services/cards'

/** 新建向导：名字、头像、描述写法 */
export function NewCardDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<string>('yaml')
  const customTemplates = useSettings((s) => s.customTemplates)
  const setSettings = useSettings((s) => s.set)
  const [avatar, setAvatar] = useState<Blob | null>(null)
  const [cropSource, setCropSource] = useState<Blob | null>(null)
  const [busy, setBusy] = useState(false)
  // blank：空白卡；ai：一句话生成草稿
  const [mode, setMode] = useState<'blank' | 'ai'>('blank')

  const reset = () => {
    setName('')
    setTemplate('yaml')
    setAvatar(null)
  }

  const chooseImage = async () => {
    const [file] = await pickFiles('image/png,image/jpeg,image/webp,image/gif')
    if (file) setCropSource(file)
  }

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error('请先填写角色名')
      return
    }
    setBusy(true)
    try {
      const custom = customTemplates.find((t) => `custom:${t.id}` === template)
      const id = custom
        ? await createCard(trimmed, 'plain', avatar, custom.content)
        : await createCard(trimmed, template as DescriptionTemplate['id'], avatar)
      onOpenChange(false)
      reset()
      navigate(`/card/${id}`)
    } finally {
      setBusy(false)
    }
  }

  /** 当前选中的描述写法：名称和骨架（AI 生成时参考） */
  const styleOf = (): { templateId: DescriptionTemplate['id']; label: string; skeleton: string } => {
    const custom = customTemplates.find((t) => `custom:${t.id}` === template)
    if (custom) return { templateId: 'plain', label: custom.label, skeleton: custom.content }
    const builtIn = DESCRIPTION_TEMPLATES.find((t) => t.id === template) ?? DESCRIPTION_TEMPLATES[0]
    return { templateId: builtIn.id, label: builtIn.label, skeleton: builtIn.build() }
  }

  const createFromDraft = async (draft: DraftCard, fields: ReadonlySet<DraftFieldKey>) => {
    setBusy(true)
    try {
      const finalName = name.trim() || draft.name || '未命名'
      const id = await createCardFromDraft(finalName, styleOf().templateId, avatar, draft, fields)
      onOpenChange(false)
      reset()
      setMode('blank')
      toast.success('已用 AI 草稿建卡')
      navigate(`/card/${id}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={mode === 'ai' ? 'max-h-[92svh] overflow-y-auto sm:max-w-2xl' : 'sm:max-w-lg'}>
          <DialogHeader>
            <DialogTitle>新建角色卡</DialogTitle>
            <DialogDescription>{mode === 'ai' ? '写一句设定，AI 生成描述、开场白等草稿，勾选后建卡。' : '先填名字和描述写法，其他内容进编辑页再补。'}</DialogDescription>
          </DialogHeader>

          <Tabs value={mode} onValueChange={(v) => setMode(v as 'blank' | 'ai')}>
            <TabsList>
              <TabsTrigger value="blank">空白卡</TabsTrigger>
              <TabsTrigger value="ai">AI 生成草稿</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex gap-4">
            <button
              type="button"
              onClick={chooseImage}
              className="group relative h-36 w-24 shrink-0 overflow-hidden rounded-lg border"
              aria-label="选择头像"
            >
              {avatar ? (
                <CardAvatar blob={avatar} name={name} className="size-full" />
              ) : (
                <div className="flex size-full flex-col items-center justify-center gap-1 text-xs text-muted-foreground">
                  <ImageIcon className="size-5" />
                  选择头像
                </div>
              )}
            </button>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="new-card-name">角色名</Label>
              <Input
                id="new-card-name"
                value={name}
                autoFocus
                placeholder={mode === 'ai' ? '可以不填，由 AI 起名' : '例如：弗洛洛'}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => mode === 'blank' && e.key === 'Enter' && !e.nativeEvent.isComposing && submit()}
              />
              <p className="text-xs text-muted-foreground">头像可以不选，导出时会自动生成一张。</p>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label>描述写法</Label>
            <RadioGroup
              value={template}
              onValueChange={setTemplate}
              className="grid grid-cols-2 gap-2"
            >
              {DESCRIPTION_TEMPLATES.map((t) => (
                <label
                  key={t.id}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5"
                >
                  <RadioGroupItem value={t.id} className="mt-0.5" />
                  <span className="flex flex-col">
                    <span className="text-sm font-medium">{t.label}</span>
                    <span className="text-xs text-muted-foreground">{t.hint}</span>
                  </span>
                </label>
              ))}
              {customTemplates.map((t) => (
                <label
                  key={t.id}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5"
                >
                  <RadioGroupItem value={`custom:${t.id}`} className="mt-0.5" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{t.label}</span>
                    <span className="text-xs text-muted-foreground">我的模板</span>
                  </span>
                  <button
                    type="button"
                    aria-label="删除模板"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={(e) => {
                      e.preventDefault()
                      setSettings({ customTemplates: customTemplates.filter((x) => x.id !== t.id) })
                      if (template === `custom:${t.id}`) setTemplate('yaml')
                    }}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </label>
              ))}
            </RadioGroup>
          </div>

          {mode === 'ai' ? (
            <AiDraftSection name={name} style={styleOf()} busy={busy} onCreate={createFromDraft} />
          ) : (
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button onClick={submit} disabled={busy}>
                创建并编辑
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
      <CropDialog
        source={cropSource}
        onCancel={() => setCropSource(null)}
        onDone={(png) => {
          setAvatar(png)
          setCropSource(null)
        }}
      />
    </>
  )
}
