import { describe, expect, it } from 'vitest'
import { createEmptyCard } from '../../src/core/card/create'
import {
  DEFAULT_TITLE_VOCAB,
  countRuleHits,
  deriveRules,
  planRename,
  ruleRegex,
  splitName,
  splitNameAt,
  type RenameConfig,
} from '../../src/core/search/rename'
import { applyReplacements, collectTextSlots } from '../../src/core/search/search'

function config(oldFull: string, newFull: string, patch: Partial<RenameConfig> = {}): RenameConfig {
  const o = splitName(oldFull)
  const n = splitName(newFull)
  return {
    oldFull,
    newFull,
    oldSurname: o.surname,
    oldGiven: o.given,
    newSurname: n.surname,
    newGiven: n.given,
    gender: 'any',
    nicknames: [],
    others: [],
    ...patch,
  }
}

describe('拆分姓名', () => {
  it('单姓、复姓、单字名', () => {
    expect(splitName('张三丰')).toEqual({ surname: '张', given: '三丰' })
    expect(splitName('欧阳锋')).toEqual({ surname: '欧阳', given: '锋' })
    expect(splitName('爱新觉罗玄烨')).toEqual({ surname: '爱新觉罗', given: '玄烨' })
    expect(splitName('欧阳')).toEqual({ surname: '欧', given: '阳' })
    expect(splitName('瑶')).toEqual({ surname: '', given: '瑶' })
  })

  it('带分隔符的名字按西式顺序', () => {
    expect(splitName('克洛伊·布朗')).toEqual({ surname: '布朗', given: '克洛伊' })
    expect(splitName('Alice Smith')).toEqual({ surname: 'Smith', given: 'Alice' })
  })

  it('手动调整拆分点', () => {
    expect(splitNameAt('宫水三叶', 2)).toEqual({ surname: '宫水', given: '三叶' })
    expect(splitNameAt('宫水三叶', 9)).toEqual({ surname: '宫水三', given: '叶' })
  })
})

describe('推导规则', () => {
  it('按性别派生姓氏称谓', () => {
    const male = deriveRules(config('张三丰', '李四光', { gender: 'male' }), DEFAULT_TITLE_VOCAB).map((r) => r.from)
    expect(male).toContain('张先生')
    expect(male).toContain('老张')
    expect(male).not.toContain('张小姐')
    const female = deriveRules(config('张三丰', '李四光', { gender: 'female' }), DEFAULT_TITLE_VOCAB).map((r) => r.from)
    expect(female).toContain('张小姐')
    expect(female).not.toContain('张先生')
  })

  it('名字和末字派生', () => {
    const rules = deriveRules(config('张三丰', '李四光'), DEFAULT_TITLE_VOCAB)
    const byFrom = new Map(rules.map((r) => [r.from, r]))
    expect(byFrom.get('三丰')).toMatchObject({ kind: '名字', to: '四光', defaultOn: true })
    expect(byFrom.get('阿丰')?.to).toBe('阿光')
    expect(byFrom.get('丰丰')?.to).toBe('光光')
  })

  it('单字名单独替换默认不勾，姓没变时不派生姓氏称谓', () => {
    const rules = deriveRules(config('张三', '张四'), DEFAULT_TITLE_VOCAB)
    expect(rules.find((r) => r.kind === '名字')).toMatchObject({ from: '三', defaultOn: false })
    expect(rules.some((r) => r.kind === '姓氏称谓')).toBe(false)
  })

  it('音译名不按末字派生，外文姓用英文称谓', () => {
    const translit = deriveRules(config('克洛伊·布朗', '艾米·怀特'), DEFAULT_TITLE_VOCAB).map((r) => r.from)
    expect(translit).toContain('布朗先生')
    expect(translit).not.toContain('阿伊')
    const latin = deriveRules(config('Alice Smith', 'Emma Jones', { gender: 'female' }), DEFAULT_TITLE_VOCAB)
    expect(latin.find((r) => r.from === 'Miss Smith')?.to).toBe('Miss Jones')
    expect(latin.some((r) => r.from === 'Mr. Smith')).toBe(false)
  })

  it('手填的绰号优先于派生的同名叫法，空的不生效', () => {
    const rules = deriveRules(
      config('张三丰', '李四光', { nicknames: [{ from: '阿丰', to: '光仔' }, { from: '张真人', to: '' }] }),
      DEFAULT_TITLE_VOCAB,
    )
    expect(rules.filter((r) => r.from === '阿丰')).toEqual([expect.objectContaining({ kind: '绰号', to: '光仔' })])
    expect(rules.some((r) => r.from === '张真人')).toBe(false)
  })
})

describe('扫描', () => {
  it('外文叫法按单词边界匹配', () => {
    expect('Ann met Anna'.match(ruleRegex('Ann'))).toEqual(['Ann'])
  })

  it('长叫法优先，不重复计算', () => {
    const card = createEmptyCard('张三丰')
    card.data.description = '张三丰是武当派掌门，大家叫他张真人，徒弟喊他三丰师父。老张今天很开心。'
    const slots = collectTextSlots(card).filter((s) => s.path.join('.') !== 'data.name')
    const rules = deriveRules(config('张三丰', '李四光', { nicknames: [{ from: '张真人', to: '李真人' }] }), DEFAULT_TITLE_VOCAB)
    const counts = countRuleHits(slots, rules)
    expect(counts.get('名字|三丰')).toBe(2)
    const hits = planRename(slots, rules)
    expect(hits.map((h) => `${h.hit.match}→${h.rule.to}`)).toEqual(['张三丰→李四光', '张真人→李真人', '三丰→四光', '老张→老李'])
  })

  it('扫描结果全部应用后各种叫法都被替换', () => {
    const card = createEmptyCard('张三丰')
    card.data.description = '他小名阿丰，师兄叫他丰哥，晚辈称他张先生。张三丰说：“老张我啊……”'
    const slots = collectTextSlots(card)
    const hits = planRename(slots, deriveRules(config('张三丰', '李四光'), DEFAULT_TITLE_VOCAB))
    applyReplacements(card, hits.map(({ hit, rule }) => ({ hit, text: rule.to })))
    expect(card.data.description).toBe('他小名阿光，师兄叫他光哥，晚辈称他李先生。李四光说：“老李我啊……”')
  })
})
