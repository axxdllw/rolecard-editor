/**
 * 多段 HTML 合并/细分章节（用于无目录的 EPUB、MOBI/KF8、单个 HTML 页面）。
 */
import { isChapterHeading, splitTextIntoChapters } from './chapters'
import { collapseInlineSpace, firstHeading, htmlToText } from './html'
import type { BookChapter } from './types'

/** 若某标题文字出现在正文前 200 字内，移除该行避免标题与首行重复 */
function removeHeadingFromTop(text: string, heading: string): string {
  const normHeading = collapseInlineSpace(heading)
  if (!normHeading) return text

  const lines = text.split('\n')
  let offset = 0
  for (let i = 0; i < lines.length && offset < 200; i++) {
    const line = lines[i]
    if (collapseInlineSpace(line) === normHeading) {
      lines.splice(i, 1)
      return lines.join('\n')
    }
    offset += line.length + 1
  }
  return text
}

/** 将若干 HTML 片段转成章节列表 */
export function chaptersFromHtmlParts(
  parts: Array<{ html: string; titleHint?: string }>,
): { chapters: BookChapter[]; warnings: string[] } {
  const chapters: BookChapter[] = []
  const warnings: string[] = []
  let pendingVolume: string | undefined

  for (const part of parts) {
    const rawText = htmlToText(part.html)
    if (!rawText) continue

    const lines = rawText.split('\n')
    let chapterHeadingCount = 0
    for (let i = 0; i < lines.length; i++) {
      if (isChapterHeading(lines[i]) === 'chapter') {
        chapterHeadingCount++
        if (chapterHeadingCount >= 2) break
      }
    }

    // 正文里包含 ≥ 2 个章节标题，用 splitTextIntoChapters 再细分
    if (chapterHeadingCount >= 2) {
      const sub = splitTextIntoChapters(rawText)
      for (let i = 0; i < sub.length; i++) {
        const ch = sub[i]
        // 第一个标题前的内容并入上一章；没有上一章则保留为“（开头）”
        if (i === 0 && ch.title === '（开头）' && chapters.length > 0) {
          chapters[chapters.length - 1].text = `${chapters[chapters.length - 1].text}\n${ch.text}`
          continue
        }
        if (ch.volume) {
          pendingVolume = ch.volume
        } else if (pendingVolume) {
          ch.volume = pendingVolume
        }
        chapters.push(ch)
      }
      continue
    }

    const heading = firstHeading(part.html)
    const bodyText = heading ? removeHeadingFromTop(rawText, heading) : rawText

    // 若整段只是一个孤立卷标题页，记为卷名供后续章使用，本身不生成空章
    if (!bodyText) {
      if (heading && isChapterHeading(heading) === 'volume') {
        pendingVolume = heading
      }
      continue
    }

    // 单段超长（> 5 万字）且无章标题时，交给 splitTextIntoChapters 按 8000 字切分
    if (bodyText.length > 50_000) {
      const sub = splitTextIntoChapters(bodyText)
      for (const ch of sub) {
        if (pendingVolume && !ch.volume) ch.volume = pendingVolume
        chapters.push(ch)
      }
      continue
    }

    const title = heading || part.titleHint?.trim() || `第 ${chapters.length + 1} 部分`
    const ch: BookChapter = { title, text: bodyText }
    if (pendingVolume) ch.volume = pendingVolume
    chapters.push(ch)
  }

  return { chapters, warnings }
}
