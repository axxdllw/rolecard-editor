/**
 * MVU 变量工作台：检查 [initvar] 和变量结构（zod）的初始化结果、每轮变量更新命令的执行情况、各楼层的变量。
 * 数据来自预览宿主页（运行着卡片脚本，不可信），一律当纯文本显示。
 */
import { WandSparklesIcon } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { describeCommand } from '@/core/mvu/commands'
import { diffVariables, jsonPointer, previewValue, type VarChange } from '@/core/mvu/diff'
import { statData, type FloorRecord, type MvuCommandRecord, type MvuInitRecord, type MvuUpdateRecord } from '@/core/mvu/records'
import type { InitvarEntryReport } from '@/core/render/initvar'
import { cn } from '@/lib/utils'

export interface MvuWorkbenchState {
  init: MvuInitRecord | null
  updates: MvuUpdateRecord[]
  floors: FloorRecord[]
}

export interface MvuWorkbenchProps {
  initvar: InitvarEntryReport[]
  state: MvuWorkbenchState
  /** 是否打开了模拟对话 */
  exchange: boolean
  /** 插入示例更新命令 */
  onInsertSample: () => void
  /** 手填初始变量的编辑区 */
  manual: ReactNode
}

const MAX_CHANGES = 300

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-medium">{title}</h4>
        {aside}
      </div>
      {children}
    </section>
  )
}

function Hint({ children, tone }: { children: ReactNode; tone?: 'error' | 'warn' }) {
  return (
    <p
      className={cn(
        'text-xs',
        tone === 'error' ? 'text-destructive' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
      )}
    >
      {children}
    </p>
  )
}

const pathText = (path: string[]) => (path.length ? jsonPointer(path) : '（根）')

type ChangeLabeler = (change: VarChange) => { label: string; tone: string }

const updateLabel: ChangeLabeler = (c) =>
  c.kind === 'added'
    ? { label: '新增', tone: 'text-emerald-600 dark:text-emerald-400' }
    : c.kind === 'removed'
      ? { label: '删除', tone: 'text-destructive' }
      : { label: c.typeChanged ? '改类型' : '修改', tone: 'text-sky-600 dark:text-sky-400' }

const zodLabel: ChangeLabeler = (c) =>
  c.kind === 'added'
    ? { label: '补默认值', tone: 'text-emerald-600 dark:text-emerald-400' }
    : c.kind === 'removed'
      ? { label: '被移除', tone: 'text-destructive' }
      : c.typeChanged
        ? { label: '类型转换', tone: 'text-amber-600 dark:text-amber-400' }
        : { label: '被改写', tone: 'text-sky-600 dark:text-sky-400' }

/** 按路径列出改动：路径、旧值 → 新值 */
function ChangeList({ changes, labeler = updateLabel, empty }: { changes: VarChange[]; labeler?: ChangeLabeler; empty: string }) {
  if (!changes.length) return <Hint>{empty}</Hint>
  return (
    <ul className="flex flex-col gap-1 rounded-md border bg-muted/30 p-2 font-mono text-xs">
      {changes.slice(0, MAX_CHANGES).map((c) => {
        const { label, tone } = labeler(c)
        return (
          <li key={`${c.kind}:${c.path.join('\u0000')}`} className="flex flex-wrap items-baseline gap-x-2">
            <span className={cn('shrink-0 font-sans', tone)}>{label}</span>
            <span className="break-all">{pathText(c.path)}</span>
            <span className="break-all text-muted-foreground">
              {c.kind === 'added' ? previewValue(c.after) : c.kind === 'removed' ? previewValue(c.before) : `${previewValue(c.before)} → ${previewValue(c.after)}`}
            </span>
          </li>
        )
      })}
      {changes.length > MAX_CHANGES && <li className="font-sans text-muted-foreground">还有 {changes.length - MAX_CHANGES} 处改动未显示</li>}
    </ul>
  )
}

function JsonView({ value }: { value: unknown }) {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? '（无）'
  } catch {
    text = String(value)
  }
  return <pre className="max-h-72 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs">{text}</pre>
}

