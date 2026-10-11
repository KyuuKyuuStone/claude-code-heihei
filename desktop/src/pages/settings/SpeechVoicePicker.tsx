import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { Check, ChevronDown, Square, Volume2 } from 'lucide-react'

import { IconButton } from '../../components/ui/IconButton'
import { useTranslation } from '../../i18n'
import type { Locale } from '../../i18n'
import { speechService } from '../../lib/speech/speechService'
import {
  cleanVoiceName,
  groupVoices,
  primaryLangCode,
  type SpeechScript,
} from '../../lib/speech/speechVoice'

/** 试听示例句按**音色语言**取用（与界面语言无关）。 */
const SAMPLE_KEYS: Record<SpeechScript, 'speech.previewSampleZh' | 'speech.previewSampleJa' | 'speech.previewSampleKo' | 'speech.previewSampleEn'> = {
  zh: 'speech.previewSampleZh',
  ja: 'speech.previewSampleJa',
  ko: 'speech.previewSampleKo',
  en: 'speech.previewSampleEn',
}

/**
 * 界面语言 → 音色目标：`group` 必须与 groupVoices 的组头同源（**小组语言码**，不是界面码），
 * 否则 jp/kr 界面的同语言组不会置顶（JP/KR 组头并不存在，实际是 JA/KO）。
 * `sample` 是该语言试听示例句所用的语言。
 */
const UI_LOCALE_VOICE_TARGET: Record<string, { group: string; sample: SpeechScript }> = {
  zh: { group: 'ZH', sample: 'zh' },
  'zh-TW': { group: 'ZH', sample: 'zh' },
  en: { group: 'EN', sample: 'en' },
  jp: { group: 'JA', sample: 'ja' },
  kr: { group: 'KO', sample: 'ko' },
}

/** voice.lang → 示例句语言；认不出按 en（与 speechVoice.sampleScriptForLang 同口径，此处不引它以免多一层导入）。 */
function sampleScriptForLang(lang: string): SpeechScript {
  const lower = (lang ?? '').toLowerCase()
  if (lower.startsWith('ja')) return 'ja'
  if (lower.startsWith('ko')) return 'ko'
  if (lower.startsWith('zh')) return 'zh'
  return 'en'
}

type Row =
  | { kind: 'auto' }
  | { kind: 'voice'; voice: SpeechSynthesisVoice }

type Props = {
  voices: SpeechSynthesisVoice[]
  /** 已选 voiceURI；'' = 自动（推荐）。 */
  value: string
  onChange: (voiceURI: string) => void
  locale: Locale
  /**
   * 可见音色小标签的 `id`：`aria-labelledby` 必须指向**真实存在**的元素，
   * 否则读屏只会念「无名按钮 / 无名列表」（审查 L1）。
   */
  labelId: string
}

const TRIGGER_CLASS =
  'w-full rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs'

