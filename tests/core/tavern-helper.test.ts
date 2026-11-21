import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { parseCardPng, writeCardPng } from '../../src/core/card/io'
import type { JsonObject } from '../../src/core/card/types'
import { getTextEntries, readChunks } from '../../src/core/png/png'
import { computeDrop, flattenTree } from '../../src/core/tavern-helper/drop'
import {
  addFolder,
  addScript,
  countEnabledScripts,
  countScripts,
  duplicateNode,
  flattenScripts,
  folderIndexAfterRemoval,
  moveNode,
  readHelper,
  removeNode,
  removeStaleLegacy,
  setVariables,
  updateButtons,
  updateFolder,
  updateScript,
  upgradeLegacy,
  type HelperScript,
} from '../../src/core/tavern-helper/scripts'
import { base64ToUtf8 } from '../../src/core/util/base64'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

function newScript(id: string, extra: JsonObject = {}): JsonObject {
  return {
    type: 'script',
    enabled: true,
    name: `脚本${id}`,
    id,
    content: `console.log(${JSON.stringify(id)})`,
    info: '',
    button: { enabled: true, buttons: [{ name: '按钮', visible: true }] },
    data: { a: 1 },
    ...extra,
  }
}

/** 新格式（对象形式），带一个文件夹和一个未知字段 */
function objectExt(): JsonObject {
  return {
    regex_scripts: [],
    tavern_helper: {
      scripts: [
        newScript('s1', { export_with: 'x' }),
        { type: 'folder', enabled: true, name: '文件夹', id: 'f1', icon: 'fa-solid fa-folder', color: 'red', scripts: [newScript('s2'), newScript('s3', { enabled: false })] },
      ],
      variables: { 好感度: 5 },
      unknown_setting: true,
    },
  }
}

/** 新格式（entries 形式） */
function entriesExt(): JsonObject {
  return {
    tavern_helper: [
      ['scripts', [newScript('e1'), newScript('e2', { enabled: false })]],
      ['variables', {}],
    ],
  }
}

/** 旧格式：包装项、裸脚本数据、文件夹 */
function legacyExt(): JsonObject {
  return {
    TavernHelper_scripts: [
      { type: 'script', value: { id: 'l1', name: '旧脚本1', content: 'a()', info: '说明', buttons: [{ name: '开始', visible: true }], data: {}, enabled: false } },
      { id: 'l2', name: '裸脚本', content: 'b()', info: '', buttons: [], enabled: true },
      { type: 'folder', id: 'lf', name: '旧文件夹', icon: 'fa-solid fa-folder', color: 'blue', value: [{ id: 'l3', name: '夹内', content: 'c()', enabled: true }] },
    ],
    TavernHelper_characterScriptVariables: { 旧变量: 1 },
  }
}

