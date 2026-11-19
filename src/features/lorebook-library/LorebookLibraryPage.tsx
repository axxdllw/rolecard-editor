import { BookOpenIcon, CopyIcon, DownloadIcon, MoreHorizontalIcon, PlusIcon, Trash2Icon, UploadIcon } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { confirm } from '@/components/confirm'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { db, type LorebookRecord } from '@/db/db'
import { useLive } from '@/db/useLive'
import { downloadBlob, pickFiles, safeFileName } from '@/lib/files'
import { formatTime } from '@/lib/format'
import { createEmptyLorebook, deleteLorebook, duplicateLorebook, exportLorebookJson, importLorebookFile } from '@/services/lorebooks'

export default function LorebookLibraryPage() {
  const navigate = useNavigate()
  const books = useLive(() => db.lorebooks.orderBy('updatedAt').reverse().toArray(), [])
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('')

  const importFiles = async () => {
    const files = await pickFiles('.json', true)
    for (const file of files) {
      try {
        const { entries } = await importLorebookFile(file)
        toast.success(`已导入「${file.name}」，${entries} 个条目`)
      } catch (error) {
        toast.error(`${file.name}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const create = async () => {
    const id = await createEmptyLorebook(newName.trim() || '新世界书')
    setNewOpen(false)
    setNewName('')
    navigate(`/lorebook/${id}`)
  }

  const remove = async (book: LorebookRecord) => {
    if (!(await confirm({ title: `删除世界书「${book.name}」？`, description: '删除后无法恢复，已经合并进角色卡的条目不受影响。', confirmText: '删除', destructive: true }))) return
    await deleteLorebook(book.id)
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">
            世界书库 <span className="text-sm font-normal text-muted-foreground">{books?.length ?? 0} 本</span>
          </h1>
          <p className="text-sm text-muted-foreground">不依附角色卡的世界书，可以在多张卡之间复用：在角色卡的世界书里选“从世界书库合并”。</p>
        </div>
        <Button variant="outline" onClick={importFiles}>
          <UploadIcon /> 导入 JSON
        </Button>
        <Button onClick={() => setNewOpen(true)}>
          <PlusIcon /> 新建
        </Button>
      </div>

      {books && books.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          <BookOpenIcon className="size-8" />
          <p>还没有世界书。可以导入 ST 导出的世界书 JSON，或者在角色卡的世界书里“整本保存到世界书库”。</p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {books?.map((book) => (
          <div key={book.id} className="flex items-start gap-3 rounded-xl border bg-card p-3 hover:shadow-sm">
            <Link to={`/lorebook/${book.id}`} className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate font-medium">{book.name}</span>
              <span className="text-xs text-muted-foreground">
                {book.entryCount} 个条目 · {formatTime(book.updatedAt)}
              </span>
              {book.note && <span className="line-clamp-2 text-xs text-muted-foreground">{book.note}</span>}
            </Link>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="更多操作">
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => downloadBlob(exportLorebookJson(book.book), `${safeFileName(book.name)}.json`, 'application/json')}>
                  <DownloadIcon /> 导出为 ST 世界书 JSON
                </DropdownMenuItem>
                <DropdownMenuItem onClick={async () => (await duplicateLorebook(book.id)) && toast.success('已复制')}>
                  <CopyIcon /> 复制一份
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => remove(book)}>
                  <Trash2Icon /> 删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建世界书</DialogTitle>
          </DialogHeader>
          <Input autoFocus placeholder="世界书名字" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && create()} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)}>
              取消
            </Button>
            <Button onClick={create}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
