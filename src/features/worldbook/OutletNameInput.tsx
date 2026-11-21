import { useId, type ComponentProps } from 'react'
import { Input } from '@/components/ui/input'

/** 锚点名输入框：用原生 datalist 提示世界书里已有的锚点名 */
export function OutletNameInput({ names, ...props }: ComponentProps<typeof Input> & { names: string[] }) {
  const listId = useId()
  return (
    <>
      <Input list={listId} placeholder="锚点名" autoComplete="off" {...props} />
      <datalist id={listId}>
        {names.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </>
  )
}
