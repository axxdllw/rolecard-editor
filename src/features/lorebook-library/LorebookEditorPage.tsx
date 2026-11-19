import { ArrowLeftIcon, CheckIcon, LoaderIcon, Redo2Icon, Undo2Icon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { Lorebook } from '@/core/card/types'
import { uuid } from '@/core/util/id'
import { db, type LorebookRecord } from '@/db/db'
import type { BookDraft } from '@/features/editor/cardDoc'
import { useAutosave } from '@/features/editor/autosave'
import { createDocStore, type UpdateOptions } from '@/features/editor/docStore'
import { WorldbookEditor } from '@/features/worldbook/WorldbookEditor'
import { saveLorebook } from '@/services/lorebooks'

interface BookDoc {
  id: string
  book: Lorebook
  entryKeys: string[]
  note: string
}

const useBookDoc = createDocStore<BookDoc>()
const EMPTY_KEYS: string[] = []

function Editor({ record }: { record: LorebookRecord }) {
  const book = useBookDoc((s) => s.doc?.book)
  const keys = useBookDoc((s) => s.doc?.entryKeys ?? EMPTY_KEYS)
  const note = useBookDoc((s) => s.doc?.note ?? '')
  const canUndo = useBookDoc((s) => s.past.length > 0)
  const canRedo = useBookDoc((s) => s.future.length > 0)
  const status = useAutosave(useBookDoc, async (doc) => {
    await saveLorebook(doc.id, doc.book)
    await db.lorebooks.update(doc.id, { note: doc.note })
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        const label = useBookDoc.getState().undo()
        if (label) toast(`已撤销：${label}`, { id: 'undo', duration: 1500 })
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault()
        useBookDoc.getState().redo()
      } else if (key === 's') {
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const update = useCallback((recipe: (d: BookDraft) => void, options?: UpdateOptions) => {
    useBookDoc.getState().update((d) => recipe({ book: d.book, keys: d.entryKeys }), options)
  }, [])

  if (!book) return null

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="icon" asChild aria-label="返回世界书库">
          <Link to="/lorebooks">
            <ArrowLeftIcon />
          </Link>
        </Button>
        <Input
          className="max-w-sm text-base font-semibold"
          value={book.name ?? ''}
          onChange={(e) => useBookDoc.getState().update((d) => void (d.book.name = e.target.value), { key: 'name', label: '修改书名' })}
        />
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {status === 'saved' ? <CheckIcon className="size-3" /> : <LoaderIcon className="size-3 animate-spin" />}
          {status === 'saved' ? '已保存' : status === 'error' ? '保存失败' : '保存中'}
        </span>
        <div className="flex-1" />
        <Button variant="ghost" size="icon" disabled={!canUndo} onClick={() => useBookDoc.getState().undo()} aria-label="撤销">
          <Undo2Icon />
        </Button>
        <Button variant="ghost" size="icon" disabled={!canRedo} onClick={() => useBookDoc.getState().redo()} aria-label="重做">
          <Redo2Icon />
        </Button>
      </div>
      <Textarea
        rows={1}
        className="min-h-8 text-sm"
        placeholder="备注：这本世界书的用途、来源……（只存在库里）"
        value={note}
        onChange={(e) => useBookDoc.getState().update((d) => void (d.note = e.target.value), { key: 'note', label: '修改备注' })}
      />
      <WorldbookEditor book={book} keys={keys} update={update} mode="library" libraryId={record.id} />
    </div>
  )
}

export default function LorebookEditorPage() {
  const { id = '' } = useParams()
  const [record, setRecord] = useState<LorebookRecord | null | undefined>(undefined)
  const [readyId, setReadyId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setReadyId(null)
    void db.lorebooks.get(id).then((r) => {
      if (cancelled) return
      setRecord(r ?? null)
      if (r) {
        useBookDoc.getState().load({ id: r.id, book: r.book, entryKeys: r.book.entries.map(() => uuid()), note: r.note })
        setReadyId(r.id)
      }
    })
    return () => {
      cancelled = true
    }
  }, [id])

  if (record === null) {
    return (
      <div className="flex flex-col items-center gap-3 p-10">
        <p>找不到这本世界书。</p>
        <Button asChild variant="outline">
          <Link to="/lorebooks">回到世界书库</Link>
        </Button>
      </div>
    )
  }
  if (!record || readyId !== id) return <div className="p-10 text-center text-sm text-muted-foreground">加载中…</div>
  return <Editor key={id} record={record} />
}
