import { useRef } from 'react'
import type { SessionContextSnapshot } from '../../api/sessions'
import { useTranslation } from '../../i18n'
import { useChatStore } from '../../stores/chatStore'

type Translate = ReturnType<typeof useTranslation>

/**
 * Near-limit hint + one-click compaction, shared by the context hover popover
 * and the /context panel so both surfaces read from one set of copy keys and
 * one threshold. The threshold comes from the CLI
 * (`autoCompactThreshold`, already in the get_context_usage payload and already
 * derived from the provider-overridden window), so the hint never disagrees
 * with what the CLI will actually do.
 *
 * The action reuses the ordinary send path with `/compact` — a CLI local
 * command with `supportsNonInteractive: true` — instead of adding a protocol.
 * It is disabled while a turn is in flight so it cannot be fired twice.
 */
export function ContextCompactBanner({
  context,
  sessionId,
  t,
}: {
  context: SessionContextSnapshot
  sessionId?: string
  t: Translate
}) {
  // Compaction feedback rides the existing session store: the CLI emits
  // compact_boundary, which bumps compactCount, and the chat state flips
  // through 'compacting'.
  const chatState = useChatStore((s) => (sessionId ? s.sessions[sessionId]?.chatState ?? 'idle' : 'idle'))
  const compactCount = useChatStore((s) => (sessionId ? s.sessions[sessionId]?.compactCount ?? 0 : 0))

  // Baseline captured on mount: feedback only covers a compaction that happened
  // while this surface was open, not one from an earlier visit.
  const baselineRef = useRef(compactCount)
  const compactedSinceOpen = compactCount > baselineRef.current
  const threshold = context.autoCompactThreshold
  const usedPercent = Math.max(0, context.percentage)
  const nearLimit =
    usedPercent >= 90 ||
    (typeof threshold === 'number' && threshold > 0 && context.totalTokens >= threshold)
  const isCompacting = chatState === 'compacting'
  // Only tell them apart once the post-compact reading has landed; the clamped
  // total equals the window exactly when it is at or over it.
  const saturated = context.rawMaxTokens > 0 && context.totalTokens >= context.rawMaxTokens

  if (!nearLimit && !isCompacting && !compactedSinceOpen) return null

  const status = isCompacting
    ? t('slash.inspector.context.compacting')
    : compactedSinceOpen
      ? saturated
        ? t('slash.inspector.context.compactStillOver')
        : t('slash.inspector.context.compacted')
      : t('slash.inspector.context.compactHint')

  return (
    <div
      className="rounded-md border border-[var(--color-inspector-border)] bg-[var(--color-inspector-panel)] px-4 py-3"
      data-testid="context-compact-banner"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[var(--color-inspector-text)]">{status}</div>
          {context.isAutoCompactEnabled === false && (
            <div className="mt-1 text-[13px] text-[var(--color-inspector-muted)]">
              {t('slash.inspector.context.autoCompactOff')}
            </div>
          )}
        </div>
        <button
          type="button"
          data-testid="context-compact-action"
          disabled={!sessionId || chatState !== 'idle'}
          onClick={() => {
            if (!sessionId) return
            useChatStore.getState().sendMessage(sessionId, '/compact')
          }}
          className="shrink-0 rounded-sm border border-[var(--color-inspector-border)] bg-[var(--color-inspector-chip)] px-3 py-1.5 text-xs font-semibold text-[var(--color-inspector-muted-strong)] hover:text-[var(--color-inspector-text)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('slash.inspector.context.compactAction')}
        </button>
      </div>
    </div>
  )
}
