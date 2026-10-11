/**
 * speechVoice —— 朗读音色：书写系统识别 + 默认音色择优（打分）+ 名称清洗 + 持久化。
 *
 * 为什么单开一个模块（架构师方案 5b8efdef）：speechService 是引擎与队列，音色挑选是
 * 纯策略，混在一个文件里既撑大行数（file-size 门禁）也让策略不可单测。此处全部是
 * 纯函数 + localStorage 读写，**不 import stores/**（沿用 speechRate.ts 的纪律：
 * 偏好走本地存储，不碰服务端 updateUser/schema）。
 *
 * 打分口径（主管裁：**音质优先**）：先按 `detectSpeechScript` 定目标语言过滤出候选池，
 * 再池内打分取最高 —— 远端 Natural 压过 localService；离线（localService）只作
 * **同分档** tiebreak。池空 ⇒ 退回全 voice 池打分；仍空 ⇒ null（用系统默认 voice）。
 */

/** localStorage 键；值 = voiceURI 字符串，**空串 = 自动（择优）**。 */
export const SPEECH_VOICE_STORAGE_KEY = 'cc-heihei-speech-voice'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function getDefaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** 读取已选音色 voiceURI；未设置/受限上下文 ⇒ 空串（自动）。 */
export function readStoredSpeechVoiceURI(storage: StorageLike | null = getDefaultStorage()): string {
  if (!storage) return ''
  try {
    return storage.getItem(SPEECH_VOICE_STORAGE_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

/** 持久化所选音色 voiceURI（空串 = 自动）。 */
export function persistSpeechVoiceURI(
  voiceURI: string,
  storage: StorageLike | null = getDefaultStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(SPEECH_VOICE_STORAGE_KEY, voiceURI ?? '')
  } catch {
    // 受限上下文：静默降级（偏好丢失，功能不受阻）。
  }
}

// ---------------------------------------------------------------- 书写系统

/** 朗读文本所属的书写系统（决定挑哪个语言的 voice）。 */
export type SpeechScript = 'ja' | 'ko' | 'zh' | 'en'

/** 假名（平假名/片假名）。 */
const KANA_RE = /[\u3040-\u309f\u30a0-\u30ff]/g
/** 谚文（jamo + 兼容字母 + 音节）。 */
const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/g
/** 汉字（扩展 A + 基本区 + 兼容表意）。 */
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g

/** 统计文本中命中某字符集的字符数（`match` 传全局正则，不看 lastIndex）。 */
function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

/**
 * 按书写系统分流：统计假名/谚文/汉字的**字符数**，取计数最多者 ——
 * 假名最多 → ja、谚文最多 → ko、汉字最多 → zh、三者皆 0 → en。
 *
 * 取代旧口径「CJK 一律按 zh」；也不按「出现即选」——一条以中文为主、只夹一个假名的
 * 消息若整条改用 ja 音色，汉字会被念成日语音读，比原问题更糟，故按多数判定。
 * 平局按 ja > ko > zh 的次序裁决。
 */
export function detectSpeechScript(text: string): SpeechScript {
  const kana = countMatches(text, KANA_RE)
  const hangul = countMatches(text, HANGUL_RE)
  const han = countMatches(text, HAN_RE)
  const max = Math.max(kana, hangul, han)
  if (max === 0) return 'en'
  if (kana === max) return 'ja'
  if (hangul === max) return 'ko'
  return 'zh'
}

/** 目标语言码前缀（voice.lang 以它开头即入池）。 */
function langPrefixOf(script: SpeechScript): string {
  return script
}

/** 语言池：lang 前缀命中目标语言；空数组表示池空。 */
export function languagePool(text: string, voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  const prefix = langPrefixOf(detectSpeechScript(text))
  return voices.filter((voice) => (voice.lang ?? '').toLowerCase().startsWith(prefix))
}

// ---------------------------------------------------------------- 打分

/** 音质加分（累加）。 */
const QUALITY_RULES: ReadonlyArray<{ pattern: RegExp; score: number }> = [
  { pattern: /natural/i, score: 100 },
  { pattern: /neural|online/i, score: 80 },
  { pattern: /premium|enhanced/i, score: 60 },
]

/** 机械音降权（累加）。`Desktop` 只认**后缀**（'… Desktop'），避免误伤含该词的正常名。 */
const PENALTY_RULES: ReadonlyArray<{ pattern: RegExp; score: number }> = [
  { pattern: /espeak/i, score: -100 },
  { pattern: /desktop\s*$/i, score: -80 },
  { pattern: /huihui|yaoyao|kangkang|lili/i, score: -80 },
  { pattern: /compact/i, score: -50 },
]

/** 离线（本地引擎）加分：仅作**同分档** tiebreak。 */
export const SPEECH_VOICE_LOCAL_BONUS = 20
/** 系统默认音色加分。 */
export const SPEECH_VOICE_DEFAULT_BONUS = 10

/** zh 池内地区加分：简体优先，其次繁体，再次港区。 */
const ZH_REGION_RULES: ReadonlyArray<{ pattern: RegExp; score: number }> = [
  { pattern: /^zh-CN/i, score: 30 },
  { pattern: /^zh-TW/i, score: 15 },
  { pattern: /^zh-HK/i, score: 5 },
]

/**
 * 主分（音质 + 机械音降权 + zh 地区）。**离线/系统默认不计入主分**——它们是同分档
 * 才生效的裁决项（见 scoreVoiceTiebreak），否则「远端 Natural 压过本地普通声」会被
 * 离线加分掀翻，与「音质优先」的口径相反。
 */
export function scoreVoice(voice: SpeechSynthesisVoice, script: SpeechScript): number {
  // 只在 name 上匹配：`Desktop` 后缀这类锚定规则用 voiceURI 拼串会失锚。
  const name = voice.name ?? ''
  let score = 0
  for (const rule of QUALITY_RULES) if (rule.pattern.test(name)) score += rule.score
  for (const rule of PENALTY_RULES) if (rule.pattern.test(name)) score += rule.score
  if (script === 'zh') {
    const lang = voice.lang ?? ''
    for (const rule of ZH_REGION_RULES) {
      if (rule.pattern.test(lang)) {
        score += rule.score
        break
      }
    }
  }
  return score
}

/** 同分档裁决分：离线 +20、系统默认 +10（只在主分相等时参与比较）。 */
export function scoreVoiceTiebreak(voice: SpeechSynthesisVoice): number {
  return (voice.localService === true ? SPEECH_VOICE_LOCAL_BONUS : 0)
    + (voice.default === true ? SPEECH_VOICE_DEFAULT_BONUS : 0)
}

/** 池内择优：主分最高；主分相同看裁决分；仍同保持原顺序（稳定）。 */
export function bestVoiceIn(text: string, voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null
  const script = detectSpeechScript(text)
  let best: SpeechSynthesisVoice | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  let bestTiebreak = Number.NEGATIVE_INFINITY
  for (const voice of voices) {
    const score = scoreVoice(voice, script)
    const tiebreak = scoreVoiceTiebreak(voice)
    if (best === null || score > bestScore || (score === bestScore && tiebreak > bestTiebreak)) {
      best = voice
      bestScore = score
      bestTiebreak = tiebreak
    }
  }
  return best
}

/**
 * 默认择优：目标语言池内择优；池空 ⇒ 全 voice 池打分；仍空 ⇒ null（系统默认）。
 */
export function bestVoice(
  text: string,
  voices: readonly SpeechSynthesisVoice[],
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null
  const pool = languagePool(text, voices)
  return bestVoiceIn(text, pool.length > 0 ? pool : voices)
}

/**
 * 解析最终使用的 voice（回退链）：
 * ① `storedURI` 在 voices 里命中 ⇒ 用它；
 * ② 未命中（语音包被卸 / 远端离线 / voices 尚未就绪）⇒ 择优打分；
 * ③ 仍无 ⇒ null（系统默认 voice）。
 *
 * 未命中**不报错、不清存储值**——用户选过的音色在语音包回来后应自动生效。
 */
export function resolveVoice(
  text: string,
  voices: readonly SpeechSynthesisVoice[],
  storedURI: string,
): SpeechSynthesisVoice | null {
  if (storedURI) {
    const hit = voices.find((voice) => voice.voiceURI === storedURI)
    if (hit) return hit
  }
  return bestVoice(text, voices)
}

// ---------------------------------------------------------------- 名称清洗

/** 模板名的主/尾分隔（'… Online (Natural) - Chinese (Mainland)'）。 */
const TEMPLATE_SEPARATOR_RE = /\s+[-–—]\s+/
/** 括号内的音质描述词。 */
const DESCRIPTOR_PAREN_RE = /\((?:online|natural|neural|enhanced|premium)\)/gi
/** 裸音质描述词。 */
const DESCRIPTOR_WORD_RE = /\b(?:online|natural|neural|enhanced|premium)\b/gi

/**
 * 名称清洗：剥 `Microsoft ` 前缀与 ` Online (Natural) - Chinese (Mainland)` 这类模板尾
 * ⇒ 主标题「人名 · 语言」。**识别失败（没有模板尾）回落原名**（保守兜底：宁可显示长名，
 * 也不要把「Google 普通话（中国大陆）」这类非模板名切坏）。
 */
export function cleanVoiceName(name: string): string {
  const raw = (name ?? '').trim()
  if (!raw) return raw
  const parts = raw.split(TEMPLATE_SEPARATOR_RE)
  if (parts.length < 2) return raw
  const language = parts.slice(1).join(' - ').trim()
  const person = (parts[0] ?? '')
    .replace(/^Microsoft\s+/i, '')
    .replace(DESCRIPTOR_PAREN_RE, ' ')
    .replace(DESCRIPTOR_WORD_RE, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!person || !language) return raw
  return `${person} · ${language}`
}

// ---------------------------------------------------------------- 分组

/** voice.lang 的主语言码（'zh-CN' → 'ZH'，'en' → 'EN'）。 */
export function primaryLangCode(lang: string): string {
  const head = (lang ?? '').split(/[-_]/)[0]?.trim() ?? ''
  return head.toUpperCase() || '—'
}

export type VoiceGroup = {
  /** 组头：主语言码（大写）。 */
  code: string
  voices: SpeechSynthesisVoice[]
}

/**
 * 按主语言码分组：**界面语言匹配的组置顶**，其余按码字母序（稳定保持组内原顺序）。
 */
export function groupVoices(
  voices: readonly SpeechSynthesisVoice[],
  preferredCode?: string,
): VoiceGroup[] {
  const byCode = new Map<string, SpeechSynthesisVoice[]>()
  for (const voice of voices) {
    const code = primaryLangCode(voice.lang ?? '')
    const bucket = byCode.get(code)
    if (bucket) bucket.push(voice)
    else byCode.set(code, [voice])
  }
  const preferred = (preferredCode ?? '').trim().toUpperCase()
  return Array.from(byCode, ([code, list]) => ({ code, voices: list })).sort((a, b) => {
    if (preferred) {
      if (a.code === preferred && b.code !== preferred) return -1
      if (b.code === preferred && a.code !== preferred) return 1
    }
    return a.code.localeCompare(b.code)
  })
}

/** 试听示例句所用语言（按 voice.lang 定；认不出回落 en）。 */
export function sampleScriptForLang(lang: string): SpeechScript {
  const lower = (lang ?? '').toLowerCase()
  if (lower.startsWith('ja')) return 'ja'
  if (lower.startsWith('ko')) return 'ko'
  if (lower.startsWith('zh')) return 'zh'
  if (lower.startsWith('en')) return 'en'
  return 'en'
}
