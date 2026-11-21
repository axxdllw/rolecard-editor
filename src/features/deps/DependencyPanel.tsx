/**
 * 依赖体检：编辑页标题下的摘要，以及点开后的详细结果。
 */
import { AlertTriangleIcon, ChevronRightIcon, PlugIcon } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  isLocationDisabled,
  locationKey,
  locationLabel,
  type DependencyIssue,
  type DependencyReport,
  type DepLocation,
  type ExtensionId,
  type ResourceHost,
} from '@/core/deps/deps'
import { isLocalHost, RESOURCE_KIND_LABELS, type ResourceKind } from '@/core/deps/urls'
import { useIsDesktop } from '@/lib/useMediaQuery'
import { cn } from '@/lib/utils'

const SHORT_NAMES: Record<ExtensionId, string> = {
  'tavern-helper': '酒馆助手',
  mvu: 'MVU',
  'prompt-template': '提示词模板',
  xiaobaix: '小白X',
}

type Jump = (loc: DepLocation) => void

function warningCount(report: DependencyReport): number {
  return report.issues.filter((i) => i.severity === 'warning').length
}

/** 标题下的一行摘要：需要哪些扩展、有几个警告 */
export function DependencySummary({ report, onOpen }: { report: DependencyReport | null; onOpen: () => void }) {
  if (!report) return null
  const names = report.extensions.map((e) => SHORT_NAMES[e.id])
  const warnings = warningCount(report)
  return (
    <button
      type="button"
      onClick={onOpen}
      title="依赖体检：这张卡要配合哪些扩展、引用了哪些外部资源"
      className="flex min-w-0 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <PlugIcon className="size-3 shrink-0" />
      <span className="truncate">{names.length > 0 ? `需要 ${names.join('、')}` : '不需要额外扩展'}</span>
      {warnings > 0 && (
        <span className="flex shrink-0 items-center gap-0.5 text-amber-600 dark:text-amber-400">
          <AlertTriangleIcon className="size-3" />
          {warnings}
        </span>
      )}
    </button>
  )
}

function LocationChip({ loc, note, onJump }: { loc: DepLocation; note?: string; onJump: Jump }) {
  const disabled = isLocationDisabled(loc)
  return (
    <button
      type="button"
      onClick={() => onJump(loc)}
      title="跳到这里"
      className={cn('inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs hover:bg-muted', disabled && 'text-muted-foreground')}
    >
      <span className="truncate">{locationLabel(loc)}</span>
      {note && <span className="shrink-0 text-muted-foreground">· {note}</span>}
      {disabled && <span className="shrink-0 text-muted-foreground">（已禁用）</span>}
    </button>
  )
}

/** 项目多时先显示一部分 */
function MoreList<T>({
  items,
  limit,
  render,
  className,
  unit = '处',
}: {
  items: T[]
  limit: number
  render: (item: T) => ReactNode
  className?: string
  unit?: string
}) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, limit)
  return (
    <div className={className}>
      {shown.map(render)}
      {items.length > limit && (
        <button type="button" className="px-1 text-xs text-primary hover:underline" onClick={() => setAll(!all)}>
          {all ? '收起' : `还有 ${items.length - limit} ${unit}`}
        </button>
      )}
    </div>
  )
}

function Locations({ locations, onJump, limit = 6 }: { locations: DepLocation[]; onJump: Jump; limit?: number }) {
  return (
    <MoreList
      items={locations}
      limit={limit}
      className="flex flex-wrap items-center gap-1"
      render={(loc) => <LocationChip key={locationKey(loc)} loc={loc} onJump={onJump} />}
    />
  )
}

function ExtensionsSection({ report, onJump }: { report: DependencyReport; onJump: Jump }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">需要的扩展</h3>
      {report.extensions.length === 0 && report.unknownKeys.length === 0 && (
        <p className="text-sm text-muted-foreground">没发现需要额外装的扩展，原版酒馆就能用。</p>
      )}
      {report.extensions.map((ext) => (
        <div key={ext.id} className="flex flex-col gap-1.5 rounded-lg border p-2.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{ext.name}</span>
            {ext.onlyDisabled && <Badge variant="secondary">相关内容都已禁用</Badge>}
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{ext.evidence.length} 处</span>
          </div>
          <p className="text-xs text-muted-foreground">{ext.summary}</p>
          <MoreList
            items={ext.evidence}
            limit={6}
            className="flex flex-wrap items-center gap-1"
            render={(e) => <LocationChip key={`${locationKey(e.location)}|${e.note ?? ''}`} loc={e.location} note={e.note} onJump={onJump} />}
          />
        </div>
      ))}
      {report.unknownKeys.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-dashed p-2.5">
          <span className="text-sm font-medium">其他扩展字段</span>
          <p className="text-xs text-muted-foreground">认不出是哪个插件写进来的。没装对应插件时，这些设置通常只是不起作用。</p>
          <Locations locations={report.unknownKeys.map((key) => ({ type: 'extension', key }))} onJump={onJump} />
        </div>
      )}
    </section>
  )
}

