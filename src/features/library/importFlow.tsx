import { useState } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { CardParseError, parseCardJson } from '@/core/card/io'
import { parseLorebookJson } from '@/core/lorebook/world'
import { fileKind } from '@/lib/files'
import { addImportedCard, findCardsByName, readCardFile } from '@/services/cards'
import { addLorebook } from '@/services/lorebooks'

type ConflictChoice = 'new' | 'replace' | 'skip'

interface Pending {
  name: string
  fileName: string
  resolve: (result: { choice: ConflictChoice; applyAll: boolean }) => void
}

const useConflictStore = create<{ pending: Pending | null }>(() => ({ pending: null }))

function askConflict(name: string, fileName: string) {
  return new Promise<{ choice: ConflictChoice; applyAll: boolean }>((resolve) => {
    useConflictStore.setState({ pending: { name, fileName, resolve } })
  })
}

/** 导入时遇到同名卡的选择框 */
export function ConflictHost() {
  const pending = useConflictStore((s) => s.pending)
  const [applyAll, setApplyAll] = useState(false)
  const choose = (choice: ConflictChoice) => {
    pending?.resolve({ choice, applyAll })
    useConflictStore.setState({ pending: null })
    setApplyAll(false)
  }
  return (
    <Dialog open={!!pending} onOpenChange={(open) => !open && choose('skip')}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>卡库里已经有「{pending?.name}」</DialogTitle>
          <DialogDescription>正在导入 {pending?.fileName}，要怎么处理？</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Checkbox id="apply-all" checked={applyAll} onCheckedChange={(v) => setApplyAll(v === true)} />
          <Label htmlFor="apply-all">后面遇到同名卡都这样处理</Label>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => choose('skip')}>
            跳过
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => choose('replace')}>
              覆盖原卡
            </Button>
            <Button onClick={() => choose('new')}>作为新卡</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 导入一批文件：角色卡进卡库；世界书 JSON 进世界书库。
 * 返回新导入的卡片 id。
 */
export async function importFiles(files: File[]): Promise<string[]> {
  const importedIds: string[] = []
  const failures: string[] = []
  const warnings: string[] = []
  let lorebooks = 0
  let skipped = 0
  let applyAll: ConflictChoice | null = null

  for (const file of files) {
    const kind = fileKind(file)
    try {
      if (kind === 'zip') {
        throw new CardParseError('zip 文件请到「设置 → 恢复备份」里导入')
      }
      if (kind === 'json') {
        const text = await file.text()
        try {
          parseCardJson(text)
        } catch (cardError) {
          // 不是角色卡：试试世界书
          try {
            const { book } = parseLorebookJson(text, file.name.replace(/\.json$/i, ''))
            await addLorebook(book)
            lorebooks++
            continue
          } catch {
            throw cardError
          }
        }
      }

      const imported = await readCardFile(file)
      const name = imported.parsed.card.data.name
      const dupes = await findCardsByName(name)
      let replaceId: string | undefined
      if (dupes.length > 0) {
        let choice: ConflictChoice | null = applyAll
        if (!choice) {
          const result = await askConflict(name, file.name)
          choice = result.choice
          if (result.applyAll) applyAll = choice
        }
        if (choice === 'skip') {
          skipped++
          continue
        }
        if (choice === 'replace') replaceId = dupes[0].id
      }
      importedIds.push(await addImportedCard(imported, replaceId))
      warnings.push(...imported.parsed.warnings.map((w) => `${file.name}：${w}`))
    } catch (error) {
      failures.push(`${file.name}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const parts: string[] = []
  if (importedIds.length) parts.push(`导入 ${importedIds.length} 张卡`)
  if (lorebooks) parts.push(`${lorebooks} 本世界书已放进世界书库`)
  if (skipped) parts.push(`跳过 ${skipped} 张同名卡`)
  if (parts.length) toast.success(parts.join('，'))
  if (warnings.length) toast.warning('导入时自动处理了一些问题', { description: warnings.slice(0, 5).join('\n'), duration: 8000 })
  if (failures.length) toast.error(`${failures.length} 个文件导入失败`, { description: failures.slice(0, 5).join('\n'), duration: 10000 })
  return importedIds
}