/** 带行号的原文，出错的行标红 */
function SourceView({ report }: { report: InitvarEntryReport }) {
  const marks = new Map<number, 'error' | 'warn'>()
  const mark = (issue: InitvarEntryReport['errors'][number], tone: 'error' | 'warn') => {
    for (let n = issue.line; n && n <= (issue.endLine ?? issue.line); n++) marks.set(n, tone)
  }
  for (const w of report.warnings) mark(w, 'warn')
  for (const e of report.errors) mark(e, 'error')
  const lines = report.body.split('\n')
  const width = String(report.bodyLine + lines.length - 1).length
  return (
    <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 py-1 font-mono text-xs">
      {lines.map((line, i) => {
        const n = report.bodyLine + i
        const mark = marks.get(n)
        return (
          <div key={i} className={cn('px-2', mark === 'error' ? 'bg-destructive/15' : mark === 'warn' ? 'bg-amber-500/15' : '')}>
            <span className="mr-2 inline-block text-right text-muted-foreground select-none" style={{ width: `${width}ch` }}>
              {n}
            </span>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

function InitvarEntryView({ report }: { report: InitvarEntryReport }) {
  const issues = [...report.errors.map((i) => ({ ...i, tone: 'error' as const })), ...report.warnings.map((i) => ({ ...i, tone: 'warn' as const }))]
  return (
    <details className="group rounded-md border p-2" open={report.errors.length > 0}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium break-all">{report.title}</span>
        <Badge variant="outline">{report.format === 'json' ? 'JSON' : 'YAML'}</Badge>
        {!report.enabled && <Badge variant="secondary">禁用（MVU 照样读取）</Badge>}
        {report.errors.length > 0 ? (
          <Badge variant="destructive">解析出错</Badge>
        ) : report.warnings.length > 0 ? (
          <Badge variant="outline" className="text-amber-600 dark:text-amber-400">
            有警告
          </Badge>
        ) : (
          <Badge variant="outline" className="text-emerald-600 dark:text-emerald-400">
            正常
          </Badge>
        )}
      </summary>
      <div className="mt-1.5 flex flex-col gap-1.5">
        {issues.map((issue, i) => (
          <Hint key={i} tone={issue.tone}>
            {issue.line ? `第 ${issue.line} 行${issue.col ? `第 ${issue.col} 列` : ''}：` : ''}
            {issue.message}
          </Hint>
        ))}
        {report.errors.length > 0 && report.format === 'yaml' && report.data && (
          <Hint>YAML 有语法错误时 MVU 不会报错，而是用解析器尽量读出的部分，结果可能与预期不同。</Hint>
        )}
        {report.body !== report.content && <Hint>已去掉 &lt;initvar&gt; 标签或代码块围栏，行号对应条目原文。</Hint>}
        <SourceView report={report} />
      </div>
    </details>
  )
}

function InitTab({ initvar, init }: { initvar: InitvarEntryReport[]; init: MvuInitRecord | null }) {
  const changes = useMemo(() => (init ? diffVariables(init.before, init.after) : []), [init])
  return (
    <div className="flex flex-col gap-3">
      <Section title="世界书 [initvar] 条目">
        {initvar.length === 0 ? (
          <Hint>世界书里没有 [initvar] 条目（MVU 也可以读开场白里的 &lt;initvar&gt; 块）。</Hint>
        ) : (
          initvar.map((report, i) => <InitvarEntryView key={i} report={report} />)
        )}
      </Section>
      <Section title="初始化结果（第 0 楼）">
        {!init ? (
          <Hint>等待 MVU 初始化…（没有出现时看「日志」里的报错）</Hint>
        ) : (
          <>
            <Hint>
              {!init.zod
                ? '没有变量结构脚本，MVU 直接使用 [initvar] 的内容。'
                : init.issues.length
                  ? '「变量结构」脚本（zod）参与了初始化。'
                  : '「变量结构」脚本（zod）参与了初始化：下面是它对 MVU 读到的 [initvar] 做的改动。'}
            </Hint>
            {init.error && <Hint tone="error">变量结构校验出错：{init.error}</Hint>}
            {init.issues.length > 0 && (
              <div className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
                <p className="text-destructive">变量结构校验失败，没有套用默认值，第 0 楼保留了 [initvar] 原样：</p>
                <ul className="flex flex-col gap-1">
                  {init.issues.map((issue, i) => (
                    <li key={i} className="flex flex-wrap gap-x-2">
                      <span className="font-mono break-all">{pathText(issue.path)}</span>
                      <span className="break-all">{issue.message}</span>
                      {issue.input !== undefined && <span className="font-mono break-all text-muted-foreground">输入：{issue.input}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {init.zod && (changes.length > 0 || init.issues.length === 0) && (
              <ChangeList changes={changes} labeler={zodLabel} empty="变量结构没有改动 [initvar] 的内容。" />
            )}
          </>
        )}
      </Section>
    </div>
  )
}

const STATUS: Record<MvuCommandRecord['status'], { label: string; className: string }> = {
  applied: { label: '生效', className: 'text-emerald-600 dark:text-emerald-400' },
  failed: { label: '失败', className: 'text-destructive' },
  noop: { label: '无变化', className: 'text-muted-foreground' },
}

function CommandRow({ command, zod }: { command: MvuCommandRecord; zod: boolean }) {
  const view = describeCommand(command)
  const status = STATUS[command.status]
  const isDelta = view.op === 'delta' || view.op === '_.add'
  return (
    <li className="flex flex-col gap-0.5 rounded-md border p-1.5 text-xs">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <Badge variant="outline" className={status.className}>
          {status.label}
        </Badge>
        <span className="font-mono font-medium">{view.op}</span>
        <span className="font-mono break-all">
          {view.from !== undefined && `${view.from || '（根）'} → `}
          {view.path || '（根）'}
        </span>
        {view.value !== undefined && (
          <span className="font-mono break-all text-muted-foreground">
            {isDelta ? '增量' : '值'} {view.value.length > 200 ? `${view.value.slice(0, 200)}…` : view.value}
          </span>
        )}
      </div>
      {command.error && <pre className="font-mono break-all whitespace-pre-wrap text-destructive">{command.error}</pre>}
      {command.status === 'noop' && (
        <Hint>{zod ? '没有产生变化（值相同，或路径以 _ 开头被变量结构忽略）。' : '目标位置的值没有变化。'}</Hint>
      )}
      {!view.patch && command.fullMatch && <p className="font-mono break-all text-muted-foreground">{command.fullMatch}</p>}
    </li>
  )
}

function UpdateTab({ updates, exchange, onInsertSample }: { updates: MvuUpdateRecord[]; exchange: boolean; onInsertSample: () => void }) {
  // 每层只看最后一次解析；默认选最新的、有命令的那层
  const records = useMemo(() => {
    const byFloor = new Map<number, MvuUpdateRecord>()
    for (const u of updates) byFloor.set(u.messageId, u)
    return [...byFloor.values()].sort((a, b) => a.messageId - b.messageId)
  }, [updates])
  const fallback = records.findLast((r) => r.commands.length > 0) ?? records.at(-1)
  const [picked, setPicked] = useState<number | null>(null)
  const record = records.find((r) => r.messageId === picked) ?? fallback
  const changes = useMemo(() => (record ? diffVariables(record.before, record.after) : []), [record])
  const counts = record
    ? (['applied', 'failed', 'noop'] as const).map((s) => [s, record.commands.filter((c) => c.status === s).length] as const).filter(([, n]) => n > 0)
    : []

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={onInsertSample}>
          <WandSparklesIcon /> 插入示例更新命令
        </Button>
        <Hint>按当前变量里的数值字段生成 delta 命令，追加到模拟对话的 AI 回复末尾。</Hint>
      </div>
      {!exchange && <Hint>打开「模拟对话」，在 AI 回复里粘贴带 &lt;UpdateVariable&gt; 的内容，这里会列出 MVU 解析出的每条命令。</Hint>}
      {!record ? (
        <Hint>还没有变量更新。</Hint>
      ) : (
        <>
          {records.length > 1 && (
            <ToggleGroup type="single" variant="outline" size="sm" value={String(record.messageId)} onValueChange={(v) => v && setPicked(Number(v))}>
              {records.map((r) => (
                <ToggleGroupItem key={r.messageId} value={String(r.messageId)} className="px-2 text-xs">
                  第 {r.messageId} 楼{r.messageId === 0 ? '（开场白）' : ''}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
          <Section
            title={`第 ${record.messageId} 楼的更新命令（${record.commands.length} 条）`}
            aside={
              <span className="text-xs text-muted-foreground">
                {counts.map(([s, n]) => `${STATUS[s].label} ${n}`).join('，')}
                {record.commands.length > 0 && (record.zod ? ' · 由变量结构执行' : ' · 由 MVU 执行')}
              </span>
            }
          >
            {record.commands.length === 0 ? (
              <Hint>这一楼没有解析出更新命令。检查是否包在 &lt;UpdateVariable&gt;&lt;JSONPatch&gt;…&lt;/JSONPatch&gt;&lt;/UpdateVariable&gt; 里、JSON 是否完整。</Hint>
            ) : (
              <ul className="flex flex-col gap-1">
                {record.commands.map((command, i) => (
                  <CommandRow key={i} command={command} zod={record.zod} />
                ))}
              </ul>
            )}
            {record.errors.map((error, i) => (
              <pre key={i} className="font-mono text-xs break-all whitespace-pre-wrap text-destructive">
                {error}
              </pre>
            ))}
          </Section>
          <Section title="stat_data 变化（更新前 → 更新后）">
            <ChangeList changes={changes} empty="变量没有变化。" />
          </Section>
        </>
      )}
    </div>
  )
}

function FloorsTab({ floors }: { floors: FloorRecord[] }) {
  const [view, setView] = useState<'first' | 'latest' | 'diff'>('latest')
  const first = floors[0]
  const latest = floors.at(-1)
  const changes = useMemo(() => (first && latest ? diffVariables(statData(first.variables), statData(latest.variables)) : []), [first, latest])
  if (!first || !latest) return <Hint>等待预览运行…</Hint>
  const single = first === latest
  const mode = single ? 'first' : view
  return (
    <div className="flex flex-col gap-2">
      <ToggleGroup type="single" variant="outline" size="sm" value={mode} onValueChange={(v) => v && setView(v as typeof view)}>
        <ToggleGroupItem value="first" className="px-2 text-xs">
          第 0 楼
        </ToggleGroupItem>
        <ToggleGroupItem value="latest" className="px-2 text-xs" disabled={single}>
          最新（第 {latest.messageId} 楼）
        </ToggleGroupItem>
        <ToggleGroupItem value="diff" className="px-2 text-xs" disabled={single}>
          对比
        </ToggleGroupItem>
      </ToggleGroup>
      {single && <Hint>只有第 0 楼。打开「模拟对话」后可以看最新楼层并对比。</Hint>}
      {mode === 'diff' ? (
        <ChangeList changes={changes} empty={`第 0 楼和第 ${latest.messageId} 楼的 stat_data 相同。`} />
      ) : (
        <JsonView value={statData((mode === 'first' ? first : latest).variables) ?? {}} />
      )}
    </div>
  )
}

export default function MvuWorkbench({ initvar, state, exchange, onInsertSample, manual }: MvuWorkbenchProps) {
  const initProblems = initvar.some((r) => r.errors.length > 0) || (state.init?.issues.length ?? 0) > 0 || !!state.init?.error
  const failed = state.updates.some((u) => u.errors.length > 0 || u.commands.some((c) => c.status === 'failed'))
  const dot = <span className="size-1.5 rounded-full bg-destructive" />
  return (
    <Tabs defaultValue={exchange ? 'update' : 'init'} className="gap-2">
      <TabsList className="w-full">
        <TabsTrigger value="init" className="text-xs">
          初始化{initProblems && dot}
        </TabsTrigger>
        <TabsTrigger value="update" className="text-xs">
          更新{failed && dot}
        </TabsTrigger>
        <TabsTrigger value="floors" className="text-xs">
          楼层
        </TabsTrigger>
        <TabsTrigger value="manual" className="text-xs">
          手填
        </TabsTrigger>
      </TabsList>
      <TabsContent value="init">
        <InitTab initvar={initvar} init={state.init} />
      </TabsContent>
      <TabsContent value="update">
        <UpdateTab updates={state.updates} exchange={exchange} onInsertSample={onInsertSample} />
      </TabsContent>
      <TabsContent value="floors">
        <FloorsTab floors={state.floors} />
      </TabsContent>
      <TabsContent value="manual">{manual}</TabsContent>
    </Tabs>
  )
}
