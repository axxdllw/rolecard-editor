/**
 * 文件选择与下载。
 */

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
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
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
