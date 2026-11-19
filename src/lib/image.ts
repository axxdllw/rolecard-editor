/**
 * 图片工具（浏览器端）：转 PNG、裁剪、生成默认头像、对象 URL 管理。
 */
import { useEffect, useState } from 'react'
import { isPng } from '@/core/png/png'

export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

export function bytesToBlob(bytes: Uint8Array, type = 'image/png'): Blob {
  return new Blob([bytes.slice()], { type })
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('图片转换失败'))), 'image/png')
  })
}

/** 任意图片转 PNG；本身是 PNG 时原样返回（保留原有的块） */
export async function toPngBlob(blob: Blob): Promise<Blob> {
  const bytes = await blobToBytes(blob)
  if (isPng(bytes)) return bytesToBlob(bytes)
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  return canvasToPng(canvas)
}

export interface CropArea {
  x: number
  y: number
  width: number
  height: number
}

/** 按裁剪区域输出 PNG，最长边不超过 maxSize */
export async function cropToPng(source: Blob, area: CropArea, maxSize = 1024): Promise<Blob> {
  const bitmap = await createImageBitmap(source)
  const scale = Math.min(1, maxSize / Math.max(area.width, area.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(area.width * scale)
  canvas.height = Math.round(area.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height)
  return canvasToPng(canvas)
}

const PALETTES = [
  ['#7c3aed', '#db2777'],
  ['#0ea5e9', '#6366f1'],
  ['#10b981', '#0ea5e9'],
  ['#f59e0b', '#ef4444'],
  ['#64748b', '#334155'],
]

/** 没有头像的卡导出 PNG 时用的默认头像：渐变底色 + 名字首字 */
export async function defaultAvatarPng(name: string): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = 400
  canvas.height = 600
  const ctx = canvas.getContext('2d')!
  const hash = [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)
  const [from, to] = PALETTES[hash % PALETTES.length]
  const gradient = ctx.createLinearGradient(0, 0, 400, 600)
  gradient.addColorStop(0, from)
  gradient.addColorStop(1, to)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 400, 600)
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.font = '600 180px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText([...(name.trim() || '?')][0], 200, 300)
  return canvasToPng(canvas)
}

/** 为 Blob 生成对象 URL，组件卸载或 Blob 变化时自动释放 */
export function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  return url
}
