import { describe, expect, it } from 'vitest'
import type { LorebookEntry } from '../../src/core/card/types'
import { createEntry, setExt } from '../../src/core/lorebook/entry'
import {
  DEFAULT_SCAN_SETTINGS,
  parseDecorators,
  scanWorldInfo,
  seededRandom,
  simulateTurns,
  type GlobalScanData,
  type ScanInput,
  type ScanMessage,
  type ScanSettings,
} from '../../src/core/lorebook/activate'

const EMPTY_GLOBAL: GlobalScanData = {
  personaDescription: '',
  characterDescription: '',
  characterPersonality: '',
  characterDepthPrompt: '',
  scenario: '',
  creatorNotes: '',
}

const DEFAULT_NAMES = { char: '爱丽丝', user: '旅行者' }

/** 简单确定性的 token 计数器：按字符数计数 */
const charTokens = (text: string): number => text.length

function makeSettings(overrides: Partial<ScanSettings> = {}): ScanSettings {
  return { ...DEFAULT_SCAN_SETTINGS, ...overrides }
}

function makeInput(overrides: Partial<ScanInput> & { entries: LorebookEntry[] }): ScanInput {
  return {
    chat: [],
    names: DEFAULT_NAMES,
    settings: makeSettings(),
    globalScanData: EMPTY_GLOBAL,
    countTokens: charTokens,
    ...overrides,
  }
}

function addEntry(
  entries: LorebookEntry[],
  init: Parameters<typeof createEntry>[1] = {},
  ext: Record<string, unknown> = {},
): LorebookEntry {
  const entry = createEntry(entries, init)
  for (const [k, v] of Object.entries(ext)) {
    setExt(entry, k, v)
  }
  entries.push(entry)
  return entry
}

