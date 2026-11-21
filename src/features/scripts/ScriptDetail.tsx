import { ArrowUpIcon, CopyIcon, EllipsisIcon, FolderInputIcon, FolderOutputIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { CodeEditor } from '@/components/CodeEditor'
import { confirm } from '@/components/confirm'
import { TextEditor } from '@/components/TextEditor'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  duplicateNode,
  folderIndexAfterRemoval,
  moveNode,
  removeNode,
  updateButtons,
  updateFolder,
  type HelperFolder,
  type HelperNode,
  type HelperScript,
  type NodePos,
} from '@/core/tavern-helper/scripts'
import { FieldLabel } from '@/features/editor/fields'
import { JsonObjectField } from './JsonObjectField'
import { currentPos, editHelper, editScript, formatChars, keyAt } from './state'
import { scriptExtensions } from './thLanguage'

interface NodeActionsProps {
  node: HelperNode
  folders: HelperFolder[]
  onSelect: (key: string | null) => void
}

/** 复制、移动到文件夹、删除 */
function NodeActions({ node, folders, onSelect }: NodeActionsProps) {
  const inFolder = node.pos.child !== undefined

  const duplicate = () => {
    const pos = currentPos(node.key)
    if (!pos) return
    let created: NodePos | null = null
    editHelper((ext) => void (created = duplicateNode(ext, pos)), node.type === 'folder' ? '复制文件夹' : '复制脚本')
    onSelect(keyAt(created))
  }

  /** folderIndex 为 null 表示移出文件夹，放到文件夹后面 */
  const moveTo = (folderIndex: number | null) => {
    const pos = currentPos(node.key)
    if (!pos) return
    const to = folderIndex === null ? { index: pos.index + 1 } : { folder: folderIndexAfterRemoval(pos, folderIndex) }
    editHelper((ext) => moveNode(ext, pos, to), folderIndex === null ? '移出文件夹' : '移到文件夹')
  }

  const remove = async () => {
    const name = node.name || '未命名'
    const title = node.type === 'folder' ? `删除文件夹「${name}」和里面的 ${node.scripts.length} 个脚本？` : `删除脚本「${name}」？`
    if (!(await confirm({ title, description: '可以用“撤销”找回。', confirmText: '删除', destructive: true }))) return
    const pos = currentPos(node.key)
    if (!pos) return
    editHelper((ext) => removeNode(ext, pos), node.type === 'folder' ? '删除文件夹' : '删除脚本')
    onSelect(null)
  }

  const targets = folders.filter((f) => f.pos.index !== node.pos.index)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="更多操作">
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
        <DropdownMenuItem onClick={duplicate}>
          <CopyIcon /> 复制一份
        </DropdownMenuItem>
        {node.type === 'script' && inFolder && (
          <DropdownMenuItem onClick={() => moveTo(null)}>
            <FolderOutputIcon /> 移出文件夹
          </DropdownMenuItem>
        )}
        {node.type === 'script' && targets.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">移到文件夹</DropdownMenuLabel>
            {targets.map((f) => (
              <DropdownMenuItem key={f.key} onClick={() => moveTo(f.pos.index)}>
                <FolderInputIcon /> {f.name || '未命名'}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={remove}>
          <Trash2Icon /> 删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ButtonList({ script }: { script: HelperScript }) {
  const edit = (label: string, recipe: Parameters<typeof updateButtons>[2], merge?: string) => {
    const pos = currentPos(script.key)
    if (pos) editHelper((ext) => updateButtons(ext, pos, recipe), label, merge)
  }
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel
        label={`按钮（${script.buttons.length}）`}
        hint="显示在酒馆输入框上方的按钮，点击后触发 getButtonEvent('按钮名') 对应的事件，需要脚本里用 eventOn 监听"
        extra={
          <div className="flex items-center gap-2">
            {script.buttonEnabled !== null && (
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Switch
                  size="sm"
                  checked={script.buttonEnabled}
                  onCheckedChange={(v) => editScript(script.key, { buttonEnabled: v }, v ? '显示脚本按钮' : '隐藏脚本按钮')}
                />
                显示按钮
              </label>
            )}
            <Button size="xs" variant="outline" onClick={() => edit('添加按钮', (list) => void list.push({ name: '', visible: true }))}>
              <PlusIcon /> 添加
            </Button>
          </div>
        }
      />
      {script.buttons.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {script.buttons.map((b, i) => (
            <div key={i} className="flex items-center gap-2">
              <Checkbox
                checked={b.visible}
                onCheckedChange={(v) => edit('修改按钮显示', (list) => void (list[i].visible = v === true))}
                aria-label={`显示按钮 ${i + 1}`}
              />
              <Input
                className="h-8 flex-1"
                value={b.name}
                placeholder="按钮名称"
                onChange={(e) => edit('修改按钮名称', (list) => void (list[i].name = e.target.value), `th.button.${script.key}.${i}`)}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={i === 0}
                aria-label="上移"
                onClick={() => edit('调整按钮顺序', (list) => void list.splice(i - 1, 0, list.splice(i, 1)[0]))}
              >
                <ArrowUpIcon />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="删除按钮" onClick={() => edit('删除按钮', (list) => void list.splice(i, 1))}>
                <Trash2Icon />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface ScriptDetailProps {
  script: HelperScript
  folders: HelperFolder[]
  /** 所在文件夹被关闭 */
  parentOff: boolean
  onSelect: (key: string | null) => void
}

export function ScriptDetail({ script, folders, parentOff, onSelect }: ScriptDetailProps) {
  const key = script.key
  const onContent = useCallback((v: string) => editScript(key, { content: v }, '编辑脚本内容', `th.content.${key}`), [key])
  const onInfo = useCallback((v: string) => editScript(key, { info: v }, '编辑作者备注', `th.info.${key}`), [key])
  const lines = useMemo(() => {
    let n = 1
    for (let i = script.content.indexOf('\n'); i >= 0; i = script.content.indexOf('\n', i + 1)) n++
    return n
  }, [script.content])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Switch
          checked={script.enabled}
          onCheckedChange={(v) => editScript(key, { enabled: v }, v ? '启用脚本' : '停用脚本')}
          aria-label="启用脚本"
        />
        <Input
          className="flex-1 font-medium"
          value={script.name}
          placeholder="脚本名称"
          aria-label="脚本名称"
          onChange={(e) => editScript(key, { name: e.target.value }, '修改脚本名称', `th.name.${key}`)}
        />
        <NodeActions node={script} folders={folders} onSelect={onSelect} />
      </div>
      {parentOff && <p className="text-xs text-amber-600">所在文件夹已关闭，这个脚本不会运行</p>}

      <div className="flex flex-col gap-1.5">
        <FieldLabel
          label="脚本内容"
          hint="JavaScript，在酒馆助手的脚本 iframe 里运行。输入接口名会自动补全（Ctrl+Space 手动打开），Ctrl+F 查找替换"
          extra={
            <span className="text-xs text-muted-foreground tabular-nums">
              {lines} 行 · {formatChars(script.content.length)}
            </span>
          }
        />
        <CodeEditor
          value={script.content}
          onChange={onContent}
          extensions={scriptExtensions}
          placeholder="// 脚本的 JavaScript 代码"
          fullscreenTitle={`脚本内容 · ${script.name || '未命名'}`}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel label="作者备注" hint="info：显示在酒馆助手脚本列表里的说明，例如作者、版本、注意事项，支持简单的 Markdown 和 HTML" />
        <TextEditor value={script.info} onChange={onInfo} minHeight={60} maxHeight={240} placeholder="作者、版本、注意事项…" fullscreenTitle={`作者备注 · ${script.name || '未命名'}`} />
      </div>

      <ButtonList script={script} />

      <JsonObjectField
        key={key}
        label="脚本变量"
        hint="data：绑定到这个脚本的变量，会随脚本一起导出；脚本里用 getVariables({ type: 'script' }) 读写"
        value={script.data}
        onApply={(v) => editScript(key, { data: v }, '修改脚本变量')}
        fullscreenTitle={`脚本变量 · ${script.name || '未命名'}`}
        maxHeight={240}
      />
    </div>
  )
}

interface FolderDetailProps {
  folder: HelperFolder
  folders: HelperFolder[]
  onSelect: (key: string | null) => void
}

export function FolderDetail({ folder, folders, onSelect }: FolderDetailProps) {
  const set = (label: string, patch: Parameters<typeof updateFolder>[2], merge?: string) => {
    const pos = currentPos(folder.key)
    if (pos) editHelper((ext) => updateFolder(ext, pos, patch), label, merge)
  }
  const enabledCount = folder.scripts.filter((s) => s.enabled).length
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        {folder.enabled !== null && (
          <Switch checked={folder.enabled} onCheckedChange={(v) => set(v ? '启用文件夹' : '停用文件夹', { enabled: v })} aria-label="启用文件夹" />
        )}
        <Input
          className="flex-1 font-medium"
          value={folder.name}
          placeholder="文件夹名称"
          aria-label="文件夹名称"
          onChange={(e) => set('修改文件夹名称', { name: e.target.value }, `th.folder.${folder.key}`)}
        />
        <NodeActions node={folder} folders={folders} onSelect={onSelect} />
      </div>
      <p className="text-sm text-muted-foreground">
        里面有 {folder.scripts.length} 个脚本，启用了 {enabledCount} 个。
        {folder.enabled === null ? '旧格式的文件夹没有开关，总是启用。' : '关闭文件夹会停用里面的所有脚本。'}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <FieldLabel label="图标" hint="Font Awesome 图标的 class，例如 fa-solid fa-folder" />
          <Input value={folder.icon} onChange={(e) => set('修改文件夹图标', { icon: e.target.value }, `th.icon.${folder.key}`)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <FieldLabel label="颜色" hint="文件夹图标在酒馆助手里的颜色，任意 CSS 颜色值" />
          <div className="flex items-center gap-2">
            <span className="size-6 shrink-0 rounded border" style={{ backgroundColor: folder.color || 'transparent' }} />
            <Input value={folder.color} onChange={(e) => set('修改文件夹颜色', { color: e.target.value }, `th.color.${folder.key}`)} />
          </div>
        </div>
      </div>
    </div>
  )
}
