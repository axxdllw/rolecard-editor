import { useEffect, useState } from 'react'
import { TagInput } from '@/components/TagInput'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { db } from '@/db/db'
import { updateCardMeta } from '@/services/cards'

/** 编辑一张卡的本地标签、来源链接和备注（只存在卡库里，不写进卡） */
export function MetaDialog({ cardId, onClose }: { cardId: string | null; onClose: () => void }) {
  const [tags, setTags] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [name, setName] = useState('')

  useEffect(() => {
    if (!cardId) return
    void db.cards.get(cardId).then((r) => {
      if (!r) return
      setTags(r.localTags)
      setNote(r.note)
      setSourceUrl(r.sourceUrl)
      setName(r.name)
    })
  }, [cardId])

  const save = async () => {
    if (cardId) await updateCardMeta(cardId, { localTags: tags, note, sourceUrl })
    onClose()
  }

  return (
    <Dialog open={!!cardId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>「{name}」的标签与备注</DialogTitle>
          <DialogDescription>这些信息只保存在卡库里，不会写进导出的卡。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>本地标签</Label>
            <TagInput value={tags} onChange={setTags} placeholder="回车或逗号分隔，例如：鸣潮、常用" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="meta-url">来源链接</Label>
            <Input id="meta-url" value={sourceUrl} placeholder="https://…" onChange={(e) => setSourceUrl(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="meta-note">备注</Label>
            <Textarea id="meta-note" value={note} rows={3} placeholder="作者、版本、改了什么……" onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={save}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 批量给多张卡加本地标签 */
export function BatchTagDialog({ ids, onClose }: { ids: string[] | null; onClose: () => void }) {
  const [tags, setTags] = useState<string[]>([])
  const save = async () => {
    if (ids && tags.length) {
      await db.transaction('rw', db.cards, async () => {
        for (const id of ids) {
          const r = await db.cards.get(id)
          if (!r) continue
          const next = [...r.localTags]
          for (const t of tags) if (!next.includes(t)) next.push(t)
          await db.cards.update(id, { localTags: next })
        }
      })
    }
    setTags([])
    onClose()
  }
  return (
    <Dialog open={!!ids} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>给 {ids?.length ?? 0} 张卡添加标签</DialogTitle>
        </DialogHeader>
        <TagInput value={tags} onChange={setTags} placeholder="回车或逗号分隔" />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={save} disabled={tags.length === 0}>
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
