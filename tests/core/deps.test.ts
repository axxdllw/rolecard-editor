import { describe, expect, it } from 'vitest'
import { createEmptyCard } from '../../src/core/card/create'
import type { CharacterCardV3, JsonObject, LorebookEntry } from '../../src/core/card/types'
import { analyzeDependencies, hasEjs, hasFrontendBlock, locationLabel, readHelperScripts } from '../../src/core/deps/deps'
import { findUrls, isLocalHost, parseJsdelivr } from '../../src/core/deps/urls'

const MVU = "import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js'"
const FRONTEND = '```html\n<!DOCTYPE html><html><body>状态栏</body></html>\n```'

function entry(patch: Partial<LorebookEntry>): LorebookEntry {
  return { keys: [], content: '', extensions: {}, enabled: true, insertion_order: 100, ...patch }
}

function makeCard(patch: { data?: Partial<CharacterCardV3['data']>; extensions?: JsonObject; entries?: LorebookEntry[] } = {}): CharacterCardV3 {
  const card = createEmptyCard('测试')
  Object.assign(card.data, patch.data)
  Object.assign(card.data.extensions, patch.extensions)
  if (patch.entries) card.data.character_book = { name: '书', extensions: {}, entries: patch.entries }
  return card
}

describe('找地址', () => {
  const kinds = (text: string) => findUrls(text).map((u) => [u.url, u.kind])

  it('按上下文判断用途', () => {
    expect(kinds(`import 'https://a.com/x'`)).toEqual([['https://a.com/x', 'script']])
    expect(kinds(`import { a } from "https://a.com/mod"`)).toEqual([['https://a.com/mod', 'script']])
    expect(kinds(`await import('https://a.com/lazy')`)).toEqual([['https://a.com/lazy', 'script']])
    expect(kinds(`<script src="https://a.com/s"></script>`)).toEqual([['https://a.com/s', 'script']])
    expect(kinds(`@import url('https://fonts.googleapis.com/css2?family=X');`)).toEqual([['https://fonts.googleapis.com/css2?family=X', 'style']])
    expect(kinds(`<link href="https://a.com/theme" rel="stylesheet">`)).toEqual([['https://a.com/theme', 'style']])
    expect(kinds(`<link rel="preconnect" href="https://fonts.gstatic.com">`)).toEqual([['https://fonts.gstatic.com', 'other']])
    expect(kinds(`<img alt="" src="https://a.com/pic">`)).toEqual([['https://a.com/pic', 'image']])
    expect(kinds(`background: url(https://a.com/bg)`)).toEqual([['https://a.com/bg', 'image']])
    expect(kinds(`src: url("https://a.com/f.woff2")`)).toEqual([['https://a.com/f.woff2', 'font']])
    expect(kinds(`<a href='http://qm.qq.com/q'>加群</a>`)).toEqual([['http://qm.qq.com/q', 'link']])
    expect(kinds(`![图](https://a.com/p) [主页](https://a.com/home)`)).toEqual([
      ['https://a.com/p', 'image'],
      ['https://a.com/home', 'link'],
    ])
  })

  it('没有上下文时按扩展名和常见主机判断', () => {
    expect(kinds(`'https://a.com/x.js' 'https://a.com/y.png?v=1' 'https://a.com/z.mp3' 'https://kappa.lol/abc' 'https://api.a.com/v1'`)).toEqual([
      ['https://a.com/x.js', 'script'],
      ['https://a.com/y.png?v=1', 'image'],
      ['https://a.com/z.mp3', 'media'],
      ['https://kappa.lol/abc', 'image'],
      ['https://api.a.com/v1', 'other'],
    ])
  })

  it('去掉末尾的标点、括号和 HTML 实体，保留中文路径和占位符', () => {
    expect(findUrls('见 https://a.com/x.png。').map((u) => u.url)).toEqual(['https://a.com/x.png'])
    expect(findUrls('（https://a.com/x）').map((u) => u.url)).toEqual(['https://a.com/x'])
    expect(findUrls('[CDN: https://a.com/gh/u/r@main]').map((u) => u.url)).toEqual(['https://a.com/gh/u/r@main'])
    expect(findUrls('href=&quot;https://a.com/x&quot;').map((u) => u.url)).toEqual(['https://a.com/x'])
    expect(findUrls("'http://127.0.0.1:5500/dist/鸣潮/index.js'").map((u) => u.url)).toEqual(['http://127.0.0.1:5500/dist/鸣潮/index.js'])
    expect(findUrls('`https://files.catbox.moe/${id}.png`').map((u) => u.url)).toEqual(['https://files.catbox.moe/${id}.png'])
  })

  it('忽略命名空间和示例域名', () => {
    expect(findUrls(`<svg xmlns="http://www.w3.org/2000/svg"></svg> fetch('https://api.example.com/v1')`)).toEqual([])
  })

  it('识别本机和局域网地址', () => {
    expect(['localhost', '127.0.0.1', '192.168.1.5', '10.0.0.2', '172.20.1.1', '[::1]'].every(isLocalHost)).toBe(true)
    expect(['172.32.0.1', 'cdn.jsdelivr.net', '8.8.8.8'].some(isLocalHost)).toBe(false)
  })
})

