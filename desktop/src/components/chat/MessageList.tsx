import { useRef, useEffect, useMemo, memo, useState, useCallback, useDeferredValue, useLayoutEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, BookMarked, Bot, CheckCircle2, ChevronDown, ChevronRight, CircleStop, FileStack, MessageCircle, Settings, Target, XCircle } from 'lucide-react'
import {
  buildRenderModel,
  buildTurnCardInsertionMap,
  buildChangedFilesByRenderIndex,
  EMPTY_TURN_CHANGE_CARDS,
  getApiErrorMessage,
  getBranchableMessageTargets,
  getCompletedTurnTargets,
  normalizeTurnCheckpoints,
  type BackgroundTaskEvent,
  type BranchableMessageTarget,
  type CompactSummaryEvent,
  type GoalEvent,
  type MemoryEvent,
  type RenderItem,
  type TurnChangeCardModel,
} from './messagelist/renderModel'
import {
  buildVirtualTranscriptWindow,
  CHAT_RENDER_ITEM_CLASS,
  CHAT_SCROLL_AREA_CLASS,
  clampNumber,
  CONVERSATION_NAVIGATION_COMPACT_MIN_WIDTH_PX,
  CONVERSATION_NAVIGATION_FULL_MIN_WIDTH_PX,
  CONVERSATION_NAVIGATION_MIN_ITEMS,
  CONVERSATION_NAVIGATION_READING_ANCHOR_RATIO,
  CONTENT_RESIZE_FOLLOW_JITTER_MAX_DELTA_PX,
  EARLIER_HISTORY_TRIGGER_PX,
  estimateRenderItemHeight,
  getActiveConversationNavigationItemId,
  getConversationNavigationTargetScrollTop,
  getRenderItemContentWeight,
  getRenderItemKey,
  getRenderItemMetricSignature,
  isNearScrollBottom,
  isRenderItemFullyVisibleInChatScroller,
  MeasuredRenderItem,
  rememberSessionScroll,
  SCROLL_BOTTOM_SENTINEL,
  sessionScrollSnapshots,
  setScrollToBottomWithoutLayoutRead,
  setScrollTopWithoutLayoutRead,
  STREAMING_ASSISTANT_NAVIGATION_KEY,
  USER_SCROLL_INTENT_WINDOW_MS,
  VIRTUAL_DEFAULT_VIEWPORT_HEIGHT,
  VIRTUAL_MAX_ITEM_HEIGHT,
  VIRTUAL_MIN_ITEM_HEIGHT,
  VIRTUAL_OVERSCAN_PX,
  VirtualSpacer,
  type VirtualViewport,
} from './messagelist/virtualization'
import {
  clearConversationFindHighlights,
  CONVERSATION_FIND_CONTENT_REFRESH_MS,
  findConversationMatches,
  paintConversationFindHighlights,
  type ConversationFindMatch,
} from './messagelist/conversationFind'

export { buildRenderModel, getCompletedTurnTargets, getLatestCompletedTurnTarget } from './messagelist/renderModel'
export {
  isRenderItemFullyVisibleInChatScroller,
  resetSessionScrollSnapshotsForTests,
  shouldVirtualizeRenderItems,
  buildVirtualItemOffsets,
  getActiveConversationNavigationItemId,
  getConversationNavigationTargetScrollTop,
} from './messagelist/virtualization'
import { listPendingPermissions, useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'
import { useWorkspacePanelStore, type WorkspacePanelOrigin } from '../../stores/workspacePanelStore'
import { SETTINGS_TAB_ID, useTabStore } from '../../stores/tabStore'
import { useTeamStore } from '../../stores/teamStore'
import { useUIStore } from '../../stores/uiStore'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n/locales/en'
import { UserMessage } from './UserMessage'
import { AssistantMessage } from './AssistantMessage'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { ToolCallGroup } from './ToolCallGroup'
import { ToolResultBlock } from './ToolResultBlock'
import { PermissionDialog } from './PermissionDialog'
import { AskUserQuestion } from './AskUserQuestion'
import { StreamingIndicator } from './StreamingIndicator'
import { InlineTaskSummary } from './InlineTaskSummary'
import { CurrentTurnChangeCard } from './CurrentTurnChangeCard'
import {
  buildConversationNavigationItems,
  ConversationNavigator,
  type ConversationNavigationItem,
  type ConversationNavigationMode,
} from './ConversationNavigator'
import type { AgentTaskNotification, UIMessage } from '../../types/chat'
import { formatTokenCount } from '../../lib/formatTokenCount'
import { formatDurationMs, hasRunningBackgroundTasks as hasAnyRunningBackgroundTasks } from '../../lib/backgroundTasks'
import { buildTurnCompletionByMessageId, type TurnCompletion } from '../../lib/turnCompletion'
import { isTouchH5Document } from '../../lib/touchH5'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Spinner } from '@/components/ui/Spinner'
import { clearWindowSelection, getSelectionPopoverPosition, useSelectionPopoverDismiss } from '../../hooks/useSelectionPopoverDismiss'
import {
  getHeightsForSession,
  getMetricsForSession,
  type VirtualRenderItemMetric,
} from './virtualHeightCache'
import {
  notifyConversationFindContentChanged,
  registerConversationFindController,
  type ConversationFindController,
} from '../search/conversationFindBridge'

type ChatMessageRole = 'user' | 'assistant'

type ChatSelectionState = {
  text: string
  x: number
  y: number
}

type SelectionPointer = {
  clientX: number
  clientY: number
}

const CHAT_SELECTION_MENU_OFFSET = 10
const CHAT_SELECTION_MENU_WIDTH = 158
const CHAT_SELECTION_MENU_HEIGHT = 44

function getElementForNode(node: Node | null): Element | null {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
}

function getChatSelectionPosition(range: Range, root: HTMLElement, pointer: { clientX: number; clientY: number }) {
  return getSelectionPopoverPosition(range, root, {
    menuWidth: CHAT_SELECTION_MENU_WIDTH,
    menuHeight: CHAT_SELECTION_MENU_HEIGHT,
    offset: CHAT_SELECTION_MENU_OFFSET,
    fallbackPointer: pointer,
  })
}

function getChatSelectionFromContainer(
  root: HTMLElement | null,
  pointer: SelectionPointer,
): ChatSelectionState | null {
  if (!root) return null
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  const startElement = getElementForNode(range.startContainer)
  const endElement = getElementForNode(range.endContainer)
  if (!startElement || !endElement || !root.contains(startElement) || !root.contains(endElement)) {
    return null
  }

  const text = selection.toString().trim()
  if (!text) return null

  return {
    ...getChatSelectionPosition(range, root, pointer),
    text,
  }
}

function getSelectionPointer(event: SelectionPointer): SelectionPointer {
  return {
    clientX: event.clientX,
    clientY: event.clientY,
  }
}

function ChatSelectionMenu({
  selection,
  onAdd,
  popoverRef,
}: {
  selection: ChatSelectionState | null
  onAdd: () => void
  popoverRef: { current: HTMLButtonElement | null }
}) {
  const t = useTranslation()
  if (!selection) return null

  return createPortal(
    <button
      ref={popoverRef}
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onAdd}
      className="fixed z-[var(--z-popover)] inline-flex h-11 items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-5 text-[15px] font-semibold text-[var(--color-text-primary)] shadow-[var(--shadow-overlay)] transition-colors hover:bg-[var(--color-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
      style={{ left: selection.x, top: selection.y }}
    >
      <MessageCircle size={21} strokeWidth={2.15} className="shrink-0 text-[var(--color-text-primary)]" aria-hidden="true" />
      <span>{t('chat.addSelectionToChat')}</span>
    </button>,
    document.body,
  )
}

function getCompactSummaryTitle(message: CompactSummaryEvent, t: ReturnType<typeof useTranslation>) {
  if (message.trigger === 'auto') return t('chat.compactSummary.autoTitle')
  if (message.trigger === 'manual') return t('chat.compactSummary.manualTitle')
  if (!message.title || message.title === 'Context compacted' || message.title === 'Conversation compacted') {
    return t('chat.compactSummary.title')
  }
  return message.title
}

