import { useEffect, useState } from 'react'
import Cropper, { type Area } from 'react-easy-crop'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Slider } from '@/components/ui/slider'
import { cropToPng, useObjectUrl } from '@/lib/image'

interface CropDialogProps {
  /** 要裁剪的图片；为 null 时对话框关闭 */
  source: Blob | null
  onCancel: () => void
  onDone: (png: Blob) => void
}

const ASPECTS = [
  { label: '2:3 竖图', value: 2 / 3 },
  { label: '1:1 方图', value: 1 },
  { label: '原图', value: 0 },
]

/** 头像裁剪，输出 PNG */
export function CropDialog({ source, onCancel, onDone }: CropDialogProps) {
  const url = useObjectUrl(source)
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [aspect, setAspect] = useState(2 / 3)
  const [area, setArea] = useState<Area | null>(null)
  const [busy, setBusy] = useState(false)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setAspect(2 / 3)
    setNatural(null)
  }, [source])

  const effectiveAspect = aspect || (natural ? natural.w / natural.h : 2 / 3)

  const finish = async () => {
    if (!source) return
    setBusy(true)
    try {
      const target = area ?? (natural ? { x: 0, y: 0, width: natural.w, height: natural.h } : null)
      if (target) onDone(await cropToPng(source, target))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!source} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>裁剪头像</DialogTitle>
          <DialogDescription>拖动调整位置，滑块调整缩放。导出时会保存为 PNG。</DialogDescription>
        </DialogHeader>
        <div className="relative h-80 w-full overflow-hidden rounded-lg bg-muted">
          {url && (
            <Cropper
              image={url}
              crop={crop}
              zoom={zoom}
              aspect={effectiveAspect}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={(_, pixels) => setArea(pixels)}
              onMediaLoaded={(size) => setNatural({ w: size.naturalWidth, h: size.naturalHeight })}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1">
            {ASPECTS.map((a) => (
              <Button key={a.label} size="sm" variant={aspect === a.value ? 'default' : 'outline'} onClick={() => setAspect(a.value)}>
                {a.label}
              </Button>
            ))}
          </div>
          <Slider className="min-w-32 flex-1" min={1} max={3} step={0.05} value={[zoom]} onValueChange={([v]) => setZoom(v)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={finish} disabled={busy}>
            {busy ? '处理中…' : '使用这张图'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