function UrlList({ urls }: { urls: string[] }) {
  return (
    <MoreList
      items={urls}
      limit={3}
      unit="个"
      className="flex flex-col items-start gap-0.5"
      render={(url) => (
        <span key={url} className="font-mono text-xs break-all text-muted-foreground select-text">
          {url}
        </span>
      )}
    />
  )
}

function IssueItem({ issue, onJump }: { issue: DependencyIssue; onJump: Jump }) {
  return (
    <li
      className={cn(
        'flex flex-col gap-1.5 rounded-lg border p-2.5 text-sm',
        issue.severity === 'warning' && 'border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30',
      )}
    >
      <p>
        <span className="mr-1.5 text-xs font-medium text-muted-foreground">{issue.severity === 'warning' ? '警告' : '提示'}</span>
        {issue.message}
      </p>
      <UrlList urls={issue.urls} />
      <Locations locations={issue.locations} onJump={onJump} />
    </li>
  )
}

const PAGE = 50

function HostGroup({ host, onJump }: { host: ResourceHost; onJump: Jump }) {
  const [open, setOpen] = useState(false)
  const [limit, setLimit] = useState(PAGE)
  const counts = new Map<ResourceKind, number>()
  for (const ref of host.refs) counts.set(ref.kind, (counts.get(ref.kind) ?? 0) + 1)
  const kinds = [...counts.entries()].map(([kind, n]) => `${RESOURCE_KIND_LABELS[kind]} ${n}`).join(' · ')
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-muted/50">
        <ChevronRightIcon className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{host.host}</span>
        {isLocalHost(host.host) && <Badge variant="destructive">本机地址</Badge>}
        <span className="shrink-0 text-xs text-muted-foreground">{kinds}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col divide-y border-t">
          {host.refs.slice(0, limit).map((ref) => (
            <li key={ref.url} className="flex flex-col gap-1 px-2.5 py-2">
              <div className="flex items-start gap-2">
                <Badge variant="outline" className="shrink-0">
                  {RESOURCE_KIND_LABELS[ref.kind]}
                </Badge>
                <span className="min-w-0 font-mono text-xs break-all select-text">{ref.url}</span>
              </div>
              <Locations locations={ref.locations} onJump={onJump} limit={3} />
            </li>
          ))}
        </ul>
        {host.refs.length > limit && (
          <button type="button" className="w-full border-t py-1.5 text-xs text-primary hover:bg-muted/50" onClick={() => setLimit(limit + PAGE)}>
            再显示 {Math.min(PAGE, host.refs.length - limit)} 个（共 {host.refs.length} 个）
          </button>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export interface DependencySheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  report: DependencyReport | null
  /** 跳到结果所在位置；由外面负责关闭面板 */
  onJump: Jump
}

export function DependencySheet({ open, onOpenChange, report, onJump }: DependencySheetProps) {
  const isDesktop = useIsDesktop()
  // 跳转时不把焦点还给触发按钮，否则页面会被拉回顶部
  const jumping = useRef(false)
  const jump: Jump = (loc) => {
    jumping.current = true
    onJump(loc)
  }
  const urlCount = report?.hosts.reduce((n, h) => n + h.refs.length, 0) ?? 0
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isDesktop ? 'right' : 'bottom'}
        className={cn('gap-4 overflow-y-auto p-4', isDesktop ? 'data-[side=right]:sm:max-w-lg' : 'data-[side=bottom]:h-[85svh]')}
        onCloseAutoFocus={(e) => {
          if (jumping.current) e.preventDefault()
          jumping.current = false
        }}
      >
        <SheetHeader className="p-0">
          <SheetTitle>依赖体检</SheetTitle>
          <SheetDescription>
            只读卡里的文字做分析，不运行任何代码；地址现在还能不能打开，要在酒馆里试。点位置标签可以跳过去。
          </SheetDescription>
        </SheetHeader>
        {report && (
          <>
            <p className="text-sm">
              需要 {report.extensions.length} 个扩展 · {report.hosts.length} 个域名的 {urlCount} 个外部地址
              {warningCount(report) > 0 && <span className="text-amber-600 dark:text-amber-400"> · {warningCount(report)} 个警告</span>}
            </p>
            <ExtensionsSection report={report} onJump={jump} />
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">引用问题（{report.issues.length}）</h3>
              {report.issues.length === 0 ? (
                <p className="text-sm text-muted-foreground">外部引用没发现问题。</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {report.issues.map((issue) => (
                    <IssueItem key={`${issue.code}|${issue.message}`} issue={issue} onJump={jump} />
                  ))}
                </ul>
              )}
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">外部资源（按域名）</h3>
              {report.hosts.length === 0 ? (
                <p className="text-sm text-muted-foreground">没有引用外部地址。</p>
              ) : (
                report.hosts.map((host) => <HostGroup key={host.host} host={host} onJump={jump} />)
              )}
            </section>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
