import { forwardRef, useMemo, useRef, useState, useEffect, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  SCHEDULED_TAB_ID,
  SETTINGS_TAB_ID,
  MARKET_TAB_ID,
  SUBAGENT_TAB_PREFIX,
  TERMINAL_TAB_PREFIX,
  TRACE_LIST_TAB_ID,
  COLLAB_TASKS_TAB_ID,
  TRACE_TAB_PREFIX,
  WORKBENCH_TAB_PREFIX,
  useTabStore,
  type Tab,
  type TabType,
} from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { isPlaceholderSessionTitle } from '../../lib/sessionTitle'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { useTerminalPanelStore } from '../../stores/terminalPanelStore'
import { useCLITaskStore } from '../../stores/cliTaskStore'
import { useTeamStore } from '../../stores/teamStore'
import { StatusDot } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'
import { useDismissable } from '@/hooks/useDismissable'
import { useTranslation } from '../../i18n'
import { getDesktopHost } from '../../lib/desktopHost'
import { hasRunningBackgroundTasks } from '../../lib/backgroundTasks'
import { WindowControls, showWindowControls } from './WindowControls'
import { OpenProjectMenu } from './OpenProjectMenu'
import { ClipboardList, Folder, FolderOpen, SquareTerminal } from 'lucide-react'
import { ActionDialog } from '@/components/ui/ActionDialog'
import { buildSessionActivityModel, hasVisibleSessionActivity } from '../activity/sessionActivityModel'
import { SessionActivityButton } from '../activity/SessionActivityButton'
import { useActivityPanelStore } from '../../stores/activityPanelStore'
import { getSessionBrowsablePath } from '../../lib/sessionWorkspace'

const DRAG_START_THRESHOLD = 4
const SCROLL_STEP_RATIO = 0.75
const REVEAL_ACTIVE_TAB: ScrollIntoViewOptions = { block: 'nearest', inline: 'nearest', behavior: 'smooth' }
const TAB_VISIBILITY_TOLERANCE = 1
const TAB_TYPE_ICON: Partial<Record<TabType, string>> = {
  settings: 'settings',
  scheduled: 'schedule',
  market: 'storefront',
  terminal: 'terminal',
  trace: 'account_tree',
  traces: 'account_tree',
  'collab-tasks': 'task_alt',
  workbench: 'view_sidebar',
  subagent: 'smart_toy',
}
const TAB_TYPE_ICON_FALLBACK = 'tab'
const desktopHost = getDesktopHost()
const isDesktopRuntime = desktopHost.isDesktop
const EMPTY_DISMISSED_BACKGROUND_TASK_KEYS: readonly string[] = []

type PendingCloseRequest = { tabs: Tab[]; runningSessionIds: string[] }

function isSessionTab(tab: Tab | null) {
  if (!tab) return false
  const type = (tab as Partial<Tab>).type
  if (type === 'session') return true
  if (type) return false
  return isSessionTabId(tab.sessionId)
}

function isSessionTabId(tabId: string | null) {
  if (!tabId) return false
  return tabId !== SETTINGS_TAB_ID && tabId !== SCHEDULED_TAB_ID && tabId !== MARKET_TAB_ID && tabId !== TRACE_LIST_TAB_ID && tabId !== COLLAB_TASKS_TAB_ID &&
    !tabId.startsWith(TERMINAL_TAB_PREFIX) && !tabId.startsWith(TRACE_TAB_PREFIX) && !tabId.startsWith(WORKBENCH_TAB_PREFIX) && !tabId.startsWith(SUBAGENT_TAB_PREFIX)
}

