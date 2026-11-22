/**
 * 文本编码识别与解码：支持 BOM、声明编码、UTF-8 严格校验、无 BOM UTF-16 猜测，
 * 以及基于常用简繁体汉字命中率的 GB18030 / Big5 打分。
 */

/** 约 350 个现代汉语高频简繁体汉字（用于区分 GB18030 和 Big5） */
const COMMON_CJK_CHARS = new Set(
  '的一是不了人我在有他这這中大来來上个個国國到说說们們为為子和你地出道也时時年得就那要下以生会會自着著去之过過家学學对對可她里裡后後小么麼心多天而能好都然没沒日于於起还還发發成事只作当當想看文无無开開手十用主行方又如前所本见見经經头頭面公同三已老从從动動两兩长長知民样樣现現分将將外但身些与與高意进進把法此实實回二理美点點月明其种種声聲全工己话話儿兒者向情部正名定女问問力机機给給等几幾很业業最间間新什打便位因重被走电電四第门門相次东東政海口使教西再平真听聽世气氣信北少关關并並内內加化由却卻代军軍产產入先山五太水万萬市眼体體别別处處总總才场場师師书書比住员員九笑性通目报報立马馬命张張活难難神数數常提风風城夜雨安章卷节節集序尾端六七八百千白黑红紅青金木火土草花树樹鸟鳥鱼魚石云雲雪雷霜星辰光影梦夢死爱愛恨杀殺战戰剑劍刀王皇帝师師父父母兄妹弟姐夫妻子爷爺奶叔伯娘官军軍兵将將贼賊鬼妖魔仙佛道僧龙龍虎狼狗猫貓车車船桥橋路街院房室屋楼樓门門窗床桌椅灯燈酒茶饭飯肉衣鞋帽钱錢银銀玉珠言语文語字词詞句段篇书書画畫诗詩歌乐樂舞戏戲影剧劇看听聽读讀写寫想思念记記忘知懂明白清楚希望期待相信怀疑害怕担心高兴快乐悲伤愤怒生气哭笑叫喊问問答讲講谈談聊告诉知道觉得认为发现看见听見来到离开回去进入出来上下左右前后内外远遠近高低大小长長短宽寬窄轻輕重快慢早晚新旧舊好坏壞美丑醜真假对對错錯是非有无無',
)

const COMMON_CJK_PUNCT = new Set('，。！？；：“”‘’（）《》、…—·')

const GB_ALIASES = new Set([
  'gbk',
  'gb2312',
  'gb_2312',
  'gb_2312-80',
  'gb18030',
  'x-gbk',
  'cp936',
  'ms936',
  'csgb2312',
  'chinese',
])

const UTF8_ALIASES = new Set(['utf-8', 'utf8', 'unicode-1-1-utf-8'])

function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function normalizeDeclaredEncoding(declared: string): string {
  const lower = declared.trim().toLowerCase()
  if (!lower) return ''
  if (GB_ALIASES.has(lower)) return 'gb18030'
  return lower
}

/** 猜测无 BOM 的 UTF-16（看前 4KB 里偶数位或奇数位是否大量为 0） */
function guessUtf16WithoutBom(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const sampleLen = Math.min(bytes.length, 4096)
  const pairs = Math.floor(sampleLen / 2)
  if (pairs < 4) return null

  let evenZeros = 0
  let oddZeros = 0
  for (let i = 0; i < pairs * 2; i += 2) {
    if (bytes[i] === 0) evenZeros++
    if (bytes[i + 1] === 0) oddZeros++
  }

  const evenRatio = evenZeros / pairs
  const oddRatio = oddZeros / pairs

  if (oddRatio >= 0.25 && evenRatio <= 0.05) return 'utf-16le'
  if (evenRatio >= 0.25 && oddRatio <= 0.05) return 'utf-16be'
  return null
}

