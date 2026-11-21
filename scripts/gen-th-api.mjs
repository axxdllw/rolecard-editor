/**
 * 从酒馆助手（JS-Slash-Runner）的 @types 生成脚本编辑器的自动补全数据：src/features/scripts/thApi.ts
 *
 * 用法：node scripts/gen-th-api.mjs <JS-Slash-Runner 目录>
 * 例如：node scripts/gen-th-api.mjs <SillyTavern 目录>/public/scripts/extensions/third-party/JS-Slash-Runner
 *
 * 只取函数名、签名和文档注释的第一段与参数说明，不含示例代码。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = process.argv[2]
if (!root) {
  console.error('用法：node scripts/gen-th-api.mjs <JS-Slash-Runner 目录>')
  process.exit(1)
}
const typesDir = join(root, '@types')
const version = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version ?? ''

/** 只看这些全局对象的成员 */
const OBJECTS = ['tavern_events', 'iframe_events', 'Mvu', 'SillyTavern', 'EjsTemplate']
const MAX_SIGNATURE = 220

const OPEN = { '(': ')', '{': '}', '[': ']', '<': '>' }
const CLOSE = new Set([')', '}', ']', '>'])

/** 从 start 开始扫描，跳过字符串和注释，直到 depth 为 0 时遇到 stop 中的字符；返回该字符的下标 */
function scan(text, start, stop) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i)
      if (i < 0) return text.length
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++
      continue
    }
    if (depth === 0 && stop.includes(c)) return i
    if (c === '=' && text[i + 1] === '>') {
      i++
      continue
    }
    if (c in OPEN) depth++
    else if (CLOSE.has(c)) depth--
    if (depth < 0) return i
  }
  return text.length
}

/** 整理 JSDoc：第一段说明 + 参数说明 + 返回值 */
function parseDoc(comment) {
  if (!comment) return ''
  const lines = comment
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\* ?/, '').trimEnd())
  const summary = []
  let i = 0
  for (; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('@')) break
    if (!line) {
      if (summary.length) break
      continue
    }
    summary.push(line)
  }
  const tags = []
  let current = null
  for (const raw of lines.slice(i)) {
    const line = raw.trim()
    const m = /^@(param|returns?|throws)\s*(.*)$/.exec(line)
    if (m) {
      current = { tag: m[1], text: m[2] }
      tags.push(current)
    } else if (line.startsWith('@')) {
      current = null
    } else if (current && line) {
      current.text += ` ${line}`
    } else if (!line) {
      current = null
    }
  }
  const parts = [summary.join(' ')]
  for (const t of tags) {
    if (t.tag === 'param') {
      const pm = /^(?:\{[^}]*\}\s*)?(\S+)\s*(.*)$/.exec(t.text)
      if (pm) parts.push(`- ${pm[1]}：${pm[2]}`)
    } else if (t.tag.startsWith('return')) parts.push(`返回：${t.text}`)
    else parts.push(`异常：${t.text}`)
  }
  return parts.filter(Boolean).join('\n')
}

const squash = (s) => {
  const one = s.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').replace(/,\)/g, ')').trim()
  return one.length > MAX_SIGNATURE ? `${one.slice(0, MAX_SIGNATURE)}…` : one
}

/** 紧挨在 pos 前面的 JSDoc */
function docBefore(text, pos) {
  const before = text.slice(0, pos).trimEnd()
  if (!before.endsWith('*/')) return ''
  const start = before.lastIndexOf('/**')
  return start < 0 ? '' : before.slice(start)
}

function collectFunctions(text, out) {
  const re = /declare function ([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(text))) {
    const name = m[1]
    const end = scan(text, m.index + m[0].length, ';\n')
    const signature = squash(name + text.slice(m.index + m[0].length, end))
    const doc = parseDoc(docBefore(text, m.index))
    const existing = out.get(name)
    if (existing) existing.overloads++
    else out.set(name, { name, signature, doc, overloads: 0 })
  }
}

