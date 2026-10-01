// v1.7.0 结构拆分第②批：output-style 内建样式标签辅助从
// pages/settings/GeneralSettings.tsx 逐字移出（原 pages/Settings.tsx 58-70、
// 1535-1587 行），逻辑零改动；仅导出供 GeneralSettings 引用的三个函数。

import type { TranslationKey } from '../../i18n'
import type { OutputStyleSource } from '../../types/settings'

const BUILT_IN_OUTPUT_STYLE_TRANSLATION_KEYS = {
  default: {
    label: 'settings.general.outputStyleBuiltin.default.label',
    description: 'settings.general.outputStyleBuiltin.default.description',
  },
  Explanatory: {
    label: 'settings.general.outputStyleBuiltin.explanatory.label',
    description: 'settings.general.outputStyleBuiltin.explanatory.description',
  },
  Learning: {
    label: 'settings.general.outputStyleBuiltin.learning.label',
    description: 'settings.general.outputStyleBuiltin.learning.description',
  },
} satisfies Record<string, { label: TranslationKey; description: TranslationKey }>

function getBuiltInOutputStyleTranslationKeys(style: {
  value: string
  source: OutputStyleSource
}) {
  if (style.source !== 'built-in') return null
  return BUILT_IN_OUTPUT_STYLE_TRANSLATION_KEYS[
    style.value as keyof typeof BUILT_IN_OUTPUT_STYLE_TRANSLATION_KEYS
  ] ?? null
}

export function getOutputStyleLabel(
  style: {
    value: string
    label: string
    source: OutputStyleSource
  },
  t: (key: TranslationKey) => string,
) {
  const keys = getBuiltInOutputStyleTranslationKeys(style)
  return keys ? t(keys.label) : style.label
}

export function getOutputStyleDescription(
  style: {
    value: string
    description: string
    source: OutputStyleSource
  },
  t: (key: TranslationKey) => string,
) {
  const keys = getBuiltInOutputStyleTranslationKeys(style)
  return keys ? t(keys.description) : style.description
}

export function getOutputStyleSourceLabel(
  source: OutputStyleSource,
  t: (key: TranslationKey) => string,
) {
  switch (source) {
    case 'built-in':
      return t('settings.general.outputStyleSourceBuiltIn')
    case 'userSettings':
      return t('settings.general.outputStyleSourceUser')
    case 'projectSettings':
      return t('settings.general.outputStyleSourceProject')
    case 'localSettings':
      return t('settings.general.outputStyleSourceLocal')
    case 'policySettings':
      return t('settings.general.outputStyleSourcePolicy')
    case 'plugin':
      return t('settings.general.outputStyleSourcePlugin')
  }
}
