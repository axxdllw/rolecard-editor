import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BOOK_ACCEPT,
  BookError,
  isBookArchive,
  parseBook,
  parseBookInArchive,
  type ParsedBook,
} from '../../src/core/book'

const LOCAL_BOOK_DIR = process.env.LOCAL_BOOK_DIR ?? ''
const HAS_LOCAL_DIR =
  LOCAL_BOOK_DIR.length > 0 && existsSync(LOCAL_BOOK_DIR) && statSync(LOCAL_BOOK_DIR).isDirectory()

const TARGET_EXTENSIONS = new Set([
  ...BOOK_ACCEPT.split(',').map((ext) => ext.trim().toLowerCase()),
  '.kfx',
  '.pdf',
])

interface ScanEntry {
  fullPath: string
  fileName: string
  ext: string
  sizeBytes: number
}

interface SummaryRow {
  index: number
  shortName: string
  ext: string
  sizeMb: string
  outcome: string
  elapsedMs: number
  groupKey: string
  ok: boolean
}

function scanBookFiles(rootDir: string): ScanEntry[] {
  const out: ScanEntry[] = []

  const walk = (dir: string) => {
    const items = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const item of items) {
      const fullPath = join(dir, item.name)
      if (item.isDirectory()) {
        // 跳过 Kindle 阅读进度目录（*.sdr）
        if (item.name.toLowerCase().endsWith('.sdr')) continue
        walk(fullPath)
        continue
      }
      if (!item.isFile()) continue
      const ext = extname(item.name).toLowerCase()
      if (!TARGET_EXTENSIONS.has(ext)) continue
      const st = statSync(fullPath)
      out.push({
        fullPath,
        fileName: item.name,
        ext,
        sizeBytes: st.size,
      })
    }
  }

  walk(rootDir)
  return out
}

function summarizeParsedBook(book: ParsedBook): {
  totalChars: number
  volumeCount: number
  desc: string
} {
  let totalChars = 0
  const volumes = new Set<string>()
  for (const ch of book.chapters) {
    totalChars += ch.text.length
    if (ch.volume) volumes.add(ch.volume)
  }
  const encPart = book.encoding ? ` / ${book.encoding}` : ''
  const desc = `${book.format} / ${book.chapters.length}章 / ${totalChars}字 / ${volumes.size}卷 / ${book.warnings.length}警告${encPart}`
  return { totalChars, volumeCount: volumes.size, desc }
}

function truncateFileName(name: string): string {
  return Array.from(name).slice(0, 12).join('')
}

describe.skipIf(!HAS_LOCAL_DIR)('本机电子书批量解析回归', () => {
  it(
    '批量解析 LOCAL_BOOK_DIR 下所有电子书（不输出书名、作者、标题、正文）',
    () => {
      const files = scanBookFiles(LOCAL_BOOK_DIR)
      const rows: SummaryRow[] = []
      const byFormat = new Map<string, { ok: number; fail: number; totalMs: number }>()

      const recordStat = (key: string, ok: boolean, ms: number) => {
        const cur = byFormat.get(key) ?? { ok: 0, fail: 0, totalMs: 0 }
        if (ok) cur.ok++
        else cur.fail++
        cur.totalMs += ms
        byFormat.set(key, cur)
      }

      const verifyBook = (book: ParsedBook) => {
        expect(book.chapters.length).toBeGreaterThanOrEqual(1)
        const totalChars = book.chapters.reduce((sum, ch) => sum + ch.text.length, 0)
        expect(totalChars).toBeGreaterThan(0)
      }

      let seq = 0
      for (const file of files) {
        seq++
        const sizeMb = (file.sizeBytes / (1024 * 1024)).toFixed(2)
        const shortName = truncateFileName(file.fileName)
        const start = performance.now()

        let bytes: Uint8Array
        try {
          bytes = new Uint8Array(readFileSync(file.fullPath))
        } catch {
          const elapsedMs = Math.round(performance.now() - start)
          rows.push({
            index: seq,
            shortName,
            ext: file.ext,
            sizeMb,
            outcome: 'read-error',
            elapsedMs,
            groupKey: file.ext,
            ok: false,
          })
          recordStat(file.ext, false, elapsedMs)
          continue
        }

        try {
          const result = parseBook(bytes, file.fileName)
          if (isBookArchive(result)) {
            let okEntries = 0
            let errEntries = 0
            let totalChapters = 0
            let totalChars = 0

            for (const entry of result.entries) {
              try {
                const sub = parseBookInArchive(bytes, entry.path)
                verifyBook(sub)
                okEntries++
                totalChapters += sub.chapters.length
                totalChars += sub.chapters.reduce((sum, c) => sum + c.text.length, 0)
              } catch (subErr) {
                if (!(subErr instanceof BookError)) {
                  const errType = subErr instanceof Error ? subErr.name : typeof subErr
                  expect.fail(`文件 #${seq} (${file.ext}) 压缩包内条目抛出了非 BookError：${errType}`)
                }
                errEntries++
              }
            }

            const elapsedMs = Math.round(performance.now() - start)
            const outcome = `zip(${result.entries.length}本: 成功${okEntries}/失败${errEntries}) / ${totalChapters}章 / ${totalChars}字`
            rows.push({
              index: seq,
              shortName,
              ext: file.ext,
              sizeMb,
              outcome,
              elapsedMs,
              groupKey: 'zip',
              ok: errEntries === 0,
            })
            recordStat('zip', errEntries === 0, elapsedMs)
          } else {
            verifyBook(result)
            const elapsedMs = Math.round(performance.now() - start)
            const info = summarizeParsedBook(result)
            rows.push({
              index: seq,
              shortName,
              ext: file.ext,
              sizeMb,
              outcome: info.desc,
              elapsedMs,
              groupKey: result.format,
              ok: true,
            })
            recordStat(result.format, true, elapsedMs)
          }
        } catch (err) {
          if (!(err instanceof BookError)) {
            const errType = err instanceof Error ? err.name : typeof err
            expect.fail(`文件 #${seq} (${file.ext}) 抛出了非 BookError：${errType}`)
          }
          const elapsedMs = Math.round(performance.now() - start)
          const outcome = `[${err.kind}] ${err.message}`
          rows.push({
            index: seq,
            shortName,
            ext: file.ext,
            sizeMb,
            outcome,
            elapsedMs,
            groupKey: file.ext,
            ok: false,
          })
          recordStat(file.ext, false, elapsedMs)
        }
      }

      // 输出脱敏汇总表（严禁包含书名、作者、章节标题、正文）
      const lines: string[] = [
        `=== 本机电子书解析汇总（共 ${rows.length} 个文件） ===`,
        '序号 | 文件名(前12字) | 扩展名 | 大小(MB) | 结果 | 耗时(ms)',
      ]
      for (const r of rows) {
        lines.push(`${r.index} | ${r.shortName} | ${r.ext} | ${r.sizeMb} | ${r.outcome} | ${r.elapsedMs}`)
      }
      lines.push('--- 按格式合计 ---')
      for (const [fmt, stat] of Array.from(byFormat.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`${fmt}: 总计 ${stat.ok + stat.fail}（成功 ${stat.ok} / 错误 ${stat.fail}），耗时 ${stat.totalMs} ms`)
      }
      console.log(lines.join('\n'))
    },
    20 * 60 * 1000,
  )
})
