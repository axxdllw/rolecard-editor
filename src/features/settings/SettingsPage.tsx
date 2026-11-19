import { ArchiveRestoreIcon, DownloadIcon, HardDriveIcon, ShieldCheckIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { confirm } from '@/components/confirm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { downloadBlob, pickFiles } from '@/lib/files'
import { formatBytes, formatTime } from '@/lib/format'
import { useSettings } from '@/lib/settings'
import { exportBackup, requestPersistentStorage, restoreBackup, storageStatus } from '@/services/backup'

function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  )
}

export default function SettingsPage() {
  const settings = useSettings()
  const [storage, setStorage] = useState<Awaited<ReturnType<typeof storageStatus>> | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = () => void storageStatus().then(setStorage)
  useEffect(refresh, [])

  const backup = async () => {
    setBusy(true)
    try {
      const { bytes, cards, lorebooks } = await exportBackup()
      const stamp = new Date().toISOString().slice(0, 10)
      downloadBlob(bytes, `角色卡编辑器备份-${stamp}.zip`, 'application/zip')
      settings.set({ lastBackupAt: Date.now() })
      toast.success(`已备份 ${cards} 张卡、${lorebooks} 本世界书`)
    } catch (error) {
      toast.error(`备份失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const restore = async () => {
    const [file] = await pickFiles('.zip')
    if (!file) return
    const replace = await confirm({
      title: '怎么恢复？',
      description: '“清空后恢复”会先删除当前所有数据；选“取消”则合并恢复（同一张卡以备份为准，其他保留）。',
      confirmText: '清空后恢复',
      destructive: true,
    })
    setBusy(true)
    try {
      const result = await restoreBackup(new Uint8Array(await file.arrayBuffer()), replace ? 'replace' : 'merge')
      toast.success(`已恢复 ${result.cards} 张卡、${result.lorebooks} 本世界书`)
      refresh()
    } catch (error) {
      toast.error(`恢复失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">设置</h1>

      <Panel title="数据备份" description="所有数据只存在这个浏览器里。换设备、清理浏览器数据之前，请先备份。">
        <div className="flex flex-wrap gap-2">
          <Button onClick={backup} disabled={busy}>
            <DownloadIcon /> 备份全部数据
          </Button>
          <Button variant="outline" onClick={restore} disabled={busy}>
            <ArchiveRestoreIcon /> 从备份恢复
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          上次备份：{settings.lastBackupAt ? formatTime(settings.lastBackupAt) : '从未备份'}。备份是一个 zip，里面有全部卡片、头像和世界书。
        </p>
      </Panel>

      <Panel title="本地存储">
        <div className="flex flex-col gap-1 text-sm">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon className="size-4 text-muted-foreground" />
            持久化存储：
            {storage?.persisted ? (
              <span className="text-emerald-600">已开启，浏览器不会自动清理</span>
            ) : (
              <>
                <span className="text-amber-600">未开启，空间紧张时浏览器可能清理数据</span>
                <Button size="xs" variant="outline" onClick={async () => ((await requestPersistentStorage()) ? (toast.success('已开启'), refresh()) : toast.error('浏览器拒绝了，可以把网站安装到桌面后再试'))}>
                  申请开启
                </Button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <HardDriveIcon className="size-4 text-muted-foreground" />
            已用 {formatBytes(storage?.usage)} / 可用 {formatBytes(storage?.quota)}
          </div>
        </div>
        {isIOS && (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            iPhone / iPad 提示：Safari 对没有添加到主屏幕的网站，7 天不打开可能会清掉本地数据。建议点分享按钮 →“添加到主屏幕”，并定期备份。
          </p>
        )}
      </Panel>

      <Panel title="预览与检查">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="set-user">预览时 {'{{user}}'} 显示为</Label>
            <Input id="set-user" value={settings.previewUserName} onChange={(e) => settings.set({ previewUserName: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="set-budget">常驻内容 token 预算</Label>
            <Input
              id="set-budget"
              type="number"
              min={0}
              value={settings.constantTokenBudget}
              onChange={(e) => settings.set({ constantTokenBudget: Number(e.target.value) || 0 })}
            />
            <p className="text-xs text-muted-foreground">世界书常驻条目超过这个数时，检查里会提示。</p>
          </div>
        </div>
      </Panel>

      <Panel title="关于">
        <p className="text-sm text-muted-foreground">
          角色卡编辑器：管理和编辑 SillyTavern 角色卡。导入导出保持数据无损，导出的 PNG 同时包含 V2 和 V3 数据。token 数用 o200k 分词器估算，仅供参考。
        </p>
      </Panel>
    </div>
  )
}
