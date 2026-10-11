import { Volume2 } from 'lucide-react'

import { Card } from '../../components/ui/Card'
import { IconButton } from '../../components/ui/IconButton'
import { SettingsSection } from '../../components/settings/SettingsSection'
import { useTranslation } from '../../i18n'
import { useSettingsStore } from '../../stores/settingsStore'
import { SPEECH_RATE_OPTIONS, formatSpeechRateLabel } from '../../lib/speech/speechRate'
import { cleanVoiceName, sampleScriptForLang } from '../../lib/speech/speechVoice'
import { speechService } from '../../lib/speech/speechService'
import { useSpeechVoices } from '../../lib/speech/useSpeechVoices'
import { SpeechVoicePicker } from './SpeechVoicePicker'

/**
 * 设置页「朗读（TTS）」分组：语速（从 GeneralSettings 迁入）+ 音色选择。
 *
 * 迁出的原因：GeneralSettings.tsx 已 1426 行，file-size 门禁不允许再长；语速与音色同属
 * 朗读偏好，合并成一个分组后 GeneralSettings 只留一行 `<SpeechSettingsSection />`。
 *
 * 降级（设计裁定）：无 speechSynthesis ⇒ **整个 section 不渲染**（含语速组）；
 * voices 读取中 ⇒ 一行「正在读取系统语音…」；voices=0 ⇒ 选择器置灰 + 说明；
 * voices=1 ⇒ 不渲染选择器，改静态说明 + 试听键。
 */
export function SpeechSettingsSection() {
  const t = useTranslation()
  const locale = useSettingsStore((state) => state.locale)
  const speechRate = useSettingsStore((state) => state.speechRate)
  const setSpeechRate = useSettingsStore((state) => state.setSpeechRate)
  const speechVoiceURI = useSettingsStore((state) => state.speechVoiceURI)
  const setSpeechVoiceURI = useSettingsStore((state) => state.setSpeechVoiceURI)
  const { supported, loading, voices } = useSpeechVoices()

  if (!supported) return null

  const onlyVoice = voices.length === 1 ? voices[0] : null
  const onlyVoiceName = onlyVoice ? cleanVoiceName(onlyVoice.name) : ''

  const renderVoiceArea = () => {
    if (loading && voices.length === 0) {
      return (
        <div data-testid="speech-voice-loading" className="text-[11px] text-[var(--color-text-tertiary)]">
          {t('speech.voiceLoading')}
        </div>
      )
    }
    if (voices.length === 0) {
      return (
        <button
          type="button"
          data-testid="speech-voice-empty"
          disabled
          className="w-full cursor-not-allowed rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left text-xs text-[var(--color-text-tertiary)] opacity-70"
        >
          {t('speech.voiceNone')}
        </button>
      )
    }
    if (onlyVoice) {
      return (
        <div data-testid="speech-voice-single" className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs text-[var(--color-text-secondary)]">
            {t('speech.voiceOnlyOne', { name: onlyVoiceName })}
          </span>
          <IconButton
            size="xs"
            shape="square"
            tone="muted"
            data-testid="speech-voice-preview-single"
            icon={<Volume2 size={12} strokeWidth={2.2} aria-hidden="true" />}
            label={t('speech.voicePreview', { name: onlyVoiceName })}
            onClick={() => {
              const sample = t(SAMPLE_KEYS_FOR_SINGLE[sampleScriptForLang(onlyVoice.lang)])
              speechService.preview(sample, onlyVoice.voiceURI)
            }}
          />
        </div>
      )
    }
    return (
      <SpeechVoicePicker
        voices={voices}
        value={speechVoiceURI}
        onChange={setSpeechVoiceURI}
        locale={locale}
      />
    )
  }

  return (
    <SettingsSection title={t('speech.settingsTitle')} description={t('speech.settingsDescription')}>
      <Card radius="xl" surface="low" padding="none" className="p-3">
        <div>
          <div id="speech-rate-label" className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            {t('speech.rateLabel')}
          </div>
          <div
            role="group"
            aria-label={t('speech.rateLabel')}
            className="mt-2 grid grid-cols-5 gap-2"
          >
            {SPEECH_RATE_OPTIONS.map((rate) => (
              <button
                key={rate}
                type="button"
                onClick={() => setSpeechRate(rate)}
                aria-pressed={speechRate === rate}
                className={`rounded-[var(--radius-lg)] border px-3 py-2 text-center text-xs font-semibold transition-colors ${
                  speechRate === rate
                    ? 'border-[var(--color-brand)] bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                }`}
              >
                {formatSpeechRateLabel(rate)}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 border-t border-[var(--color-border-separator)] pt-3">
          <div id="speech-voice-label" className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            {t('speech.voiceLabel')}
          </div>
          <div className="mt-2">{renderVoiceArea()}</div>
        </div>
      </Card>
    </SettingsSection>
  )
}

/** 唯一音色态试听：示例句按该 voice 的语言取。 */
const SAMPLE_KEYS_FOR_SINGLE = {
  zh: 'speech.previewSampleZh',
  ja: 'speech.previewSampleJa',
  ko: 'speech.previewSampleKo',
  en: 'speech.previewSampleEn',
} as const