function CompactStatusDivider({ message, state }: { message?: CompactSummaryEvent; state: 'compacting' | 'complete' }) {
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

function GoalEventCard({ message }: { message: GoalEvent }) {
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

function GoalContinuationDivider({ message }: { message: GoalEvent }) {
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

function BackgroundTaskEventCard({ message }: { message: BackgroundTaskEvent }) {
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

function SelectableChatMessage({
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

function MemoryEventCard({ message }: { message: MemoryEvent }) {
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

type MessageListProps = {
  sessionId?: string | null
  compact?: boolean
  mobileLayout?: boolean
}

const EMPTY_MESSAGES: UIMessage[] = []
const EMPTY_AGENT_TASK_NOTIFICATIONS: Record<string, AgentTaskNotification> = {}


export function MessageList({ sessionId, compact = false, mobileLayout = false }: MessageListProps = {}) {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const resolvedSessionId = sessionId ?? activeTabId
  const isWorkspacePanelOpen = useWorkspacePanelStore((state) =>
    resolvedSessionId ? state.isPanelOpen(resolvedSessionId) : false,
  )
  const workspacePanelOrigin = useWorkspacePanelStore((state) =>
    resolvedSessionId ? state.originBySession[resolvedSessionId] ?? null : null,
  )
  const sessionState = useChatStore((s) =>
    resolvedSessionId ? s.sessions[resolvedSessionId] : undefined,
  )
  const branchSession = useSessionStore((s) => s.branchSession)
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const reloadHistory = useChatStore((s) => s.reloadHistory)
  const loadEarlierHistory = useChatStore((s) => s.loadEarlierHistory)
  // v1.5.0 历史分页：首开只装最近一窗，滚近顶部时按游标向前翻页。
  const historyHasMore = sessionState?.historyHasMore === true
  const earlierHistoryStatus = sessionState?.earlierHistoryStatus ?? 'idle'
  const queueComposerPrefill = useChatStore((s) => s.queueComposerPrefill)
  const isMemberSession = useTeamStore((s) =>
    resolvedSessionId ? Boolean(s.getMemberBySessionId(resolvedSessionId)) : false,
  )
  const addToast = useUIStore((s) => s.addToast)
  const messages = sessionState?.messages ?? EMPTY_MESSAGES
  const chatState = sessionState?.chatState ?? 'idle'
  const streamingText = sessionState?.streamingText ?? ''
  const streamingToolInput = sessionState?.streamingToolInput ?? ''
  const activeThinkingId = sessionState?.activeThinkingId ?? null
  const agentTaskNotifications = sessionState?.agentTaskNotifications ?? EMPTY_AGENT_TASK_NOTIFICATIONS
  const hasRunningBackgroundTasks = hasAnyRunningBackgroundTasks(sessionState?.backgroundAgentTasks)
  const pendingPermissions = listPendingPermissions(sessionState)
  const activeAskUserQuestionToolUseId =
    pendingPermissions
      .find((permission) => permission.toolName === 'AskUserQuestion')?.toolUseId ?? null
  const hasPendingPermissionCard = pendingPermissions.some(
    (permission) => permission.toolName !== 'AskUserQuestion',
  )
  const shouldFollowContentResize =
    streamingText.trim().length > 0 ||
    chatState === 'streaming' ||
    chatState === 'compacting' ||
    chatState === 'tool_executing' ||
    hasPendingPermissionCard ||
    (chatState === 'thinking' && Boolean(activeThinkingId))
  const messageListRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const scrollContentRef = useRef<HTMLDivElement>(null)
  const virtualItemHeightsRef = useRef<Map<string, number>>(
    resolvedSessionId ? getHeightsForSession(resolvedSessionId) : new Map<string, number>(),
  )
  const virtualItemMetricCacheRef = useRef<Map<string, VirtualRenderItemMetric>>(
    resolvedSessionId ? getMetricsForSession(resolvedSessionId) : new Map<string, VirtualRenderItemMetric>(),
  )
  const pendingMeasuredHeightsRef = useRef(false)
  const measureFlushFrameRef = useRef<number | null>(null)
  const navigationHighlightTimerRef = useRef<number | null>(null)
  // v1.5.0 历史分页：向前翻页时的滚动锚点（prepend 前 scrollHeight/scrollTop）。
  const earlierHistoryPrependAnchorRef = useRef<{
    sessionId: string
    scrollHeight: number
    scrollTop: number
  } | null>(null)
  const workspaceOriginRestoreFrameRef = useRef<number | null>(null)
  const conversationFindRefreshTimerRef = useRef<number | null>(null)
  const conversationFindLastRefreshAtRef = useRef(0)
  const workspaceOriginSessionRef = useRef(resolvedSessionId)
  const lastAutoScrollAtRef = useRef(0)
  const lastContentResizeFollowHeightRef = useRef<number | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const isProgrammaticScrollingRef = useRef(false)
  const ignoreProgrammaticScrollUntilRef = useRef(0)
  const ignoreProgrammaticScrollTopRef = useRef<number | null>(null)
  const userScrollIntentUntilRef = useRef(0)
  const lastSessionIdRef = useRef<string | null | undefined>(undefined)
  const lastTailMessageIdBySessionRef = useRef(new Map<string, string | null>())
  const t = useTranslation()
  const [turnChangeCards, setTurnChangeCards] = useState<TurnChangeCardModel[]>([])
  const [turnChangeLoadError, setTurnChangeLoadError] = useState<string | null>(null)
  const [turnActionErrors, setTurnActionErrors] = useState<Record<string, string>>({})
  const [isLoadingTurnChangeCards, setIsLoadingTurnChangeCards] = useState(false)
  const [branchingMessageId, setBranchingMessageId] = useState<string | null>(null)
  const [rewindingTurnId, setRewindingTurnId] = useState<string | null>(null)
  const [turnUndoConfirmTargetId, setTurnUndoConfirmTargetId] = useState<string | null>(null)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const [virtualViewport, setVirtualViewport] = useState<VirtualViewport>({
    scrollTop: SCROLL_BOTTOM_SENTINEL,
    viewportHeight: VIRTUAL_DEFAULT_VIEWPORT_HEIGHT,
  })
  const [measuredItemsVersion, setMeasuredItemsVersion] = useState(0)
  const [highlightedNavigationItemKey, setHighlightedNavigationItemKey] = useState<string | null>(null)
  const [activeConversationFindMatch, setActiveConversationFindMatch] = useState<ConversationFindMatch | null>(null)
  const conversationFindMatchesRef = useRef<ConversationFindMatch[]>([])
  const [messageListWidth, setMessageListWidth] = useState<number | null>(null)
  const branchActionsDisabled =
    isMemberSession ||
    chatState !== 'idle' ||
    hasRunningBackgroundTasks ||
    streamingText.trim().length > 0 ||
    Boolean(activeThinkingId) ||
    Boolean(sessionState?.activeToolUseId) ||
    Boolean(sessionState?.activeToolName)
  const hasCompactingDivider = messages.some((message) =>
    message.type === 'compact_summary' && message.phase === 'compacting')

  useEffect(() => () => {
    if (measureFlushFrameRef.current !== null) {
      cancelAnimationFrame(measureFlushFrameRef.current)
    }
    if (navigationHighlightTimerRef.current !== null) {
      window.clearTimeout(navigationHighlightTimerRef.current)
    }
    if (workspaceOriginRestoreFrameRef.current !== null) {
      cancelAnimationFrame(workspaceOriginRestoreFrameRef.current)
    }
    if (conversationFindRefreshTimerRef.current !== null) {
      window.clearTimeout(conversationFindRefreshTimerRef.current)
    }
    clearConversationFindHighlights()
  }, [])

  useLayoutEffect(() => {
    const messageList = messageListRef.current
    if (!messageList) return

    const updateWidth = (width: number) => {
      const roundedWidth = Math.round(width)
      if (roundedWidth <= 0) return
      setMessageListWidth((current) => current === roundedWidth ? current : roundedWidth)
    }

    updateWidth(messageList.getBoundingClientRect().width || messageList.clientWidth)
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === messageList)
      if (entry) updateWidth(entry.contentRect.width)
    })
    observer.observe(messageList)
    return () => observer.disconnect()
  }, [])

  const syncVirtualViewportFromContainer = useCallback((container: HTMLElement) => {
    const nextScrollTop = container.scrollTop
    const nextViewportHeight = container.clientHeight || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT
    setVirtualViewport((current) => {
      if (
        Math.abs(current.scrollTop - nextScrollTop) < 1 &&
        Math.abs(current.viewportHeight - nextViewportHeight) < 1
      ) {
        return current
      }
      return {
        scrollTop: nextScrollTop,
        viewportHeight: nextViewportHeight,
      }
    })
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    shouldAutoScrollRef.current = true
    isProgrammaticScrollingRef.current = true
    ignoreProgrammaticScrollUntilRef.current = performance.now() + 250
    lastAutoScrollAtRef.current = performance.now()
    const container = scrollContainerRef.current
    let requestedScrollTop: number | null = null
    if (container) {
      setScrollToBottomWithoutLayoutRead(container, behavior)
      requestedScrollTop = container.scrollTop
      ignoreProgrammaticScrollTopRef.current = requestedScrollTop
    }
    setVirtualViewport((current) => ({
      scrollTop: SCROLL_BOTTOM_SENTINEL,
      viewportHeight: current.viewportHeight,
    }))
    if (container && resolvedSessionId) {
      sessionScrollSnapshots.set(resolvedSessionId, {
        scrollTop: container.scrollTop,
        wasAtBottom: true,
      })
    }
    setShowJumpToLatest(false)
    // Reset flag after the scroll event(s) from scrollIntoView have fired
    requestAnimationFrame(() => {
      const latestContainer = scrollContainerRef.current
      if (
        shouldAutoScrollRef.current &&
        latestContainer &&
        (
          requestedScrollTop === null ||
          latestContainer.scrollTop === requestedScrollTop
        )
      ) {
        setScrollToBottomWithoutLayoutRead(latestContainer, 'auto')
        if (resolvedSessionId) {
          sessionScrollSnapshots.set(resolvedSessionId, {
            scrollTop: latestContainer.scrollTop,
            wasAtBottom: true,
          })
        }
      }
      isProgrammaticScrollingRef.current = false
    })
  }, [resolvedSessionId])

  const flushMeasuredHeightVersion = useCallback(() => {
    if (!pendingMeasuredHeightsRef.current) return
    pendingMeasuredHeightsRef.current = false
    setMeasuredItemsVersion((version) => version + 1)
  }, [])

  const handleVirtualItemHeightChange = useCallback((itemKey: string, height: number) => {
    const measuredHeight = clampNumber(height, VIRTUAL_MIN_ITEM_HEIGHT, VIRTUAL_MAX_ITEM_HEIGHT)
    const previousHeight = virtualItemHeightsRef.current.get(itemKey)
    if (previousHeight !== undefined && Math.abs(previousHeight - measuredHeight) < 1) return

    virtualItemHeightsRef.current.set(itemKey, measuredHeight)
    if (hasPendingPermissionCard && shouldAutoScrollRef.current) {
      scrollToBottom('auto')
    }

    if (typeof requestAnimationFrame === 'undefined') {
      pendingMeasuredHeightsRef.current = true
      flushMeasuredHeightVersion()
    } else if (!pendingMeasuredHeightsRef.current) {
      pendingMeasuredHeightsRef.current = true
      if (measureFlushFrameRef.current !== null) {
        cancelAnimationFrame(measureFlushFrameRef.current)
      }
      measureFlushFrameRef.current = requestAnimationFrame(() => {
        measureFlushFrameRef.current = null
        flushMeasuredHeightVersion()
      })
    }
  }, [flushMeasuredHeightVersion, hasPendingPermissionCard, scrollToBottom])

  const updateAutoScrollState = useCallback(() => {
    // Ignore scroll events triggered by our own programmatic scrolling to
    // prevent the jump-to-latest button from flickering during auto-scroll.
    const container = scrollContainerRef.current
    if (!container) return
    const matchesProgrammaticScrollTop =
      ignoreProgrammaticScrollTopRef.current !== null &&
      Math.abs(container.scrollTop - ignoreProgrammaticScrollTopRef.current) < 1
    const shouldIgnoreRecentProgrammaticScroll =
      matchesProgrammaticScrollTop &&
      (
        isProgrammaticScrollingRef.current ||
        performance.now() < ignoreProgrammaticScrollUntilRef.current
      )
    if (shouldIgnoreRecentProgrammaticScroll) {
      syncVirtualViewportFromContainer(container)
      return
    }
    syncVirtualViewportFromContainer(container)

    // v1.5.0 历史分页：用户滚近顶部且还有更早历史时，按游标翻页。
    // 先记录滚动锚点（scrollHeight/scrollTop），prepend 提交后由
    // useLayoutEffect 按高度差回移 scrollTop，用户视口不跳动。
    if (
      resolvedSessionId &&
      historyHasMore &&
      earlierHistoryStatus !== 'loading' &&
      messages.length > 0 &&
      container.scrollTop <= EARLIER_HISTORY_TRIGGER_PX &&
      !earlierHistoryPrependAnchorRef.current
    ) {
      earlierHistoryPrependAnchorRef.current = {
        sessionId: resolvedSessionId,
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
      }
      void loadEarlierHistory(resolvedSessionId)
    }

    const isAtBottom = isNearScrollBottom(container)
    const isPermissionLayoutShift =
      hasPendingPermissionCard &&
      shouldAutoScrollRef.current &&
      !isAtBottom &&
      performance.now() >= userScrollIntentUntilRef.current
    if (isPermissionLayoutShift) return

    shouldAutoScrollRef.current = isAtBottom
    setShowJumpToLatest(!isAtBottom)

    if (resolvedSessionId) {
      rememberSessionScroll(resolvedSessionId, container)
    }
  }, [
    earlierHistoryStatus,
    hasPendingPermissionCard,
    historyHasMore,
    loadEarlierHistory,
    messages.length,
    resolvedSessionId,
    syncVirtualViewportFromContainer,
  ])

  // 翻页请求失败（earlierHistoryStatus 归 error）时释放锚点，允许用户再次上滚重试。
  useEffect(() => {
    if (earlierHistoryStatus === 'error') {
      earlierHistoryPrependAnchorRef.current = null
    }
  }, [earlierHistoryStatus])

  // prepend 提交后恢复视口：scrollTop += 新增内容高度，用户看到的消息保持原位。
  useLayoutEffect(() => {
    const anchor = earlierHistoryPrependAnchorRef.current
    if (!anchor || anchor.sessionId !== resolvedSessionId) return
    earlierHistoryPrependAnchorRef.current = null
    const container = scrollContainerRef.current
    if (!container) return
    const heightDelta = container.scrollHeight - anchor.scrollHeight
    if (heightDelta <= 0) return
    const nextScrollTop = anchor.scrollTop + heightDelta
    // 这次 scrollTop 变化是程序补偿，不是用户滚动——按既有程序化滚动协议登记，
    // 避免 onScroll 把它误判成用户上滚（关掉自动跟随/弹"回到底部"）。
    ignoreProgrammaticScrollUntilRef.current = performance.now() + 250
    ignoreProgrammaticScrollTopRef.current = nextScrollTop
    container.scrollTop = nextScrollTop
    syncVirtualViewportFromContainer(container)
  }, [messages, resolvedSessionId, syncVirtualViewportFromContainer])

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current = performance.now() + USER_SCROLL_INTENT_WINDOW_MS
  }, [])

  const handleWheelScrollIntent = useCallback((event: { deltaY: number }) => {
    markUserScrollIntent()
    if (event.deltaY < 0) {
      shouldAutoScrollRef.current = false
      setShowJumpToLatest(true)
    }
  }, [markUserScrollIntent])

  const handleKeyDownScrollIntent = useCallback((event: { key: string; shiftKey: boolean }) => {
    const isUpwardScrollKey =
      event.key === 'ArrowUp' ||
      event.key === 'PageUp' ||
      event.key === 'Home' ||
      (event.key === ' ' && event.shiftKey)
    const isScrollKey = isUpwardScrollKey ||
      event.key === 'ArrowDown' ||
      event.key === 'PageDown' ||
      event.key === 'End' ||
      event.key === ' '
    if (!isScrollKey) return

    markUserScrollIntent()
    if (isUpwardScrollKey) {
      shouldAutoScrollRef.current = false
      setShowJumpToLatest(true)
    }
  }, [markUserScrollIntent])

  useLayoutEffect(() => {
    if (lastSessionIdRef.current !== resolvedSessionId) {
      const snapshot = resolvedSessionId ? sessionScrollSnapshots.get(resolvedSessionId) : undefined
      shouldAutoScrollRef.current = snapshot?.wasAtBottom ?? true
      lastSessionIdRef.current = resolvedSessionId
      virtualItemHeightsRef.current = resolvedSessionId
        ? getHeightsForSession(resolvedSessionId)
        : new Map<string, number>()
      virtualItemMetricCacheRef.current = resolvedSessionId
        ? getMetricsForSession(resolvedSessionId)
        : new Map<string, VirtualRenderItemMetric>()
      pendingMeasuredHeightsRef.current = false
      lastContentResizeFollowHeightRef.current = null
      if (measureFlushFrameRef.current !== null) {
        cancelAnimationFrame(measureFlushFrameRef.current)
        measureFlushFrameRef.current = null
      }
      setMeasuredItemsVersion((version) => version + 1)

      const container = scrollContainerRef.current
      if (container && snapshot && !snapshot.wasAtBottom) {
        ignoreProgrammaticScrollUntilRef.current = performance.now() + 250
        ignoreProgrammaticScrollTopRef.current = snapshot.scrollTop
        setScrollTopWithoutLayoutRead(container, snapshot.scrollTop)
        setVirtualViewport((current) => ({
          scrollTop: snapshot.scrollTop,
          viewportHeight: container.clientHeight || current.viewportHeight || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT,
        }))
        setShowJumpToLatest(true)
      } else if (container) {
        // Switch to a session we were at the bottom of (or first visit): write
        // the bottom sentinel without going through scrollToBottom's read path,
        // so we never force a layout flush during the switch's commit.
        ignoreProgrammaticScrollUntilRef.current = performance.now() + 250
        ignoreProgrammaticScrollTopRef.current = null
        lastAutoScrollAtRef.current = performance.now()
        shouldAutoScrollRef.current = true
        setScrollToBottomWithoutLayoutRead(container, 'auto')
        setVirtualViewport((current) => ({
          scrollTop: SCROLL_BOTTOM_SENTINEL,
          viewportHeight: container.clientHeight || current.viewportHeight || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT,
        }))
        setShowJumpToLatest(false)
        if (resolvedSessionId) {
          sessionScrollSnapshots.set(resolvedSessionId, {
            scrollTop: container.scrollTop,
            wasAtBottom: true,
          })
        }
      } else {
        // No container yet (initial mount before ref settles): fall back to the
        // existing scrollToBottom path which is safe pre-mount.
        scrollToBottom('auto')
      }
    }
  }, [resolvedSessionId, scrollToBottom])

  const tailMessage = messages[messages.length - 1] ?? null
  const tailMessageId = tailMessage?.id ?? null
  const tailMessageType = tailMessage?.type ?? null

  useEffect(() => {
    if (!resolvedSessionId) return

    const previousTailMessageId = lastTailMessageIdBySessionRef.current.get(resolvedSessionId)
    lastTailMessageIdBySessionRef.current.set(resolvedSessionId, tailMessageId)
    if (previousTailMessageId === undefined || previousTailMessageId === tailMessageId) return

    if (tailMessageType === 'user_text') {
      scrollToBottom('auto')
    }
  }, [resolvedSessionId, scrollToBottom, tailMessageId, tailMessageType])

  useEffect(() => {
    if (!shouldAutoScrollRef.current) {
      setShowJumpToLatest(true)
      return
    }

    scrollToBottom('auto')
  }, [messages.length, resolvedSessionId, scrollToBottom, streamingText, streamingToolInput])

  const handleJumpToLatest = useCallback(() => {
    scrollToBottom('auto')
  }, [scrollToBottom])

  useEffect(() => {
    const content = scrollContentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      const nextHeight = entries[0]?.contentRect.height
      if (typeof nextHeight === 'number' && Number.isFinite(nextHeight)) {
        const previousFollowHeight = lastContentResizeFollowHeightRef.current
        if (
          previousFollowHeight !== null &&
          Math.abs(nextHeight - previousFollowHeight) <= CONTENT_RESIZE_FOLLOW_JITTER_MAX_DELTA_PX
        ) {
          return
        }
        lastContentResizeFollowHeightRef.current = nextHeight
      }
      if (!shouldFollowContentResize) return
      if (!shouldAutoScrollRef.current) return
      scrollToBottom('auto')
    })
    observer.observe(content)

    return () => observer.disconnect()
  }, [scrollToBottom, shouldFollowContentResize])

  // Touch-H5 only: the visual-viewport fit (touchH5.ts) shrinks the scroll
  // container when the soft keyboard opens. If the user was reading the tail,
  // keep the latest message pinned above the keyboard instead of letting the
  // shorter container cut it off.
  useEffect(() => {
    if (!isTouchH5Document()) return
    const container = scrollContainerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      if (!shouldAutoScrollRef.current) return
      scrollToBottom('auto')
    })
    observer.observe(container)

    return () => observer.disconnect()
  }, [scrollToBottom])

  const { toolResultMap, childToolCallsByParent, renderItems } = useMemo(
    () => buildRenderModel(messages, activeAskUserQuestionToolUseId),
    [activeAskUserQuestionToolUseId, messages],
  )
  // Defer the per-message branchable / completed-turn computations so the first
  // commit on tab switch can render the virtualization window without doing two
  // additional O(N) walks synchronously. They re-run in a low-priority render
  // once the initial frame is painted.
  const deferredMessages = useDeferredValue(messages)
  const branchableMessageTargets = useMemo(
    () => branchActionsDisabled
      ? new Map<string, BranchableMessageTarget>()
      : getBranchableMessageTargets(deferredMessages),
    [branchActionsDisabled, deferredMessages],
  )
  const completedTurnTargets = useMemo(
    () => getCompletedTurnTargets(deferredMessages),
    [deferredMessages],
  )
  const turnCompletionByMessageId = useMemo(
    () => buildTurnCompletionByMessageId(deferredMessages, { turnActive: chatState !== 'idle' }),
    [deferredMessages, chatState],
  )
  const latestCompletedTurnId =
    completedTurnTargets.length > 0
      ? completedTurnTargets[completedTurnTargets.length - 1]?.messageId ?? null
      : null
  const visibleTurnChangeCards = hasRunningBackgroundTasks ? EMPTY_TURN_CHANGE_CARDS : turnChangeCards
  const turnCardsByRenderIndex = useMemo(
    () => buildTurnCardInsertionMap(renderItems, visibleTurnChangeCards),
    [renderItems, visibleTurnChangeCards],
  )
  const changedFilesByRenderIndex = useMemo(
    () => buildChangedFilesByRenderIndex(renderItems, visibleTurnChangeCards),
    [renderItems, visibleTurnChangeCards],
  )
  const renderItemKeys = useMemo(
    () => renderItems.map(getRenderItemKey),
    [renderItems],
  )
  const renderItemMetrics = useMemo(
    () => renderItems.map((item, index) => {
      const key = renderItemKeys[index]!
      const signature = getRenderItemMetricSignature(item)
      const cached = virtualItemMetricCacheRef.current.get(key)
      if (cached?.signature === signature) return cached

      const metric = {
        signature,
        contentWeight: getRenderItemContentWeight(item),
        estimatedHeight: estimateRenderItemHeight(item),
      }
      virtualItemMetricCacheRef.current.set(key, metric)
      return metric
    }),
    [renderItemKeys, renderItems],
  )
  const conversationNavigationHistoryItems = useMemo(() => {
    const sources = renderItems.flatMap((item, renderIndex) => item.kind === 'message'
      ? [{
          message: item.message,
          renderIndex,
          renderItemKey: getRenderItemKey(item),
        }]
      : [])

    return buildConversationNavigationItems(sources)
  }, [renderItems])
  const streamingConversationNavigationItem = useMemo(() => {
    if (!streamingText.trim()) return null

    return buildConversationNavigationItems([{
      message: {
        id: `${STREAMING_ASSISTANT_NAVIGATION_KEY}-${resolvedSessionId ?? 'session'}`,
        type: 'assistant_text',
        content: streamingText,
        timestamp: 0,
      },
      renderIndex: renderItems.length,
      renderItemKey: STREAMING_ASSISTANT_NAVIGATION_KEY,
    }])[0] ?? null
  }, [renderItems, resolvedSessionId, streamingText])
  const conversationNavigationItems = useMemo(
    () => streamingConversationNavigationItem
      ? [...conversationNavigationHistoryItems, streamingConversationNavigationItem]
      : conversationNavigationHistoryItems,
    [conversationNavigationHistoryItems, streamingConversationNavigationItem],
  )
  const virtualTranscriptWindow = useMemo(
    () => buildVirtualTranscriptWindow(
      renderItems,
      renderItemKeys,
      renderItemMetrics,
      virtualItemHeightsRef.current,
      virtualViewport,
      VIRTUAL_OVERSCAN_PX,
    ),
    [measuredItemsVersion, renderItemKeys, renderItemMetrics, renderItems, virtualViewport],
  )
  const activeConversationNavigationItemId = useMemo(
    () => getActiveConversationNavigationItemId(
      conversationNavigationItems,
      virtualTranscriptWindow.offsets,
      virtualViewport.scrollTop,
      virtualViewport.viewportHeight,
    ),
    [conversationNavigationItems, virtualTranscriptWindow.offsets, virtualViewport],
  )
  const conversationNavigationMode: ConversationNavigationMode =
    messageListWidth === null || messageListWidth >= CONVERSATION_NAVIGATION_FULL_MIN_WIDTH_PX
      ? 'full'
      : messageListWidth >= CONVERSATION_NAVIGATION_COMPACT_MIN_WIDTH_PX
        ? 'compact'
        : 'edge'
  const showConversationNavigator =
    !mobileLayout &&
    !isTouchH5Document() &&
    conversationNavigationItems.length >= CONVERSATION_NAVIGATION_MIN_ITEMS
  const chatScrollPaddingClass = compact
    ? showConversationNavigator && conversationNavigationMode === 'full'
      ? 'pb-5 px-20 py-3'
      : showConversationNavigator && conversationNavigationMode === 'compact'
        ? 'pb-5 px-12 py-3'
        : showConversationNavigator && conversationNavigationMode === 'edge'
          ? 'pb-5 px-7 py-3'
          : 'px-3 py-3 pb-5'
    : showConversationNavigator && conversationNavigationMode === 'full'
      ? 'px-20 py-4'
      : showConversationNavigator && conversationNavigationMode === 'compact'
        ? 'px-12 py-4'
        : showConversationNavigator && conversationNavigationMode === 'edge'
          ? 'px-7 py-4'
          : 'px-4 py-4'
  const confirmTurnCard = useMemo(
    () => visibleTurnChangeCards.find((card) => card.target.messageId === turnUndoConfirmTargetId) ?? null,
    [turnUndoConfirmTargetId, visibleTurnChangeCards],
  )

  useEffect(() => {
    const liveKeys = new Set(renderItemKeys)
    let removed = false
    for (const key of virtualItemHeightsRef.current.keys()) {
      if (!liveKeys.has(key)) {
        virtualItemHeightsRef.current.delete(key)
        removed = true
      }
    }
    for (const key of virtualItemMetricCacheRef.current.keys()) {
      if (!liveKeys.has(key)) {
        virtualItemMetricCacheRef.current.delete(key)
      }
    }
    if (removed) setMeasuredItemsVersion((version) => version + 1)
  }, [renderItemKeys])

  useEffect(() => {
    if (!resolvedSessionId || completedTurnTargets.length === 0 || isMemberSession) {
      setTurnChangeCards([])
      setTurnChangeLoadError(null)
      setIsLoadingTurnChangeCards(false)
      return
    }

    if (hasRunningBackgroundTasks) {
      setTurnChangeLoadError(null)
      setIsLoadingTurnChangeCards(false)
      return
    }

    if (chatState !== 'idle') {
      setTurnChangeLoadError(null)
      setIsLoadingTurnChangeCards(false)
      return
    }

    let cancelled = false
    setIsLoadingTurnChangeCards(true)
    setTurnChangeLoadError(null)

    Promise.all([
      sessionsApi.getTurnCheckpoints(resolvedSessionId),
      sessionsApi.getWorkspaceStatus(resolvedSessionId).catch(() => null),
    ])
      .then(([checkpointResponse, workspaceStatus]) => {
        if (cancelled) return
        const targetByMessageId = new Map(
          completedTurnTargets.map((target) => [target.messageId, target] as const),
        )
        const targetByUserMessageIndex = new Map(
          completedTurnTargets.map((target) => [target.userMessageIndex, target] as const),
        )

        setTurnChangeCards(
          normalizeTurnCheckpoints(checkpointResponse).flatMap((checkpoint) => {
            const target =
              targetByMessageId.get(checkpoint.target.targetUserMessageId) ??
              targetByUserMessageIndex.get(checkpoint.target.userMessageIndex)
            if (!target || !checkpoint.code.available || checkpoint.code.filesChanged.length === 0) {
              return []
            }
            return [{
              target,
              checkpoint,
              workDir: checkpoint.workDir ?? workspaceStatus?.workDir ?? null,
              isLatest: target.messageId === latestCompletedTurnId,
            }]
          }),
        )
      })
      .catch((error) => {
        if (cancelled) return
        setTurnChangeCards([])
        setTurnChangeLoadError(getApiErrorMessage(error))
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingTurnChangeCards(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [chatState, completedTurnTargets, hasRunningBackgroundTasks, isMemberSession, latestCompletedTurnId, resolvedSessionId])

  const handleUndoCurrentTurn = useCallback(async () => {
    if (!resolvedSessionId || !confirmTurnCard || rewindingTurnId || hasRunningBackgroundTasks) return

    const target = confirmTurnCard.target
    setRewindingTurnId(target.messageId)
    setTurnActionErrors((current) => {
      if (!(target.messageId in current)) return current
      const next = { ...current }
      delete next[target.messageId]
      return next
    })

    try {
      if (chatState !== 'idle') {
        stopGeneration(resolvedSessionId)
      }

      const checkpointTarget = confirmTurnCard.checkpoint.target
      const result = await sessionsApi.rewind(resolvedSessionId, {
        targetUserMessageId: checkpointTarget.targetUserMessageId,
        userMessageIndex: checkpointTarget.userMessageIndex,
        expectedContent: target.expectedContent,
      })

      await reloadHistory(resolvedSessionId)
      queueComposerPrefill(resolvedSessionId, {
        text: target.content,
        attachments: target.attachments,
      })

      addToast({
        type: 'success',
        message: result.code.available
          ? t('chat.rewindSuccessWithCode', {
              count: result.conversation.messagesRemoved,
            })
          : t('chat.rewindSuccessConversationOnly', {
              count: result.conversation.messagesRemoved,
            }),
      })

      setTurnUndoConfirmTargetId(null)
    } catch (error) {
      setTurnActionErrors((current) => ({
        ...current,
        [target.messageId]: getApiErrorMessage(error),
      }))
      setTurnUndoConfirmTargetId(null)
    } finally {
      setRewindingTurnId(null)
    }
  }, [
    addToast,
    chatState,
    confirmTurnCard,
    hasRunningBackgroundTasks,
    queueComposerPrefill,
    reloadHistory,
    resolvedSessionId,
    rewindingTurnId,
    stopGeneration,
    t,
  ])

  const handleBranchMessage = useCallback(async (target: BranchableMessageTarget) => {
    if (!resolvedSessionId || branchingMessageId) return

    setBranchingMessageId(target.uiMessageId)
    try {
      const result = await branchSession(resolvedSessionId, target.transcriptMessageId)
      const title = result.title.trim() || t('sidebar.newSession')
      useTabStore.getState().openTab(result.sessionId, title)
      useChatStore.getState().connectToSession(result.sessionId)
      addToast({
        type: 'success',
        message: t('chat.branchSuccess', { title }),
      })
    } catch (error) {
      addToast({
        type: 'error',
        message: t('chat.branchError', { detail: getApiErrorMessage(error) }),
      })
    } finally {
      setBranchingMessageId(null)
    }
  }, [addToast, branchSession, branchingMessageId, resolvedSessionId, t])

  // Pre-compute per-message branchAction + toolResult lookups so MessageBlock's
  // memo barrier is not broken by inline object literals on every render.
  const branchActionByMessageId = useMemo(() => {
    if (branchableMessageTargets.size === 0) {
      return new Map<string, { label: string; loading: boolean; onBranch: () => void }>()
    }
    const result = new Map<string, { label: string; loading: boolean; onBranch: () => void }>()
    const label = t('chat.branchFromHere')
    for (const [uiMessageId, target] of branchableMessageTargets) {
      result.set(uiMessageId, {
        label,
        loading: branchingMessageId === target.uiMessageId,
        onBranch: () => { void handleBranchMessage(target) },
      })
    }
    return result
  }, [branchableMessageTargets, branchingMessageId, handleBranchMessage, t])

  const toolResultByToolUseId = useMemo(() => {
    if (toolResultMap.size === 0) return new Map<string, { content: unknown; isError: boolean }>()
    const result = new Map<string, { content: unknown; isError: boolean }>()
    for (const [toolUseId, toolResult] of toolResultMap) {
      result.set(toolUseId, { content: toolResult.content, isError: toolResult.isError })
    }
    return result
  }, [toolResultMap])

  const handleNavigateToConversationItem = useCallback((item: ConversationNavigationItem) => {
    const container = scrollContainerRef.current
    if (!container) return

    const viewportHeight = container.clientHeight || virtualViewport.viewportHeight || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT
    const isTranscriptTail =
      item.renderItemKey === STREAMING_ASSISTANT_NAVIGATION_KEY ||
      item.renderIndex === renderItems.length - 1
    setHighlightedNavigationItemKey(item.renderItemKey)

    const scheduleHighlightClear = () => {
      if (navigationHighlightTimerRef.current !== null) {
        window.clearTimeout(navigationHighlightTimerRef.current)
      }
      navigationHighlightTimerRef.current = window.setTimeout(() => {
        setHighlightedNavigationItemKey((current) => current === item.renderItemKey ? null : current)
        navigationHighlightTimerRef.current = null
      }, 1400)
    }

    if (isTranscriptTail) {
      scrollToBottom('auto')
      requestAnimationFrame(scheduleHighlightClear)
      return
    }

    const targetScrollTop = getConversationNavigationTargetScrollTop(
      item,
      virtualTranscriptWindow.offsets,
      viewportHeight,
      virtualTranscriptWindow.totalHeight,
    )
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const isNearby = Math.abs(container.scrollTop - targetScrollTop) <= viewportHeight * 1.25

    shouldAutoScrollRef.current = false
    setShowJumpToLatest(true)
    ignoreProgrammaticScrollUntilRef.current = performance.now() + 250
    ignoreProgrammaticScrollTopRef.current = targetScrollTop

    if (isNearby && !prefersReducedMotion && typeof container.scrollTo === 'function') {
      container.scrollTo({ top: targetScrollTop, behavior: 'smooth' })
    } else {
      setScrollTopWithoutLayoutRead(container, targetScrollTop)
    }
    setVirtualViewport({ scrollTop: targetScrollTop, viewportHeight })

    requestAnimationFrame(() => {
      const targetNode = Array.from(
        scrollContentRef.current?.querySelectorAll<HTMLElement>('[data-chat-render-item-key]') ?? [],
      ).find((node) => node.dataset.chatRenderItemKey === item.renderItemKey)

      if (targetNode) {
        const targetRect = targetNode.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()
        if (targetRect.height > 0) {
          const correction = targetRect.top - containerRect.top - viewportHeight * CONVERSATION_NAVIGATION_READING_ANCHOR_RATIO
          if (Math.abs(correction) >= 1) {
            setScrollTopWithoutLayoutRead(container, container.scrollTop + correction)
            syncVirtualViewportFromContainer(container)
          }
        }
      }

      scheduleHighlightClear()
    })
  }, [
    renderItems.length,
    scrollToBottom,
    syncVirtualViewportFromContainer,
    virtualTranscriptWindow.offsets,
    virtualTranscriptWindow.totalHeight,
    virtualViewport.viewportHeight,
  ])

  const navigateToConversationFindMatch = useCallback((match: ConversationFindMatch) => {
    const container = scrollContainerRef.current
    if (!container) return

    const viewportHeight = container.clientHeight || virtualViewport.viewportHeight || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT
    const targetOffset = virtualTranscriptWindow.offsets[match.renderIndex] ?? virtualTranscriptWindow.totalHeight
    const targetScrollTop = clampNumber(
      targetOffset - viewportHeight * CONVERSATION_NAVIGATION_READING_ANCHOR_RATIO,
      0,
      Math.max(0, virtualTranscriptWindow.totalHeight - viewportHeight),
    )

    setActiveConversationFindMatch(match)
    shouldAutoScrollRef.current = false
    setShowJumpToLatest(true)
    ignoreProgrammaticScrollUntilRef.current = performance.now() + 250
    ignoreProgrammaticScrollTopRef.current = targetScrollTop
    setScrollTopWithoutLayoutRead(container, targetScrollTop)
    setVirtualViewport({ scrollTop: targetScrollTop, viewportHeight })
  }, [virtualTranscriptWindow.offsets, virtualTranscriptWindow.totalHeight, virtualViewport.viewportHeight])
  const navigateToConversationFindMatchRef = useRef(navigateToConversationFindMatch)
  navigateToConversationFindMatchRef.current = navigateToConversationFindMatch
  const conversationFindRenderItemsRef = useRef(renderItems)
  conversationFindRenderItemsRef.current = renderItems
  const conversationFindStreamingTextRef = useRef(streamingText)
  conversationFindStreamingTextRef.current = streamingText
  const conversationFindControllerRef = useRef<ConversationFindController | null>(null)

  useEffect(() => {
    if (!resolvedSessionId || resolvedSessionId !== activeTabId) return

    const controller: ConversationFindController = {
      search(query, preferredIndex = 0) {
        const matches = findConversationMatches(
          conversationFindRenderItemsRef.current,
          conversationFindStreamingTextRef.current,
          query,
        )
        conversationFindMatchesRef.current = matches
        const selectedMatch = matches[Math.min(preferredIndex, Math.max(0, matches.length - 1))]
        if (selectedMatch) {
          navigateToConversationFindMatchRef.current(selectedMatch)
        } else {
          setActiveConversationFindMatch(null)
          clearConversationFindHighlights()
        }
        return matches.length
      },
      navigate(index) {
        const match = conversationFindMatchesRef.current[index]
        if (match) navigateToConversationFindMatchRef.current(match)
      },
      clear() {
        conversationFindMatchesRef.current = []
        setActiveConversationFindMatch(null)
        clearConversationFindHighlights()
      },
    }
    conversationFindControllerRef.current = controller
    const unregister = registerConversationFindController(controller)
    return () => {
      if (conversationFindControllerRef.current === controller) {
        conversationFindControllerRef.current = null
      }
      unregister()
    }
  }, [activeTabId, resolvedSessionId])

  useEffect(() => {
    const controller = conversationFindControllerRef.current
    if (!controller) return
    const notify = () => {
      conversationFindRefreshTimerRef.current = null
      conversationFindLastRefreshAtRef.current = performance.now()
      notifyConversationFindContentChanged(controller)
    }
    if (conversationFindRefreshTimerRef.current !== null) return
    const remainingDelay = CONVERSATION_FIND_CONTENT_REFRESH_MS -
      (performance.now() - conversationFindLastRefreshAtRef.current)
    if (remainingDelay <= 0) {
      notify()
      return
    }
    conversationFindRefreshTimerRef.current = window.setTimeout(notify, remainingDelay)
  }, [renderItems, streamingText])

  useLayoutEffect(() => {
    if (!activeConversationFindMatch) {
      clearConversationFindHighlights()
      return
    }

    const root = scrollContentRef.current
    if (!root) return
    paintConversationFindHighlights(root, activeConversationFindMatch)
  }, [activeConversationFindMatch, virtualTranscriptWindow.items])

  const restoreWorkspacePanelOrigin = useCallback((origin: WorkspacePanelOrigin, attempt = 0) => {
    const container = scrollContainerRef.current
    const content = scrollContentRef.current
    if (!container || !content || !resolvedSessionId) return

    const renderItem = [...content.querySelectorAll<HTMLElement>('[data-chat-render-item-key]')]
      .find((node) => node.dataset.chatRenderItemKey === origin.sourceTurnKey)
    const opener = renderItem
      ? [...renderItem.querySelectorAll<HTMLElement>('[id]')]
          .find((node) => node.id === origin.sourceElementId)
      : null

    if (renderItem && opener) {
      if (!isRenderItemFullyVisibleInChatScroller(renderItem)) {
        renderItem.scrollIntoView({ block: 'nearest' })
      }
      opener.focus({ preventScroll: true })
      useWorkspacePanelStore.getState().clearOrigin(resolvedSessionId)
      workspaceOriginRestoreFrameRef.current = null
      return
    }

    const renderIndex = renderItemKeys.indexOf(origin.sourceTurnKey)
    if (!renderItem && renderIndex >= 0) {
      const viewportHeight = container.clientHeight || virtualViewport.viewportHeight || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT
      const targetScrollTop = clampNumber(
        (virtualTranscriptWindow.offsets[renderIndex] ?? 0) - viewportHeight * CONVERSATION_NAVIGATION_READING_ANCHOR_RATIO,
        0,
        Math.max(0, virtualTranscriptWindow.totalHeight - viewportHeight),
      )
      shouldAutoScrollRef.current = false
      setScrollTopWithoutLayoutRead(container, targetScrollTop)
      setVirtualViewport({ scrollTop: targetScrollTop, viewportHeight })
    }

    if (attempt >= 7 || renderIndex < 0) {
      useWorkspacePanelStore.getState().clearOrigin(resolvedSessionId)
      workspaceOriginRestoreFrameRef.current = null
      return
    }

    workspaceOriginRestoreFrameRef.current = requestAnimationFrame(() => {
      restoreWorkspacePanelOrigin(origin, attempt + 1)
    })
  }, [
    renderItemKeys,
    resolvedSessionId,
    virtualTranscriptWindow.offsets,
    virtualTranscriptWindow.totalHeight,
    virtualViewport.viewportHeight,
  ])

  useEffect(() => {
    if (workspaceOriginSessionRef.current !== resolvedSessionId) {
      workspaceOriginSessionRef.current = resolvedSessionId
      if (workspaceOriginRestoreFrameRef.current !== null) {
        cancelAnimationFrame(workspaceOriginRestoreFrameRef.current)
        workspaceOriginRestoreFrameRef.current = null
      }
    }
    if (isWorkspacePanelOpen) {
      if (workspaceOriginRestoreFrameRef.current !== null) {
        cancelAnimationFrame(workspaceOriginRestoreFrameRef.current)
        workspaceOriginRestoreFrameRef.current = null
      }
      return
    }
    if (!workspacePanelOrigin || workspaceOriginRestoreFrameRef.current !== null) return

    workspaceOriginRestoreFrameRef.current = requestAnimationFrame(() => {
      workspaceOriginRestoreFrameRef.current = null
      restoreWorkspacePanelOrigin(workspacePanelOrigin)
    })
  }, [isWorkspacePanelOpen, resolvedSessionId, restoreWorkspacePanelOrigin, workspacePanelOrigin])

  const renderTranscriptItem = (item: RenderItem, index: number) => {
    const cardsForItem = turnCardsByRenderIndex.get(index) ?? []

    return (
      <>
        {item.kind === 'tool_group' ? (
          <ToolCallGroup
            sessionId={resolvedSessionId}
            toolCalls={item.toolCalls}
            resultMap={toolResultMap}
            childToolCallsByParent={childToolCallsByParent}
            agentTaskNotifications={agentTaskNotifications}
            isStreaming={
              chatState === 'tool_executing' &&
              item.toolCalls.some((tc) => !toolResultMap.has(tc.toolUseId))
            }
          />
        ) : (
          <MessageBlock
            sessionId={resolvedSessionId}
            message={item.message}
            activeThinkingId={activeThinkingId}
            agentTaskNotifications={agentTaskNotifications}
            toolResult={
              item.message.type === 'tool_use'
                ? toolResultByToolUseId.get(item.message.toolUseId) ?? null
                : null
            }
            branchAction={branchActionByMessageId.get(item.message.id)}
            turnChangedFiles={changedFilesByRenderIndex.get(index)}
            turnCompletion={turnCompletionByMessageId.get(item.message.id)}
          />
        )}

        {resolvedSessionId && cardsForItem.map((card) => (
          <CurrentTurnChangeCard
            key={`turn-change-${card.target.messageId}`}
            sessionId={resolvedSessionId}
            checkpoint={card.checkpoint}
            workDir={card.workDir}
            error={turnActionErrors[card.target.messageId] ?? null}
            isUndoing={rewindingTurnId === card.target.messageId}
            isLatest={card.isLatest}
            onUndo={() => {
              setTurnUndoConfirmTargetId(card.target.messageId)
            }}
          />
        ))}
      </>
    )
  }

  return (
    <div ref={messageListRef} data-testid="message-list" className="relative min-h-0 flex-1">
      <div
        ref={scrollContainerRef}
        onScroll={updateAutoScrollState}
        onWheel={handleWheelScrollIntent}
        onPointerDown={markUserScrollIntent}
        onTouchStart={markUserScrollIntent}
        onKeyDown={handleKeyDownScrollIntent}
        className={`${CHAT_SCROLL_AREA_CLASS} h-full overflow-y-auto ${chatScrollPaddingClass}`}
      >
        <div
          ref={scrollContentRef}
          className={compact ? 'mx-auto max-w-full' : 'mx-auto max-w-[900px]'}
        >
          {(historyHasMore || earlierHistoryStatus === 'loading') && resolvedSessionId && (
            <div
              data-testid="earlier-history-status"
              className="flex justify-center pb-1 pt-2 text-xs text-[var(--color-text-tertiary)]"
            >
              {earlierHistoryStatus === 'loading' ? (
                <span>{t('chat.loadingEarlier')}</span>
              ) : (
                <button
                  type="button"
                  className="rounded-[var(--radius-md)] px-3 py-1 transition-colors hover:bg-[var(--color-surface-container-low)] hover:text-[var(--color-text-secondary)]"
                  onClick={() => {
                    const container = scrollContainerRef.current
                    if (container && !earlierHistoryPrependAnchorRef.current) {
                      earlierHistoryPrependAnchorRef.current = {
                        sessionId: resolvedSessionId,
                        scrollHeight: container.scrollHeight,
                        scrollTop: container.scrollTop,
                      }
                    }
                    void loadEarlierHistory(resolvedSessionId)
                  }}
                >
                  {t('chat.loadEarlier')}
                </button>
              )}
            </div>
          )}
          {virtualTranscriptWindow.enabled ? (
            <VirtualSpacer height={virtualTranscriptWindow.beforeHeight} position="top" />
          ) : null}

          {virtualTranscriptWindow.items.map(({ item, index }) => {
            const itemKey = getRenderItemKey(item)
            const content = renderTranscriptItem(item, index)

            return virtualTranscriptWindow.enabled ? (
              <MeasuredRenderItem
                key={itemKey}
                itemKey={itemKey}
                onHeightChange={handleVirtualItemHeightChange}
                highlighted={highlightedNavigationItemKey === itemKey}
              >
                {content}
              </MeasuredRenderItem>
            ) : (
              <div
                key={itemKey}
                data-chat-render-item-key={itemKey}
                className={`${CHAT_RENDER_ITEM_CLASS} chat-render-item--cv ${highlightedNavigationItemKey === itemKey ? 'chat-render-item--navigation-target' : ''}`}
              >
                {content}
              </div>
            )
          })}

          {virtualTranscriptWindow.enabled ? (
            <VirtualSpacer height={virtualTranscriptWindow.afterHeight} position="bottom" />
          ) : null}

          {streamingText.trim() && (
            <div
              data-chat-render-item-key={STREAMING_ASSISTANT_NAVIGATION_KEY}
              className={highlightedNavigationItemKey === STREAMING_ASSISTANT_NAVIGATION_KEY ? 'chat-render-item--navigation-target' : ''}
            >
              <AssistantMessage content={streamingText} isStreaming={chatState === 'streaming'} />
            </div>
          )}

          {chatState === 'compacting' && !hasCompactingDivider && (
            <CompactStatusDivider state="compacting" />
          )}

          {/* Show StreamingIndicator when:
              - tool_executing: background work is running
              - thinking but no active ThinkingBlock yet: the gap between
                sending a message and receiving the first thinking delta */}
          {(chatState === 'tool_executing' || (chatState === 'thinking' && !activeThinkingId)) && (
            <StreamingIndicator />
          )}

          {!isLoadingTurnChangeCards && visibleTurnChangeCards.length === 0 && turnChangeLoadError && (
            <div className="mx-auto mb-5 w-full max-w-[900px] rounded-[var(--radius-lg)] border border-[var(--color-error)] bg-[var(--color-error-container)] px-4 py-3 text-xs text-[var(--color-on-error-container)]">
              {turnChangeLoadError}
            </div>
          )}

          <div />
        </div>
      </div>

      {showConversationNavigator ? (
        <ConversationNavigator
          mode={conversationNavigationMode}
          items={conversationNavigationItems}
          activeItemId={activeConversationNavigationItemId}
          onNavigate={handleNavigateToConversationItem}
        />
      ) : null}

      {showJumpToLatest && (
        <Button
          variant="secondary"
          size="md"
          onClick={handleJumpToLatest}
          title={t('chat.jumpToLatest')}
          aria-label={t('chat.jumpToLatest')}
          // `glass-panel` is unlayered CSS, so it wins over the variant's
          // layered background/border utilities without a tailwind-merge.
          className="glass-panel absolute bottom-4 right-5 z-20 rounded-full text-[13.5px] font-medium hover:-translate-y-px motion-reduce:hover:translate-y-0"
          icon={<ArrowDown size={15} aria-hidden="true" />}
        >
          {t('chat.jumpToLatest')}
        </Button>
      )}

      <ConfirmDialog
        open={Boolean(confirmTurnCard)}
        onClose={() => {
          if (!rewindingTurnId) {
            setTurnUndoConfirmTargetId(null)
          }
        }}
        onConfirm={handleUndoCurrentTurn}
        title={confirmTurnCard?.isLatest
          ? t('chat.turnChangesLatestConfirmTitle')
          : t('chat.turnChangesHistoricalConfirmTitle')}
        body={confirmTurnCard?.isLatest
          ? t('chat.turnChangesLatestConfirmBody')
          : t('chat.turnChangesHistoricalConfirmBody')}
        confirmLabel={confirmTurnCard?.isLatest
          ? t('chat.turnChangesLatestConfirmUndo')
          : t('chat.turnChangesHistoricalConfirmUndo')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={Boolean(rewindingTurnId)}
      />
    </div>
  )
}

export const MessageBlock = memo(function MessageBlock({
  sessionId,
  message,
  activeThinkingId,
  agentTaskNotifications,
  toolResult,
  branchAction,
  turnChangedFiles,
  turnCompletion,
}: {
  sessionId?: string | null
  message: UIMessage
  activeThinkingId: string | null
  agentTaskNotifications: Record<string, AgentTaskNotification>
  toolResult?: { content: unknown; isError: boolean } | null
  branchAction?: {
    label: string
    loading?: boolean
    onBranch: () => void
  }
  turnChangedFiles?: string[]
  turnCompletion?: TurnCompletion
}) {
  const t = useTranslation()

  switch (message.type) {
    case 'user_text':
      return (
        <SelectableChatMessage
          sessionId={sessionId}
          messageId={message.id}
          role="user"
          content={message.content}
        >
          <UserMessage
            content={message.content}
            attachments={message.attachments}
            branchAction={branchAction}
            timestamp={message.timestamp}
            sessionId={sessionId ?? undefined}
          />
        </SelectableChatMessage>
      )
    case 'assistant_text':
      return (
        <SelectableChatMessage
          sessionId={sessionId}
          messageId={message.id}
          role="assistant"
          content={message.content}
        >
          <AssistantMessage
            content={message.content}
            branchAction={branchAction}
            sessionId={sessionId ?? undefined}
            timestamp={message.timestamp}
            turnChangedFiles={turnChangedFiles}
            turnCompletion={turnCompletion}
          />
        </SelectableChatMessage>
      )
    case 'thinking':
      return <ThinkingBlock content={message.content} isActive={message.id === activeThinkingId} />
    case 'tool_use':
      if (message.toolName === 'AskUserQuestion' && !message.isPending) {
        return (
          <AskUserQuestion
            sessionId={sessionId}
            toolUseId={message.toolUseId}
            input={message.input}
            result={toolResult?.content}
          />
        )
      }
      // No durationMs prop here on purpose: buildRenderModel only emits a
      // standalone tool_use item for AskUserQuestion, and this branch is reached
      // only while such a call is still pending — so there is never a result to
      // measure against. The badge is wired in ToolCallGroup, the path every
      // other tool call takes.
      return (
        <ToolCallBlock
          toolName={message.toolName}
          input={message.input}
          result={toolResult}
          isPending={message.isPending}
          status={message.status}
          partialInput={message.partialInput}
          agentTaskNotification={
            message.toolName === 'Agent'
              ? agentTaskNotifications[message.toolUseId]
              : undefined
          }
        />
      )
    case 'tool_result':
      return (
        <ToolResultBlock
          content={message.content}
          isError={message.isError}
          standalone
        />
      )
    case 'permission_request':
      return (
        <PermissionDialog
          sessionId={sessionId}
          requestId={message.requestId}
          toolName={message.toolName}
          input={message.input}
          description={message.description}
        />
      )
    case 'error': {
      const businessErrorKey = message.businessErrorCode
        ? `businessError.${message.businessErrorCode}` as TranslationKey
        : null
      const businessErrorText = businessErrorKey ? t(businessErrorKey) : null
      const errorKey = message.code ? `error.${message.code}` as TranslationKey : null
      const errorText = errorKey ? t(errorKey) : null
      const displayMessage =
        businessErrorText && businessErrorText !== businessErrorKey
          ? businessErrorText
          : (errorText && errorText !== errorKey)
            ? errorText
            : message.message
      const showRawDetail =
        !message.businessErrorCode &&
        Boolean(message.message) &&
        message.message.trim() !== '' &&
        message.message !== displayMessage
      return (
        <div className="mb-3 px-4 py-2.5 rounded-[var(--radius-lg)] border border-[var(--color-error)] bg-[var(--color-error-container)] text-sm text-[var(--color-on-error-container)]">
          <strong>{t('common.error')}:</strong> {displayMessage}
          {showRawDetail && (
            <div className="mt-1 whitespace-pre-wrap text-xs text-[var(--color-on-error-container)]">
              {message.message}
            </div>
          )}
        </div>
      )
    }
    case 'task_summary':
      return <InlineTaskSummary tasks={message.tasks} />
    case 'memory_event':
      return <MemoryEventCard message={message} />
    case 'compact_summary':
      return <CompactStatusDivider message={message} state={message.phase === 'compacting' ? 'compacting' : 'complete'} />
    case 'goal_event':
      return message.action === 'status' && message.status === 'continuing'
        ? <GoalContinuationDivider message={message} />
        : <GoalEventCard message={message} />
    case 'background_task':
      return <BackgroundTaskEventCard message={message} />
    case 'system':
      return (
        <div className="mb-3 text-center text-xs text-[var(--color-text-tertiary)]">
          {message.content}
        </div>
      )
  }
})
