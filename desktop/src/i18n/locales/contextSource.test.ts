import { describe, expect, it } from 'vitest'

import { translate } from '..'
import {
  contextSourceEn,
  contextSourceJp,
  contextSourceKr,
  contextSourceZh,
  contextSourceZhTW,
} from './contextSource'

// per-语言显式字典 + 逐键断言（不写元组解包推导：2026 年曾因拆包把五语言整体错一环）。
const LOCALES = {
  en: contextSourceEn,
  zh: contextSourceZh,
  'zh-TW': contextSourceZhTW,
  jp: contextSourceJp,
  kr: contextSourceKr,
} as const

const KEYS = [
  'contextIndicator.sourceProvider',
  'contextIndicator.basisProvider',
  'contextIndicator.basisEstimate',
  'contextIndicator.outputNotCounted',
] as const

describe('上下文基准文案表', () => {
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
    for (const [name, dict] of Object.entries(LOCALES)) {
      expect(Object.keys(dict).length, `${name} 键数不一致`).toBe(KEYS.length)
    }
  })

  it('取值确实按语言逐键对上，没有整体错位', () => {
    expect(contextSourceZh['contextIndicator.sourceProvider']).toBe('实测')
    expect(contextSourceEn['contextIndicator.sourceProvider']).toBe('Measured')
    expect(contextSourceZhTW['contextIndicator.sourceProvider']).toBe('實測')
    expect(contextSourceJp['contextIndicator.sourceProvider']).toBe('実測')
    expect(contextSourceKr['contextIndicator.sourceProvider']).toBe('실측')
    // 第二列抽查（错位最常见的表现是「配对的键值互相串行」）。
    expect(contextSourceZh['contextIndicator.outputNotCounted']).toContain('不计入上下文')
    expect(contextSourceEn['contextIndicator.basisEstimate']).toBe('Estimated from the transcript')
    expect(contextSourceJp['contextIndicator.basisProvider']).toContain('実測値')
    expect(contextSourceKr['contextIndicator.basisEstimate']).toContain('추정')
  })

  it('经 i18n 合并后 translate 能取到新键（五语言全覆盖）', () => {
    expect(translate('en', 'contextIndicator.sourceProvider')).toBe('Measured')
    expect(translate('zh', 'contextIndicator.basisProvider')).toBe('基于上一轮调用实测')
    expect(translate('zh-TW', 'contextIndicator.basisEstimate')).toBe('基於轉寫估算')
    expect(translate('jp', 'contextIndicator.outputNotCounted')).toContain('前回の出力')
    expect(translate('kr', 'contextIndicator.sourceProvider')).toBe('실측')
  })
})
