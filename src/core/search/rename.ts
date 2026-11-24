/**
 * 改名向导的规则推导与扫描。
 *
 * 把「原姓名 → 新姓名」拆成姓和名，按称谓词表派生出各种叫法（张先生、老张、阿丰、丰哥……），
 * 再加上手填的绰号和其他替换，汇总成一组「旧叫法 → 新叫法」规则。
 * 扫描时长的叫法优先，已经被占用的位置不再重复匹配。
 */
import { findInSlots, type SearchHit, type TextSlot } from './search'

export type Gender = 'any' | 'male' | 'female'

export interface NamePair {
  from: string
  to: string
}

export interface RenameConfig {
  oldFull: string
  newFull: string
  oldSurname: string
  oldGiven: string
  newSurname: string
  newGiven: string
  /** 只派生对应性别的称谓 */
  gender: Gender
  nicknames: NamePair[]
  others: NamePair[]
}

/** 称谓词表；每项是词语数组 */
export interface TitleVocab {
  /** 放在姓前面：老张、小张 */
  surnamePrefixes: string[]
  /** 放在姓后面：张老师 */
  surnameAny: string[]
  surnameMale: string[]
  surnameFemale: string[]
  /** 放在名前面：阿丰、小丰 */
  givenPrefixes: string[]
  /** 放在名后面：丰酱 */
  givenAny: string[]
  givenMale: string[]
  givenFemale: string[]
}

export const DEFAULT_TITLE_VOCAB: TitleVocab = {
  surnamePrefixes: ['老', '小', '阿'],
  surnameAny: ['老师', '同学', '医生', '总', '董', '经理', '主任', '队长', '教授', '警官', '大人', '前辈', '家', '氏'],
  surnameMale: ['先生', '公子', '少爷', '老爷', '大哥', '哥', '兄', '叔', '伯'],
  surnameFemale: ['小姐', '女士', '姑娘', '夫人', '太太', '大姐', '姐', '妹', '阿姨', '姨', '婶'],
  givenPrefixes: ['阿', '小'],
  givenAny: ['酱', '君', '桑', '同学'],
  givenMale: ['哥', '哥哥', '兄', '少'],
  givenFemale: ['姐', '姐姐', '妹', '妹妹', '儿'],
}

const LATIN_TITLES: Record<'any' | 'male' | 'female', string[]> = {
  any: ['Dr.', 'Prof.'],
  male: ['Mr.', 'Mr', 'Sir'],
  female: ['Mrs.', 'Mrs', 'Ms.', 'Ms', 'Miss', 'Lady'],
}

/** 常见复姓；拆分「欧阳锋」这类名字时用 */
const COMPOUND_SURNAMES = new Set(
  (
    '欧阳 司马 上官 诸葛 东方 皇甫 尉迟 公孙 慕容 长孙 宇文 司徒 夏侯 轩辕 令狐 端木 独孤 南宫 西门 百里 呼延 澹台 ' +
    '公冶 太史 申屠 钟离 闻人 赫连 拓跋 万俟 司空 单于 濮阳 淳于 仲孙 宗政 左丘 东郭 南门 羊舌 微生 梁丘 第五 谷梁 ' +
    '乐正 漆雕 壤驷 公良 巫马 亓官 鲜于 闾丘 东门 公西 夹谷 段干 子车 颛孙 司寇 公羊 太叔 叱干 纳兰 爱新觉罗'
  ).split(' '),
)

/** 音译名、外文名的分隔符 */
const NAME_SEPARATOR = /[·•・‧\s]+/

export function hasNameSeparator(full: string): boolean {
  return NAME_SEPARATOR.test(full.trim())
}

/**
 * 拆分姓和名。
 * 带分隔符的（克洛伊·布朗、Alice Smith）按西式顺序：第一段是名，最后一段是姓；
 * 其余按中文：复姓取两个字，否则取第一个字；只有一个字时没有姓。
 */
export function splitName(full: string): { surname: string; given: string } {
  const name = full.trim()
  if (!name) return { surname: '', given: '' }
  if (hasNameSeparator(name)) {
    const parts = name.split(NAME_SEPARATOR).filter(Boolean)
    return { surname: parts[parts.length - 1], given: parts[0] }
  }
  const chars = [...name]
  if (chars.length <= 1) return { surname: '', given: name }
  for (const len of [4, 2]) {
    if (chars.length > len && COMPOUND_SURNAMES.has(chars.slice(0, len).join(''))) {
      return { surname: chars.slice(0, len).join(''), given: chars.slice(len).join('') }
    }
  }
  return { surname: chars[0], given: chars.slice(1).join('') }
}

/** 按指定姓氏字数拆分不带分隔符的名字（手动调整拆分点用） */
export function splitNameAt(full: string, surnameLength: number): { surname: string; given: string } {
  const chars = [...full.trim()]
  const n = Math.max(0, Math.min(surnameLength, chars.length - 1))
  return { surname: chars.slice(0, n).join(''), given: chars.slice(n).join('') }
}

export type RuleKind = '全名' | '绰号' | '其他' | '名字' | '姓氏称谓' | '名字称谓'

export const RULE_KINDS: RuleKind[] = ['全名', '名字', '姓氏称谓', '名字称谓', '绰号', '其他']

