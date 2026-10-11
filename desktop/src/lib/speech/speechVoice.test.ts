import { describe, expect, it } from 'vitest'

import {
  SPEECH_VOICE_STORAGE_KEY,
  bestVoice,
  bestVoiceIn,
  cleanVoiceName,
  detectSpeechScript,
  groupVoices,
  languagePool,
  persistSpeechVoiceURI,
  primaryLangCode,
  readStoredSpeechVoiceURI,
  resolveVoice,
  scoreVoice,
  type SpeechScript,
} from './speechVoice'

function voice(
  input: { name: string; lang: string; localService?: boolean; default?: boolean; voiceURI?: string },
): SpeechSynthesisVoice {
  const { name, lang, localService = true, default: isDefault = false, voiceURI } = input
  return { name, lang, localService, default: isDefault, voiceURI: voiceURI ?? name } as unknown as SpeechSynthesisVoice
}

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    dump: () => Object.fromEntries(map),
  }
}

describe('speechVoice 打分与择优', () => {
  it('音质优先：Natural > 系统默认 > Huihui > espeak（同一 zh 池内）', () => {
    const natural = voice({ name: 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)', lang: 'zh-CN' })
    const system = voice({ name: 'System Voice', lang: 'zh-CN', default: true })
    const huihui = voice({ name: 'Microsoft Huihui - Chinese (Simplified)', lang: 'zh-CN' })
    const espeak = voice({ name: 'eSpeak Mandarin', lang: 'zh-CN' })
    const all = [espeak, huihui, system, natural]
    expect(bestVoiceIn('你好', all)?.name).toBe(natural.name)
    // 顺序确实由分数决定（不是「取第一个」的巧合）。
    expect(scoreVoice(natural, 'zh')).toBeGreaterThan(scoreVoice(system, 'zh'))
    expect(scoreVoice(system, 'zh')).toBeGreaterThan(scoreVoice(huihui, 'zh'))
    expect(scoreVoice(huihui, 'zh')).toBeGreaterThan(scoreVoice(espeak, 'zh'))
  })

  it('zh 文本下 zh-CN 胜 zh-TW / zh-HK（地区加分）', () => {
    const cn = voice({ name: 'Xiaoxiao', lang: 'zh-CN' })
    const tw = voice({ name: 'Xiaoxiao', lang: 'zh-TW' })
    const hk = voice({ name: 'Xiaoxiao', lang: 'zh-HK' })
    expect(bestVoiceIn('你好世界', [tw, hk, cn])?.lang).toBe('zh-CN')
    expect(bestVoiceIn('你好世界', [hk, tw])?.lang).toBe('zh-TW')
  })

  it('localService 只在同分档 tiebreak：远端 Natural 压过本地普通声', () => {
    const remoteNatural = voice({ name: 'Microsoft Aria Online (Natural)', lang: 'en-US', localService: false })
    const localPlain = voice({ name: 'Plain Engine Voice', lang: 'en-US', localService: true })
    expect(bestVoiceIn('hello', [localPlain, remoteNatural])?.name).toBe(remoteNatural.name)
    // 同分档：离线优先（其余条件完全一致）。
    const localSame = voice({ name: 'Same Name', lang: 'en-US', localService: true })
    const remoteSame = voice({ name: 'Same Name', lang: 'en-US', localService: false })
    expect(bestVoiceIn('hello', [remoteSame, localSame])?.localService).toBe(true)
  })

  it('语言池：按书写系统过滤；池空时 bestVoice 退回全池', () => {
    const all = [voice({ name: 'en', lang: 'en-US' }), voice({ name: 'ja', lang: 'ja-JP' })]
    expect(languagePool('こんにちは', all).map((v) => v.lang)).toEqual(['ja-JP'])
    expect(bestVoice('こんにちは', all)?.lang).toBe('ja-JP')
    // 无 ja voice ⇒ 全池择优（新口径）。
    expect(bestVoice('こんにちは', [voice({ name: 'en', lang: 'en-US' })])?.lang).toBe('en-US')
    expect(bestVoice('hello', [])).toBeNull()
  })

  it('detectSpeechScript 从本模块导出且行为不变（服务端同样再导出）', () => {
    const cases: Array<[string, SpeechScript]> = [
      ['こんにちは', 'ja'],
      ['안녕하세요', 'ko'],
      ['中文句子', 'zh'],
      ['plain ascii', 'en'],
      ['こんにちは、你好你好你好', 'zh'],
    ]
    for (const [text, expected] of cases) expect(detectSpeechScript(text)).toBe(expected)
  })
})

describe('speechVoice 名称清洗', () => {
  it('模板名 ⇒「人名 · 语言」', () => {
    expect(cleanVoiceName('Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)'))
      .toBe('Xiaoxiao · Chinese (Mainland)')
    expect(cleanVoiceName('Microsoft Huihui - Chinese (Simplified)'))
      .toBe('Huihui · Chinese (Simplified)')
    expect(cleanVoiceName('Google 日本語 - Japanese')).toBe('Google 日本語 · Japanese')
  })

  it('识别失败（无模板尾）回落原名', () => {
    expect(cleanVoiceName('Google 普通话（中国大陆）')).toBe('Google 普通话（中国大陆）')
    expect(cleanVoiceName('Plain Voice')).toBe('Plain Voice')
    expect(cleanVoiceName('')).toBe('')
  })
})

describe('speechVoice 持久化与回退链', () => {
  it('读写：空串 = 自动；写入后读回同一 voiceURI', () => {
    const storage = memoryStorage()
    expect(readStoredSpeechVoiceURI(storage)).toBe('')
    persistSpeechVoiceURI('Microsoft Xiaoxiao', storage)
    expect(storage.dump()[SPEECH_VOICE_STORAGE_KEY]).toBe('Microsoft Xiaoxiao')
    expect(readStoredSpeechVoiceURI(storage)).toBe('Microsoft Xiaoxiao')
  })

  it('resolveVoice 命中存储值 ⇒ 用它（即便不是择优结果）', () => {
    const chosen = voice({ name: 'Huihui', lang: 'zh-CN', voiceURI: 'uri-huihui' })
    const better = voice({ name: 'Xiaoxiao Online (Natural)', lang: 'zh-CN', voiceURI: 'uri-natural' })
    expect(resolveVoice('你好', [better, chosen], 'uri-huihui')?.voiceURI).toBe('uri-huihui')
  })

  it('resolveVoice 未命中 ⇒ 回落择优，且**不清存储值**', () => {
    const storage = memoryStorage({ [SPEECH_VOICE_STORAGE_KEY]: 'gone-uri' })
    const voices = [voice({ name: 'Plain', lang: 'zh-CN', voiceURI: 'uri-plain' })]
    expect(resolveVoice('你好', voices, readStoredSpeechVoiceURI(storage))?.voiceURI).toBe('uri-plain')
    expect(readStoredSpeechVoiceURI(storage)).toBe('gone-uri')
  })

  it('voices 全空 ⇒ null（用系统默认 voice）', () => {
    expect(resolveVoice('你好', [], 'uri-any')).toBeNull()
  })
})

describe('speechVoice 分组', () => {
  it('界面语言匹配组置顶，其余按码字母序', () => {
    const voices = [
      voice({ name: 'a', lang: 'en-US' }),
      voice({ name: 'b', lang: 'zh-CN' }),
      voice({ name: 'c', lang: 'ja-JP' }),
      voice({ name: 'd', lang: 'zh-TW' }),
    ]
    const groups = groupVoices(voices, primaryLangCode('zh'))
    expect(groups.map((group) => group.code)).toEqual(['ZH', 'EN', 'JA'])
    expect(groups[0]!.voices.map((v) => v.lang)).toEqual(['zh-CN', 'zh-TW'])
    expect(groups.map((group) => group.voices.length)).toEqual([2, 1, 1])
  })

  it('无偏好时纯字母序', () => {
    const voices = [voice({ name: 'a', lang: 'ko-KR' }), voice({ name: 'b', lang: 'en-US' })]
    expect(groupVoices(voices).map((group) => group.code)).toEqual(['EN', 'KO'])
  })

  it('primaryLangCode：取主码并大写', () => {
    expect(primaryLangCode('zh-CN')).toBe('ZH')
    expect(primaryLangCode('en')).toBe('EN')
    expect(primaryLangCode('')).toBe('—')
  })
})