/** 音色选择器：触发钮 + 弹层（搜索 + 分组列表 + 每行试听）。 */
export function SpeechVoicePicker({ voices, value, onChange, locale, labelId }: Props) {
  const t = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const optionRefs = useRef<Array<HTMLDivElement | null>>([])
  const snapshot = useSyncExternalStore(
    speechService.subscribe,
    speechService.getSnapshot,
    speechService.getSnapshot,
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return voices
    return voices.filter((voice) => {
      const name = (voice.name ?? '').toLowerCase()
      const lang = (voice.lang ?? '').toLowerCase()
      return name.includes(q) || lang.includes(q)
    })
  }, [query, voices])

  const groups = useMemo(
    () => groupVoices(filtered, UI_LOCALE_VOICE_TARGET[locale]?.group ?? primaryLangCode(locale)),
    [filtered, locale],
  )

  // 键盘在**扁平行序**上移动（auto 恒为第 0 行），indexByURI 供分组渲染回查行号。
  const { rows, indexByURI } = useMemo(() => {
    const list: Row[] = [{ kind: 'auto' }]
    const map = new Map<string, number>()
    for (const group of groups) {
      for (const voice of group.voices) {
        map.set(voice.voiceURI, list.length)
        list.push({ kind: 'voice', voice })
      }
    }
    return { rows: list, indexByURI: map }
  }, [groups])

  const selectedIndex = useMemo(
    () => rows.findIndex((row) => (row.kind === 'auto' ? value === '' : row.voice.voiceURI === value)),
    [rows, value],
  )

  const selectedVoice = useMemo(
    () => voices.find((voice) => voice.voiceURI === value) ?? null,
    [value, voices],
  )

  // 打开时焦点进搜索框（设计师规范）；关闭后归还触发钮。
  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (triggerRef.current?.contains(target)) return
      if (optionRefs.current.some((node) => node?.contains(target))) return
      if (searchRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const close = (restoreFocus: boolean) => {
    setOpen(false)
    setQuery('')
    if (restoreFocus) triggerRef.current?.focus()
  }

  const selectRow = (row: Row | undefined) => {
    if (!row) return
    onChange(row.kind === 'auto' ? '' : row.voice.voiceURI)
    close(true)
  }

  const moveActive = (next: number) => {
    if (rows.length === 0) return
    const clamped = Math.max(0, Math.min(rows.length - 1, next))
    setActiveIndex(clamped)
    optionRefs.current[clamped]?.focus()
  }

  const togglePreview = (voiceURI: string, text: string) => {
    if (snapshot.previewing && snapshot.previewVoiceURI === (voiceURI || null)) {
      speechService.stopPreview()
      return
    }
    speechService.preview(text, voiceURI)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveActive(activeIndex + 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(activeIndex - 1)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      moveActive(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      moveActive(rows.length - 1)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
      return
    }
    if (event.key === 'Enter') {
      // 搜索框里的回车不选中（那是输入行为）。
      if (searchRef.current && document.activeElement === searchRef.current) return
      event.preventDefault()
      selectRow(rows[activeIndex])
    }
  }

  const renderOption = (row: Row, index: number, recommended = false) => {
    const isAuto = row.kind === 'auto'
    const isSelected = index === selectedIndex
    const voice = row.kind === 'voice' ? row.voice : null
    const title = isAuto ? t('speech.voiceAuto') : cleanVoiceName(voice!.name)
    const previewURI = isAuto
      ? ''
      : voice!.voiceURI
    const sampleText = t(SAMPLE_KEYS[isAuto
      ? UI_LOCALE_VOICE_TARGET[locale]?.sample ?? 'en'
      : sampleScriptForLang(voice!.lang)])
    const previewingThis = snapshot.previewing && snapshot.previewVoiceURI === (previewURI || null)
    return (
      <div key={isAuto ? 'auto' : voice!.voiceURI} className="flex items-center gap-1">
        <div
          ref={(node) => {
            optionRefs.current[index] = node
          }}
          role="option"
          aria-selected={isSelected}
          tabIndex={index === activeIndex ? 0 : -1}
          data-testid="speech-voice-option"
          onClick={() => selectRow(row)}
          className={`min-w-0 flex-1 cursor-pointer rounded-[var(--radius-md)] px-2 py-1.5 ${
            isSelected
              ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
          }`}
        >
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium" title={isAuto ? title : voice!.name}>
              {title}
            </span>
            {isAuto || recommended ? (
              <span className="shrink-0 rounded-full border border-[var(--color-border)] px-1.5 text-[10px] text-[var(--color-text-tertiary)]">
                {t('speech.voiceRecommended')}
              </span>
            ) : null}
            {isSelected ? (
              <Check size={14} strokeWidth={2.4} aria-hidden="true" className="ml-auto shrink-0 text-[var(--color-brand)]" />
            ) : null}
          </div>
          {voice ? (
            <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-[var(--color-text-tertiary)]">
              <span className="font-mono">{voice.lang}</span>
              <span className="rounded-full border border-[var(--color-border)] px-1.5">
                {voice.localService ? t('speech.voiceLocal') : t('speech.voiceOnline')}
              </span>
            </div>
          ) : (
            <div className="mt-0.5 text-[10.5px] text-[var(--color-text-tertiary)]">
              {t('speech.voiceLabel')}
            </div>
          )}
        </div>
        <IconButton
          size="xs"
          shape="square"
          tone={previewingThis ? 'brand' : 'muted'}
          data-testid="speech-voice-preview"
          icon={previewingThis
            ? <Square size={12} strokeWidth={2.2} aria-hidden="true" />
            : <Volume2 size={12} strokeWidth={2.2} aria-hidden="true" />}
          label={previewingThis
            ? t('speech.voicePreviewStop', { name: title })
            : t('speech.voicePreview', { name: title })}
          onClick={() => togglePreview(previewURI, sampleText)}
        />
      </div>
    )
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid="speech-voice-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={labelId}
        onClick={() => setOpen((current) => !current)}
        className={`${TRIGGER_CLASS} flex items-center justify-between gap-2 text-left text-[var(--color-text-primary)]`}
      >
        <span className="min-w-0 truncate">
          {selectedVoice ? cleanVoiceName(selectedVoice.name) : t('speech.voiceAuto')}
        </span>
        <ChevronDown size={14} strokeWidth={2} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
      </button>

      {open ? (
        <div
          data-testid="speech-voice-popup"
          className="absolute left-0 right-0 z-[var(--z-popover)] mt-1 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-2 shadow-[var(--shadow-card)]"
        >
          <div onKeyDown={onKeyDown}>
            <input
              ref={searchRef}
              data-testid="speech-voice-search"
              aria-label={t('speech.voiceSearch')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('speech.voiceSearch')}
              className="mb-1.5 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-xs text-[var(--color-text-primary)] outline-none"
            />
            <div role="listbox" aria-labelledby={labelId} className="max-h-[260px] overflow-y-auto">
              {/* 首项恒为「自动（推荐）」：它不是系统 voice，不该被搜索过滤掉。 */}
              {renderOption({ kind: 'auto' }, 0)}
              {groups.map((group) => (
                <div key={group.code}>
                  <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                    {`${group.code} · ${group.voices.length}`}
                  </div>
                  {group.voices.map((voice, voiceIndex) =>
                    renderOption(
                      { kind: 'voice', voice },
                      indexByURI.get(voice.voiceURI) ?? 1,
                      // 组内已按择优分降序 ⇒ 第一名就是该语言的「推荐」。
                      voiceIndex === 0,
                    ),
                  )}
                </div>
              ))}
              {filtered.length === 0 ? (
                <div className="px-2 py-1.5 text-[11px] text-[var(--color-text-tertiary)]">
                  {t('speech.voiceNoMatch')}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