describe('读取', () => {
  it('新格式对象形式：脚本树、文件夹、变量', () => {
    const view = readHelper(objectExt())
    expect(view.format).toBe('object')
    expect(view.invalid).toBeNull()
    expect(view.nodes.map((n) => n.type)).toEqual(['script', 'folder'])
    const [s1, folder] = view.nodes
    expect(s1).toMatchObject({ id: 's1', key: 's1', enabled: true, buttonEnabled: true, buttons: [{ name: '按钮', visible: true }], data: { a: 1 } })
    expect(folder).toMatchObject({ type: 'folder', enabled: true, color: 'red' })
    expect(flattenScripts(view.nodes).map((s) => [s.id, s.pos])).toEqual([
      ['s1', { index: 0 }],
      ['s2', { index: 1, child: 0 }],
      ['s3', { index: 1, child: 1 }],
    ])
    expect(view.variables).toEqual({ 好感度: 5 })
  })

  it('新格式 entries 形式', () => {
    const view = readHelper(entriesExt())
    expect(view.format).toBe('entries')
    expect(flattenScripts(view.nodes).map((s) => s.id)).toEqual(['e1', 'e2'])
    expect(view.variables).toEqual({})
  })

  it('旧格式：包装项、裸数据、文件夹都能读；没有按钮总开关和文件夹开关', () => {
    const view = readHelper(legacyExt())
    expect(view.format).toBe('legacy')
    const scripts = flattenScripts(view.nodes)
    expect(scripts.map((s) => [s.id, s.enabled, s.buttonEnabled])).toEqual([
      ['l1', false, null],
      ['l2', true, null],
      ['l3', true, null],
    ])
    expect(scripts[0].buttons).toEqual([{ name: '开始', visible: true }])
    expect(view.nodes[2]).toMatchObject({ type: 'folder', enabled: null, name: '旧文件夹' })
    expect(view.variables).toEqual({ 旧变量: 1 })
  })

  it('没有数据、结构不对、新旧格式并存', () => {
    expect(readHelper({}).format).toBeNull()
    expect(readHelper({ tavern_helper: 'oops' }).invalid).toBeTruthy()
    expect(readHelper({ tavern_helper: { scripts: {} } }).invalid).toBeTruthy()
    expect(readHelper({ tavern_helper: { scripts: [1] } }).invalid).toBeTruthy()
    expect(readHelper({ TavernHelper_scripts: 'x' }).invalid).toBeTruthy()
    const both = readHelper({ ...objectExt(), TavernHelper_scripts: [] })
    expect(both.format).toBe('object')
    expect(both.staleLegacy).toEqual(['TavernHelper_scripts'])
  })

  it('id 缺失或重复时用位置作为 key', () => {
    const ext = { tavern_helper: { scripts: [newScript('dup'), newScript('dup'), { type: 'script' }] } }
    expect(flattenScripts(readHelper(ext).nodes).map((s) => s.key)).toEqual(['dup', '@1', '@2'])
  })

  it('统计实际启用的脚本：缺省为关闭，文件夹关闭时里面的也不算，旧格式看 value 里的 enabled', () => {
    expect(countEnabledScripts(objectExt())).toBe(2)
    const off = objectExt()
    ;((off.tavern_helper as JsonObject).scripts as JsonObject[])[1].enabled = false
    expect(countEnabledScripts(off)).toBe(1)
    expect(countEnabledScripts({ tavern_helper: { scripts: [{ type: 'script', name: '没写 enabled' }] } })).toBe(0)
    expect(countEnabledScripts(legacyExt())).toBe(2)
    expect(countScripts(legacyExt())).toBe(3)
  })
})