describe('jsDelivr 地址', () => {
  it('解析 gh 和 npm 包', () => {
    expect(parseJsdelivr('https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js')).toMatchObject({
      host: 'testingcf.jsdelivr.net',
      source: 'gh',
      name: 'MagicalAstrogy/MagVarUpdate',
      version: null,
      pinned: false,
    })
    expect(parseJsdelivr('https://cdn.jsdelivr.net/npm/@vue/runtime@3.4.1/dist/x.js')).toMatchObject({
      name: '@vue/runtime',
      version: '3.4.1',
      pinned: true,
      file: 'dist/x.js',
    })
    expect(parseJsdelivr('https://cdn.jsdelivr.net/npm/js-yaml')).toMatchObject({ name: 'js-yaml', version: null, pinned: false, file: '' })
    expect(parseJsdelivr('https://files.catbox.moe/a.png')).toBeNull()
  })

  it('只有具体版本号和提交哈希算固定版本', () => {
    const pinned = (v: string) => parseJsdelivr(`https://cdn.jsdelivr.net/gh/u/r@${v}/a.js`)!.pinned
    expect(['1.7.22', 'v2.0.3', '2e67929', '1.0.0-beta.1'].map(pinned)).toEqual([true, true, true, true])
    expect(['main', 'master', 'beta', 'latest', '1', '1.2', ''].map(pinned)).toEqual([false, false, false, false, false, false, false])
  })
})

describe('酒馆助手脚本', () => {
  it('读对象形式，文件夹禁用时里面的脚本也算禁用', () => {
    const scripts = readHelperScripts({
      tavern_helper: {
        scripts: [
          { type: 'script', name: 'A', content: 'a', enabled: true },
          { type: 'folder', name: 'F', enabled: false, scripts: [{ type: 'script', name: 'B', content: 'b', enabled: true }] },
        ],
        variables: {},
      },
    })
    expect(scripts.map((s) => [s.name, s.path, s.enabled])).toEqual([
      ['A', [0], true],
      ['B', [1, 0], false],
    ])
  })

  it('读 [键, 值] 数组形式', () => {
    const scripts = readHelperScripts({ tavern_helper: [['scripts', [{ type: 'script', name: 'A', content: 'x' }]], ['variables', {}]] })
    expect(scripts.map((s) => s.name)).toEqual(['A'])
  })

  it('读旧版 TavernHelper_scripts，包括 { type, value } 包装', () => {
    const scripts = readHelperScripts({
      TavernHelper_scripts: [
        { type: 'script', value: { name: '包装', content: 'x', enabled: false } },
        { name: '平铺', content: 'y', enabled: true },
      ],
    })
    expect(scripts.map((s) => [s.name, s.content, s.enabled])).toEqual([
      ['包装', 'x', false],
      ['平铺', 'y', true],
    ])
  })
})

describe('前端代码块和 EJS', () => {
  it('代码块里有 html 标记才算前端', () => {
    expect(hasFrontendBlock(FRONTEND)).toBe(true)
    expect(hasFrontendBlock('<pre><code><body>x</body></code></pre>')).toBe(true)
    expect(hasFrontendBlock('<html><body>没包在代码块里</body></html>')).toBe(false)
    expect(hasFrontendBlock('```js\nconsole.log(1)\n```')).toBe(false)
  })

  it('EJS 要有成对的 <% %>', () => {
    expect(hasEjs('<% if (x) { %>有<% } %>')).toBe(true)
    expect(hasEjs('<%= getvar("a") %>')).toBe(true)
    expect(hasEjs('100<%的概率')).toBe(false)
  })
})

