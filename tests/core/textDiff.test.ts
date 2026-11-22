import { describe, expect, it } from 'vitest'
import { diffText } from '../../src/core/text/textDiff'

describe('文本差异', () => {
  it('改动的行做行内对比，远处未改动的行折叠', () => {
    const before = ['第一行', '第二行', '第三行', '第四行', '他是一个勇敢的骑士', '第六行'].join('\n')
    const after = ['第一行', '第二行', '第三行', '第四行', '她是一个勇敢的骑士', '第六行'].join('\n')
    const diff = diffText(before, after, { context: 1 })
    expect(diff.tooLarge).toBe(false)
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(diff.rows.map((r) => r.type)).toEqual(['skip', 'same', 'edit', 'same'])
    const edit = diff.rows[2]
    if (edit.type !== 'edit') throw new Error('应为行内对比')
    expect(edit.segments.filter((s) => s.type === 'del').map((s) => s.text).join('')).toContain('他')
    expect(edit.segments.filter((s) => s.type === 'ins').map((s) => s.text).join('')).toContain('她')
    // 拼回去分别等于前后文本
    expect(edit.segments.filter((s) => s.type !== 'ins').map((s) => s.text).join('')).toBe('他是一个勇敢的骑士')
    expect(edit.segments.filter((s) => s.type !== 'del').map((s) => s.text).join('')).toBe('她是一个勇敢的骑士')
  })

  it('只增不删时逐行列出新增', () => {
    const diff = diffText('a\nb', 'a\nb\nc\nd')
    expect(diff.rows).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
      { type: 'ins', text: 'c' },
      { type: 'ins', text: 'd' },
    ])
    expect(diff.added).toBe(2)
  })

  it('只折叠一行时直接显示', () => {
    const diff = diffText('x\na\nb', 'x\na\nB', { context: 1 })
    expect(diff.rows[0]).toEqual({ type: 'same', text: 'x' })
  })

  it('改动太大放弃行内对比，退回整行删除和新增', () => {
    const before = 'a'.repeat(50)
    const after = 'b'.repeat(50)
    const diff = diffText(before, after, { inlineLimit: 10 })
    expect(diff.rows).toEqual([
      { type: 'del', text: before },
      { type: 'ins', text: after },
    ])
  })
})

describe('换行符差异', () => {
  it('\r\n 和 \n 的同一段文字不算改动', () => {
    const diff = diffText('甲\r\n乙\r\n丙', '甲\n乙\n丁')
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
  })
})
