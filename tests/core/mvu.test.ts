import { describe, expect, it } from 'vitest'
import type { Lorebook } from '../../src/core/card/types'
import { describeCommand, toPathSegments } from '../../src/core/mvu/commands'
import { diffVariables, getAtPath, jsonPointer, previewValue } from '../../src/core/mvu/diff'
import { readFloors, readMvuInit, readMvuUpdate, statData } from '../../src/core/mvu/records'
import { buildSampleUpdate, numericFields } from '../../src/core/mvu/sample'
import { findJsonError, inspectInitvar } from '../../src/core/render/initvar'

describe('变量差异', () => {
  it('按路径列出新增、删除和改动', () => {
    const before = { 主角: { 修为: { 当前: 0, 最大: 0 }, 姓名: '林曦' }, 旧字段: 1 }
    const after = { 主角: { 修为: { 当前: 10, 最大: 0 }, 姓名: '林曦', 功法: { 名称: '混元诀' } } }
    expect(diffVariables(before, after)).toEqual([
      { path: ['主角', '修为', '当前'], kind: 'changed', before: 0, after: 10 },
      { path: ['主角', '功法'], kind: 'added', after: { 名称: '混元诀' } },
      { path: ['旧字段'], kind: 'removed', before: 1 },
    ])
  })

  it('标出类型变化（强制转换）', () => {
    expect(diffVariables({ a: '10' }, { a: 10 })).toEqual([{ path: ['a'], kind: 'changed', before: '10', after: 10, typeChanged: true }])
  })

  it('长度相同的数组逐项比较，长度不同整体比较', () => {
    expect(diffVariables({ 好感: [5, '描述'] }, { 好感: [8, '描述'] })).toEqual([{ path: ['好感', '0'], kind: 'changed', before: 5, after: 8 }])
    expect(diffVariables({ 列表: ['a'] }, { 列表: ['a', 'b'] })).toEqual([{ path: ['列表'], kind: 'changed', before: ['a'], after: ['a', 'b'] }])
  })

  it('相同时没有改动，可忽略顶层键', () => {
    expect(diffVariables({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 2 }] } })).toEqual([])
    expect(diffVariables({ a: 1, $internal: {} }, { a: 1 }, { ignoreTopKeys: ['$internal'] })).toEqual([])
  })

  it('路径写成 JSON Pointer，取值', () => {
    expect(jsonPointer(['主角', 'a/b', 'c~d'])).toBe('/主角/a~1b/c~0d')
    expect(getAtPath({ a: [{ b: 3 }] }, ['a', '0', 'b'])).toBe(3)
    expect(getAtPath({ a: 1 }, ['a', 'b'])).toBeUndefined()
    expect(previewValue('x'.repeat(10), 5)).toBe('"xxxx…')
    expect(previewValue(undefined)).toBe('（无）')
  })
})

describe('更新命令', () => {
  const patch = (op: Record<string, unknown>, type: string, args: string[]) => ({ type, fullMatch: JSON.stringify(op), args, reason: 'json_patch' })

  it('JSONPatch 显示原始 op 和路径', () => {
    const op = { op: 'delta', path: '/主角/修为/当前', value: 10 }
    expect(describeCommand(patch(op, 'add', ['["主角"]["修为"]["当前"]', '10']))).toEqual({ op: 'delta', path: '/主角/修为/当前', value: '10', patch: true })
    const move = { op: 'move', from: '/a', path: '/b' }
    expect(describeCommand(patch(move, 'move', ['["a"]', '["b"]']))).toEqual({ op: 'move', path: '/b', from: '/a', patch: true })
    const remove = { op: 'remove', path: '/物品栏/铁剑' }
    expect(describeCommand(patch(remove, 'delete', ['["物品栏"]["铁剑"]']))).toEqual({ op: 'remove', path: '/物品栏/铁剑', patch: true })
  })

  it('旧式命令按参数显示', () => {
    expect(describeCommand({ type: 'set', fullMatch: "_.set('角色.络络.好感度', 1, 2);//变化", args: ["'角色.络络.好感度'", '1', '2'], reason: '变化' })).toEqual({
      op: '_.set',
      path: '/角色/络络/好感度',
      value: '2',
      patch: false,
    })
    expect(describeCommand({ type: 'insert', fullMatch: '', args: ['物品栏', '"铁剑"', '{"数量":1}'], reason: '' })).toEqual({
      op: '_.insert',
      path: '/物品栏/铁剑',
      value: '{"数量":1}',
      patch: false,
    })
    expect(describeCommand({ type: 'delete', fullMatch: '', args: ['a.b'], reason: '' })).toEqual({ op: '_.delete', path: '/a/b', patch: false })
  })

  it('拆分 lodash 风格路径', () => {
    expect(toPathSegments('a.b[0].c')).toEqual(['a', 'b', '0', 'c'])
    expect(toPathSegments('["a.b"]["c"]')).toEqual(['a.b', 'c'])
    expect(toPathSegments("'stat_data.主角.寿命'")).toEqual(['主角', '寿命'])
  })
})