describe('需要的扩展', () => {
  it('空卡什么都不需要', () => {
    const report = analyzeDependencies(makeCard())
    expect(report).toEqual({ extensions: [], unknownKeys: [], hosts: [], issues: [] })
  })

  it('有脚本需要酒馆助手，导入 MagVarUpdate 需要 MVU', () => {
    const report = analyzeDependencies(makeCard({ extensions: { tavern_helper: { scripts: [{ type: 'script', name: 'MVU', content: MVU, enabled: true }] } } }))
    expect(report.extensions.map((e) => e.id)).toEqual(['tavern-helper', 'mvu'])
    const mvu = report.extensions[1]
    expect(mvu.evidence).toEqual([{ location: { type: 'script', path: [0], name: 'MVU', enabled: true }, note: '导入了 MagVarUpdate' }])
    expect(mvu.summary).not.toContain('需要自己')
  })

  it('开场白和正则替换里的前端代码块需要酒馆助手；只改提示词的正则不算', () => {
    const report = analyzeDependencies(
      makeCard({
        data: { alternate_greetings: ['普通', FRONTEND] },
        extensions: {
          regex_scripts: [
            { scriptName: '状态栏', findRegex: '/<s>/', replaceString: FRONTEND, disabled: true },
            { scriptName: '提示词', findRegex: '/<p>/', replaceString: FRONTEND, promptOnly: true },
          ],
        },
      }),
    )
    const helper = report.extensions.find((e) => e.id === 'tavern-helper')!
    expect(helper.evidence.map((e) => locationLabel(e.location))).toEqual(['备选开场白 2', '正则「状态栏」'])
    expect(helper.onlyDisabled).toBe(false)
  })

  it('只有 [initvar] 条目时也需要 MVU，并提示要自己装', () => {
    const report = analyzeDependencies(makeCard({ entries: [entry({ comment: '[InitVar]初始变量', content: 'a: 1', enabled: false })] }))
    expect(report.extensions.map((e) => e.id)).toEqual(['tavern-helper', 'mvu'])
    expect(report.extensions[1].summary).toContain('需要自己在酒馆助手里装上 MVU')
    expect(report.extensions[1].onlyDisabled).toBe(true)
    expect(report.extensions[0].evidence[0].note).toBe('MVU 需要酒馆助手')
  })

  it('世界书和角色字段里的 EJS 需要提示词模板，创作者备注不算', () => {
    const report = analyzeDependencies(
      makeCard({
        data: { description: '<%= user %>', creator_notes: '<% 不算 %>' },
        entries: [entry({ comment: '甲', content: '无' }), entry({ comment: '乙', content: '<% if (a) { %>x<% } %>' })],
      }),
    )
    const template = report.extensions.find((e) => e.id === 'prompt-template')!
    expect(template.evidence.map((e) => locationLabel(e.location))).toEqual(['角色描述', '世界书「乙」'])
  })

  it('小白X 和不认识的扩展字段', () => {
    const report = analyzeDependencies(makeCard({ extensions: { 'xiaobaix-template': { enabled: true }, 'quick-response-force': { apiSettings: {} }, chub: {} } }))
    expect(report.extensions.map((e) => e.id)).toEqual(['xiaobaix'])
    expect(report.unknownKeys).toEqual(['quick-response-force'])
  })
})