describe('修改只动目标字段', () => {
  it('新格式：改内容、改回去后与原数据完全一致，未知字段保留', () => {
    const original = objectExt()
    const ext = clone(original)
    updateScript(ext, { index: 0 }, { content: 'changed()' })
    const expected = clone(original)
    ;(((expected.tavern_helper as JsonObject).scripts as JsonObject[])[0] as JsonObject).content = 'changed()'
    expect(JSON.stringify(ext)).toBe(JSON.stringify(expected))

    updateScript(ext, { index: 0 }, { content: 'console.log("s1")' })
    expect(JSON.stringify(ext)).toBe(JSON.stringify(original))
  })

  it('新格式：文件夹里的脚本、按钮总开关、按钮列表、文件夹字段', () => {
    const ext = objectExt()
    updateScript(ext, { index: 1, child: 1 }, { enabled: true, name: '新名字', buttonEnabled: false, data: { b: 2 } })
    updateButtons(ext, { index: 1, child: 1 }, (list) => void list.push({ name: '新按钮', visible: false }))
    updateFolder(ext, { index: 1 }, { enabled: false, color: 'green' })
    const folder = ((ext.tavern_helper as JsonObject).scripts as JsonObject[])[1]
    const s3 = (folder.scripts as JsonObject[])[1]
    expect(s3).toMatchObject({ enabled: true, name: '新名字', data: { b: 2 }, button: { enabled: false } })
    expect((s3.button as JsonObject).buttons).toEqual([
      { name: '按钮', visible: true },
      { name: '新按钮', visible: false },
    ])
    expect(folder).toMatchObject({ enabled: false, color: 'green' })
  })

  it('entries 形式：修改后仍是 entries，变量写回原位置', () => {
    const ext = entriesExt()
    updateScript(ext, { index: 1 }, { enabled: true })
    setVariables(ext, { x: 1 })
    expect(ext.tavern_helper).toEqual([
      ['scripts', [newScript('e1'), newScript('e2', { enabled: true })]],
      ['variables', { x: 1 }],
    ])
  })

  it('entries 形式缺 scripts 时新建脚本会追加键值对', () => {
    const ext: JsonObject = { tavern_helper: [['variables', {}]] }
    expect(addScript(ext, { name: 'n' })).toEqual({ index: 0 })
    const list = ext.tavern_helper as unknown[][]
    expect(list[1][0]).toBe('scripts')
    expect((list[1][1] as JsonObject[])[0]).toMatchObject({ type: 'script', name: 'n', button: { enabled: true, buttons: [] } })
  })

  it('旧格式：改的是 value 里的字段，按钮总开关和文件夹开关被忽略', () => {
    const original = legacyExt()
    const ext = clone(original)
    updateScript(ext, { index: 0 }, { enabled: true, buttonEnabled: false })
    updateScript(ext, { index: 1 }, { name: '改名' })
    updateScript(ext, { index: 2, child: 0 }, { info: '夹内说明' })
    updateFolder(ext, { index: 2 }, { enabled: false, name: '改名文件夹' })
    updateButtons(ext, { index: 0 }, (list) => void (list[0].name = '暂停'))
    setVariables(ext, { 新变量: 2 })

    const expected = clone(original)
    const list = expected.TavernHelper_scripts as JsonObject[]
    Object.assign(list[0].value as JsonObject, { enabled: true })
    ;((list[0].value as JsonObject).buttons as JsonObject[])[0].name = '暂停'
    list[1].name = '改名'
    list[2].name = '改名文件夹'
    ;(list[2].value as JsonObject[])[0].info = '夹内说明'
    expected.TavernHelper_characterScriptVariables = { 新变量: 2 }
    expect(JSON.stringify(ext)).toBe(JSON.stringify(expected))
    expect(ext.tavern_helper).toBeUndefined()
  })

  it('旧格式只有变量时新建脚本：保持旧格式', () => {
    const ext: JsonObject = { TavernHelper_characterScriptVariables: {} }
    addScript(ext, { name: '新' })
    expect(ext.tavern_helper).toBeUndefined()
    expect(ext.TavernHelper_scripts).toEqual([{ type: 'script', value: expect.objectContaining({ name: '新', buttons: [], enabled: false }) }])
  })

  it('卡里没有酒馆助手数据时新建脚本，按新格式创建', () => {
    const ext: JsonObject = { fav: false }
    addScript(ext, { name: '第一个' })
    expect(Object.keys(ext)).toEqual(['fav', 'tavern_helper'])
    expect(ext.tavern_helper).toEqual({ scripts: [expect.objectContaining({ type: 'script', name: '第一个', enabled: false })], variables: {} })
  })

  it('结构无法识别时不做任何修改', () => {
    const ext: JsonObject = { tavern_helper: { scripts: 'bad' } }
    const before = JSON.stringify(ext)
    updateScript(ext, { index: 0 }, { content: 'x' })
    addScript(ext)
    addFolder(ext, 'f')
    removeNode(ext, { index: 0 })
    expect(JSON.stringify(ext)).toBe(before)
  })
})

