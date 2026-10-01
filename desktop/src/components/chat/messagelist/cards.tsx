// v1.7.0 结构拆分第②批（卡片 / selection / MessageBlock）：卡片域从
// components/chat/MessageList.tsx 逐字移出（原 208-640 行），逻辑零改动；
// 门面保留为入口。getCompactSummaryTitle / getBackgroundTaskLabel /
// memoryFileLabel / openMemorySettings 仅供本文件内卡片使用，保持模块私有。

import { useRef, useEffect, useState, useCallback, type ReactNode } from 'react'
import { BookMarked, Bot, CheckCircle2, ChevronDown, ChevronRight, CircleStop, FileStack, Settings, Target, XCircle } from 'lucide-react'
import { useWorkspaceChatContextStore } from '../../../stores/workspaceChatContextStore'
import { SETTINGS_TAB_ID, useTabStore } from '../../../stores/tabStore'
import { useUIStore } from '../../../stores/uiStore'
import { useTranslation } from '../../../i18n'
import type { TranslationKey } from '../../../i18n/locales/en'
import { formatTokenCount } from '../../../lib/formatTokenCount'
import { formatDurationMs } from '../../../lib/backgroundTasks'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { clearWindowSelection, useSelectionPopoverDismiss } from '../../../hooks/useSelectionPopoverDismiss'
import type { BackgroundTaskEvent, CompactSummaryEvent, GoalEvent, MemoryEvent } from './renderModel'
import {
  ChatSelectionMenu,
  getChatSelectionFromContainer,
  getSelectionPointer,
  type ChatMessageRole,
  type ChatSelectionState,
  type SelectionPointer,
} from './selection'

function getCompactSummaryTitle(message: CompactSummaryEvent, t: ReturnType<typeof useTranslation>) {
  if (message.trigger === 'auto') return t('chat.compactSummary.autoTitle')
  if (message.trigger === 'manual') return t('chat.compactSummary.manualTitle')
  if (!message.title || message.title === 'Context compacted' || message.title === 'Conversation compacted') {
    return t('chat.compactSummary.title')
  }
  return message.title
}

export function CompactStatusDivider({ message, state }: { message?: CompactSummaryEvent; state: 'compacting' | 'complete' }) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const hasSummary = Boolean(message?.summary?.trim())
  const meta = [
    message?.trigger ? t(`chat.compactSummary.trigger.${message.trigger}` as TranslationKey) : null,
    typeof message?.preTokens === 'number'
      ? t('chat.compactSummary.tokens', { count: formatTokenCount(message.preTokens) })
      : null,
    typeof message?.messagesSummarized === 'number'
      ? t('chat.compactSummary.messages', { count: String(message.messagesSummarized) })
      : null,
  ].filter((item): item is string => Boolean(item))
  const hasDetails = hasSummary || meta.length > 0
  const title = state === 'compacting'
    ? t('chat.compactSummary.compacting')
    : message
      ? getCompactSummaryTitle(message, t)
      : t('chat.compactSummary.title')

  return (
    <section data-testid="compact-status-divider" className="my-4 w-full px-1">
      <div className="flex w-full items-center gap-3">
        <div className="h-px flex-1 bg-[var(--color-border)]" aria-hidden="true" />
        <button
          type="button"
          aria-expanded={hasDetails ? expanded : undefined}
          onClick={() => hasDetails && setExpanded((value) => !value)}
          disabled={!hasDetails}
          className="group inline-flex min-h-8 max-w-[min(78vw,520px)] items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1 text-[13px] font-semibold text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:cursor-default disabled:hover:text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
        >
          {state === 'compacting' ? (
            <Spinner size={16} className="text-[var(--color-text-tertiary)]" />
          ) : (
            <FileStack size={16} strokeWidth={2.05} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
          )}
          <span className="min-w-0 truncate font-medium text-[var(--color-text-primary)]">
            {title}
          </span>
        </button>
        <div className="h-px flex-1 bg-[var(--color-border)]" aria-hidden="true" />
      </div>
      {hasDetails && expanded && (
        <div className="mx-auto mt-1.5 w-full max-w-[620px] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 py-2">
          {meta.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-x-2 gap-y-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">
              {meta.map((item) => <span key={item}>{item}</span>)}
            </div>
          )}
          {message?.summary && (
            <div className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words text-[12px] leading-5 text-[var(--color-text-secondary)]">
              {message.summary}
            </div>
          )}
          </div>
      )}
    </section>
  )
}