/** 解析对象类型 { ... } 的成员；嵌套对象类型的成员放进 nested */
function parseMembers(body, prefix, objects) {
  const members = []
  let i = 0
  while (i < body.length) {
    const end = scan(body, i, ';,')
    const segment = body.slice(i, end)
    i = end + 1
    // 跳过成员前面的注释，记下最后一段 JSDoc
    let p = 0
    let comment = ''
    for (;;) {
      while (p < segment.length && /\s/.test(segment[p])) p++
      if (segment.startsWith('/*', p)) {
        const close = segment.indexOf('*/', p + 2)
        if (close < 0) break
        if (segment.startsWith('/**', p)) comment = segment.slice(p, close + 2)
        p = close + 2
      } else if (segment.startsWith('//', p)) {
        const nl = segment.indexOf('\n', p)
        p = nl < 0 ? segment.length : nl + 1
      } else break
    }
    const decl = segment.slice(p).replace(/^readonly\s+/, '')
    const m = /^([A-Za-z_$][\w$]*)\??\s*([:(<])/.exec(decl)
    if (!m) continue
    const name = m[1]
    const rest = decl.slice(m[1].length).replace(/^\?/, '').trim()
    let signature
    if (m[2] === ':') {
      const type = rest.slice(1).trim()
      if (type.startsWith('{')) {
        const close = scan(type, 1, '}')
        parseMembers(type.slice(1, close), `${prefix}.${name}`, objects)
        signature = `${name}: {…}`
      } else {
        signature = squash(`${name}: ${type}`)
      }
    } else {
      signature = squash(`${name}${rest}`)
    }
    members.push({ name, signature, doc: parseDoc(comment) })
  }
  if (members.length) objects[prefix] = members
}

function collectObjects(text, objects) {
  for (const name of OBJECTS) {
    const m = new RegExp(`declare const ${name}\\s*:\\s*\\{`).exec(text)
    if (!m) continue
    const start = m.index + m[0].length
    const close = scan(text, start, '}')
    parseMembers(text.slice(start, close), name, objects)
  }
}

const functions = new Map()
const objects = {}
for (const dir of ['function', 'iframe']) {
  for (const file of readdirSync(join(typesDir, dir)).sort()) {
    if (!file.endsWith('.d.ts')) continue
    const text = readFileSync(join(typesDir, dir, file), 'utf8')
    collectFunctions(text, functions)
    collectObjects(text, objects)
  }
}

const fnList = [...functions.values()]
  .sort((a, b) => a.name.localeCompare(b.name))
  .map(({ name, signature, doc, overloads }) => ({ name, signature: overloads ? `${signature}（另有 ${overloads} 个重载）` : signature, doc }))

const lines = [
  '/**',
  ` * 酒馆助手 ${version} 的接口清单，用于脚本编辑器的自动补全。`,
  ' * 由 scripts/gen-th-api.mjs 从酒馆助手的 @types 生成，不要手改。',
  ' */',
  '',
  'export interface ThApiDoc {',
  '  name: string',
  '  signature: string',
  '  doc: string',
  '}',
  '',
  '/** 全局函数（脚本里可以直接调用，也挂在 TavernHelper 上） */',
  'export const TH_FUNCTIONS: ThApiDoc[] = [',
  ...fnList.map((f) => `  ${JSON.stringify(f)},`),
  ']',
  '',
  '/** 全局对象的成员，键是对象路径 */',
  'export const TH_OBJECTS: Record<string, ThApiDoc[]> = {',
  ...Object.entries(objects).flatMap(([key, list]) => [`  ${JSON.stringify(key)}: [`, ...list.map((m) => `    ${JSON.stringify(m)},`), '  ],']),
  '}',
  '',
]
const target = resolve(import.meta.dirname, '../src/features/scripts/thApi.ts')
writeFileSync(target, lines.join('\n'))
console.log(`生成 ${fnList.length} 个函数，${Object.keys(objects).length} 个对象 → ${target}`)
