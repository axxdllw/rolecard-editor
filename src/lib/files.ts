/**
 * 文件选择与下载。
 */
import { toast } from 'sonner'

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.onchange = () => resolve(input.files ? Array.from(input.files) : [])
    input.oncancel = () => resolve([])
    input.click()
  })
}

/** 去掉文件名里不允许的字符 */
// oxlint-disable-next-line no-control-regex
export function safeFileName(name: string, fallback = '未命名'): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return clean || fallback
}

export function downloadBlob(data: Blob | Uint8Array | string, fileName: string, type = 'application/octet-stream') {
  const blob =
    data instanceof Blob ? data : new Blob([typeof data === 'string' ? data : data.slice()], { type })
  // 桌面版的 webview 不一定支持 <a download>，改为弹“另存为”后写盘
  if (import.meta.env.TAURI_ENV_PLATFORM) {
    void saveWithDialog(blob, fileName).catch((error: unknown) => {
      toast.error(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    })
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 桌面版保存文件：用户取消时什么都不做 */
async function saveWithDialog(blob: Blob, fileName: string) {
  const [{ save }, { writeFile }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')])
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : ''
  const path = await save({
    defaultPath: fileName,
    filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined,
  })
  if (!path) return
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()))
  toast.success(`已保存到 ${path}`)
}

export type DroppedKind = 'png' | 'json' | 'charx' | 'image' | 'zip' | 'unknown'

export function fileKind(file: File): DroppedKind {
  const name = file.name.toLowerCase()
  if (name.endsWith('.png')) return 'png'
  if (name.endsWith('.json')) return 'json'
  if (name.endsWith('.charx')) return 'charx'
  if (name.endsWith('.zip')) return 'zip'
  if (/\.(jpe?g|webp|gif|avif)$/.test(name)) return 'image'
  return 'unknown'
}