describe('外部资源和问题', () => {
  it('同一个地址合并位置，按域名分组', () => {
    const report = analyzeDependencies(
      makeCard({
        data: { first_mes: '<img src="https://files.catbox.moe/a.png">', alternate_greetings: ['<img src="https://files.catbox.moe/a.png"><img src="https://files.catbox.moe/b.png">'] },
        extensions: { regex_scripts: [{ scriptName: 'R', replaceString: '<script src="https://cdn.tailwindcss.com"></script>' }] },
      }),
    )
    expect(report.hosts.map((h) => [h.host, h.refs.length])).toEqual([
      ['files.catbox.moe', 2],
      ['cdn.tailwindcss.com', 1],
    ])
    expect(report.hosts[0].refs[0].locations.map(locationLabel)).toEqual(['主开场白', '备选开场白 1'])
    expect(report.issues).toEqual([])
  })

  it('脚本数据和角色变量里的地址也算', () => {
    const report = analyzeDependencies(
      makeCard({
        extensions: {
          tavern_helper: {
            scripts: [{ type: 'script', name: '预载', content: '', data: { 资源: ['https://kappa.lol/x'] } }],
            variables: { map: [{ imageUrls: ['https://i.ibb.co/y.jpg'] }] },
          },
        },
      }),
    )
    expect(report.hosts.flatMap((h) => h.refs.map((r) => [r.url, locationLabel(r.locations[0])]))).toEqual([
      ['https://i.ibb.co/y.jpg', '酒馆助手角色变量'],
      ['https://kappa.lol/x', '酒馆助手脚本「预载」'],
    ])
  })

  it('本机地址即使在禁用的脚本里也提示', () => {
    const report = analyzeDependencies(
      makeCard({
        extensions: {
          tavern_helper: {
            scripts: [
              { type: 'script', name: '本地1', content: "import 'http://127.0.0.1:5500/a/index.js'", enabled: false },
              { type: 'script', name: '本地2', content: "import 'http://127.0.0.1:5500/b/index.js'", enabled: false },
            ],
          },
        },
      }),
    )
    const local = report.issues.filter((i) => i.code === 'localhost')
    expect(local).toHaveLength(1)
    expect(local[0].severity).toBe('warning')
    expect(local[0].message).toContain('http://127.0.0.1:5500（2 个）')
    expect(local[0].message).toContain('启用后会加载失败')
    expect(local[0].locations.map(locationLabel)).toEqual(['酒馆助手脚本「本地1」', '酒馆助手脚本「本地2」'])
    // 本机地址不再重复报明文 http
    expect(report.issues.some((i) => i.code === 'insecure')).toBe(false)
  })

  it('jsDelivr 没固定版本按仓库和版本合并', () => {
    const content = [
      "import 'https://testingcf.jsdelivr.net/gh/u/r@main/a.js'",
      "import 'https://testingcf.jsdelivr.net/gh/u/r@main/b.js'",
      "import 'https://testingcf.jsdelivr.net/gh/u/r@1.2.3/c.js'",
      MVU,
    ].join('\n')
    const report = analyzeDependencies(makeCard({ extensions: { tavern_helper: { scripts: [{ type: 'script', name: 'S', content }] } } }))
    const unpinned = report.issues.filter((i) => i.code === 'unpinned')
    expect(unpinned.map((i) => [i.severity, i.urls.length])).toEqual([
      ['info', 2],
      ['info', 1],
    ])
    expect(unpinned[0].message).toContain('u/r 用的是 @main')
    expect(unpinned[1].message).toContain('MagicalAstrogy/MagVarUpdate 没写版本号')
  })

  it('说明文字里只写到仓库的 jsDelivr 地址不算加载的文件', () => {
    const report = analyzeDependencies(
      makeCard({
        extensions: {
          tavern_helper: { scripts: [{ type: 'script', name: 'S', content: '', info: '建议一起启用。[CDN: https://cdn.jsdelivr.net/gh/u/r@main]' }] },
        },
      }),
    )
    expect(report.hosts.map((h) => h.refs.map((r) => [r.url, r.kind]))).toEqual([[['https://cdn.jsdelivr.net/gh/u/r@main', 'other']]])
    expect(report.issues).toEqual([])
  })

  it('import 地址在 @ 后被换行截断时提示', () => {
    const content = "import 'https://cdn.jsdelivr.net/gh/u/r@\n2e67929/a.js'"
    const report = analyzeDependencies(makeCard({ extensions: { tavern_helper: { scripts: [{ type: 'script', name: 'S', content }] } } }))
    expect(report.issues.map((i) => i.message)).toEqual([expect.stringContaining('u/r@ 后面是空的（可能被换行截断了）')])
  })

  it('cdn.jsdelivr.net 和 testingcf 混用时提示，位置指向 cdn 那些', () => {
    const report = analyzeDependencies(
      makeCard({
        extensions: {
          tavern_helper: {
            scripts: [
              { type: 'script', name: '国内', content: "import 'https://testingcf.jsdelivr.net/gh/u/r@1.0.0/a.js'" },
              { type: 'script', name: '官方', content: "import 'https://cdn.jsdelivr.net/gh/u/r@1.0.0/b.js'" },
            ],
          },
        },
      }),
    )
    expect(report.issues.map((i) => i.code)).toEqual(['mixed-cdn'])
    expect(report.issues[0].message).toContain('统一换成 testingcf.jsdelivr.net')
    expect(report.issues[0].locations.map(locationLabel)).toEqual(['酒馆助手脚本「官方」'])
  })

  it('明文 http：脚本和样式是警告，图片是提示，超链接不提示', () => {
    const report = analyzeDependencies(
      makeCard({
        data: {
          first_mes: '<script src="http://a.com/x.js"></script><img src="http://b.com/y.png"><a href="http://qm.qq.com/q">群</a>',
        },
      }),
    )
    expect(report.issues.map((i) => [i.code, i.severity, i.urls])).toEqual([
      ['insecure', 'warning', ['http://a.com/x.js']],
      ['insecure', 'info', ['http://b.com/y.png']],
    ])
  })
})
