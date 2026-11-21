import { describe, expect, it } from 'vitest'
import type { Lorebook } from '../../src/core/card/types'
import { applyRegexScripts, finishHtml, prepareForMarkdown, receiveMessage, wrapQuotes } from '../../src/core/render/display'
import { isFrontend, replaceVhInContent } from '../../src/core/render/frontend'
import { initVariablesFromBook } from '../../src/core/render/initvar'
import { createRegexScript, type RegexScript } from '../../src/core/regex/regex'

const ctx = { char: '弗洛洛', user: '我' }

function script(patch: Partial<RegexScript>): RegexScript {
  return { ...createRegexScript(), ...patch }
}

describe('正则分阶段运行', () => {
  const permanent = script({ findRegex: '/A/g', replaceString: 'B', placement: [2] })
  const displayOnly = script({ findRegex: '/A/g', replaceString: 'D', placement: [2], markdownOnly: true })
  const promptOnly = script({ findRegex: '/A/g', replaceString: 'P', placement: [2], promptOnly: true })

  it('收到时只跑两个“仅”都没勾的脚本', () => {
    expect(applyRegexScripts('A', [displayOnly, promptOnly, permanent], { placement: 2, stage: 'receive', ctx })).toBe('B')
  })

  it('显示时只跑“仅格式显示”的脚本', () => {
    expect(applyRegexScripts('A', [permanent, promptOnly, displayOnly], { placement: 2, stage: 'display', ctx })).toBe('D')
  })

  it('按位置过滤：AI 输出的脚本不作用于用户消息', () => {
    expect(applyRegexScripts('A', [displayOnly], { placement: 1, stage: 'display', ctx })).toBe('A')
  })

  it('按深度过滤，与酒馆的边界一致', () => {
    const recent = script({ findRegex: '/A/g', replaceString: 'R', placement: [2], markdownOnly: true, maxDepth: 1 })
    const old = script({ findRegex: '/A/g', replaceString: 'O', placement: [2], markdownOnly: true, minDepth: 2 })
    const run = (depth: number) => applyRegexScripts('A', [recent, old], { placement: 2, stage: 'display', depth, ctx })
    expect(run(0)).toBe('R')
    expect(run(1)).toBe('R')
    expect(run(2)).toBe('O')
  })

  it('禁用的脚本不运行', () => {
    expect(applyRegexScripts('A', [{ ...displayOnly, disabled: true }], { placement: 2, stage: 'display', ctx })).toBe('A')
  })

  it('收到消息时先替换宏再跑正则', () => {
    const s = script({ findRegex: '/弗洛洛/g', replaceString: '[{{match}}]', placement: [2] })
    expect(receiveMessage({ name: '弗洛洛', isUser: false, text: '你好，{{char}}' }, [s], ctx)).toBe('你好，[弗洛洛]')
  })
})

describe('格式化细节', () => {
  it('引号包进 <q>，标签属性里的引号不动', () => {
    expect(wrapQuotes('她说"你好"，<span class="a">「嗯」</span>')).toBe('她说<q>"你好"</q>，<span class="a"><q>「嗯」</q></span>')
  })

  it('代码块和 <style> 里的引号不处理', () => {
    const text = '```\n"x"\n```\n<style>.a::after{content:"x"}</style>'
    expect(wrapQuotes(text)).toBe(text)
  })

  it('显示前处理：先跑显示正则再包引号；代码里的空格和下划线原样保留', () => {
    const s = script({ findRegex: '/<say>(.*?)<\\/say>/g', replaceString: '"$1"', placement: [2], markdownOnly: true })
    expect(prepareForMarkdown('<say>早</say>', { isUser: false, depth: 0, scripts: [s], ctx })).toBe('<q>"早"</q>')
    const code = '```html\n<script>a.stat_data; typeof _ * 2</script>\n```'
    expect(prepareForMarkdown(code, { isUser: false, depth: 0, scripts: [], ctx })).toBe(code)
  })

  it('代码里的 &amp; 还原，行首角色名保留', () => {
    expect(finishHtml('<code>a &amp;&amp; b</code>')).toBe('<code>a && b</code>')
    expect(finishHtml('弗洛洛: 你好')).toBe('弗洛洛: 你好')
  })
})

describe('前端代码块', () => {
  it('识别规则与酒馆助手一致', () => {
    expect(isFrontend('<!DOCTYPE html><html>')).toBe(true)
    expect(isFrontend('<body>')).toBe(true)
    expect(isFrontend('<head>')).toBe(true)
    expect(isFrontend('<div>普通 HTML</div>')).toBe(false)
  })

  it('min-height 的 vh 换成预览区高度变量', () => {
    expect(replaceVhInContent('.a{min-height:100vh}')).toBe('.a{min-height:var(--TH-viewport-height)}')
    expect(replaceVhInContent('<div style="min-height: 50vh">')).toBe('<div style="min-height: calc(var(--TH-viewport-height) * 0.5)">')
    expect(replaceVhInContent("el.style.minHeight = '80vh'")).toBe("el.style.minHeight = 'calc(var(--TH-viewport-height) * 0.8)'")
    expect(replaceVhInContent('.a{height:100vh}')).toBe('.a{height:100vh}')
  })
})

describe('MVU 初始变量', () => {
  const book: Lorebook = {
    name: 'test',
    entries: [
      { keys: [], content: '系统:\n  当前日期: 第1天\n  金钱: 5000\n', comment: '[initvar]变量初始化勿开', enabled: false, insertion_order: 0, extensions: {} },
      { keys: [], content: '{"系统": {"金钱": 100}, "角色": {"好感": 0}}', comment: '[InitVar]补充', enabled: false, insertion_order: 0, extensions: {} },
      { keys: ['x'], content: '无关条目', comment: '普通条目', enabled: true, insertion_order: 0, extensions: {} },
      { keys: [], content: 'a: [1, 2', comment: '[initvar]坏的', enabled: false, insertion_order: 0, extensions: {} },
    ],
    extensions: {},
  }

  it('YAML 和 JSON 都能解析，按顺序深度合并', () => {
    const result = initVariablesFromBook(book)
    expect(result.data).toEqual({ 系统: { 当前日期: '第1天', 金钱: 100 }, 角色: { 好感: 0 } })
    expect(result.sources).toEqual(['[initvar]变量初始化勿开', '[InitVar]补充'])
    expect(result.errors).toHaveLength(1)
  })
})
