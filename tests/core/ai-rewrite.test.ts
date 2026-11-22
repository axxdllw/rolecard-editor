import { describe, expect, it } from 'vitest'
import { buildRewriteRequest, cleanRewriteOutput, matchLineEndings } from '../../src/core/ai/tasks/rewrite'

describe('字段改写提示词', () => {
  it('带上字段说明、原文、模式要求和用户补充要求', () => {
    const { system, messages } = buildRewriteRequest({
      mode: 'expand',
      instruction: '多写一些她和{{user}}的相处',
      fieldLabel: '角色描述',
      fieldHint: '每轮都会发送',
      text: '{{char}}是一名骑士。',
      context: { name: '艾琳', fields: [{ label: '性格', text: '勇敢' }, { label: '场景', text: '' }] },
    })
    expect(system).toContain('{{char}}')
    expect(messages).toHaveLength(1)
    const prompt = messages[0].content
    expect(prompt).toContain('角色名：艾琳')
    expect(prompt).toContain('<性格>\n勇敢\n</性格>')
    // 空字段不带进上下文
    expect(prompt).not.toContain('<场景>')
    expect(prompt).toContain('# 要修改的字段：角色描述\n字段作用：每轮都会发送')
    expect(prompt).toContain('<原文>\n{{char}}是一名骑士。\n</原文>')
    expect(prompt).toContain('扩写')
    expect(prompt).toContain('用户的要求：多写一些她和{{user}}的相处')
  })

  it('参考字段过长时截断', () => {
    const long = '字'.repeat(5000)
    const { messages } = buildRewriteRequest({
      mode: 'polish',
      fieldLabel: '场景',
      text: '原文',
      context: { name: 'A', fields: [{ label: '角色描述', text: long }] },
    })
    expect(messages[0].content).toContain('后面省略 1000 字')
  })

  it('字段为空时说明是空的', () => {
    const { messages } = buildRewriteRequest({ mode: 'write', fieldLabel: '场景', text: '' })
    expect(messages[0].content).toContain('# 字段原文\n（空）')
  })
})

describe('清理改写输出', () => {
  it('去掉整段代码块和首尾空行', () => {
    expect(cleanRewriteOutput('```yaml\nname: 艾琳\n```')).toBe('name: 艾琳')
    expect(cleanRewriteOutput('\n\n正文\n第二行\n\n')).toBe('正文\n第二行')
  })

  it('去掉模型照抄的 <原文> 标签', () => {
    expect(cleanRewriteOutput('<原文>\n新的内容\n</原文>')).toBe('新的内容')
  })

  it('正文中间的代码块不动', () => {
    const text = '说明\n```\ncode\n```\n结尾'
    expect(cleanRewriteOutput(text)).toBe(text)
  })
})

describe('换行符跟原文一致', () => {
  it('原文用 \r\n 时把输出转成 \r\n', () => {
    expect(matchLineEndings('a\nb\r\nc', 'x\r\ny')).toBe('a\r\nb\r\nc')
  })

  it('原文用 \n 或为空时统一成 \n', () => {
    expect(matchLineEndings('a\r\nb', 'x\ny')).toBe('a\nb')
    expect(matchLineEndings('a\r\nb', '')).toBe('a\nb')
  })
})