export interface RenameRule {
  /** 由类型和旧叫法组成，规则重新推导后保持不变 */
  id: string
  kind: RuleKind
  from: string
  to: string
  /** 默认是否勾选；单字名单独替换容易误伤，默认不勾 */
  defaultOn: boolean
}

const isLatin = (text: string) => /^[A-Za-z]/.test(text)
const lastChar = (text: string) => [...text].slice(-1).join('')

function genderPick<T>(gender: Gender, any: T[], male: T[], female: T[]): T[] {
  return [...any, ...(gender === 'female' ? [] : male), ...(gender === 'male' ? [] : female)]
}

/** 由配置推导全部规则。旧叫法相同时，先出现的类型优先（手填的绰号、其他替换优先于自动派生的称谓） */
export function deriveRules(config: RenameConfig, vocab: TitleVocab): RenameRule[] {
  const rules: RenameRule[] = []
  const seen = new Set<string>()
  const add = (kind: RuleKind, from: string, to: string, defaultOn = true) => {
    from = from.trim()
    to = to.trim()
    if (!from || !to || from === to || seen.has(from)) return
    seen.add(from)
    rules.push({ id: `${kind}|${from}`, kind, from, to, defaultOn })
  }

  const oldFull = config.oldFull.trim()
  const newFull = config.newFull.trim()
  add('全名', oldFull, newFull)
  for (const p of config.nicknames) add('绰号', p.from, p.to)
  for (const p of config.others) add('其他', p.from, p.to)

  const { oldSurname, newSurname, oldGiven, newGiven, gender } = config
  const separated = hasNameSeparator(oldFull)

  if (oldGiven && newGiven && oldGiven !== oldFull) {
    add('名字', oldGiven, newGiven, [...oldGiven].length >= 2)
  }

  if (oldSurname && newSurname && oldSurname !== oldFull) {
    if (isLatin(oldSurname)) {
      for (const t of genderPick(gender, LATIN_TITLES.any, LATIN_TITLES.male, LATIN_TITLES.female)) {
        add('姓氏称谓', `${t} ${oldSurname}`, `${t} ${newSurname}`)
      }
    } else {
      for (const p of vocab.surnamePrefixes) add('姓氏称谓', p + oldSurname, p + newSurname)
      for (const s of genderPick(gender, vocab.surnameAny, vocab.surnameMale, vocab.surnameFemale)) {
        add('姓氏称谓', oldSurname + s, newSurname + s)
      }
    }
  }

  if (oldGiven && newGiven && !isLatin(oldGiven)) {
    const bases: Array<[string, string]> = [[oldGiven, newGiven]]
    // 双字名常用末字派生昵称（阿丰、丰哥、丰丰）；音译名不这样叫
    if (!separated && [...oldGiven].length >= 2) bases.push([lastChar(oldGiven), lastChar(newGiven)])
    const suffixes = genderPick(gender, vocab.givenAny, vocab.givenMale, vocab.givenFemale)
    for (const [from, to] of bases) {
      if (from === to) continue
      for (const p of vocab.givenPrefixes) add('名字称谓', p + from, p + to)
      for (const s of suffixes) add('名字称谓', from + s, to + s)
      if ([...from].length === 1) add('名字称谓', from + from, to + to)
    }
  }

  return rules
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 规则对应的正则；外文叫法两侧要求不是字母数字，避免 Ann 命中 Anna */
export function ruleRegex(from: string): RegExp {
  let source = escapeRegex(from)
  if (/^[A-Za-z0-9_]/.test(from)) source = `(?<![A-Za-z0-9_])${source}`
  if (/[A-Za-z0-9_]$/.test(from)) source = `${source}(?![A-Za-z0-9_])`
  return new RegExp(source, 'g')
}

/** 统计每条规则单独在卡里出现几次（不考虑长短叫法互相覆盖） */
export function countRuleHits(slots: TextSlot[], rules: RenameRule[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const rule of rules) {
    const re = ruleRegex(rule.from)
    let n = 0
    for (const slot of slots) {
      re.lastIndex = 0
      while (re.exec(slot.text)) n++
    }
    counts.set(rule.id, n)
  }
  return counts
}

export interface RenameHit {
  hit: SearchHit
  rule: RenameRule
}

/**
 * 按规则扫描。长的叫法先匹配，已被占用的位置跳过，
 * 例如“艾琳姐姐”整体替换，不会再被“艾琳”拆开。结果按出现位置排序。
 */
export function planRename(slots: TextSlot[], rules: RenameRule[]): RenameHit[] {
  const taken = new Map<number, Array<[number, number]>>()
  const out: RenameHit[] = []
  const sorted = [...rules].sort((a, b) => [...b.from].length - [...a.from].length)
  for (const rule of sorted) {
    for (const hit of findInSlots(slots, ruleRegex(rule.from), `${rule.id}|`)) {
      const spans = taken.get(hit.slotIndex) ?? []
      if (spans.some(([s, e]) => hit.start < e && hit.end > s)) continue
      spans.push([hit.start, hit.end])
      taken.set(hit.slotIndex, spans)
      out.push({ hit, rule })
    }
  }
  return out.sort((a, b) => a.hit.slotIndex - b.hit.slotIndex || a.hit.start - b.hit.start)
}
