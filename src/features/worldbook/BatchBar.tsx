import { Trash2Icon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { LorebookEntry } from '@/core/card/types'
import { POSITION_OPTIONS, setExt, setPosition, setStrategy } from '@/core/lorebook/entry'

interface BatchBarProps {
  count: number
  onEdit: (label: string, edit: (entry: LorebookEntry) => void) => void
  onDelete: () => void
  onSelectAll: () => void
  onClear: () => void
  onExit: () => void
  extra?: React.ReactNode
}

/** 批量修改条目 */
export function BatchBar({ count, onEdit, onDelete, onSelectAll, onClear, onExit, extra }: BatchBarProps) {
  const [order, setOrder] = useState('100')
  const [offset, setOffset] = useState('1')
  const [depth, setDepth] = useState('4')
  const disabled = count === 0

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/40 p-2">
      <span className="px-1 text-sm">已选 {count} 条</span>
      <Button size="xs" variant="ghost" onClick={onSelectAll}>
        全选
      </Button>
      <Button size="xs" variant="ghost" onClick={onClear}>
        清空
      </Button>
      <div className="flex-1" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="xs" variant="outline" disabled={disabled}>
            启用/方式
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => onEdit('批量启用', (e) => void (e.enabled = true))}>启用</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onEdit('批量禁用', (e) => void (e.enabled = false))}>禁用</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onEdit('批量设为常驻', (e) => setStrategy(e, 'constant'))}>设为常驻</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onEdit('批量设为关键词', (e) => setStrategy(e, 'keyword'))}>设为关键词触发</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>递归</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => onEdit('批量开启防止递归', (e) => setExt(e, 'prevent_recursion', true))}>内容不再触发其他条目：开</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onEdit('批量关闭防止递归', (e) => setExt(e, 'prevent_recursion', false))}>内容不再触发其他条目：关</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onEdit('批量开启排除递归', (e) => setExt(e, 'exclude_recursion', true))}>不被其他条目触发：开</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onEdit('批量关闭排除递归', (e) => setExt(e, 'exclude_recursion', false))}>不被其他条目触发：关</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Popover>
        <PopoverTrigger asChild>
          <Button size="xs" variant="outline" disabled={disabled}>
            位置
          </Button>
        </PopoverTrigger>
        <PopoverContent className="flex w-56 flex-col gap-1 p-2">
          <div className="flex items-center gap-2 px-1 pb-1 text-xs text-muted-foreground">
            指定深度时用：
            <Input className="h-7 w-16" type="number" value={depth} onChange={(e) => setDepth(e.target.value)} />
          </div>
          {POSITION_OPTIONS.map((p) => (
            <Button
              key={p.value}
              size="sm"
              variant="ghost"
              className="justify-start"
              onClick={() =>
                onEdit(`批量改为${p.label}`, (e) => {
                  setPosition(e, p.value)
                  if (p.value === 4) setExt(e, 'depth', Number(depth) || 0)
                })
              }
            >
              {p.label}
            </Button>
          ))}
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button size="xs" variant="outline" disabled={disabled}>
            顺序
          </Button>
        </PopoverTrigger>
        <PopoverContent className="flex w-60 flex-col gap-2 p-3">
          <div className="flex items-center gap-2">
            <Input className="h-7" type="number" value={order} onChange={(e) => setOrder(e.target.value)} />
            <Button size="xs" onClick={() => onEdit('批量设置顺序', (e) => void (e.insertion_order = Number(order) || 0))}>
              统一设为
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Input className="h-7" type="number" value={offset} onChange={(e) => setOffset(e.target.value)} />
            <Button size="xs" variant="outline" onClick={() => onEdit('批量调整顺序', (e) => void (e.insertion_order = (e.insertion_order ?? 100) + (Number(offset) || 0)))}>
              加上
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {extra}

      <Button size="xs" variant="destructive" disabled={disabled} onClick={onDelete}>
        <Trash2Icon /> 删除
      </Button>
      <Button size="icon-xs" variant="ghost" onClick={onExit} aria-label="退出批量">
        <XIcon />
      </Button>
    </div>
  )
}
