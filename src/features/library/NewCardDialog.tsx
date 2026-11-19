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
import { DESCRIPTION_TEMPLATES, type DescriptionTemplate } from '@/core/card/create'
import { pickFiles } from '@/lib/files'
import { useSettings } from '@/lib/settings'
import { createCard } from '@/services/cards'

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

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>新建角色卡</DialogTitle>
            <DialogDescription>先填名字和描述写法，其他内容进编辑页再补。</DialogDescription>
          </DialogHeader>

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
                placeholder="例如：弗洛洛"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && submit()}
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

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button onClick={submit} disabled={busy}>
              创建并编辑
            </Button>
          </DialogFooter>
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
