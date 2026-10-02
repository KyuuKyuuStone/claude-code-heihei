import { useRef, useEffect, useMemo, useState, useCallback, useDeferredValue, useLayoutEffect } from 'react'
import { ArrowDown } from 'lucide-react'
import {
  buildRenderModel,
  buildTurnCardInsertionMap,
  buildChangedFilesByRenderIndex,
  EMPTY_TURN_CHANGE_CARDS,
  getApiErrorMessage,
  getBranchableMessageTargets,
  getCompletedTurnTargets,
  normalizeTurnCheckpoints,
  type BranchableMessageTarget,
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
import { sessionsApi } from '../../api/sessions'
import {
  clearConversationFindHighlights,
  CONVERSATION_FIND_CONTENT_REFRESH_MS,
  findConversationMatches,
  paintConversationFindHighlights,
  type ConversationFindMatch,
} from './messagelist/conversationFind'
import { CompactStatusDivider } from './messagelist/cards'
import { MessageBlock } from './messagelist/MessageBlock'
export { MessageBlock } from './messagelist/MessageBlock'

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
import { useWorkspacePanelStore, type WorkspacePanelOrigin } from '../../stores/workspacePanelStore'
import { useTabStore } from '../../stores/tabStore'
import { useTeamStore } from '../../stores/teamStore'
import { useUIStore } from '../../stores/uiStore'
import { useTranslation } from '../../i18n'
import { AssistantMessage } from './AssistantMessage'
import { ToolCallGroup } from './ToolCallGroup'
import { StreamingIndicator } from './StreamingIndicator'
import { CurrentTurnChangeCard } from './CurrentTurnChangeCard'
import {
  buildConversationNavigationItems,
  ConversationNavigator,
  type ConversationNavigationItem,
  type ConversationNavigationMode,
} from './ConversationNavigator'
import type { AgentTaskNotification, UIMessage } from '../../types/chat'
import { hasRunningBackgroundTasks as hasAnyRunningBackgroundTasks } from '../../lib/backgroundTasks'
import { buildTurnCompletionByMessageId } from '../../lib/turnCompletion'
import { isTouchH5Document } from '../../lib/touchH5'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
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