describe('世界书触发模拟（activate）', () => {
  describe('1. 扫描深度与条目覆盖', () => {
    it('关键词只在倒数第 3 条消息里时，scanDepth=2 不触发、=3 触发', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { keys: ['龙鳞'], content: '巨龙设定' })

      const chat: ScanMessage[] = [
        { role: 'user', text: '我捡到了一片龙鳞' },
        { role: 'char', text: '今天天气真好' },
        { role: 'user', text: '我们去集市吧' },
      ]

      const r2 = scanWorldInfo(makeInput({ entries, chat, settings: makeSettings({ scanDepth: 2 }) }))
      expect(r2.activated).toEqual([])
      expect(r2.traces[0]).toMatchObject({ status: 'skipped', reason: 'no-match' })

      const r3 = scanWorldInfo(makeInput({ entries, chat, settings: makeSettings({ scanDepth: 3 }) }))
      expect(r3.activated).toEqual([0])
      expect(r3.traces[0]).toMatchObject({
        status: 'activated',
        reason: 'keyword',
        matchedKey: '龙鳞',
        matchSource: { kind: 'chat', messageIndex: 0 },
      })
    })

    it('条目自己的 scan_depth 覆盖全局 scanDepth', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { keys: ['龙鳞'], content: '深度覆盖为3' }, { scan_depth: 3 })
      addEntry(entries, { keys: ['集市'], content: '深度覆盖为0' }, { scan_depth: 0 })

      const chat: ScanMessage[] = [
        { role: 'user', text: '龙鳞' },
        { role: 'char', text: '普通回复' },
        { role: 'user', text: '去集市' },
      ]

      const res = scanWorldInfo(makeInput({ entries, chat, settings: makeSettings({ scanDepth: 1 }) }))
      expect(res.activated).toEqual([0])
      expect(res.traces[0]).toMatchObject({
        status: 'activated',
        matchSource: { kind: 'chat', messageIndex: 0 },
      })
      expect(res.traces[1]).toMatchObject({ status: 'skipped', reason: 'no-match' })
    })
  })

  describe('2. includeNames 与宏替换', () => {
    it('开启 includeNames 时，消息带 "名字: 消息" 前缀并可被角色名或 {{char}} 命中', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { keys: ['爱丽丝:'], content: '角色 {{char}} 回应了 {{user}}' })
      addEntry(entries, { keys: ['{{user}}'], content: '玩家信息' })

      const chat: ScanMessage[] = [
        { role: 'char', text: '你好呀' },
        { role: 'user', text: '早安' },
      ]

      const off = scanWorldInfo(makeInput({ entries, chat, settings: makeSettings({ includeNames: false }) }))
      expect(off.activated).toEqual([])

      const on = scanWorldInfo(makeInput({ entries, chat, settings: makeSettings({ includeNames: true }) }))
      expect(on.activated).toEqual([0, 1])
      expect(on.traces[0]).toMatchObject({
        status: 'activated',
        matchedKey: '爱丽丝:',
        matchSource: { kind: 'chat', messageIndex: 0 },
      })
      expect(on.traces[1]).toMatchObject({
        status: 'activated',
        matchedKey: '{{user}}',
        matchSource: { kind: 'chat', messageIndex: 1 },
      })
    })
  })

  describe('3. 次要关键词四种逻辑', () => {
    it('AND_ANY(0)、NOT_ALL(1)、NOT_ANY(2)、AND_ALL(3) 判定正确', () => {
      const makeSecondaryEntry = (logic: number): LorebookEntry[] => {
        const list: LorebookEntry[] = []
        const e = addEntry(list, { keys: ['魔法'], content: '内容' }, { selectiveLogic: logic })
        e.selective = true
        e.secondary_keys = ['火', '冰']
        return list
      }

      const chatNone: ScanMessage[] = [{ role: 'user', text: '使用魔法' }]
      const chatOne: ScanMessage[] = [{ role: 'user', text: '使用火系魔法' }]
      const chatBoth: ScanMessage[] = [{ role: 'user', text: '同时使用火和冰的魔法' }]

      // AND_ANY (0)
      expect(scanWorldInfo(makeInput({ entries: makeSecondaryEntry(0), chat: chatNone })).activated).toEqual([])
      expect(scanWorldInfo(makeInput({ entries: makeSecondaryEntry(0), chat: chatNone })).traces[0].reason).toBe('secondary')
      const andAnyOne = scanWorldInfo(makeInput({ entries: makeSecondaryEntry(0), chat: chatOne }))
      expect(andAnyOne.activated).toEqual([0])
      expect(andAnyOne.traces[0].matchedSecondary).toEqual(['火'])
      expect(scanWorldInfo(makeInput({ entries: makeSecondaryEntry(0), chat: chatBoth })).activated).toEqual([0])

      // NOT_ALL (1)
      expect(scanWorldInfo(makeInput({ entries: makeSecondaryEntry(1), chat: chatNone })).activated).toEqual([0])
      expect(scanWorldInfo(makeInput({ entries: makeSecondaryEntry(1), chat: chatOne })).activated).toEqual([0])
      const notAllBoth = scanWorldInfo(makeInput({ entries: makeSecondaryEntry(1), chat: chatBoth }))
      expect(notAllBoth.activated).toEqual([])
      expect(notAllBoth.traces[0].reason).toBe('secondary')

      // NOT_ANY (2)
      expect(scanWorldInfo(makeInput({ entries: makeSecondaryEntry(2), chat: chatNone })).activated).toEqual([0])
      expect(scanWorldInfo(makeInput({ entries: makeSecondaryEntry(2), chat: chatOne })).traces[0].reason).toBe('secondary')
      expect(scanWorldInfo(makeInput({ entries: makeSecondaryEntry(2), chat: chatBoth })).traces[0].reason).toBe('secondary')

      // AND_ALL (3)
      expect(scanWorldInfo(makeInput({ entries: makeSecondaryEntry(3), chat: chatNone })).traces[0].reason).toBe('secondary')
      expect(scanWorldInfo(makeInput({ entries: makeSecondaryEntry(3), chat: chatOne })).traces[0].reason).toBe('secondary')
      const andAllBoth = scanWorldInfo(makeInput({ entries: makeSecondaryEntry(3), chat: chatBoth }))
      expect(andAllBoth.activated).toEqual([0])
      expect(andAllBoth.traces[0].matchedSecondary).toEqual(['火', '冰'])
    })
  })

  describe('4. 正则关键词、全词匹配、大小写敏感', () => {
    it('正则关键词支持 flags 与转义斜杠，带 g 标志时不受 lastIndex 影响', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { keys: ['/fire\\s+ball/gi'], content: '火球术' })
      addEntry(entries, { keys: ['/a\\/b/'], content: '斜杠测试' })
      // 内部含未转义斜杠，按酒馆 parseRegexFromString 不视为正则，而是普通文本
      addEntry(entries, { keys: ['/not/regex/'], content: '非正则' })

      const chat: ScanMessage[] = [{ role: 'user', text: 'Cast FIRE   BALL and a/b' }]

      const res = scanWorldInfo(makeInput({ entries, chat }))
      expect(res.activated).toEqual([0, 1])
      expect(res.traces[0].matchedKey).toBe('/fire\\s+ball/gi')
      expect(res.traces[1].matchedKey).toBe('/a\\/b/')
      expect(res.traces[2].reason).toBe('no-match')
    })

    it('全词匹配与大小写敏感（全局及条目级覆盖）', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { keys: ['cat'], content: '单词猫' }) // 继承全局
      addEntry(entries, { keys: ['cat'], content: '禁用全词' }, { match_whole_words: false })
      addEntry(entries, { keys: ['Dragon'], content: '区分大小写' }, { case_sensitive: true })
      addEntry(entries, { keys: ['black cat'], content: '多词按子串' }) // 酒馆规则：多词不套单词边界

      const chat: ScanMessage[] = [{ role: 'user', text: 'scatter dragon and subblack catx' }]

      const res = scanWorldInfo(
        makeInput({
          entries,
          chat,
          settings: makeSettings({ matchWholeWords: true, caseSensitive: false }),
        }),
      )

      // 0: cat 全词不匹配 scatter，但 black catx 中 catx 不是完整词 -> 未命中
      expect(res.traces[0].reason).toBe('no-match')
      // 1: 条目关闭全词 -> 命中 scatter 里的 cat
      expect(res.traces[1].status).toBe('activated')
      // 2: 条目开启大小写敏感 -> Dragon 不匹配 dragon
      expect(res.traces[2].reason).toBe('no-match')
      // 3: 多词关键词在全词模式下退化为 includes -> 命中 subblack catx
      expect(res.traces[3].status).toBe('activated')
      expect(res.activated).toEqual([1, 3])
    })
  })

  describe('5. 递归、prevent_recursion、exclude_recursion、delay_until_recursion', () => {
    it('A 的内容含 B 的关键词时 B 被递归触发且 matchSource 指向 A', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { keys: ['王城'], content: '王城中央矗立着白银圣塔。' })
      addEntry(entries, { keys: ['白银圣塔'], content: '圣塔藏着古老秘典。' })

      const chat: ScanMessage[] = [{ role: 'user', text: '我们抵达了王城' }]

      const res = scanWorldInfo(makeInput({ entries, chat, settings: makeSettings({ recursive: true }) }))
      expect(res.activated).toEqual([0, 1])
      expect(res.traces[0]).toMatchObject({
        status: 'activated',
        loop: 1,
        scanState: 'initial',
        matchSource: { kind: 'chat', messageIndex: 0 },
      })
      expect(res.traces[1]).toMatchObject({
        status: 'activated',
        loop: 2,
        scanState: 'recursion',
        matchedKey: '白银圣塔',
        matchSource: { kind: 'recursion', entryIndex: 0 },
      })
    })

    it('prevent_recursion 阻止条目内容进入递归缓冲', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { keys: ['王城'], content: '白银圣塔' }, { prevent_recursion: true })
      addEntry(entries, { keys: ['白银圣塔'], content: '圣塔设定' })

      const res = scanWorldInfo(makeInput({ entries, chat: [{ role: 'user', text: '去王城' }] }))
      expect(res.activated).toEqual([0])
      expect(res.traces[1]).toMatchObject({ status: 'skipped', reason: 'no-match' })
    })

    it('exclude_recursion 阻止条目被递归触发并记录 exclude-recursion', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { keys: ['王城'], content: '提到白银圣塔' })
      addEntry(entries, { keys: ['白银圣塔'], content: '不可被递归触发' }, { exclude_recursion: true })
      addEntry(entries, { keys: ['完全无关词'], content: '无关条目' }, { exclude_recursion: true })

      const res = scanWorldInfo(makeInput({ entries, chat: [{ role: 'user', text: '来到王城' }] }))
      expect(res.activated).toEqual([0])
      expect(res.traces[1]).toMatchObject({ status: 'skipped', reason: 'exclude-recursion' })
      // 未在递归中命中的无关条目保持 no-match
      expect(res.traces[2]).toMatchObject({ status: 'skipped', reason: 'no-match' })
    })

    it('delay_until_recursion 支持 true 与数字层级 1/2 逐层触发', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { keys: ['起点'], content: '引出第一层' })
      addEntry(entries, { keys: ['第一层'], content: '引出第二层' }, { delay_until_recursion: true })
      addEntry(entries, { keys: ['第二层'], content: '最终秘密' }, { delay_until_recursion: 2 })

      const res = scanWorldInfo(makeInput({ entries, chat: [{ role: 'user', text: '从起点出发' }] }))
      expect(res.activated).toEqual([0, 1, 2])
      expect(res.traces[0].loop).toBe(1)
      expect(res.traces[1].loop).toBe(2)
      expect(res.traces[1].matchSource).toEqual({ kind: 'recursion', entryIndex: 0 })
      // 第 2 轮激活了 level 1 后，第 3 轮仍是 level 1 空跑，第 4 轮才升到 level 2 激活条目 2
      expect(res.traces[2].loop).toBe(4)
      expect(res.traces[2].scanState).toBe('recursion')
      expect(res.traces[2].matchSource).toEqual({ kind: 'recursion', entryIndex: 1 })
    })

    it('delay_until_recursion 条目在未进入递归时被跳过', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { keys: ['秘密'], content: '只有递归时触发' }, { delay_until_recursion: true })

      const res = scanWorldInfo(makeInput({ entries, chat: [{ role: 'user', text: '秘密' }] }))
      expect(res.activated).toEqual([])
      expect(res.traces[0]).toMatchObject({ status: 'skipped', reason: 'delay-until-recursion' })
    })

    it('maxRecursionSteps 限制循环步数', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { keys: ['甲'], content: '乙' })
      addEntry(entries, { keys: ['乙'], content: '丙' })

      const res = scanWorldInfo(
        makeInput({
          entries,
          chat: [{ role: 'user', text: '甲' }],
          settings: makeSettings({ recursive: true, maxRecursionSteps: 1 }),
        }),
      )
      expect(res.loops).toBe(1)
      expect(res.activated).toEqual([0])
    })
  })

  describe('6. 概率检查', () => {
    it('注入 random 验证掷中/未掷中、roll 值及 useProbability=false 跳过掷骰', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { keys: ['宝箱'], content: '成功', order: 300 }, { probability: 50, useProbability: true })
      addEntry(entries, { keys: ['宝箱'], content: '失败', order: 200 }, { probability: 50, useProbability: true })
      addEntry(entries, { keys: ['宝箱'], content: '不掷骰', order: 100 }, { probability: 10, useProbability: false })

      const rolls = [0.25, 0.75]
      let cursor = 0
      const fakeRandom = () => rolls[cursor++] ?? 0.5

      const res = scanWorldInfo(
        makeInput({
          entries,
          chat: [{ role: 'user', text: '打开宝箱' }],
          random: fakeRandom,
          settings: makeSettings({ recursive: true }),
        }),
      )

      expect(res.activated).toEqual([0, 2])
      expect(res.traces[0]).toMatchObject({ status: 'activated', roll: 25 })
      expect(res.traces[1]).toMatchObject({ status: 'skipped', reason: 'probability', roll: 75 })
      expect(res.traces[2].status).toBe('activated')
      expect(res.traces[2].roll).toBeUndefined()
      // 递归轮次不会对已失败条目 1 重掷，且条目 2 没掷骰，因此总共只调用了 2 次 random
      expect(cursor).toBe(2)
    })
  })

  describe('7. 包含组（group_override、按权重抽选、组评分）', () => {
    it('group_override 选中 order 最高的条目', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { keys: ['天气'], content: '小雨', order: 100 }, { group: '天气', group_override: true })
      addEntry(entries, { keys: ['天气'], content: '暴雨', order: 250 }, { group: '天气', group_override: true })
      addEntry(entries, { keys: ['天气'], content: '晴天', order: 500 }, { group: '天气', group_override: false })

      const res = scanWorldInfo(makeInput({ entries, chat: [{ role: 'user', text: '今天天气如何' }] }))
      expect(res.activated).toEqual([1])
      expect(res.traces[1]).toMatchObject({ status: 'activated', group: '天气' })
      expect(res.traces[0]).toMatchObject({ status: 'skipped', reason: 'group', group: '天气' })
      expect(res.traces[2]).toMatchObject({ status: 'skipped', reason: 'group', group: '天气' })
    })

    it('按权重随机抽选：注入 random 验证命中不同区间', () => {
      const buildEntries = (): LorebookEntry[] => {
        const list: LorebookEntry[] = []
        addEntry(list, { keys: ['事件'], content: '轻权重', order: 200 }, { group: '事件', group_weight: 20 })
        addEntry(list, { keys: ['事件'], content: '重权重', order: 100 }, { group: '事件', group_weight: 80 })
        return list
      }

      // totalWeight = 100；roll = 0.1 * 100 = 10 <= 20 -> 选中 0
      const pickFirst = scanWorldInfo(
        makeInput({ entries: buildEntries(), chat: [{ role: 'user', text: '触发事件' }], random: () => 0.1 }),
      )
      expect(pickFirst.activated).toEqual([0])
      expect(pickFirst.traces[0].group).toBe('事件')
      expect(pickFirst.traces[1]).toMatchObject({ status: 'skipped', reason: 'group', group: '事件' })

      // roll = 0.5 * 100 = 50 > 20 且 <= 100 -> 选中 1
      const pickSecond = scanWorldInfo(
        makeInput({ entries: buildEntries(), chat: [{ role: 'user', text: '触发事件' }], random: () => 0.5 }),
      )
      expect(pickSecond.activated).toEqual([1])
      expect(pickSecond.traces[1].group).toBe('事件')
      expect(pickSecond.traces[0]).toMatchObject({ status: 'skipped', reason: 'group', group: '事件' })
    })

    it('组评分：全局 useGroupScoring（条目为 null 继承）与条目级 use_group_scoring 淘汰低分条目', () => {
      // 全局开启，条目 use_group_scoring=null 继承全局
      const globalEntries: LorebookEntry[] = []
      addEntry(globalEntries, { keys: ['剑'], content: '单命中', order: 200 }, { group: '武器', use_group_scoring: null })
      addEntry(globalEntries, { keys: ['剑', '圣光'], content: '双命中', order: 100 }, { group: '武器', use_group_scoring: null })

      const rGlobal = scanWorldInfo(
        makeInput({
          entries: globalEntries,
          chat: [{ role: 'user', text: '挥舞圣光之剑' }],
          settings: makeSettings({ useGroupScoring: true }),
          random: () => 0, // 即使随机数偏向前面的条目，也应因评分先淘汰 0
        }),
      )
      expect(rGlobal.activated).toEqual([1])
      expect(rGlobal.traces[0]).toMatchObject({ status: 'skipped', reason: 'group', group: '武器' })

      // 全局关闭，仅条目级开启 use_group_scoring=true
      const entryEntries: LorebookEntry[] = []
      addEntry(entryEntries, { keys: ['剑'], content: '低分参评', order: 200 }, { group: '武器', use_group_scoring: true })
      addEntry(entryEntries, { keys: ['剑', '圣光'], content: '高分参评', order: 100 }, { group: '武器', use_group_scoring: true })

      const rEntry = scanWorldInfo(
        makeInput({
          entries: entryEntries,
          chat: [{ role: 'user', text: '圣光之剑' }],
          settings: makeSettings({ useGroupScoring: false }),
          random: () => 0,
        }),
      )
      expect(rEntry.activated).toEqual([1])
      expect(rEntry.traces[0]).toMatchObject({ status: 'skipped', reason: 'group', group: '武器' })
    })
  })

  describe('8. 预算控制与 ignore_budget', () => {
    it('超出预算时后续条目跳过（budget），ignore_budget 条目不受影响', () => {
      const entries: LorebookEntry[] = []
      // order 大的先检查预算
      addEntry(entries, { keys: ['触发'], content: '12345', order: 300 }) // + '\n' = 6 tokens (< 10)
      addEntry(entries, { keys: ['触发'], content: '67890', order: 200 }) // 累计 12 tokens (>= 10) -> 溢出
      addEntry(entries, { keys: ['触发'], content: '忽略预算条', order: 100 }, { ignore_budget: true })
      addEntry(entries, { keys: ['触发'], content: '被连带跳过', order: 50 })

      const res = scanWorldInfo(
        makeInput({
          entries,
          chat: [{ role: 'user', text: '触发' }],
          settings: makeSettings({ maxContext: 10, budgetPercent: 100, budgetCap: 0 }),
        }),
      )

      expect(res.budget).toBe(10)
      expect(res.budgetOverflowed).toBe(true)
      expect(res.usedTokens).toBe(12)
      expect(res.activated).toEqual([0, 2])
      expect(res.traces[0].status).toBe('activated')
      expect(res.traces[1]).toMatchObject({ status: 'skipped', reason: 'budget' })
      expect(res.traces[2].status).toBe('activated')
      expect(res.traces[3]).toMatchObject({ status: 'skipped', reason: 'budget' })
    })

    it('budgetCap 限制最大预算', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { keys: ['词'], content: '超过五字内容' })

      const res = scanWorldInfo(
        makeInput({
          entries,
          chat: [{ role: 'user', text: '词' }],
          settings: makeSettings({ maxContext: 1000, budgetPercent: 50, budgetCap: 5 }),
        }),
      )

      expect(res.budget).toBe(5)
      expect(res.budgetOverflowed).toBe(true)
      expect(res.activated).toEqual([])
    })
  })

  describe('9. 最少激活数（minActivations）', () => {
    it('未达 minActivations 时向前扩展扫描深度，且受 minActivationsDepthMax 限制', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { keys: ['古老遗迹'], content: '遗迹资料' })

      const chat: ScanMessage[] = [
        { role: 'user', text: '听说北方有古老遗迹' },
        { role: 'char', text: '回复1' },
        { role: 'user', text: '消息2' },
        { role: 'char', text: '回复3' },
        { role: 'user', text: '消息4' },
      ]

      // 初始 scanDepth=1，需要扩到深度 5 才能扫到第 0 条消息
      const expanded = scanWorldInfo(
        makeInput({
          entries,
          chat,
          settings: makeSettings({ scanDepth: 1, minActivations: 1, minActivationsDepthMax: 0 }),
        }),
      )
      expect(expanded.activated).toEqual([0])
      expect(expanded.traces[0]).toMatchObject({
        status: 'activated',
        scanState: 'min-activations',
        matchSource: { kind: 'chat', messageIndex: 0 },
      })

      // 限制最大深度为 2：到深度 3 时停止（酒馆判断 buffer.getDepth() > max），仍够不到第 0 条消息
      const capped = scanWorldInfo(
        makeInput({
          entries,
          chat,
          settings: makeSettings({ scanDepth: 1, minActivations: 1, minActivationsDepthMax: 2 }),
        }),
      )
      expect(capped.activated).toEqual([])
    })
  })

  describe('10. 计时效果（sticky、cooldown、delay）与 simulateTurns', () => {
    it('sticky 连续保持激活，结束后立即进入 cooldown；cooldown 期间关键词命中也不触发', () => {
      const entries: LorebookEntry[] = []
      // 用纯 user 消息序列让每轮 chatLength 逐一递增（1, 2, 3, 4, 5, 6），便于精确核对每一步
      addEntry(entries, { keys: ['变身'], content: '变身状态' }, { sticky: 2, cooldown: 2 })

      const chat: ScanMessage[] = [
        { role: 'user', text: '变身！' },        // Turn 1, len=1: 关键词激活 -> sticky[1..3], cooldown[1..3]
        { role: 'user', text: '普通攻击' },      // Turn 2, len=2: 2 < 3 -> sticky 激活
        { role: 'user', text: '再次变身！' },    // Turn 3, len=3: 3 >= 3 -> sticky 结束，立刻设 cooldown[3..5](protected) -> 冷却跳过！
        { role: 'user', text: '尝试变身！' },    // Turn 4, len=4: 4 < 5 -> 冷却跳过！
        { role: 'user', text: '终于变身！' },    // Turn 5, len=5: 5 >= 5 -> 冷却结束，关键词重新激活！
      ]

      const turns = simulateTurns({
        entries,
        chat,
        names: DEFAULT_NAMES,
        settings: makeSettings({ scanDepth: 1 }),
        globalScanData: EMPTY_GLOBAL,
        countTokens: charTokens,
      })

      expect(turns.map((t) => t.chatLength)).toEqual([1, 2, 3, 4, 5])
      expect(turns[0].activated).toEqual([0])
      expect(turns[0].traces[0].reason).toBe('keyword')

      expect(turns[1].activated).toEqual([0])
      expect(turns[1].traces[0].reason).toBe('sticky')

      expect(turns[2].activated).toEqual([])
      expect(turns[2].traces[0].reason).toBe('cooldown')
      expect(turns[2].timedState.cooldown['0']).toEqual({ start: 3, end: 5, protected: true })

      expect(turns[3].activated).toEqual([])
      expect(turns[3].traces[0].reason).toBe('cooldown')

      expect(turns[4].activated).toEqual([0])
      expect(turns[4].traces[0].reason).toBe('keyword')
    })

    it('delay 在消息数不足时不触发，达到消息数后触发', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { keys: ['剧情'], content: '后期剧情' }, { delay: 3 })

      const chat: ScanMessage[] = [
        { role: 'char', text: '开场白' },
        { role: 'user', text: '触发剧情' }, // Turn 1, len=2 < 3 -> delay
        { role: 'char', text: '继续' },
        { role: 'user', text: '再次剧情' }, // Turn 2, len=4 >= 3 -> 激活
      ]

      const turns = simulateTurns({
        entries,
        chat,
        names: DEFAULT_NAMES,
        settings: makeSettings(),
        globalScanData: EMPTY_GLOBAL,
        countTokens: charTokens,
      })

      expect(turns.map((t) => t.chatLength)).toEqual([2, 4])
      expect(turns[0].activated).toEqual([])
      expect(turns[0].traces[0].reason).toBe('delay')
      expect(turns[1].activated).toEqual([0])
      expect(turns[1].traces[0].reason).toBe('keyword')
    })

    it('simulateTurns 处理空聊天和以 char 结尾的聊天', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { constant: true, content: '常驻' })

      expect(
        simulateTurns({
          entries,
          chat: [],
          names: DEFAULT_NAMES,
          settings: makeSettings(),
          globalScanData: EMPTY_GLOBAL,
          countTokens: charTokens,
        }),
      ).toEqual([])

      const turns = simulateTurns({
        entries,
        chat: [
          { role: 'char', text: '开场白' },
          { role: 'user', text: '玩家发言' },
          { role: 'char', text: '角色回复' },
        ],
        names: DEFAULT_NAMES,
        settings: makeSettings(),
        globalScanData: EMPTY_GLOBAL,
        countTokens: charTokens,
      })

      expect(turns.map((t) => t.chatLength)).toEqual([2, 3])
    })
  })

  describe('11. 装饰器 @@activate / @@dont_activate', () => {
    it('parseDecorators 剥离已知装饰器并支持 @@@ 回退', () => {
      expect(parseDecorators('@@activate\n正文内容')).toEqual([['@@activate'], '正文内容'])
      expect(parseDecorators('@@dont_activate\n第一行\n第二行')).toEqual([['@@dont_activate'], '第一行\n第二行'])
      expect(parseDecorators('@@unknown_dec\n@@@activate\n回退后正文')).toEqual([['@@activate'], '回退后正文'])
      expect(parseDecorators('普通内容')).toEqual([[], '普通内容'])
    })

    it('@@activate 强制激活且剥掉装饰器参与递归，@@dont_activate 抑制常驻与关键词条目', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { keys: [], content: '@@activate\n包含暗号' })
      addEntry(entries, { keys: ['暗号'], content: '被递归激活' })
      addEntry(entries, { constant: true, keys: ['常驻词'], content: '@@dont_activate\n不该激活' })

      const res = scanWorldInfo(makeInput({ entries, chat: [{ role: 'user', text: '常驻词' }] }))
      expect(res.activated).toEqual([0, 1])
      expect(res.traces[0]).toMatchObject({ status: 'activated', reason: 'decorator' })
      expect(res.traces[1]).toMatchObject({
        status: 'activated',
        reason: 'keyword',
        matchSource: { kind: 'recursion', entryIndex: 0 },
      })
      expect(res.traces[2]).toMatchObject({ status: 'skipped', reason: 'dont-activate' })
    })
  })

  describe('12. 常驻、未启用、无关键词、触发类型过滤、全局扫描数据', () => {
    it('各类状态产生正确的 trace', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { constant: true, content: '常驻条目' })
      const disabled = addEntry(entries, { constant: true, content: '禁用条目' })
      disabled.enabled = false
      addEntry(entries, { keys: [], content: '没写关键词' })
      addEntry(entries, { constant: true, content: '仅续写触发' }, { triggers: ['continue'] })
      addEntry(
        entries,
        { keys: ['银发'], content: '外貌补充' },
        { match_character_description: true },
      )

      const res = scanWorldInfo(
        makeInput({
          entries,
          chat: [{ role: 'user', text: '你好' }],
          globalScanData: { ...EMPTY_GLOBAL, characterDescription: '她有着一头银发' },
          trigger: 'normal',
        }),
      )

      expect(res.activated).toEqual([0, 4])
      expect(res.traces[0]).toMatchObject({ status: 'activated', reason: 'constant' })
      expect(res.traces[1]).toMatchObject({ status: 'skipped', reason: 'disabled' })
      expect(res.traces[2]).toMatchObject({ status: 'skipped', reason: 'no-keys' })
      expect(res.traces[3]).toMatchObject({ status: 'skipped', reason: 'trigger-filter' })
      expect(res.traces[4]).toMatchObject({
        status: 'activated',
        reason: 'keyword',
        matchSource: { kind: 'global', field: 'characterDescription' },
      })
    })
  })

  describe('13. 排序顺序、纯函数不修改入参、seededRandom', () => {
    it('activated 按 order 从大到小排列，同 order 保持原数组顺序', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { constant: true, order: 50, content: 'A' })
      addEntry(entries, { constant: true, order: 200, content: 'B' })
      addEntry(entries, { constant: true, order: 200, content: 'C' })
      addEntry(entries, { constant: true, order: 100, content: 'D' })

      const res = scanWorldInfo(makeInput({ entries, chat: [{ role: 'user', text: 'hi' }] }))
      expect(res.activated).toEqual([1, 2, 3, 0])
    })

    it('scanWorldInfo 不修改传入的 entries、chat 和 timedState', () => {
      const entries: LorebookEntry[] = []
      const e = addEntry(entries, { keys: ['{{char}}'], content: '@@activate\n你好 {{user}}' }, { sticky: 2 })
      delete e.id
      const snapshot = JSON.stringify(entries)
      const chat: ScanMessage[] = [{ role: 'user', text: '爱丽丝' }]
      const chatSnapshot = JSON.stringify(chat)
      const timedState = { sticky: {}, cooldown: {} }

      const res = scanWorldInfo(makeInput({ entries, chat, timedState }))
      expect(res.activated).toEqual([0])
      expect(JSON.stringify(entries)).toBe(snapshot)
      expect(JSON.stringify(chat)).toBe(chatSnapshot)
      expect(timedState).toEqual({ sticky: {}, cooldown: {} })
      expect(res.timedState.sticky['0']).toEqual({ start: 1, end: 3, protected: false })
    })

    it('seededRandom 具有确定性且输出落在 [0, 1)', () => {
      const a = seededRandom(42)
      const b = seededRandom(42)
      const c = seededRandom(43)

      const seqA = Array.from({ length: 10 }, () => a())
      const seqB = Array.from({ length: 10 }, () => b())
      const seqC = Array.from({ length: 10 }, () => c())

      expect(seqA).toEqual(seqB)
      expect(seqA).not.toEqual(seqC)
      for (const v of seqA) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThan(1)
      }
    })
  })
  describe('与酒馆一致的边界行为', () => {
    it('缺少 enabled 字段的条目按酒馆导入规则视为未启用', () => {
      const entries: LorebookEntry[] = []
      const entry = addEntry(entries, { keys: ['龙鳞'], content: '巨龙设定' })
      delete (entry as Partial<LorebookEntry>).enabled
      const r = scanWorldInfo(makeInput({ entries, chat: [{ role: 'user', text: '龙鳞' }] }))
      expect(r.activated).toEqual([])
      expect(r.traces[0]).toMatchObject({ status: 'skipped', reason: 'disabled' })
      expect(r.traces[0].detail).toContain('enabled')
    })

    it('只有空白的关键词在酒馆里每次都命中', () => {
      const entries: LorebookEntry[] = []
      addEntry(entries, { keys: [' '], content: '总会出现' })
      addEntry(entries, { keys: [''], content: '空串跳过' })
      const r = scanWorldInfo(makeInput({ entries, chat: [{ role: 'user', text: '随便聊聊' }] }))
      expect(r.activated).toEqual([0])
    })

    it('组评分直接用关键词原文，不替换宏', () => {
      const entries: LorebookEntry[] = []
      // 两条都靠 {{char}} 命中；评分时酒馆不替换宏，A 的 {{char}} 不计分，B 多一个原文关键词“集市”计 1 分
      addEntry(entries, { keys: ['{{char}}'], content: 'A' }, { group: '组', use_group_scoring: true })
      addEntry(entries, { keys: ['{{char}}', '集市'], content: 'B' }, { group: '组', use_group_scoring: true })
      const r = scanWorldInfo(makeInput({ entries, chat: [{ role: 'user', text: '爱丽丝去集市' }] }))
      expect(r.activated).toEqual([1])
      expect(r.traces[0]).toMatchObject({ status: 'skipped', reason: 'group' })
    })
  })
})
