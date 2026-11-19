import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  parseCardJson,
  parseCardPng,
  serializeCardJson,
  writeCardPng,
  type ParsedCard,
} from '@/core/card/io'

/**
 * 骨架阶段的导入导出调试页：验证核心逻辑在浏览器里能跑通。
 * 正式界面（卡库、单页编辑、世界书）后续替换这里。
 */

type Loaded = ParsedCard & { fileName: string; image?: Uint8Array }

function download(data: BlobPart, fileName: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(file: File) {
    setError(null)
    try {
      if (file.name.toLowerCase().endsWith('.json')) {
        setLoaded({ ...parseCardJson(await file.text()), fileName: file.name })
      } else {
        const bytes = new Uint8Array(await file.arrayBuffer())
        setLoaded({ ...parseCardPng(bytes), fileName: file.name })
      }
    } catch (e) {
      setLoaded(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const data = loaded?.card.data

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">角色卡编辑器</h1>
        <p className="text-sm text-muted-foreground">骨架阶段 · 导入导出调试页</p>
      </header>

      <div className="flex gap-2">
        <Button onClick={() => inputRef.current?.click()}>导入角色卡（PNG / JSON）</Button>
        <input
          ref={inputRef}
          type="file"
          accept=".png,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleFile(file)
            e.target.value = ''
          }}
        />
      </div>

      {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

      {loaded && data && (
        <section className="flex flex-col gap-4 rounded-lg border p-4">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
            <dt className="text-muted-foreground">文件</dt>
            <dd>{loaded.fileName}</dd>
            <dt className="text-muted-foreground">角色名</dt>
            <dd>{data.name}</dd>
            <dt className="text-muted-foreground">原始规范</dt>
            <dd>{loaded.sourceSpec.toUpperCase()}</dd>
            <dt className="text-muted-foreground">开场白</dt>
            <dd>1 + {data.alternate_greetings.length} 条备选</dd>
            <dt className="text-muted-foreground">世界书条目</dt>
            <dd>{data.character_book?.entries.length ?? 0}</dd>
            <dt className="text-muted-foreground">描述长度</dt>
            <dd>{data.description.length} 字</dd>
          </dl>

          {loaded.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-amber-600">
              {loaded.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          <div className="flex gap-2">
            {'image' in loaded && loaded.image && (
              <Button
                variant="outline"
                onClick={() =>
                  download(
                    writeCardPng(loaded.image!, loaded.card),
                    `${data.name}.png`,
                    'image/png',
                  )
                }
              >
                导出 PNG
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() =>
                download(serializeCardJson(loaded.card), `${data.name}.json`, 'application/json')
              }
            >
              导出 JSON
            </Button>
          </div>
        </section>
      )}
    </main>
  )
}
