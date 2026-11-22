/**
 * 小说转卡项目页（/novels/:id）：顶部书目信息、解析提示、四步流程切换（选范围 → 抽取 → 整理 → 生成）。
 */
import { AlertTriangleIcon, ArrowLeftIcon, LoaderIcon, PencilIcon } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { updateNovel } from '@/services/novels'
import { ExtractStep } from './ExtractStep'
import { useExtractRunner } from './extractRunner'
import { GenerateStep } from './GenerateStep'
import { useGenerateRunner } from './generateRunner'
import { formatBookFormat, formatWanChars, isNovelStep, NOVEL_STEPS, type NovelStep } from './novelHelpers'
import { RangeStep } from './RangeStep'
import { ReviewStep } from './ReviewStep'
import { useDebouncedField, useNovelData } from './useNovelData'

function NovelTitleEditor({ novelId, title }: { novelId: string; title: string }) {
  const [editing, setEditing] = useState(false)
  const field = useDebouncedField(title, (next) => {
    const trimmed = next.trim()
    if (trimmed) void updateNovel(novelId, { title: trimmed })
  })

  if (editing) {
    return (
      <Input
        autoFocus
        value={field.value}
        onChange={(e) => field.onChange(e.target.value)}
        onBlur={() => {
          field.onBlur()
          setEditing(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            field.onBlur()
            setEditing(false)
          } else if (e.key === 'Escape') {
            field.cancel()
            setEditing(false)
          }
        }}
        aria-label="书名"
        className="h-8 max-w-sm text-base font-semibold"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="点击修改书名"
      className="group flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-muted"
    >
      <h1 className="truncate text-lg font-semibold sm:text-xl">{title || '未命名书籍'}</h1>
      <PencilIcon className="size-3.5 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />
    </button>
  )
}

export default function NovelPage() {
  const { id = '' } = useParams<{ id: string }>()
  const [searchParams, setSearchParams] = useSearchParams()

  const { novel, records, recordsLoaded, plans, results, entities, chunkCount, profile, profiles } = useNovelData(id)
  const extractingHere = useExtractRunner((s) => s.running && s.novelId === id)
  const generatingHere = useGenerateRunner((s) => s.running && s.novelId === id)

  if (novel === undefined || (novel !== null && !recordsLoaded)) {
    return <div className="p-10 text-center text-sm text-muted-foreground">加载中…</div>
  }

  if (novel === null) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
        <p className="font-medium">这本书不存在或已删除</p>
        <Button variant="outline" asChild>
          <Link to="/novels">
            <ArrowLeftIcon /> 返回小说列表
          </Link>
        </Button>
      </div>
    )
  }

  const rawStep = searchParams.get('step')
  const defaultStep: NovelStep = novel.result ? 'generate' : chunkCount > 0 ? 'review' : 'range'
  const step: NovelStep = isNovelStep(rawStep) ? rawStep : defaultStep

  const goStep = (next: NovelStep) => {
    setSearchParams(
      (prev) => {
        const copy = new URLSearchParams(prev)
        copy.set('step', next)
        return copy
      },
      { replace: true },
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-4">
      {/* 顶部栏 */}
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" asChild className="shrink-0">
            <Link to="/novels">
              <ArrowLeftIcon /> 列表
            </Link>
          </Button>
          <NovelTitleEditor key={novel.id} novelId={novel.id} title={novel.title} />
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-1 text-xs text-muted-foreground">
          {novel.author && <span className="text-foreground/80">{novel.author}</span>}
          <Badge variant="secondary">{formatBookFormat(novel.format)}</Badge>
          <span>{novel.toc.length} 章</span>
          <span>·</span>
          <span>{formatWanChars(novel.totalChars)}</span>
          {novel.encoding && (
            <>
              <span>·</span>
              <span>编码 {novel.encoding.toUpperCase()}</span>
            </>
          )}
        </div>

        {novel.warnings.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-50/70 px-3 py-2 text-xs text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-200">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <ul className="flex flex-col gap-0.5">
              {novel.warnings.map((w, idx) => (
                <li key={idx}>{w}</li>
              ))}
            </ul>
          </div>
        )}
      </header>

      {/* 四步流程 Tabs */}
      <Tabs value={step} onValueChange={(v) => isNovelStep(v) && goStep(v)} className="flex flex-1 flex-col gap-4">
        <div className="max-w-full overflow-x-auto pb-0.5">
          <TabsList className="w-max min-w-full sm:w-fit sm:min-w-0">
            {NOVEL_STEPS.map((item) => (
              <TabsTrigger key={item.id} value={item.id} className="px-3">
                <span>{item.label}</span>
                {item.id === 'extract' && extractingHere && (
                  <LoaderIcon className="size-3.5 animate-spin text-primary" />
                )}
                {item.id === 'review' && chunkCount > 0 && (
                  <span className="text-xs text-muted-foreground">({chunkCount}块)</span>
                )}
                {item.id === 'generate' && generatingHere && (
                  <LoaderIcon className="size-3.5 animate-spin text-primary" />
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="range" className="mt-0">
          <RangeStep
            novel={novel}
            records={records}
            plans={plans}
            profile={profile}
            profiles={profiles}
            onGoStep={goStep}
          />
        </TabsContent>

        <TabsContent value="extract" className="mt-0">
          <ExtractStep
            novel={novel}
            records={records}
            plans={plans}
            entities={entities}
            profile={profile}
            onGoStep={goStep}
          />
        </TabsContent>

        <TabsContent value="review" className="mt-0">
          <ReviewStep
            novel={novel}
            results={results}
            entities={entities}
            chunkCount={chunkCount}
            onGoStep={goStep}
          />
        </TabsContent>

        <TabsContent value="generate" className="mt-0">
          <GenerateStep
            novel={novel}
            records={records}
            plans={plans}
            results={results}
            entities={entities}
            profile={profile}
            onGoStep={goStep}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
