import { useCallback } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { en, type TranslationKey } from './locales/en'
import { zh } from './locales/zh'
import { zh as zhTW } from './locales/zh-TW'
import { jp } from './locales/jp'
import { kr } from './locales/kr'
// 朗读（TTS）文案单开一个模块：五个 locale 主表已到 2495–2497 行，再加键会越过
// file-size 门禁（LIMIT=2500）且基线表不许新增条目。此处合并进各语言的翻译表。
import { speechEn, speechJp, speechKr, speechZh, speechZhTW, type SpeechKey } from './locales/speech'
import type { Locale } from './locale'

const translations: Record<Locale, Record<string, string>> = {
  en: { ...en, ...speechEn },
  zh: { ...zh, ...speechZh },
  'zh-TW': { ...zhTW, ...speechZhTW },
  jp: { ...jp, ...speechJp },
  kr: { ...kr, ...speechKr },
}

/**
 * 翻译键 = locale 主表键 ∪ 朗读文案模块键。
 *
 * 朗读键**不并进** `TranslationKey`（那是 `keyof typeof en`，五个 locale 文件都以
 * `Record<TranslationKey, string>` 声明自身，一旦扩键它们全体报缺失），改在这里做
 * 调用面并集：`t()` 的参数类型放宽，调用点仍写平铺字面量。
 */
export type TextKey = TranslationKey | SpeechKey

/**
 * Translate a key with optional interpolation params.
 * Falls back to the key itself if no translation is found.
 *
 * @example
 * translate('en', 'settings.providers.connected', { latency: '42' })
 * // => "Connected (42ms)"
 */
export function translate(
  locale: Locale,
  key: TextKey,
  params?: Record<string, string | number>,
): string {
  let text = translations[locale]?.[key] ?? translations.en[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return text
}

/**
 * React hook that returns a `t()` function bound to the current locale.
 * Re-renders when the locale changes.
 *
 * @example
 * const t = useTranslation()
 * t('sidebar.newSession')  // => "New session" or "新建会话"
 */
export function useTranslation() {
  const locale = useSettingsStore((s) => s.locale)
  return useCallback(
    (key: TextKey, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    [locale],
  )
}

/**
 * Get a translation outside of React (e.g. in stores).
 * Reads the current locale from the Zustand store directly.
 */
export function t(key: TextKey, params?: Record<string, string | number>): string {
  const locale = useSettingsStore.getState().locale
  return translate(locale, key, params)
}

export type { TranslationKey }
export type { Locale } from './locale'
