/**
 * 酒馆助手（JS-Slash-Runner）角色脚本编辑区：脚本树、脚本内容（CodeMirror）、按钮、脚本变量、角色变量。
 * 新旧两种存储格式都能直接编辑，默认保持原格式；旧格式可以手动升级。
 */
import { ArrowUpCircleIcon, FolderPlusIcon, PlusIcon, TriangleAlertIcon } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { confirm } from '@/components/confirm'
import { Button } from '@/components/ui/button'
import {
  addFolder,
  addScript,
  flattenScripts,
  LEGACY_SCRIPTS_KEY,
  LEGACY_VARIABLES_KEY,
  removeStaleLegacy,
  setVariables,
  upgradeLegacy,
  type HelperFolder,
  type HelperView,
  type NodePos,
} from '@/core/tavern-helper/scripts'
import { useIsDesktop } from '@/lib/useMediaQuery'
import { JsonObjectField } from './JsonObjectField'
import { FolderDetail, ScriptDetail } from './ScriptDetail'
import { ScriptTree } from './ScriptTree'
import { editHelper, findByKey, keyAt, useHelperView } from './state'

function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/8 px-3 py-2 text-sm">
      <TriangleAlertIcon className="size-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  )
}

function FormatNotices({ view }: { view: HelperView }) {
  const upgrade = async () => {
    const ok = await confirm({
      title: '升级为新格式？',
      description:
        '把 TavernHelper_scripts 改成新版酒馆助手的 tavern_helper 格式（新版酒馆助手导入这张卡时也会自动这样转换）。升级后旧版酒馆助手读不到这些脚本。可以撤销。',
      confirmText: '升级',
    })
    if (!ok) return
    editHelper(upgradeLegacy, '升级脚本格式')
    toast.success('已升级为新格式')
  }

  const removeStale = async () => {
    const ok = await confirm({
      title: '删除残留的旧格式数据？',
      description: `删除 ${view.staleLegacy.join('、')}。卡里已经有新格式的脚本，酒馆助手只认新格式，导入时也会删掉这些旧字段。可以撤销。`,
      confirmText: '删除',
      destructive: true,
    })
    if (ok) editHelper(removeStaleLegacy, '删除旧格式脚本数据')
  }

  return (
    <>
      {view.format === 'legacy' && (
        <Notice
          action={
            <Button size="sm" variant="outline" onClick={upgrade}>
              <ArrowUpCircleIcon /> 升级为新格式
            </Button>
          }
        >
          这张卡用的是旧版酒馆助手的脚本格式（{LEGACY_SCRIPTS_KEY}）。可以照常编辑，导出时保持原格式；新版酒馆助手导入时会自动转换。
        </Notice>
      )}
      {view.staleLegacy.length > 0 && (
        <Notice
          action={
            <Button size="sm" variant="outline" onClick={removeStale}>
              删除残留数据
            </Button>
          }
        >
          卡里同时还有旧格式的脚本数据（{view.staleLegacy.join('、')}），酒馆助手会忽略并删除它们。
        </Notice>
      )}
    </>
  )
}

export default function ScriptsPanel() {
  const view = useHelperView()
  const [selected, setSelected] = useState<string | null>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const wide = useIsDesktop()

  if (view.invalid) {
    return (
      <Notice>
        酒馆助手数据的结构无法识别（{view.invalid}）。为了不丢数据，这里不接管，可以在「角色 › ST 扩展 › 其他扩展数据」里按 JSON 修改。
      </Notice>
    )
  }

  const legacy = view.format === 'legacy'
  const folders = view.nodes.filter((n): n is HelperFolder => n.type === 'folder')
  const active = findByKey(view.nodes, selected) ?? flattenScripts(view.nodes)[0] ?? view.nodes[0]
  const activeParent = active?.pos.child !== undefined ? view.nodes[active.pos.index] : undefined

  const create = (folder: boolean) => {
    let pos: NodePos | null = null
    // 选中文件夹或文件夹里的脚本时，新脚本放进那个文件夹
    const target = !folder && active ? (active.type === 'folder' ? active.pos.index : active.pos.child !== undefined ? active.pos.index : undefined) : undefined
    editHelper(
      (ext) => void (pos = folder ? addFolder(ext, '新文件夹') : addScript(ext, { name: '新脚本' }, { folder: target })),
      folder ? '新建文件夹' : '新建脚本',
    )
    setSelected(keyAt(pos))
  }

  // 窄屏时详情在列表下面，点了列表项要滚过去才看得到
  const selectFromTree = (key: string) => {
    setSelected(key)
    if (!wide) requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }

  const variablesHint =
    legacy
      ? `${LEGACY_VARIABLES_KEY}：角色卡变量，脚本里用 getVariables({ type: 'character' }) 读写`
      : "tavern_helper.variables：角色卡变量，脚本里用 getVariables({ type: 'character' }) 读写"

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-48 flex-1 text-sm text-muted-foreground">
          酒馆助手的角色脚本，跟着卡一起导入导出；装了酒馆助手扩展并允许这张卡运行脚本时才会生效。
        </p>
        <Button variant="outline" onClick={() => create(true)}>
          <FolderPlusIcon /> 新建文件夹
        </Button>
        <Button onClick={() => create(false)}>
          <PlusIcon /> 新建脚本
        </Button>
      </div>

      <FormatNotices view={view} />

      {view.nodes.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">这张卡没有酒馆助手脚本</div>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <div className="lg:sticky lg:top-28">
            <ScriptTree nodes={view.nodes} selected={active?.key ?? null} onSelect={selectFromTree} />
          </div>
          {active && (
            <div ref={detailRef} className="min-w-0 scroll-mt-28 rounded-xl border bg-card p-3 sm:p-4">
              {active.type === 'script' ? (
                <ScriptDetail
                  key={active.key}
                  script={active}
                  folders={folders}
                  parentOff={activeParent?.enabled === false}
                  onSelect={setSelected}
                />
              ) : (
                <FolderDetail key={active.key} folder={active} folders={folders} onSelect={setSelected} />
              )}
            </div>
          )}
        </div>
      )}

      {view.format !== null && (
        <div className="rounded-xl border bg-card p-3 sm:p-4">
          <JsonObjectField
            label="角色变量"
            hint={variablesHint}
            value={view.variables}
            onApply={(v) => editHelper((ext) => setVariables(ext, v), '修改角色变量')}
            fullscreenTitle="角色变量"
          />
        </div>
      )}
    </div>
  )
}