describe('增删移动', () => {
  const ids = (ext: JsonObject) =>
    readHelper(ext).nodes.map((n) => (n.type === 'folder' ? `${n.id}[${n.scripts.map((s) => s.id).join(',')}]` : n.id))

  it('新格式：移进移出文件夹、调整顺序、文件夹不能放进文件夹', () => {
    const ext = objectExt()
    moveNode(ext, { index: 0 }, { folder: folderIndexAfterRemoval({ index: 0 }, 1), index: 1 })
    expect(ids(ext)).toEqual(['f1[s2,s1,s3]'])
    moveNode(ext, { index: 0, child: 2 }, { index: 0 })
    expect(ids(ext)).toEqual(['s3', 'f1[s2,s1]'])
    moveNode(ext, { index: 1 }, { index: 0 })
    expect(ids(ext)).toEqual(['f1[s2,s1]', 's3'])
    const before = JSON.stringify(ext)
    addFolder(ext, '第二个')
    const after = JSON.stringify(ext)
    moveNode(ext, { index: 2 }, { folder: 0, index: 0 })
    expect(JSON.stringify(ext)).toBe(after)
    expect(after).not.toBe(before)
  })

  it('旧格式：包装脚本移进文件夹会去掉包装，移出来保持裸数据', () => {
    const ext = legacyExt()
    moveNode(ext, { index: 0 }, { folder: folderIndexAfterRemoval({ index: 0 }, 2), index: 0 })
    const list = ext.TavernHelper_scripts as JsonObject[]
    expect(list).toHaveLength(2)
    expect((list[1].value as JsonObject[])[0]).toMatchObject({ id: 'l1', name: '旧脚本1' })
    expect((list[1].value as JsonObject[])[0].type).toBeUndefined()
    moveNode(ext, { index: 1, child: 1 }, { index: 0 })
    expect(list[0]).toMatchObject({ id: 'l3', name: '夹内' })
    expect(readHelper(ext).invalid).toBeNull()
    expect(flattenScripts(readHelper(ext).nodes).map((s) => s.id)).toEqual(['l3', 'l2', 'l1'])
  })

  it('旧格式：新建文件夹和文件夹里的脚本用旧格式的结构', () => {
    const ext = legacyExt()
    const folder = addFolder(ext, '新文件夹')!
    addScript(ext, { name: '夹内新脚本' }, { folder: folder.index })
    const raw = (ext.TavernHelper_scripts as JsonObject[])[folder.index]
    expect(raw).toMatchObject({ type: 'folder', name: '新文件夹', value: [expect.objectContaining({ name: '夹内新脚本' })] })
    expect((raw.value as JsonObject[])[0].type).toBeUndefined()
  })

  it('复制：新 id、默认关闭、名字加副本，放在原节点后面', () => {
    const ext = objectExt()
    const pos = duplicateNode(ext, { index: 1, child: 0 })
    expect(pos).toEqual({ index: 1, child: 1 })
    const copy = (readHelper(ext).nodes[1] as { scripts: HelperScript[] }).scripts[1]
    expect(copy).toMatchObject({ name: '脚本s2 副本', enabled: false, content: 'console.log("s2")' })
    expect(copy.id).not.toBe('s2')

    const legacy = legacyExt()
    duplicateNode(legacy, { index: 0 })
    expect((legacy.TavernHelper_scripts as JsonObject[])[1]).toMatchObject({ type: 'script', value: { name: '旧脚本1 副本', enabled: false } })
  })

  it('删除', () => {
    const ext = objectExt()
    removeNode(ext, { index: 1, child: 0 })
    expect(ids(ext)).toEqual(['s1', 'f1[s3]'])
    removeNode(ext, { index: 1 })
    expect(ids(ext)).toEqual(['s1'])
  })

  it('在 Immer 草稿上修改，没动的部分保持引用不变', () => {
    const base = objectExt()
    const next = produce(base, (d) => {
      updateScript(d, { index: 1, child: 0 }, { content: 'x' })
      duplicateNode(d, { index: 0 })
    })
    const scripts = (next.tavern_helper as JsonObject).scripts as JsonObject[]
    const baseScripts = (base.tavern_helper as JsonObject).scripts as JsonObject[]
    expect(scripts).toHaveLength(3)
    expect(scripts[1]).toMatchObject({ name: '脚本s1 副本', enabled: false })
    expect((scripts[2].scripts as JsonObject[])[0].content).toBe('x')
    expect(scripts[0]).toBe(baseScripts[0])
    expect((scripts[2].scripts as JsonObject[])[1]).toBe((baseScripts[1].scripts as JsonObject[])[1])
  })
})