export function TabBar() {
  const tabs = useTabStore((state) => state.tabs)
  const activeTabId = useTabStore((state) => state.activeTabId)
  const setActiveTab = useTabStore((state) => state.setActiveTab)
  const closeTab = useTabStore((state) => state.closeTab)
  const sessionTabIds = useMemo(() => tabs.filter(isSessionTab).map((tab) => tab.sessionId), [tabs])
  const activeChatSessionIds = useChatStore(useShallow((state) => sessionTabIds.filter((id) => {
    const chat = state.sessions[id]
    return !!chat && (chat.chatState !== 'idle' || hasRunningBackgroundTasks(chat.backgroundAgentTasks))
  })))
  const disconnectSession = useChatStore((state) => state.disconnectSession)
  const activeTab = tabs.find((tab) => tab.sessionId === activeTabId) ?? null
  const isActiveSessionTab = isSessionTab(activeTab) || isSessionTabId(activeTabId)
  const activeSession = useSessionStore((state) => activeTabId ? state.sessions.find((session) => session.id === activeTabId) : undefined)
  const openProjectPath = isActiveSessionTab ? getSessionBrowsablePath(activeSession) ?? null : null
  const isWorkbenchOpen = useWorkspacePanelStore((state) => activeTabId && isActiveSessionTab ? state.isPanelOpen(activeTabId) : false)
  const workbenchMode = useWorkspacePanelStore((state) => activeTabId && isActiveSessionTab ? state.getMode(activeTabId) : 'workspace')
  const isWorkspacePanelOpen = isWorkbenchOpen && workbenchMode === 'workspace'
  const isTerminalPanelOpen = useTerminalPanelStore((state) => activeTabId && isActiveSessionTab ? state.isPanelOpen(activeTabId) : false)
  const cliTasks = useCLITaskStore((state) => state.tasks)
  const cliTasksSessionId = useCLITaskStore((state) => state.sessionId)
  const cliTasksCompletedAndDismissed = useCLITaskStore((state) => state.completedAndDismissed)
  const dismissedBackgroundTaskKeyList = useActivityPanelStore((state) => activeTabId ? state.dismissedBackgroundTaskKeysBySession[activeTabId] ?? EMPTY_DISMISSED_BACKGROUND_TASK_KEYS : EMPTY_DISMISSED_BACKGROUND_TASK_KEYS)
  const dismissedBackgroundTaskKeys = useMemo(() => new Set(dismissedBackgroundTaskKeyList), [dismissedBackgroundTaskKeyList])
  const activityTeamMembers = useTeamStore(useShallow((state) => {
    const team = state.activeTeam
    if (!activeTabId || !team || team.leadSessionId !== activeTabId) return []
    return team.members.filter((member) => !team.leadAgentId || member.agentId !== team.leadAgentId)
  }))
  const activityMessages = useChatStore((state) => activeTabId && isActiveSessionTab ? state.sessions[activeTabId]?.messages : undefined)
  const activityBackgroundTasks = useChatStore((state) => activeTabId && isActiveSessionTab ? state.sessions[activeTabId]?.backgroundAgentTasks : undefined)
  const activityNotifications = useChatStore((state) => activeTabId && isActiveSessionTab ? state.sessions[activeTabId]?.agentTaskNotifications : undefined)
  const activityState = useMemo(() => {
    if (!activeTabId || !isActiveSessionTab) return { hasVisibleActivity: false }
    const includeCliTasks = cliTasksSessionId === activeTabId
    const model = buildSessionActivityModel({ sessionId: activeTabId, messages: activityMessages ?? [], tasks: includeCliTasks ? cliTasks : [], completedAndDismissed: includeCliTasks ? cliTasksCompletedAndDismissed : false, backgroundTasks: Object.values(activityBackgroundTasks ?? {}), dismissedBackgroundTaskKeys, agentNotifications: Object.values(activityNotifications ?? {}), teamMembers: activityTeamMembers })
    return { hasVisibleActivity: hasVisibleSessionActivity(model) }
  }, [activeTabId, isActiveSessionTab, activityMessages, activityBackgroundTasks, activityNotifications, cliTasks, cliTasksSessionId, cliTasksCompletedAndDismissed, dismissedBackgroundTaskKeys, activityTeamMembers])
  const showActivityButton = activeTabId && activityState.hasVisibleActivity && !isWorkbenchOpen
  const moveTab = useTabStore((state) => state.moveTab)
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolledRef = useRef(false)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null)
  const [pendingCloseRequest, setPendingCloseRequest] = useState<PendingCloseRequest | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null)
  const [dragOffsetX, setDragOffsetX] = useState(0)
  const dragIndexRef = useRef<number | null>(null)
  const pendingDragRef = useRef<{ index: number; startX: number; startY: number } | null>(null)
  const suppressClickRef = useRef(false)
  const tabRefs = useRef(new Map<string, HTMLDivElement | null>())
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const t = useTranslation()
  const runningSessionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const tab of tabs) if (isSessionTab(tab) && tab.status === 'running') ids.add(tab.sessionId)
    for (const id of activeChatSessionIds) ids.add(id)
    return ids
  }, [activeChatSessionIds, tabs])

  const updateScrollState = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    setCanScrollLeft(element.scrollLeft > 0)
    setCanScrollRight(element.scrollLeft + element.clientWidth < element.scrollWidth - 1)
  }, [])
  const realignActiveTab = useCallback(() => {
    if (userScrolledRef.current) return
    const element = scrollRef.current
    const activeId = useTabStore.getState().activeTabId
    if (!element || !activeId) return
    const activeElement = tabRefs.current.get(activeId)
    if (!activeElement) return
    const strip = element.getBoundingClientRect()
    const tab = activeElement.getBoundingClientRect()
    if (tab.left >= strip.left - TAB_VISIBILITY_TOLERANCE && tab.right <= strip.right + TAB_VISIBILITY_TOLERANCE) return
    activeElement.scrollIntoView(REVEAL_ACTIVE_TAB)
  }, [])
  useEffect(() => {
    updateScrollState()
    const element = scrollRef.current
    if (!element) return
    element.addEventListener('scroll', updateScrollState)
    const observer = new ResizeObserver(() => { updateScrollState(); realignActiveTab() })
    observer.observe(element)
    return () => { element.removeEventListener('scroll', updateScrollState); observer.disconnect() }
  }, [realignActiveTab, updateScrollState, tabs.length])
  useEffect(() => {
    if (!activeTabId) return
    const activeElement = tabRefs.current.get(activeTabId)
    if (!activeElement) return
    userScrolledRef.current = false
    activeElement.scrollIntoView(REVEAL_ACTIVE_TAB)
    const frame = window.requestAnimationFrame(updateScrollState)
    return () => window.cancelAnimationFrame(frame)
  }, [activeTabId, tabs.length, updateScrollState])
  const closeContextMenu = useCallback(() => setContextMenu(null), [])
  useDismissable({ open: contextMenu !== null, refs: [contextMenuRef], onDismiss: closeContextMenu })
  const scroll = (direction: 'left' | 'right') => {
    const element = scrollRef.current
    if (!element) return
    userScrolledRef.current = true
    element.scrollBy({ left: direction === 'left' ? -element.clientWidth * SCROLL_STEP_RATIO : element.clientWidth * SCROLL_STEP_RATIO, behavior: 'smooth' })
  }
  const closeTabWithCleanup = useCallback((tab: Tab) => {
    if (isSessionTab(tab)) {
      useWorkspacePanelStore.getState().clearSession(tab.sessionId)
      useTerminalPanelStore.getState().clearSession(tab.sessionId)
      useActivityPanelStore.getState().close(tab.sessionId)
    }
    closeTab(tab.sessionId)
  }, [closeTab])
  const getRunningSessionIds = useCallback((targetTabs: Tab[]) => targetTabs.filter(isSessionTab).filter((tab) => {
    const state = useChatStore.getState().sessions[tab.sessionId]
    return !!state && (state.chatState !== 'idle' || hasRunningBackgroundTasks(state.backgroundAgentTasks))
  }).map((tab) => tab.sessionId), [])
  const closeTabsWithPolicy = useCallback((targetTabs: Tab[], runningIds: string[], stopRunning: boolean) => {
    const running = new Set(runningIds)
    for (const tab of targetTabs) {
      if (isSessionTab(tab)) {
        const isRunning = running.has(tab.sessionId)
        if (isRunning && stopRunning) useChatStore.getState().stopGeneration(tab.sessionId)
        if (!isRunning || stopRunning) {
          const session = useSessionStore.getState().sessions.find((item) => item.id === tab.sessionId)
          const chat = useChatStore.getState().sessions[tab.sessionId]
          if (isPlaceholderSessionTitle(session?.title) && (!chat || chat.messages.length === 0)) void useSessionStore.getState().deleteSession(tab.sessionId)
          disconnectSession(tab.sessionId)
        }
      }
      closeTabWithCleanup(tab)
    }
  }, [closeTabWithCleanup, disconnectSession])
  const requestCloseTabs = useCallback((targetTabs: Tab[]) => {
    if (!targetTabs.length) return
    const runningIds = getRunningSessionIds(targetTabs)
    if (runningIds.length) setPendingCloseRequest({ tabs: targetTabs, runningSessionIds: runningIds })
    else closeTabsWithPolicy(targetTabs, [], false)
  }, [closeTabsWithPolicy, getRunningSessionIds])
  const handleClose = (id: string) => { const tab = tabs.find((item) => item.sessionId === id); if (tab) requestCloseTabs([tab]) }
  const handleContextMenu = (event: React.MouseEvent, id: string) => { event.preventDefault(); setContextMenu({ sessionId: id, x: event.clientX, y: event.clientY }) }
  const handleCloseOthers = (id: string) => { setContextMenu(null); requestCloseTabs(tabs.filter((tab) => tab.sessionId !== id)) }
  const handleCloseLeft = (id: string) => { setContextMenu(null); requestCloseTabs(tabs.slice(0, tabs.findIndex((tab) => tab.sessionId === id))) }
  const handleCloseRight = (id: string) => { setContextMenu(null); requestCloseTabs(tabs.slice(tabs.findIndex((tab) => tab.sessionId === id) + 1)) }
  const handleCloseAll = () => { setContextMenu(null); requestCloseTabs(tabs) }
  const getTargetIndexFromClientX = useCallback((clientX: number) => {
    for (let index = 0; index < tabs.length; index++) {
      const element = tabRefs.current.get(tabs[index]!.sessionId)
      if (!element) continue
      const rect = element.getBoundingClientRect()
      if (clientX < rect.left + rect.width / 2) return index
    }
    return tabs.length ? tabs.length - 1 : null
  }, [tabs])
  const finalizeDrag = useCallback((targetIndex: number | null) => {
    if (dragIndexRef.current !== null && targetIndex !== null && dragIndexRef.current !== targetIndex) moveTab(dragIndexRef.current, targetIndex)
    dragIndexRef.current = null
    pendingDragRef.current = null
    setDraggingSessionId(null)
    setDragOffsetX(0)
    setDragOverIndex(null)
  }, [moveTab])
  const handlePointerMove = useCallback((event: MouseEvent) => {
    const pending = pendingDragRef.current
    if (!pending) return
    const deltaX = Math.abs(event.clientX - pending.startX)
    const deltaY = Math.abs(event.clientY - pending.startY)
    if (dragIndexRef.current === null) {
      if (Math.max(deltaX, deltaY) < DRAG_START_THRESHOLD) return
      dragIndexRef.current = pending.index
      suppressClickRef.current = true
      setDraggingSessionId(tabs[pending.index]?.sessionId ?? null)
    }
    setDragOffsetX(event.clientX - pending.startX)
    const targetIndex = getTargetIndexFromClientX(event.clientX)
    setDragOverIndex(targetIndex === null || targetIndex === dragIndexRef.current ? null : targetIndex)
  }, [getTargetIndexFromClientX, tabs])
  const handlePointerUp = useCallback(() => finalizeDrag(dragOverIndex), [dragOverIndex, finalizeDrag])
  useEffect(() => {
    window.addEventListener('mousemove', handlePointerMove)
    window.addEventListener('mouseup', handlePointerUp)
    return () => { window.removeEventListener('mousemove', handlePointerMove); window.removeEventListener('mouseup', handlePointerUp) }
  }, [handlePointerMove, handlePointerUp])
  useEffect(() => {
    if (!draggingSessionId) return
    const oldCursor = document.body.style.cursor
    document.body.style.cursor = 'grabbing'
    return () => { document.body.style.cursor = oldCursor }
  }, [draggingSessionId])
  const handleTabMouseDown = (event: React.MouseEvent, index: number) => { if (event.button === 0) pendingDragRef.current = { index, startX: event.clientX, startY: event.clientY } }
  const handleTabClick = (id: string) => { if (suppressClickRef.current) { suppressClickRef.current = false; return } setActiveTab(id) }

  return (
    <div data-testid="tab-bar" data-desktop-drag-region={isDesktopRuntime ? true : undefined} className="flex min-h-[52px] items-stretch bg-[var(--color-surface-sidebar)] select-none">
      {canScrollLeft && <button type="button" onClick={() => scroll('left')} aria-label={t('tabs.scrollLeft')} className="flex h-[52px] w-7 flex-shrink-0 items-center justify-center text-[var(--color-text-tertiary)]"><span className="material-symbols-outlined text-[16px]">chevron_left</span></button>}
      <div ref={scrollRef} data-testid="tab-bar-scroll-region" data-desktop-drag-region={isDesktopRuntime ? true : undefined} className="flex-1 flex items-stretch gap-[2px] overflow-x-hidden pt-[6px]" onDragOver={(event) => event.preventDefault()}>
        {tabs.map((tab, index) => {
          const title = tab.type === 'settings' ? t('settings.title') : tab.title || t('tabs.untitled')
          return <TabItem key={tab.sessionId} ref={(node) => { tabRefs.current.set(tab.sessionId, node) }} tab={tab} displayTitle={title} closeLabel={t('tabs.closeTab', { title })} isRunning={runningSessionIds.has(tab.sessionId)} isActive={tab.sessionId === activeTabId} isDragOver={dragOverIndex === index} isDragging={tab.sessionId === draggingSessionId} dragOffsetX={tab.sessionId === draggingSessionId ? dragOffsetX : 0} runningLabel={t('tabs.sessionRunning')} onClick={() => handleTabClick(tab.sessionId)} onClose={() => handleClose(tab.sessionId)} onContextMenu={(event) => handleContextMenu(event, tab.sessionId)} onMouseDown={(event) => handleTabMouseDown(event, index)} />
        })}
      </div>
      <div className="relative flex shrink-0 items-center gap-1 px-2 before:absolute before:left-0 before:top-1/2 before:h-4 before:w-px before:-translate-y-1/2 before:bg-[var(--color-tab-separator)]">
        {showActivityButton && activeTabId && <SessionActivityButton sessionId={activeTabId} />}
        {isDesktopRuntime && <IconButton icon={<ClipboardList size={17} strokeWidth={1.9} />} label="协作任务台账" onClick={() => useTabStore.getState().openCollabTasksTab()} size="md" tone={activeTabId === COLLAB_TASKS_TAB_ID ? 'default' : 'muted'} pressed={activeTabId === COLLAB_TASKS_TAB_ID} />}
        {isDesktopRuntime && isActiveSessionTab && <OpenProjectMenu path={openProjectPath} />}
        <IconButton icon={<SquareTerminal size={17} strokeWidth={1.9} />} label={t('tabs.openTerminal')} onClick={() => { if (activeTabId && isActiveSessionTab) { useTerminalPanelStore.getState().togglePanel(activeTabId); return } useTabStore.getState().openTerminalTab() }} size="md" tone={isTerminalPanelOpen ? 'default' : 'muted'} pressed={isTerminalPanelOpen} data-active={isTerminalPanelOpen ? 'true' : 'false'} />
        {isActiveSessionTab && activeTabId && <IconButton icon={isWorkspacePanelOpen ? <FolderOpen size={18} strokeWidth={1.9} /> : <Folder size={18} strokeWidth={1.9} />} label={t(isWorkspacePanelOpen ? 'tabs.hideWorkspace' : 'tabs.showWorkspace')} onClick={() => { const workbench = useWorkspacePanelStore.getState(); if (workbench.isPanelOpen(activeTabId) && workbench.getMode(activeTabId) === 'workspace') workbench.closePanel(activeTabId); else { workbench.setMode(activeTabId, 'workspace'); workbench.openPanel(activeTabId) } }} size="md" tone={isWorkspacePanelOpen ? 'default' : 'muted'} pressed={isWorkspacePanelOpen} data-active={isWorkspacePanelOpen ? 'true' : 'false'} />}
      </div>
      {isDesktopRuntime && <div data-testid="tab-bar-drag-gutter" data-desktop-drag-region aria-hidden="true" className={`min-h-[52px] flex-shrink-0 ${showWindowControls ? 'w-3' : 'w-4'}`} />}
      {canScrollRight && <button type="button" onClick={() => scroll('right')} aria-label={t('tabs.scrollRight')} className="flex h-[52px] w-7 flex-shrink-0 items-center justify-center text-[var(--color-text-tertiary)]"><span className="material-symbols-outlined text-[16px]">chevron_right</span></button>}
      <WindowControls />
      {contextMenu && <div ref={contextMenuRef} className="fixed z-[var(--z-dropdown)] min-w-[180px] rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-2 shadow-[var(--shadow-dropdown)]" style={{ left: contextMenu.x, top: contextMenu.y }}><button onClick={() => { handleClose(contextMenu.sessionId); setContextMenu(null) }} className="w-full px-4 py-2 text-left">{t('tabs.close')}</button><button onClick={() => handleCloseOthers(contextMenu.sessionId)} className="w-full px-4 py-2 text-left">{t('tabs.closeOthers')}</button><button onClick={() => handleCloseLeft(contextMenu.sessionId)} className="w-full px-4 py-2 text-left">{t('tabs.closeLeft')}</button><button onClick={() => handleCloseRight(contextMenu.sessionId)} className="w-full px-4 py-2 text-left">{t('tabs.closeRight')}</button><div className="my-1.5 border-t border-[var(--color-border)]" /><button onClick={handleCloseAll} className="w-full px-4 py-2 text-left">{t('tabs.closeAll')}</button></div>}
      <ActionDialog open={pendingCloseRequest !== null} onClose={() => setPendingCloseRequest(null)} title={pendingCloseRequest && pendingCloseRequest.runningSessionIds.length > 1 ? t('tabs.closeAllConfirmTitle') : t('tabs.closeConfirmTitle')} body={pendingCloseRequest && pendingCloseRequest.runningSessionIds.length > 1 ? t('tabs.closeAllConfirmMessage', { count: pendingCloseRequest.runningSessionIds.length }) : t('tabs.closeConfirmMessage')} actions={[{ label: t('common.cancel'), onClick: () => setPendingCloseRequest(null), variant: 'secondary' }, { label: t('tabs.closeConfirmKeep'), onClick: () => { if (!pendingCloseRequest) return; closeTabsWithPolicy(pendingCloseRequest.tabs, pendingCloseRequest.runningSessionIds, false); setPendingCloseRequest(null) }, variant: 'secondary' }, { label: pendingCloseRequest && pendingCloseRequest.runningSessionIds.length > 1 ? t('tabs.closeAllConfirmStop') : t('tabs.closeConfirmStop'), onClick: () => { if (!pendingCloseRequest) return; closeTabsWithPolicy(pendingCloseRequest.tabs, pendingCloseRequest.runningSessionIds, true); setPendingCloseRequest(null) }, variant: 'danger' }]} />
    </div>
  )
}

