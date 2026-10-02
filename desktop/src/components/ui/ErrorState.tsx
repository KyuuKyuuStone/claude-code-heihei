import { useState } from 'react'
import type { ReactNode } from 'react'

import { copyTextToClipboard } from '../../lib/clipboard'
import { useTranslation } from '../../i18n'
import { cx } from '@/lib/cx'
import { Button } from './Button'
import type { StateSize } from './EmptyState'

export type ErrorStateTechnicalDetail = {
  /** 原始 error.message（人话映射前的串） */
  message: string
  /** ApiFailureKind（timeout/network/server 等英文枚举，按稿直接展示） */
  kind?: string
  /** 错误发生时间（可选；一期接入方无统一来源，预留） */
  timestamp?: number
}

export type ErrorStateProps = {
  title: string
  detail?: ReactNode
  onRetry?: () => void
  retryLabel?: string
  size?: StateSize
  /**
   * `soft` for an inline notice inside otherwise working UI, `strong` when the
   * error is the only thing in the region. Two levels replace the 20 distinct
   * error backgrounds the app had accumulated (5 background alphas x 7 border
   * alphas x 8 container alphas).
   */
  tone?: 'soft' | 'strong'
  className?: string
  /**
   * v1.7.1 P0（设计稿：错误技术详情折叠）：人话为主、技术为辅——默认折叠的
   * 二级详情，展开可看被 `describeApiFailure` 映射吞掉的原始错误串。为
   * undefined 或 message 为空串时不渲染触发器（空详情降级，与协作折叠同理）。
   */
  technicalDetail?: ErrorStateTechnicalDetail
}

const SIZE_CLASSES: Record<StateSize, string> = {
  sm: 'px-3 py-2 gap-1 text-xs',
  md: 'px-4 py-3 gap-1.5 text-sm',
  lg: 'px-5 py-6 gap-2 text-sm',
}

/**
 * The "this failed" panel.
 *
 * `role="alert"` is on the container so the failure is announced when it
 * appears — most of the replaced markup was a plain `<div>`, which a screen
 * reader user only discovers by chance.
 */
export function ErrorState({
  title,
  detail,
  onRetry,
  retryLabel,
  size = 'md',
  tone = 'soft',
  className,
  technicalDetail,
}: ErrorStateProps) {
  const t = useTranslation()
  const [techExpanded, setTechExpanded] = useState(false)

  const hasTechDetail = Boolean(technicalDetail && technicalDetail.message.trim() !== '')
  const techMessage = technicalDetail?.message ?? ''
  const techLines = [
    `${t('error.techDetail.original')}：${techMessage}`,
    technicalDetail?.kind ? `${t('error.techDetail.kind')}：${technicalDetail.kind}` : null,
    technicalDetail?.timestamp ? `${t('error.techDetail.original')}@${new Date(technicalDetail.timestamp).toISOString()}` : null,
  ].filter((line): line is string => line !== null)

  return (
    <div
      role="alert"
      className={cx(
        'flex flex-col rounded-[var(--radius-lg)] border',
        tone === 'soft'
          ? 'border-[var(--color-error-soft-hover)] bg-[var(--color-error-soft)]'
          : 'border-[var(--color-error)] bg-[var(--color-error-container)]',
        SIZE_CLASSES[size],
        className,
      )}
    >
      <span className="font-medium text-[var(--color-error)]">{title}</span>
      {detail && (
        <span className="text-xs leading-5 text-[var(--color-text-secondary)]">{detail}</span>
      )}
      {(onRetry || hasTechDetail) && (
        <div className="mt-1.5 flex w-full items-center justify-between gap-2">
          <span className="flex min-w-0 items-center">
            {onRetry && retryLabel && (
              <Button size="sm" variant="danger-outline" onClick={onRetry} className="self-start">
                {retryLabel}
              </Button>
            )}
          </span>
          {hasTechDetail && (
            <button
              type="button"
              onClick={() => setTechExpanded((value) => !value)}
              className="flex shrink-0 items-center gap-0.5 text-[12px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
            >
              {t('error.techDetail.toggle')}
              <span aria-hidden="true" className="material-symbols-outlined text-[14px]">
                {techExpanded ? 'expand_less' : 'expand_more'}
              </span>
            </button>
          )}
        </div>
      )}
      {hasTechDetail && techExpanded && (
        <div className="relative mt-1 w-full">
          <button
            type="button"
            onClick={() => void copyTextToClipboard(techLines.join('\n'))}
            className="absolute right-1.5 top-1.5 z-10 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          >
            {t('error.techDetail.copy')}
          </button>
          <pre className="max-h-[160px] overflow-y-auto rounded-[var(--radius-sm)] bg-[var(--color-surface-container-lowest)] px-2.5 py-1.5 pr-14 text-left font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)] whitespace-pre-wrap break-all">
            {techLines.join('\n')}
          </pre>
        </div>
      )}
    </div>
  )
}
