import { describe, expect, it } from 'vitest'

import {
  SPEECH_RATE_DEFAULT,
  SPEECH_RATE_MAX,
  SPEECH_RATE_OPTIONS,
  SPEECH_RATE_STORAGE_KEY,
  formatSpeechRateLabel,
  normalizeSpeechRate,
  persistSpeechRate,
  readStoredSpeechRate,
} from './speechRate'

function makeStorage(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial }
  return {
    getItem: (key: string): string | null => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value
    },
    dump: () => data,
  }
}

describe('speechRate 偏好', () => {
  it('normalize：越界收敛到 0.5–2.0，非法值回默认 1', () => {
    expect(normalizeSpeechRate(1.5)).toBe(1.5)
    expect(normalizeSpeechRate(0.1)).toBe(0.5)
    expect(normalizeSpeechRate(9)).toBe(2)
    expect(normalizeSpeechRate('1.25')).toBe(1.25)
    expect(normalizeSpeechRate('abc')).toBe(SPEECH_RATE_DEFAULT)
    expect(normalizeSpeechRate(null)).toBe(SPEECH_RATE_DEFAULT)
    expect(normalizeSpeechRate(Number.NaN)).toBe(SPEECH_RATE_DEFAULT)
    expect(normalizeSpeechRate(0.333)).toBe(0.5)
    expect(normalizeSpeechRate(1.234)).toBe(1.23)
  })

  it('read：无存储/无键回默认，坏值回默认，好值原样取出', () => {
    expect(readStoredSpeechRate(null)).toBe(SPEECH_RATE_DEFAULT)
    expect(readStoredSpeechRate(makeStorage())).toBe(SPEECH_RATE_DEFAULT)
    expect(readStoredSpeechRate(makeStorage({ [SPEECH_RATE_STORAGE_KEY]: 'oops' }))).toBe(SPEECH_RATE_DEFAULT)
    expect(readStoredSpeechRate(makeStorage({ [SPEECH_RATE_STORAGE_KEY]: '1.5' }))).toBe(1.5)
  })

  it('persist：写入规范化后的值；无存储时不抛错', () => {
    const storage = makeStorage()
    persistSpeechRate(1.5, storage)
    expect(storage.dump()[SPEECH_RATE_STORAGE_KEY]).toBe('1.5')
    persistSpeechRate(5, storage)
    expect(storage.dump()[SPEECH_RATE_STORAGE_KEY]).toBe(String(SPEECH_RATE_MAX))
    expect(() => persistSpeechRate(1, null)).not.toThrow()
  })

  it('档位：0.75/1/1.25/1.5/2，默认 1 在其中', () => {
    expect([...SPEECH_RATE_OPTIONS]).toEqual([0.75, 1, 1.25, 1.5, 2])
    expect(SPEECH_RATE_OPTIONS).toContain(SPEECH_RATE_DEFAULT)
  })

  it('档位文案用数字倍率（跨语言免翻译）', () => {
    expect(formatSpeechRateLabel(1)).toBe('1×')
    expect(formatSpeechRateLabel(0.75)).toBe('0.75×')
    expect(formatSpeechRateLabel(1.25)).toBe('1.25×')
  })
})