export function GoalEventCard({ message }: { message: GoalEvent }) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(true)
  const titleKey = `chat.goalEvent.${message.action === 'status' ? 'statusTitle' : message.action}` as TranslationKey
  const title = t(titleKey) === titleKey ? t('chat.goalEvent.message') : t(titleKey)
  const metaDetails = [
    message.status ? t('chat.goalEvent.statusValue', { value: message.status }) : null,
    message.budget ? t('chat.goalEvent.budget', { value: message.budget }) : null,
    message.continuations ? t('chat.goalEvent.continuations', { value: message.continuations }) : null,
  ].filter((detail): detail is string => detail !== null)

  return (
    <div className="mb-2">
      <div
        data-testid="goal-event-card"
        className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-memory-border)] bg-[var(--color-memory-surface)]"
      >
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
        >
          {expanded ? (
            <ChevronDown size={15} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
          ) : (
            <ChevronRight size={15} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
          )}
          <Target size={15} className="shrink-0 text-[var(--color-memory-accent)]" strokeWidth={2.25} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-text-primary)]">
            {title}
          </span>
          {message.status ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-[var(--color-text-tertiary)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-memory-accent)]" aria-hidden="true" />
              {message.status}
            </span>
          ) : null}
        </button>

        {expanded ? (
          <div className="border-t border-[var(--color-border)] px-3 py-2.5">
            <div className="space-y-1.5">
              {message.objective ? (
                <div className="line-clamp-2 rounded-[var(--radius-md)] px-2 py-1 text-[12px] leading-5 text-[var(--color-text-secondary)]">
                  {t('chat.goalEvent.objective', { value: message.objective })}
                </div>
              ) : message.message ? (
                <div className="whitespace-pre-wrap rounded-[var(--radius-md)] px-2 py-1 text-[12px] leading-5 text-[var(--color-text-secondary)]">
                  {message.message}
                </div>
              ) : null}
              {metaDetails.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 px-2 pt-0.5">
                  {metaDetails.map((detail) => (
                    <span
                      key={detail}
                      className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-text-secondary)]"
                    >
                      {detail}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function GoalContinuationDivider({ message }: { message: GoalEvent }) {
  const t = useTranslation()
  const reason = message.message?.replace(/^Goal continuing:\s*/i, '').trim()

  return (
    <section data-testid="goal-continuation-divider" className="my-4 w-full px-1">
      <div className="flex w-full items-center gap-3">
        <div className="h-px flex-1 bg-[var(--color-border)]" aria-hidden="true" />
        <div className="inline-flex min-h-8 max-w-[min(78vw,620px)] items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1 text-[13px] font-medium text-[var(--color-text-secondary)]">
          <Target size={16} strokeWidth={2.1} className="shrink-0 text-[var(--color-memory-accent)]" aria-hidden="true" />
          <span className="shrink-0 font-semibold text-[var(--color-text-primary)]">
            {t('chat.goalEvent.continuing')}
          </span>
          {reason ? (
            <span className="min-w-0 truncate text-[12px] text-[var(--color-text-tertiary)]" title={reason}>
              {reason}
            </span>
          ) : null}
        </div>
        <div className="h-px flex-1 bg-[var(--color-border)]" aria-hidden="true" />
      </div>
    </section>
  )
}

export function BackgroundTaskEventCard({ message }: { message: BackgroundTaskEvent }) {
  const t = useTranslation()
  const { task } = message
  const isRunning = task.status === 'running'
  const isFailed = task.status === 'failed'
  const isStopped = task.status === 'stopped'
  const duration = formatDurationMs(task.usage?.durationMs, t)
  const detail = task.summary || task.lastToolName || task.description || task.outputFile || task.taskId
  const label = getBackgroundTaskLabel(task.taskType, t)

  return (
    <div className="mb-2">
      <div
        data-testid="background-task-event-card"
        data-status={task.status}
        className="flex min-w-0 items-start gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2"
      >
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
          {isRunning ? (
            <Spinner size={15} tone="brand" />
          ) : isFailed ? (
            <XCircle size={15} strokeWidth={2.25} className="text-[var(--color-error)]" aria-hidden="true" />
          ) : isStopped ? (
            <CircleStop size={15} strokeWidth={2.25} className="text-[var(--color-text-tertiary)]" aria-hidden="true" />
          ) : (
            <CheckCircle2 size={15} strokeWidth={2.25} className="text-[var(--color-success)]" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <Bot size={14} strokeWidth={2.25} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
            <span className="shrink-0 text-[12px] font-medium text-[var(--color-text-primary)]">
              {label}
            </span>
            <span className="shrink-0 text-[11px] text-[var(--color-text-tertiary)]">
              {t(`chat.backgroundAgents.status.${task.status}`)}
            </span>
            {task.usage?.totalTokens ? (
              <span className="hidden shrink-0 text-[11px] text-[var(--color-text-tertiary)] sm:inline">
                {t('chat.backgroundAgents.tokens', { count: formatTokenCount(task.usage.totalTokens) })}
              </span>
            ) : null}
            {duration ? (
              <span className="hidden shrink-0 text-[11px] text-[var(--color-text-tertiary)] sm:inline">
                {duration}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 truncate text-[12px] leading-5 text-[var(--color-text-secondary)]">
            {detail}
          </div>
        </div>
      </div>
    </div>
  )
}


function getBackgroundTaskLabel(
  taskType: string | undefined,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  if (taskType === 'local_bash') return t('chat.backgroundTasks.command')
  if (taskType === 'local_workflow') return t('chat.backgroundTasks.workflow')
  return t('chat.backgroundTasks.task')
}

export function SelectableChatMessage({
  sessionId,
  messageId,
  role,
  content,
  children,
}: {
  sessionId?: string | null
  messageId: string
  role: ChatMessageRole
  content: string
  children: ReactNode
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const selectionMenuRef = useRef<HTMLButtonElement>(null)
  const lastSelectionPointerRef = useRef<SelectionPointer | null>(null)
  const selectionUpdateFrameRef = useRef<number | null>(null)
  const addReference = useWorkspaceChatContextStore((state) => state.addReference)
  const [selectionMenu, setSelectionMenu] = useState<ChatSelectionState | null>(null)
  const t = useTranslation()
  const sourceName = role === 'assistant'
    ? t('chat.assistantMessageReference')
    : t('chat.userMessageReference')

  useEffect(() => {
    setSelectionMenu(null)
    lastSelectionPointerRef.current = null
  }, [content, messageId])

  const dismissSelectionMenu = useCallback(() => {
    setSelectionMenu(null)
  }, [])

  const queueSelectionMenuUpdate = useCallback((pointer?: SelectionPointer) => {
    if (pointer) lastSelectionPointerRef.current = pointer

    if (selectionUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionUpdateFrameRef.current)
    }

    selectionUpdateFrameRef.current = window.requestAnimationFrame(() => {
      selectionUpdateFrameRef.current = window.requestAnimationFrame(() => {
        selectionUpdateFrameRef.current = null
        const root = rootRef.current
        const rootRect = root?.getBoundingClientRect()
        const fallbackPointer = lastSelectionPointerRef.current ?? {
          clientX: (rootRect?.left ?? 0) + 24,
          clientY: (rootRect?.top ?? 0) + 24,
        }
        setSelectionMenu(getChatSelectionFromContainer(root, fallbackPointer))
      })
    })
  }, [])

  useEffect(() => {
    return () => {
      if (selectionUpdateFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionUpdateFrameRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      lastSelectionPointerRef.current = getSelectionPointer(event)
    }

    const handlePointerUp = (event: PointerEvent) => {
      queueSelectionMenuUpdate(getSelectionPointer(event))
    }

    const handleMouseUp = (event: MouseEvent) => {
      queueSelectionMenuUpdate(getSelectionPointer(event))
    }

    const handleSelectionChange = () => {
      queueSelectionMenuUpdate()
    }

    const handleKeyUp = () => {
      queueSelectionMenuUpdate()
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('pointerup', handlePointerUp, true)
    document.addEventListener('mouseup', handleMouseUp, true)
    document.addEventListener('selectionchange', handleSelectionChange)
    document.addEventListener('keyup', handleKeyUp, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('pointerup', handlePointerUp, true)
      document.removeEventListener('mouseup', handleMouseUp, true)
      document.removeEventListener('selectionchange', handleSelectionChange)
      document.removeEventListener('keyup', handleKeyUp, true)
    }
  }, [queueSelectionMenuUpdate])

  useSelectionPopoverDismiss({
    active: Boolean(selectionMenu),
    popoverRef: selectionMenuRef,
    onDismiss: dismissSelectionMenu,
  })

  const addCurrentSelectionToChat = useCallback(() => {
    if (!sessionId || !selectionMenu) return
    addReference(sessionId, {
      kind: 'chat-selection',
      path: `chat://${role}/${messageId}`,
      name: sourceName,
      quote: selectionMenu.text,
      sourceRole: role,
      messageId,
    })
    setSelectionMenu(null)
    clearWindowSelection()
  }, [addReference, messageId, role, selectionMenu, sessionId, sourceName])

  return (
    <div
      ref={rootRef}
      data-chat-selectable-message={role}
      onPointerDown={(event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        lastSelectionPointerRef.current = getSelectionPointer(event)
      }}
      onMouseUp={(event) => {
        queueSelectionMenuUpdate(getSelectionPointer(event))
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setSelectionMenu(null)
      }}
    >
      {children}
      <ChatSelectionMenu selection={selectionMenu} onAdd={addCurrentSelectionToChat} popoverRef={selectionMenuRef} />
    </div>
  )
}

function memoryFileLabel(path: string) {
  const normalized = path.replace(/\\/g, '/')
  return normalized.split('/').pop() || normalized
}

function openMemorySettings(path?: string) {
  const ui = useUIStore.getState()
  if (path) ui.setPendingMemoryPath(path)
  ui.setPendingSettingsTab('memory')
  useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
}

export function MemoryEventCard({ message }: { message: MemoryEvent }) {
  const t = useTranslation()
  const visibleFiles = message.files.slice(0, 3)
  const hiddenCount = Math.max(0, message.files.length - visibleFiles.length)

  return (
    <div className="mb-3 flex justify-center px-3">
      <div className="w-full max-w-2xl rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3.5 py-3 text-xs shadow-[var(--shadow-card)]">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-brand)]">
            <BookMarked size={15} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium text-[var(--color-text-primary)]">
                {t('chat.memorySavedTitle', { count: message.files.length })}
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openMemorySettings(message.files[0]?.path)}
                icon={<Settings size={13} aria-hidden="true" />}
              >
                {t('chat.memoryOpenSettings')}
              </Button>
            </div>
            {message.message ? (
              <div className="mt-1 text-[var(--color-text-tertiary)]">{message.message}</div>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {visibleFiles.map((file) => (
                <span
                  key={file.path}
                  title={file.path}
                  className="max-w-full truncate rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-text-secondary)]"
                >
                  {memoryFileLabel(file.path)}
                </span>
              ))}
              {hiddenCount > 0 ? (
                <span className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-text-tertiary)]">
                  {t('chat.memoryMoreFiles', { count: hiddenCount })}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