const TabItem = forwardRef<HTMLDivElement, { tab: Tab; displayTitle: string; closeLabel: string; isRunning: boolean; isActive: boolean; isDragOver: boolean; isDragging: boolean; dragOffsetX: number; runningLabel: string; onClick: () => void; onClose: () => void; onContextMenu: (event: React.MouseEvent) => void; onMouseDown: (event: React.MouseEvent) => void }>(({ tab, displayTitle, closeLabel, isRunning, isActive, isDragOver, isDragging, dragOffsetX, runningLabel, onClick, onClose, onContextMenu, onMouseDown }, ref) => {
  const glyph = isSessionTab(tab) ? (isRunning ? <StatusDot tone="brand" pulse label={runningLabel} /> : tab.status === 'error' ? <StatusDot tone="danger" /> : null) : <span className="material-symbols-outlined text-[14px] leading-none text-[var(--color-text-tertiary)]">{TAB_TYPE_ICON[tab.type] ?? TAB_TYPE_ICON_FALLBACK}</span>
  return <div ref={ref} data-dragging={isDragging ? 'true' : 'false'} data-active={isActive ? 'true' : 'false'} onClick={onClick} onMouseDown={onMouseDown} onContextMenu={onContextMenu} className={`tab-bar-interactive tab-strip-item group relative flex min-h-[46px] min-w-[140px] max-w-[200px] flex-shrink-0 items-center rounded-t-[8px] border border-b-0 px-3 ${isDragging ? 'z-[var(--z-sticky)] cursor-grabbing' : 'cursor-grab'} transition-[background-color,border-color,box-shadow,opacity,transform] duration-150 ease-out ${isActive || isDragging ? 'border-[var(--color-tab-edge)] bg-[var(--color-surface)]' : 'border-transparent bg-transparent hover:border-[var(--color-tab-separator)] hover:bg-[var(--color-surface)]'} ${isDragging ? 'opacity-95 shadow-[var(--shadow-overlay)]' : ''} ${isDragOver ? 'before:absolute before:left-0 before:top-[4px] before:bottom-[4px] before:w-[3px] before:bg-[var(--color-brand)] before:rounded-full' : ''}`} style={{ transform: isDragging ? `translateX(${dragOffsetX}px) scale(1.02)` : undefined }}><span className={`flex h-[14px] flex-shrink-0 items-center justify-center overflow-hidden transition-[width,margin-right] duration-150 ease-out ${glyph ? 'mr-1.5 w-[14px]' : 'mr-0 w-0'}`}>{glyph}</span><span className={`min-w-0 flex-1 truncate text-[13px] ${isActive ? 'text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-secondary)]'}`}>{displayTitle}</span><span className="-mr-1 ml-1.5 flex-shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100"><IconButton icon="close" label={closeLabel} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onClose() }} size="xs" tone="muted" showTooltip={false} /></span></div>
})
TabItem.displayName = 'TabItem'
