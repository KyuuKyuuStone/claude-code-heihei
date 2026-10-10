import { describe, expect, it } from 'vitest'

import { translate } from '..'
import { speechEn, speechJp, speechKr, speechZh, speechZhTW } from './speech'

// per-语言显式字典 + 逐键断言（不写元组解包推导：2026 年曾因拆包把五语言整体错一环）。
const LOCALES = {
  en: speechEn,
  zh: speechZh,
  'zh-TW': speechZhTW,
  jp: speechJp,
  kr: speechKr,
} as const

const KEYS = [
  'speech.play',
  'speech.pause',
  'speech.resume',
  'speech.settingsTitle',
  'speech.rateLabel',
  'speech.truncated',
  'speech.codeBlockPlaceholder',
  'speech.liveStart',
  'speech.livePaused',
  'speech.liveResumed',
] as const

describe('朗读文案表', () => {
  it('五种语言都定义了全部键，且取值非空、非键名本身', () => {
    for (const [name, dict] of Object.entries(LOCALES)) {
      for (const key of KEYS) {
        const value = (dict as Record<string, string>)[key] ?? ''
        expect(value, `${name} 缺 ${key}`).toBeTruthy()
        expect(value.trim(), `${name} 的 ${key} 为空白`).not.toBe('')
        expect(value, `${name} 的 ${key} 落回键名`).not.toBe(key)
      }
    }
  })

  it('各语言的键集合完全一致（防增加/漏掉一环）', () => {
    const counts = Object.entries(LOCALES).map(([name, dict]) => [name, Object.keys(dict).length])
    for (const [name, count] of counts) {
      expect(count, `${name} 键数不一致`).toBe(KEYS.length)
    }
  })

  it('取值确实按语言逐键对上，没有整体错位', () => {
    expect(speechZh['speech.play']).toContain('朗读')
    expect(speechEn['speech.play']).toBe('Read this message aloud')
    expect(speechZhTW['speech.play']).toContain('朗讀')
    expect(speechJp['speech.play']).toContain('読み上げ')
    expect(speechKr['speech.play']).toContain('읽어주기')
    // 逐键抽查第二列（错位最常见的表现是「配对的键值互相串行」）。
    expect(speechEn['speech.livePaused']).toBe('Paused')
    expect(speechZh['speech.livePaused']).toBe('已暂停')
    expect(speechZhTW['speech.liveResumed']).toContain('繼續')
    expect(speechJp['speech.rateLabel']).toBe('速度')
  })

  it('经 i18n 合并后 translate 能取到朗读键（五语言全覆盖）', () => {
    expect(translate('en', 'speech.play')).toBe('Read this message aloud')
    expect(translate('zh', 'speech.play')).toBe('朗读本条消息')
    expect(translate('zh-TW', 'speech.resume')).toBe('繼續朗讀')
    expect(translate('jp', 'speech.pause')).toBe('読み上げを一時停止')
    expect(translate('kr', 'speech.settingsTitle')).toBe('읽어주기')
  })
})