/** 给解码样本打分：常用简繁汉字与标点加分，替换字符和控制字符扣分 */
function scoreDecodedSample(text: string, truncated: boolean): number {
  let score = 0
  // 若样本在 64KB 处硬截断，忽略末尾可能因截断半个字符产生的替换字符
  const end = truncated && text.length > 0 ? text.length - 1 : text.length
  for (let i = 0; i < end; i++) {
    const ch = text[i]
    const code = ch.charCodeAt(0)
    if (code === 0xfffd) {
      score -= 6
    } else if (COMMON_CJK_CHARS.has(ch)) {
      score += 3
    } else if (COMMON_CJK_PUNCT.has(ch)) {
      score += 2
    } else if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x0c) {
      score -= 3
    } else if (code >= 0xe000 && code <= 0xf8ff) {
      score -= 2
    }
  }
  return score
}

/** 按 BOM → 声明编码 → UTF-8 严格解码 → 无 BOM UTF-16 → GB18030/Big5 打分顺序解码字节 */
export function decodeText(bytes: Uint8Array, declared?: string): { text: string; encoding: string } {
  if (bytes.length === 0) {
    return { text: '', encoding: 'utf-8' }
  }

  // 1. BOM 检测（优先于一切猜测）
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = new TextDecoder('utf-8').decode(bytes.subarray(3))
    return { text, encoding: 'utf-8' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = new TextDecoder('utf-16le').decode(bytes.subarray(2))
    return { text, encoding: 'utf-16le' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const text = new TextDecoder('utf-16be').decode(bytes.subarray(2))
    return { text, encoding: 'utf-16be' }
  }

  // 2. 声明的编码（TextDecoder 认识才用；gbk/gb2312 统一按 gb18030）
  if (declared) {
    const label = normalizeDeclaredEncoding(declared)
    if (label) {
      if (UTF8_ALIASES.has(label)) {
        // 声明 utf-8 时先严格验证，失败则回退到后续编码猜测（防止标错头的中文文件乱码）
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          return { text: stripLeadingBom(text), encoding: 'utf-8' }
        } catch {
          // 继续往下猜
        }
      } else {
        try {
          const decoder = new TextDecoder(label)
          const text = decoder.decode(bytes)
          return { text: stripLeadingBom(text), encoding: decoder.encoding }
        } catch {
          // TextDecoder 不认识的编码名，忽略并继续
        }
      }
    }
  }

  // 3. 无 BOM 的 UTF-16 猜测：要在 UTF-8 之前，纯英文的 UTF-16 每隔一个字节是 0，按 UTF-8 也能“成功”解码
  const utf16 = guessUtf16WithoutBom(bytes)
  if (utf16) {
    const text = new TextDecoder(utf16).decode(bytes)
    return { text: stripLeadingBom(text), encoding: utf16 }
  }

  // 4. UTF-8 严格解码
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { text: stripLeadingBom(text), encoding: 'utf-8' }
  } catch {
    // 非合法 UTF-8
  }

  // 5. GB18030 与 Big5 打分择优
  const truncated = bytes.length > 65536
  const sample = truncated ? bytes.subarray(0, 65536) : bytes

  let gbScore = -Infinity
  let big5Score = -Infinity

  try {
    const gbSample = new TextDecoder('gb18030').decode(sample)
    gbScore = scoreDecodedSample(gbSample, truncated)
  } catch {
    // 运行时不支持时忽略
  }

  try {
    const big5Sample = new TextDecoder('big5').decode(sample)
    big5Score = scoreDecodedSample(big5Sample, truncated)
  } catch {
    // 运行时不支持时忽略
  }

  if (big5Score > gbScore && big5Score > 0) {
    const text = new TextDecoder('big5').decode(bytes)
    return { text: stripLeadingBom(text), encoding: 'big5' }
  }

  const text = new TextDecoder('gb18030').decode(bytes)
  return { text: stripLeadingBom(text), encoding: 'gb18030' }
}