describe('示例更新命令', () => {
  const stat = { $meta: { n: 1 }, _隐藏: 3, 主角: { 姓名: '林曦', 修为: { 当前: 0, 最大: 100 }, 好感: [5, '描述'] }, 资源: { 灵石: 2 } }

  it('按顺序取数值字段，跳过 $ 和 _ 开头的键', () => {
    expect(numericFields(stat)).toEqual([
      ['主角', '修为', '当前'],
      ['主角', '修为', '最大'],
      ['主角', '好感', '0'],
      ['资源', '灵石'],
    ])
  })

  it('生成 JSONPatch 的 delta 示例', () => {
    const sample = buildSampleUpdate(stat, { limit: 2 })!
    expect(sample.startsWith('<UpdateVariable>\n<JSONPatch>\n')).toBe(true)
    const ops = JSON.parse(sample.match(/<JSONPatch>([\s\S]*)<\/JSONPatch>/)![1])
    expect(ops).toEqual([
      { op: 'delta', path: '/主角/修为/当前', value: 1 },
      { op: 'delta', path: '/主角/修为/最大', value: 1 },
    ])
  })

  it('没有数值字段时返回 null', () => {
    expect(buildSampleUpdate({ a: 'x' })).toBeNull()
  })
})

describe('[initvar] 检查', () => {
  const book = (entries: Array<{ comment: string; content: string; enabled?: boolean }>): Lorebook => ({
    entries: entries.map((e) => ({ keys: [], insertion_order: 0, extensions: {}, enabled: e.enabled ?? false, ...e })),
    extensions: {},
  })

  it('YAML 正常读取，非 [initvar] 条目不算', () => {
    const [report, ...rest] = inspectInitvar(book([{ comment: '[initvar]初始', content: '主角:\n  修为: 0\n' }, { comment: '普通', content: 'x' }]))
    expect(rest).toHaveLength(0)
    expect(report).toMatchObject({ title: '[initvar]初始', enabled: false, format: 'yaml', data: { 主角: { 修为: 0 } }, errors: [], bodyLine: 1 })
  })

  it('YAML 错误给出原文中的行号，并保留尽量读出的部分', () => {
    const content = '<initvar>\n```yaml\na: 1\nb: [1, 2\nc: 3\n```\n</initvar>'
    const [report] = inspectInitvar(book([{ comment: '[InitVar]', content }]))
    expect(report.body).toBe('a: 1\nb: [1, 2\nc: 3')
    expect(report.bodyLine).toBe(3)
    expect(report.errors[0].line).toBe(5)
    expect(report.errors[0].message).toContain('缩进不对')
    expect(report.data).toMatchObject({ a: 1 })
  })

  it('JSON 正常读取；不标准时给警告，读不了时给错误位置', () => {
    const [ok, loose, bad] = inspectInitvar(
      book([
        { comment: '[initvar]a', content: '{"a": 1}' },
        { comment: '[initvar]b', content: '{"a": 1,}' },
        { comment: '[initvar]c', content: '{\n  "a": 1\n  "b": 2\n}' },
      ]),
    )
    expect(ok).toMatchObject({ format: 'json', data: { a: 1 }, errors: [], warnings: [] })
    expect(loose.errors).toEqual([])
    expect(loose.warnings[0]).toMatchObject({ line: 1, col: 9 })
    expect(loose.data).toEqual({ a: 1 })
    expect(bad.data).toBeNull()
    expect(bad.errors[0]).toEqual({ line: 3, col: 3, message: '缺少逗号或 }' })
  })

  it('内容不是键值结构时报错', () => {
    const [report] = inspectInitvar(book([{ comment: '[initvar]', content: '- 1\n- 2' }]))
    expect(report.errors[0].message).toBe('内容不是键值结构')
  })
})

describe('JSON 语法检查', () => {
  it.each([
    ['{"a": [1, 2]}', null],
    ['{"a": 1,}', '最后一项后面多了逗号'],
    ["{'a': 1}", '属性名要用双引号括起来'],
    ['{"a" 1}', '属性名后面缺少冒号'],
    ['{"a": "x', '字符串没有结束，缺少右引号'],
    ['[1, 2', '数组没有结束，缺少 ]'],
    ['{"a": 01}', '缺少逗号或 }'],
    ['{"a": tru}', '无法识别的值（以「t」开头）'],
    ['{} x', '后面有多余的内容'],
    ['{"a": "\\q"}', '无效的转义字符'],
  ])('%s', (input, message) => {
    expect(findJsonError(input)?.message ?? null).toBe(message)
  })
})

describe('宿主页记录', () => {
  it('检查更新记录的字段', () => {
    const record = readMvuUpdate({
      messageId: '2',
      zod: true,
      commands: [{ type: 'add', fullMatch: '{}', args: ['a', 1], reason: 'json_patch', status: 'failed', error: '原因' }, 'x', { type: 'set', status: 'weird' }],
      before: { a: 1 },
      after: { a: 2 },
      errors: ['e', 3],
    })
    expect(record).toEqual({
      messageId: 2,
      zod: true,
      commands: [
        { type: 'add', fullMatch: '{}', args: ['a', '1'], reason: 'json_patch', status: 'failed', error: '原因' },
        { type: 'set', fullMatch: '', args: [], reason: '', status: 'noop' },
      ],
      before: { a: 1 },
      after: { a: 2 },
      errors: ['e', '3'],
    })
    expect(readMvuUpdate(null)).toBeNull()
  })

  it('检查初始化记录和楼层', () => {
    expect(readMvuInit({ zod: true, issues: [{ path: ['主角', 1], message: 'm', input: '"x"' }, 5], before: {}, after: {} })).toEqual({
      swipeId: 0,
      zod: true,
      before: {},
      after: {},
      issues: [{ path: ['主角', '1'], message: 'm', input: '"x"' }],
    })
    expect(readFloors([{ messageId: 0, variables: { stat_data: { a: 1 } } }, { messageId: 'x' }, null])).toEqual([
      { messageId: 0, isUser: false, variables: { stat_data: { a: 1 } } },
    ])
    expect(statData({ stat_data: { a: 1 }, schema: {} })).toEqual({ a: 1 })
    expect(statData({ a: 1 })).toEqual({ a: 1 })
  })
})
