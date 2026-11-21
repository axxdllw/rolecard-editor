import { describe, expect, it } from 'vitest'
import { enabledHelperScripts, helperCharacterVariables, usesMvu } from '../../src/core/render/helperScripts'

const mvu = { type: 'script', enabled: true, name: 'MVU', id: 'a', content: "import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js'", info: '', button: { enabled: true, buttons: [{ name: '重新处理变量', visible: true }] }, data: {} }

describe('读取酒馆助手角色脚本', () => {
  it('新格式：只取启用的脚本，关闭的文件夹里的脚本不运行', () => {
    const ext = {
      tavern_helper: {
        scripts: [
          mvu,
          { type: 'script', enabled: false, name: '关闭的', id: 'b', content: 'x' },
          { type: 'script', name: '没写 enabled', id: 'c', content: 'x' },
          { type: 'folder', enabled: false, name: '关闭的文件夹', scripts: [{ type: 'script', enabled: true, name: '里面', id: 'd', content: 'x' }] },
          { type: 'folder', enabled: true, name: '文件夹', scripts: [{ type: 'script', enabled: true, name: '变量结构', id: 'e', content: 'y' }] },
        ],
        variables: { foo: 1 },
      },
    }
    const scripts = enabledHelperScripts(ext)
    expect(scripts.map((s) => s.name)).toEqual(['MVU', '变量结构'])
    expect(scripts[0].button.buttons).toEqual([{ name: '重新处理变量', visible: true }])
    expect(helperCharacterVariables(ext)).toEqual({ foo: 1 })
    expect(usesMvu(scripts)).toBe(true)
  })

  it('新格式也可能存成 [key, value] 数组', () => {
    const ext = { tavern_helper: [['scripts', [mvu]], ['variables', { bar: 2 }]] }
    expect(enabledHelperScripts(ext).map((s) => s.id)).toEqual(['a'])
    expect(helperCharacterVariables(ext)).toEqual({ bar: 2 })
  })

  it('旧格式：TavernHelper_scripts 的 value 里才有 enabled，按钮默认启用', () => {
    const ext = {
      TavernHelper_scripts: [
        { type: 'script', value: { id: 'o1', name: '旧脚本', content: 'z', enabled: true, buttons: [{ name: '按钮', visible: true }] } },
        { type: 'script', value: { id: 'o2', name: '旧的关闭脚本', content: 'z', enabled: false } },
        { type: 'folder', name: '旧文件夹', value: [{ id: 'o3', name: '文件夹里的', content: 'z', enabled: true }] },
      ],
      TavernHelper_characterScriptVariables: { old: true },
    }
    const scripts = enabledHelperScripts(ext)
    expect(scripts.map((s) => s.name)).toEqual(['旧脚本', '文件夹里的'])
    expect(scripts[0].button).toEqual({ enabled: true, buttons: [{ name: '按钮', visible: true }] })
    expect(helperCharacterVariables(ext)).toEqual({ old: true })
    expect(usesMvu(scripts)).toBe(false)
  })

  it('没有脚本时返回空', () => {
    expect(enabledHelperScripts(undefined)).toEqual([])
    expect(enabledHelperScripts({ tavern_helper: { scripts: [] } })).toEqual([])
    expect(helperCharacterVariables({})).toEqual({})
  })
})
