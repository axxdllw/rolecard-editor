/**
 * 小说转卡列表页（/novels）：导入电子书（点击或拖拽）、选择压缩包里的书、查看与管理已导入的小说项目。
 */
import { BookOpenIcon, FileTextIcon, LoaderIcon, ScrollTextIcon, Trash2Icon, UploadIcon } from 'lucide-react'
import { useState, type DragEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { confirm } from '@/components/confirm'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { BOOK_ACCEPT, BookError, isBookArchive, type BookArchive } from '@/core/book'
import { db, type NovelRecord } from '@/db/db'
import { useLive } from '@/db/useLive'
import { pickFiles } from '@/lib/files'
import { formatBytes, formatTime } from '@/lib/format'
import { createNovel, deleteNovel, normalizeNovel } from '@/services/novels'
import { useExtractRunner } from './extractRunner'
import { useGenerateRunner } from './generateRunner'
import { formatBookFormat, formatWanChars } from './novelHelpers'
import { parseArchiveEntry, parseBookFile } from './parseBookFile'

interface ArchivePickState {
  file: File
  archive: BookArchive
}

function NovelRow({
  record,
  extracting,
  generating,
  onDelete,
}: {
  record: NovelRecord
  extracting: boolean
  generating: boolean
  onDelete: (novel: NovelRecord) => void
}) {
  const novel = normalizeNovel(record)
  // 用 novelId 索引统计已保存的块数，不读取大体积正文和抽取内容
  const chunkCount = useLive(() => db.novelChunks.where('novelId').equals(novel.id).count(), [novel.id])

  return (
    <div className="group flex items-start gap-3 rounded-xl border bg-card p-3.5 transition hover:shadow-sm sm:items-center">
      <Link to={`/novels/${novel.id}`} className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium group-hover:text-primary">{novel.title || '未命名书籍'}</span>
          <Badge variant="secondary" className="shrink-0">
            {formatBookFormat(novel.format)}
          </Badge>
          {extracting && (
            <Badge variant="outline" className="shrink-0 border-primary/50 text-primary">
              <LoaderIcon className="size-3 animate-spin" /> 抽取中
            </Badge>
          )}
          {generating && (
            <Badge variant="outline" className="shrink-0 border-primary/50 text-primary">
              <LoaderIcon className="size-3 animate-spin" /> 生成中
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {novel.author && <span className="truncate max-w-48">{novel.author}</span>}
          {novel.author && <span>·</span>}
          <span>{novel.toc.length} 章</span>
          <span>·</span>
          <span>{formatWanChars(novel.totalChars)}</span>
          {chunkCount !== undefined && chunkCount > 0 && (
            <>
              <span>·</span>
              <span>已抽取 {chunkCount} 块</span>
            </>
          )}
          {novel.cardIds.length > 0 && (
            <>
              <span>·</span>
              <span>建过 {novel.cardIds.length} 张卡</span>
            </>
          )}
          <span>·</span>
          <span>更新于 {formatTime(novel.updatedAt)}</span>
        </div>
      </Link>

      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        aria-label={`删除「${novel.title}」`}
        onClick={() => onDelete(novel)}
      >
        <Trash2Icon />
      </Button>
    </div>
  )
}

export default function NovelListPage() {
  const navigate = useNavigate()
  const novels = useLive(() => db.novels.orderBy('updatedAt').reverse().toArray(), [])
  const extractNovelId = useExtractRunner((s) => (s.running ? s.novelId : null))
  const generateNovelId = useGenerateRunner((s) => (s.running ? s.novelId : null))

  const [dragging, setDragging] = useState(false)
  const [readingName, setReadingName] = useState<string | null>(null)
  const [archivePick, setArchivePick] = useState<ArchivePickState | null>(null)

  const showReadError = (error: unknown) => {
    if (error instanceof BookError) {
      toast.error(error.message)
    } else {
      toast.error(`读取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const handleImportFile = async (file: File) => {
    if (readingName) return
    setReadingName(file.name)
    try {
      const parsed = await parseBookFile(file)
      if (isBookArchive(parsed)) {
        setArchivePick({ file, archive: parsed })
        return
      }
      const id = await createNovel(parsed, { name: file.name, size: file.size })
      toast.success(`已导入《${parsed.title}》`)
      navigate(`/novels/${id}`)
    } catch (error) {
      showReadError(error)
    } finally {
      setReadingName(null)
    }
  }

  const handlePickFromArchive = async (entryPath: string) => {
    if (!archivePick || readingName) return
    const { file } = archivePick
    setArchivePick(null)
    setReadingName(entryPath)
    try {
      const book = await parseArchiveEntry(file, entryPath)
      const id = await createNovel(book, { name: file.name, size: file.size })
      toast.success(`已导入《${book.title}》`)
      navigate(`/novels/${id}`)
    } catch (error) {
      showReadError(error)
    } finally {
      setReadingName(null)
    }
  }

  const pickAndImport = async () => {
    const [file] = await pickFiles(BOOK_ACCEPT, false)
    if (file) await handleImportFile(file)
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (readingName) return
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    if (files.length > 1) toast('一次导入一本，将读取第一个文件')
    void handleImportFile(files[0])
  }

  const handleDelete = async (novel: NovelRecord) => {
    const ok = await confirm({
      title: `删除《${novel.title || '未命名书籍'}》？`,
      description: '会删掉本地保存的正文和所有抽取结果，无法恢复。用这本书建过的角色卡不受影响。',
      confirmText: '删除',
      destructive: true,
    })
    if (!ok) return
    await deleteNovel(novel.id)
    toast.success('已删除这本书')
  }

  return (
    <div
      className="relative mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-4"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">
            小说转卡{' '}
            {novels && novels.length > 0 && (
              <span className="text-sm font-normal text-muted-foreground">{novels.length} 本</span>
            )}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            导入小说，AI 整理人物和设定，生成角色卡和世界书。支持 EPUB、TXT、MOBI/AZW3、FB2、DOCX、HTML，以及装着这些格式的
            zip；加密的书、KFX、PDF 不支持。正文只存在本地，不进整库备份。
          </p>
        </div>
        <Button onClick={pickAndImport} disabled={!!readingName} className="shrink-0">
          {readingName ? <LoaderIcon className="animate-spin" /> : <UploadIcon />}
          {readingName ? '正在读取…' : '导入小说'}
        </Button>
      </div>

      {readingName && (
        <div className="flex items-center gap-2.5 rounded-xl border bg-muted/40 px-4 py-3 text-sm">
          <LoaderIcon className="size-4 shrink-0 animate-spin text-primary" />
          <span className="truncate">正在读取「{readingName}」，大文件可能需要几秒钟…</span>
        </div>
      )}

      {novels && novels.length === 0 && !readingName && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-10 text-center">
          <ScrollTextIcon className="size-9 text-muted-foreground" />
          <p className="font-medium">还没有导入过小说</p>
          <p className="max-w-md text-sm text-muted-foreground">
            把电子书文件拖到这里，或者点右上角「导入小说」。导入后可以挑选章节范围，让 AI 分段整理人物、地点与设定，再一键生成角色卡和世界书。
          </p>
          <Button variant="outline" onClick={pickAndImport} className="mt-1">
            <UploadIcon /> 选择电子书文件
          </Button>
        </div>
      )}

      {novels && novels.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {novels.map((novel) => (
            <NovelRow
              key={novel.id}
              record={novel}
              extracting={extractNovelId === novel.id}
              generating={generateNovelId === novel.id}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-primary/10 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-primary bg-background px-8 py-6 text-center">
            <BookOpenIcon className="size-8 text-primary" />
            <span className="text-lg font-medium">松开即可导入电子书</span>
            <span className="text-xs text-muted-foreground">一次一本，支持 EPUB / TXT / MOBI / AZW3 / FB2 / DOCX / HTML / ZIP</span>
          </div>
        </div>
      )}

      <Dialog open={!!archivePick} onOpenChange={(open) => !open && setArchivePick(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>选择压缩包里的书</DialogTitle>
            <DialogDescription>
              「{archivePick?.file.name}」里找到 {archivePick?.archive.entries.length ?? 0} 本电子书，选一本导入：
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[55svh] flex-col gap-1.5 overflow-y-auto">
            {archivePick?.archive.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => void handlePickFromArchive(entry.path)}
                className="flex items-center gap-2.5 rounded-lg border p-2.5 text-left transition hover:bg-muted"
              >
                <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{entry.name}</div>
                  <div className="text-xs text-muted-foreground">{formatBytes(entry.size)}</div>
                </div>
                <Badge variant="secondary" className="shrink-0">
                  {formatBookFormat(entry.format)}
                </Badge>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
