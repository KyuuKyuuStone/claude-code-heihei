import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Check, Copy, GitFork, Pause, Play, Volume2 } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTranslation } from '../../i18n'
import { formatExactMessageTimestamp, formatMessageHoverTime } from '../../lib/formatMessageTimestamp'
import { useSpeech } from '../../lib/speech/useSpeech'
import { CopyButton } from '@/components/ui/CopyButton'
import { IconButton } from '@/components/ui/IconButton'

export type MessageBranchAction = {
  label: string
  loading?: boolean
  onBranch: () => void
}

/**
 * The copy chip and the branch chip sit side by side and must look identical.
 * The branch one is an `IconButton size="sm" tone="muted" shape="circle"`;
 * `CopyButton` is styled by className, so its shell is mirrored here.
 */
const ACTION_CHIP_CLASS = [
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
  'text-[var(--color-text-tertiary)] transition-colors duration-150 cursor-pointer',
  'hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
].join(' ')

type Props = {
  copyText?: string
  copyLabel: string
  branchAction?: MessageBranchAction
  align?: 'start' | 'end'
  timestamp?: number
  /** 消息 id：有它才挂朗读键（朗读源与 copyText 同源）。 */
  messageId?: string
}

export function MessageActionBar({
  copyText,
  copyLabel,
  branchAction,
  align = 'start',
  timestamp,
  messageId,
}: Props) {
  const locale = useSettingsStore((state) => state.locale)
  const speechRate = useSettingsStore((state) => state.speechRate)
  const t = useTranslation()
  const hasCopy = Boolean(copyText?.trim())
  const hoverTimeLabel = typeof timestamp === 'number'
    ? formatMessageHoverTime(timestamp, locale)
    : ''
  const exactTimeLabel = typeof timestamp === 'number'
    ? formatExactMessageTimestamp(timestamp, locale)
    : ''

  // 朗读（TTS）：一处实现，三调用点生效（助手/用户/协作卡都从这里拿 chip）。
  const speech = useSpeech({
    messageId,
    text: copyText ?? '',
    rate: speechRate,
    codeBlockPlaceholder: t('speech.codeBlockPlaceholder'),
  })
  // 一旦在播就保持可见（即使 voices 中途消失导致 canSpeak 变假）——否则 chip 连同
  // 暂停出口一起消失，service 仍在朗读、本体描边还在，用户无法停。
  const showTts = hasCopy && Boolean(messageId) && (speech.visible || speech.status !== 'idle')
  const ttsStatus = showTts ? speech.status : 'idle'

  // aria-live 只播「状态切换事件」文案，不做常驻状态区；续播与首播分别播报。
  const [liveText, setLiveText] = useState('')
  const previousStatus = useRef<'idle' | 'speaking' | 'paused'>('idle')
  useEffect(() => {
    const previous = previousStatus.current
    previousStatus.current = ttsStatus
    if (previous === ttsStatus) return
    if (ttsStatus === 'speaking') {
      setLiveText(previous === 'paused' ? t('speech.liveResumed') : t('speech.liveStart'))
      return
    }
    setLiveText(ttsStatus === 'paused' ? t('speech.livePaused') : '')
  }, [ttsStatus, t])

  if (!hasCopy && !branchAction) return null

  const ttsLabel = ttsStatus === 'speaking'
    ? t('speech.pause')
    : ttsStatus === 'paused'
      ? t('speech.resume')
      : t('speech.play')

  return (
    <div
      data-message-actions
      data-align={align}
      data-tts-state={ttsStatus}
      // 朗读中/已暂停的消息：chip 常驻可见（覆盖操作条自身的 hover 显现规则）。
      // 暂停态同样常驻——暂停是把播放入口变成继续入口，藏起来就找不回播放位置。
      className={`mt-2 flex h-7 w-full transition-opacity duration-150 ${
        ttsStatus !== 'idle'
          ? 'pointer-events-auto opacity-100'
          : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'
      } ${
        align === 'end' ? 'justify-end' : 'justify-start'
      }`}
    >
      <div className="flex min-h-7 items-center gap-1.5">
        {hasCopy ? (
          <CopyButton
            text={copyText!}
            label={copyLabel}
            displayLabel={<Copy size={13} strokeWidth={2.2} aria-hidden="true" />}
            displayCopiedLabel={<Check size={13} strokeWidth={2.4} aria-hidden="true" />}
            onPointerUp={(event) => event.currentTarget.blur()}
            className={ACTION_CHIP_CLASS}
          />
        ) : null}
        {branchAction ? (
          <IconButton
            icon={<GitFork size={13} strokeWidth={2.2} aria-hidden="true" />}
            label={branchAction.label}
            size="sm"
            tone="muted"
            shape="circle"
            disabled={branchAction.loading}
            onClick={branchAction.onBranch}
            onPointerUp={(event) => event.currentTarget.blur()}
          />
        ) : null}
        {showTts ? (
          // 严禁用 IconButton 的 pressed：其常驻填充 --color-surface-selected 与用户气泡同底色。
          <IconButton
            icon={
              ttsStatus === 'speaking'
                ? <Pause size={13} strokeWidth={2.2} aria-hidden="true" />
                : ttsStatus === 'paused'
                  ? <Play size={13} strokeWidth={2.2} aria-hidden="true" />
                  : <Volume2 size={13} strokeWidth={2.2} aria-hidden="true" />
            }
            label={ttsLabel}
            size="sm"
            tone={ttsStatus === 'speaking' ? 'brand' : ttsStatus === 'paused' ? 'secondary' : 'muted'}
            shape="circle"
            onClick={speech.toggle}
            onPointerUp={(event: ReactPointerEvent<HTMLButtonElement>) => event.currentTarget.blur()}
          />
        ) : null}
        {showTts && speech.truncated && ttsStatus !== 'idle' ? (
          <span className="text-[11px] text-[var(--color-text-tertiary)]">{t('speech.truncated')}</span>
        ) : null}
        {hoverTimeLabel ? (
          <span
            className="ml-1 inline-flex items-center text-[11px] font-medium tabular-nums text-[var(--color-text-tertiary)]"
            title={exactTimeLabel || hoverTimeLabel}
          >
            {hoverTimeLabel}
          </span>
        ) : null}
        {showTts ? (
          <span className="sr-only" aria-live="polite">{liveText}</span>
        ) : null}
      </div>
    </div>
  )
}
