import { useObjectUrl } from '@/lib/image'
import { cn } from '@/lib/utils'

const GRADIENTS = [
  'from-violet-500 to-pink-500',
  'from-sky-500 to-indigo-500',
  'from-emerald-500 to-sky-500',
  'from-amber-500 to-rose-500',
  'from-slate-500 to-slate-700',
]

/** 角色头像；没有图片时显示渐变底色 + 名字首字 */
export function CardAvatar({ blob, name, className }: { blob: Blob | null; name: string; className?: string }) {
  const url = useObjectUrl(blob)
  if (url) {
    return <img src={url} alt={name} className={cn('object-cover', className)} loading="lazy" draggable={false} />
  }
  const hash = [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)
  return (
    <div
      className={cn(
        'flex items-center justify-center bg-gradient-to-br text-3xl font-semibold text-white/90 select-none',
        GRADIENTS[hash % GRADIENTS.length],
        className,
      )}
    >
      {[...(name.trim() || '?')][0]}
    </div>
  )
}