describe('拖动排序', () => {
  const ids = (ext: JsonObject) =>
    readHelper(ext).nodes.map((n) => (n.type === 'folder' ? `${n.id}[${n.scripts.map((s) => s.id).join(',')}]` : n.id))
  /** 摊平后的行：s1, f1, s2, s3, s4 */
  const make = (): JsonObject => {
    const ext = objectExt()
    ;((ext.tavern_helper as JsonObject).scripts as JsonObject[]).push(newScript('s4'))
    return ext
  }
  const drag = (ext: JsonObject, from: string, to: string, collapsed: string[] = []) => {
    const rows = flattenTree(readHelper(ext).nodes, new Set(collapsed))
    const drop = computeDrop(rows, rows.findIndex((r) => r.key === from), rows.findIndex((r) => r.key === to))
    if (drop) moveNode(ext, drop.from, drop.to)
    return ids(ext)
  }

  it('摊平：折叠的文件夹不显示子项', () => {
    const nodes = readHelper(make()).nodes
    expect(flattenTree(nodes, new Set()).map((r) => r.key)).toEqual(['s1', 'f1', 's2', 's3', 's4'])
    expect(flattenTree(nodes, new Set(['f1'])).map((r) => r.key)).toEqual(['s1', 'f1', 's4'])
  })

  it('脚本拖到展开的文件夹下面或文件夹里的脚本之间，进入文件夹', () => {
    expect(drag(make(), 's1', 'f1')).toEqual(['f1[s1,s2,s3]', 's4'])
    // 往上拖时落在目标行的前面
    expect(drag(make(), 's4', 's3')).toEqual(['s1', 'f1[s2,s4,s3]'])
    expect(drag(make(), 's4', 's2')).toEqual(['s1', 'f1[s4,s2,s3]'])
  })

  it('文件夹内调整顺序、拖出文件夹', () => {
    expect(drag(make(), 's3', 's2')).toEqual(['s1', 'f1[s3,s2]', 's4'])
    expect(drag(make(), 's2', 's4')).toEqual(['s1', 'f1[s3]', 's4', 's2'])
    expect(drag(make(), 's2', 's1')).toEqual(['s2', 's1', 'f1[s3]', 's4'])
  })

  it('折叠的文件夹下面放的是顶层；文件夹拖进别的文件夹内部时放到它后面', () => {
    expect(drag(make(), 's1', 'f1', ['f1'])).toEqual(['f1[s2,s3]', 's1', 's4'])
    expect(drag(make(), 's4', 'f1', ['f1'])).toEqual(['s1', 's4', 'f1[s2,s3]'])
    expect(drag(make(), 's1', 's4', ['f1'])).toEqual(['f1[s2,s3]', 's4', 's1'])
    const ext = make()
    addFolder(ext, '第二个')
    const second = readHelper(ext).nodes[3].key
    expect(drag(ext, second, 's2', [second])).toEqual(['s1', 'f1[s2,s3]', expect.stringMatching(/\[\]$/), 's4'])
  })
})

describe('旧格式升级与清理', () => {
  it('升级结果与酒馆助手的迁移一致', () => {
    const ext: JsonObject = { fav: true, ...legacyExt() }
    upgradeLegacy(ext)
    expect(Object.keys(ext)).toEqual(['fav', 'tavern_helper'])
    expect(ext.tavern_helper).toEqual({
      scripts: [
        { type: 'script', enabled: false, name: '旧脚本1', id: 'l1', content: 'a()', info: '说明', button: { enabled: true, buttons: [{ name: '开始', visible: true }] }, data: {} },
        { type: 'script', enabled: true, name: '裸脚本', id: 'l2', content: 'b()', info: '', button: { enabled: true, buttons: [] }, data: {} },
        {
          type: 'folder',
          enabled: true,
          name: '旧文件夹',
          id: 'lf',
          icon: 'fa-solid fa-folder',
          color: 'blue',
          scripts: [{ type: 'script', enabled: true, name: '夹内', id: 'l3', content: 'c()', info: '', button: { enabled: true, buttons: [] }, data: {} }],
        },
      ],
      variables: { 旧变量: 1 },
    })
    expect(countEnabledScripts(ext)).toBe(2)
  })

  it('删除残留的旧格式字段', () => {
    const ext: JsonObject = { ...objectExt(), TavernHelper_scripts: [], TavernHelper_characterScriptVariables: {} }
    removeStaleLegacy(ext)
    expect(Object.keys(ext)).toEqual(['regex_scripts', 'tavern_helper'])
    const legacy = legacyExt()
    removeStaleLegacy(legacy)
    expect(legacy).toEqual(legacyExt())
  })
})

