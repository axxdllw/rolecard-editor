/**
 * 从模型输出中提取 JSON。
 * 模型有时会在 JSON 外面包一层代码块、附带解释文字，或在对象/数组末尾多写一个逗号，这里统一容错处理。
 */
import { AiError } from './types'

const BAD_JSON_MESSAGE = '模型返回的内容不是有效的 JSON，可以重新生成试试'

/** 扫描外层括号时最多尝试的起点数，避免异常长文本退化 */
const MAX_SCAN_ATTEMPTS = 100

/**
 * 去掉对象/数组末尾多余的逗号（如 [1, 2,]、{"a": 1,}）。
 * 扫描时跳过双引号字符串和转义字符，避免误改字符串内容。
 */
function stripTrailingCommas(json: string): string {
  let out = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < json.length; i++) {
    const ch = json[i]
    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      continue
    }

    if (ch === ',') {
      let nextIndex = i + 1
      while (nextIndex < json.length && (json[nextIndex] === ' ' || json[nextIndex] === '\t' || json[nextIndex] === '\n' || json[nextIndex] === '\r')) {
        nextIndex++
      }
      const next = json[nextIndex]
      if (next === '}' || next === ']') {
        continue
      }
    }

    out += ch
  }

  return out
}

/**
 * 从指定的 `{` 或 `[` 开始，找到与之配对的闭合 `}` 或 `]` 并返回切片。
 * 忽略字符串字面量内部的括号和转义字符。
 */
function findMatchingSlice(text: string, start: number): string | null {
  const open = text[start]
  if (open !== '{' && open !== '[') return null

  const stack: string[] = [open === '{' ? '}' : ']']
  let inString = false
  let escaped = false

  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      stack.push('}')
    } else if (ch === '[') {
      stack.push(']')
    } else if (ch === '}' || ch === ']') {
      if (stack[stack.length - 1] !== ch) return null
      stack.pop()
      if (stack.length === 0) {
        return text.slice(start, i + 1)
      }
    }
  }

  return null
}

function tryParseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(stripTrailingCommas(raw)) }
  } catch {
    return { ok: false }
  }
}

/** 从一段文本里依次尝试提取最外层 `{...}` 或 `[...]` 并解析 */
function tryExtractFromText(text: string): { ok: true; value: unknown } | { ok: false } {
  const direct = tryParseJson(text)
  if (direct.ok) return direct

  let attempts = 0
  for (let i = 0; i < text.length && attempts < MAX_SCAN_ATTEMPTS; i++) {
    const ch = text[i]
    if (ch !== '{' && ch !== '[') continue
    attempts++
    const slice = findMatchingSlice(text, i)
    if (!slice) continue
    const parsed = tryParseJson(slice)
    if (parsed.ok) return parsed
  }

  return { ok: false }
}

/** 提取文本里的 Markdown 代码块内容（优先 json 代码块） */
function extractCodeBlocks(text: string): string[] {
  const jsonBlocks: string[] = []
  const otherBlocks: string[] = []
  const pattern = /(?:^|\r?\n)[ \t]*```([^\r\n]*)\r?\n([\s\S]*?)\r?\n?[ \t]*```(?=[ \t]*(?:\r?\n|$))/g

  for (const match of text.matchAll(pattern)) {
    const lang = match[1].trim().toLowerCase()
    const body = match[2].trim()
    if (!body) continue
    if (lang === 'json' || lang === 'jsonc') {
      jsonBlocks.push(body)
    } else {
      otherBlocks.push(body)
    }
  }

  return [...jsonBlocks, ...otherBlocks]
}

/**
 * 从模型输出里取出并解析 JSON。
 * 支持去掉 ```json 代码块包裹、前后说明文字，并容忍对象/数组末尾多余逗号。
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) {
    throw new AiError('bad_output', BAD_JSON_MESSAGE)
  }

  // 1. 本身就是完整 JSON（含末尾逗号容错）时直接返回，避免误切字符串里的反引号
  const direct = tryParseJson(trimmed)
  if (direct.ok) return direct.value

  // 2. 优先尝试从代码块里提取，避免前文说明里的中括号/花括号干扰
  for (const block of extractCodeBlocks(trimmed)) {
    const parsed = tryExtractFromText(block)
    if (parsed.ok) return parsed.value
  }

  // 3. 回退到在全文里查找配对的 {...} 或 [...]
  const fromFull = tryExtractFromText(trimmed)
  if (fromFull.ok) return fromFull.value

  throw new AiError('bad_output', BAD_JSON_MESSAGE)
}
