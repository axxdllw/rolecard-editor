import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { POSITION_OPTIONS } from '@/core/lorebook/entry'
import { db, type LorebookRecord } from '@/db/db'
import { useLive } from '@/db/useLive'
import { OutletNameInput } from './OutletNameInput'

export interface WrapperOptions {
  tag: string
  position: number
  depth: number
  openOrder: number
  closeOrder: number
  outletName: string
}

/** 包裹标签助手：生成一对常驻的开/收标签条目 */
export function WrapperDialog({
  open,
  onOpenChange,
  onCreate,
  outletNames = [],
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (o: WrapperOptions) => void
  outletNames?: string[]
}) {
  const [tag, setTag] = useState('')
  const [position, setPosition] = useState(0)
  const [depth, setDepth] = useState(4)
  const [openOrder, setOpenOrder] = useState(0)
  const [closeOrder, setCloseOrder] = useState(999)
  const [outletName, setOutletName] = useState('')
  const isOutlet = position === 7

  // 锚点里顺序大的在前，切进/切出锚点时把开收标签的顺序对调
  const changePosition = (next: number) => {
    if ((next === 7) !== isOutlet) {
      setOpenOrder(closeOrder)
      setCloseOrder(openOrder)
    }
    setPosition(next)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加包裹标签</DialogTitle>
          <DialogDescription>
            生成两个常驻条目：开标签（顺序 {openOrder}）和收标签（顺序 {closeOrder}）。同一位置里顺序在两者之间的条目会被包在标签里，方便模型区分内容。
            {isOutlet && '锚点里顺序大的排在前面，所以开标签的顺序要比收标签大。'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wrap-tag">标签名</Label>
            <Input id="wrap-tag" value={tag} placeholder="例如 Glossary、secondary character" onChange={(e) => setTag(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>位置</Label>
              <Select value={String(position)} onValueChange={(v) => changePosition(Number(v))}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {POSITION_OPTIONS.map((p) => (
                    <SelectItem key={p.value} value={String(p.value)}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {position === 4 && (
              <div className="flex w-20 flex-col gap-1.5">
                <Label>深度</Label>
                <Input type="number" value={depth} onChange={(e) => setDepth(Number(e.target.value) || 0)} />
              </div>
            )}
            {isOutlet && (
              <div className="flex w-36 flex-col gap-1.5">
                <Label>锚点名</Label>
                <OutletNameInput names={outletNames} value={outletName} onChange={(e) => setOutletName(e.target.value)} />
              </div>
            )}
            <div className="flex w-20 flex-col gap-1.5">
              <Label>开标签顺序</Label>
              <Input type="number" value={openOrder} onChange={(e) => setOpenOrder(Number(e.target.value) || 0)} />
            </div>
            <div className="flex w-20 flex-col gap-1.5">
              <Label>收标签顺序</Label>
              <Input type="number" value={closeOrder} onChange={(e) => setCloseOrder(Number(e.target.value) || 0)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={!tag.trim() || (isOutlet && !outletName.trim())}
            onClick={() => {
              onCreate({ tag: tag.trim(), position, depth, openOrder, closeOrder, outletName: isOutlet ? outletName.trim() : '' })
              onOpenChange(false)
              setTag('')
            }}
          >
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const NEW_BOOK = '__new__'

/** 选择世界书库里的一本书（可选“新建一本”） */
export function PickLorebookDialog({
  open,
  title,
  description,
  allowNew,
  excludeId,
  confirmText,
  onOpenChange,
  onPick,
}: {
  open: boolean
  title: string
  description?: string
  allowNew?: boolean
  excludeId?: string
  confirmText: string
  onOpenChange: (open: boolean) => void
  onPick: (target: { record: LorebookRecord } | { newName: string }) => void
}) {
  const books = useLive(() => db.lorebooks.orderBy('updatedAt').reverse().toArray(), [])
  const [choice, setChoice] = useState<string>('')
  const [newName, setNewName] = useState('')
  const options = (books ?? []).filter((b) => b.id !== excludeId)
  const selected = choice || (options[0]?.id ?? (allowNew ? NEW_BOOK : ''))

  const confirm = () => {
    if (selected === NEW_BOOK) {
      onPick({ newName: newName.trim() || '新世界书' })
    } else {
      const record = options.find((b) => b.id === selected)
      if (record) onPick({ record })
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {options.length === 0 && !allowNew ? (
          <p className="text-sm text-muted-foreground">世界书库里还没有书。可以先到「世界书库」导入或新建。</p>
        ) : (
          <div className="flex flex-col gap-3">
            <Select value={selected} onValueChange={setChoice}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择世界书" />
              </SelectTrigger>
              <SelectContent>
                {options.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}（{b.entryCount} 条）
                  </SelectItem>
                ))}
                {allowNew && <SelectItem value={NEW_BOOK}>＋ 新建一本</SelectItem>}
              </SelectContent>
            </Select>
            {selected === NEW_BOOK && <Input value={newName} placeholder="新世界书的名字" onChange={(e) => setNewName(e.target.value)} />}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!selected} onClick={confirm}>
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
