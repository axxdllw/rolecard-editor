import { create } from 'zustand'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'

interface ConfirmOptions {
  title: string
  description?: string
  confirmText?: string
  destructive?: boolean
}

interface ConfirmState {
  open: boolean
  options: ConfirmOptions | null
  resolve: ((ok: boolean) => void) | null
}

const useConfirmStore = create<ConfirmState>(() => ({ open: false, options: null, resolve: null }))

/** 命令式确认框：const ok = await confirm({...}) */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirmStore.setState({ open: true, options, resolve })
  })
}

export function ConfirmHost() {
  const { open, options, resolve } = useConfirmStore()
  const close = (ok: boolean) => {
    resolve?.(ok)
    useConfirmStore.setState({ open: false, resolve: null })
  }
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && close(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{options?.title}</AlertDialogTitle>
          {options?.description && <AlertDialogDescription>{options.description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => close(false)}>取消</AlertDialogCancel>
          <AlertDialogAction
            className={options?.destructive ? buttonVariants({ variant: 'destructive' }) : undefined}
            onClick={() => close(true)}
          >
            {options?.confirmText ?? '确定'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