// —— 本机测试卡往返（用 TH_CARD_DIR 指定目录，未设置或不存在时跳过；测试名只用序号，不输出正文） ——

const CARD_DIR = process.env.TH_CARD_DIR ?? ''

function ccv3Text(png: Uint8Array): string {
  const entry = getTextEntries(readChunks(png)).find((e) => e.keyword === 'ccv3')
  if (!entry) throw new Error('没有 ccv3 块')
  return base64ToUtf8(entry.text)
}

function loadHelperCards() {
  if (!existsSync(CARD_DIR)) return []
  const cards: { label: string; bytes: Uint8Array }[] = []
  for (const [i, file] of readdirSync(CARD_DIR).filter((f) => f.toLowerCase().endsWith('.png')).entries()) {
    const bytes = new Uint8Array(readFileSync(join(CARD_DIR, file)))
    try {
      const ext = parseCardPng(bytes).card.data.extensions
      if (readHelper(ext).format !== null) cards.push({ label: `#${i + 1}`, bytes })
    } catch {
      // 不是角色卡或解析失败，跳过
    }
  }
  return cards
}

const helperCards = loadHelperCards()

describe.skipIf(helperCards.length === 0)('本机测试卡：编辑脚本后导出，其余内容逐字节一致', () => {
  it('包含新旧两种格式', () => {
    const formats = new Set(helperCards.map((c) => readHelper(parseCardPng(c.bytes).card.data.extensions).format))
    expect(formats.has('legacy')).toBe(true)
    expect(formats.has('object') || formats.has('entries')).toBe(true)
  })

  it.each(helperCards.map((c) => [c.label, c.bytes] as const))('%s', (_label, bytes) => {
    const parsed = parseCardPng(bytes)
    const baseline = ccv3Text(writeCardPng(parsed.image, parsed.card))
    const view = readHelper(parsed.card.data.extensions)
    expect(view.invalid).toBeNull()
    const scripts = flattenScripts(view.nodes)

    // 1. 改脚本内容、开关、按钮再改回去：导出与原样导出逐字节一致
    const edited = produce(parsed.card, (d) => {
      for (const s of scripts) {
        updateScript(d.data.extensions, s.pos, { content: `${s.content}\n// 改`, enabled: !s.enabled, name: `${s.name}!` })
        updateButtons(d.data.extensions, s.pos, (list) => void list.push({ name: '临时', visible: true }))
      }
    })
    const reverted = produce(edited, (d) => {
      for (const s of scripts) {
        updateScript(d.data.extensions, s.pos, { content: s.content, enabled: s.enabled, name: s.name })
        updateButtons(d.data.extensions, s.pos, (list) => void list.pop())
      }
    })
    // 导出 PNG 写的就是 JSON.stringify(card)，这里直接比较字符串，省掉重复编码 PNG
    expect(JSON.stringify(reverted)).toBe(baseline)

    // 2. 只改第一个脚本的内容：导出结果只有这个字段不同
    if (scripts.length === 0) return
    const first = scripts[0]
    const changed = produce(parsed.card, (d) => updateScript(d.data.extensions, first.pos, { content: 'changed()' }))
    const text = ccv3Text(writeCardPng(parsed.image, changed))
    const expected = JSON.parse(baseline)
    const target = flattenScripts(readHelper(expected.data.extensions).nodes)[0]
    updateScript(expected.data.extensions, target.pos, { content: 'changed()' })
    expect(text).toBe(JSON.stringify(expected))
    expect(text.length).toBe(baseline.length - JSON.stringify(first.content).length + JSON.stringify('changed()').length)
  }, 60_000)
})
