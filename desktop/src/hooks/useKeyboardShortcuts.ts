import { useEffect, useRef } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useChatStore } from '../stores/chatStore'
import { useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'
import {
  getAppZoomKeyboardAction,
  nextAppZoomLevel,
} from '../lib/appZoom'
import { useSettingsStore } from '../stores/settingsStore'
import { getDesktopHost } from '../lib/desktopHost'

const isDesktopRuntime = getDesktopHost().isDesktop

export function useKeyboardShortcuts() {
  const setActiveSession = useSessionStore((s) => s.setActiveSession)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const openModal = useUIStore((s) => s.openModal)
  const closeModal = useUIStore((s) => s.closeModal)
  const activeModal = useUIStore((s) => s.activeModal)
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const chatState = useChatStore((s) => activeTabId ? s.sessions[activeTabId]?.chatState ?? 'idle' : 'idle')
  const uiZoom = useSettingsStore((s) => s.uiZoom)
  const setUiZoom = useSettingsStore((s) => s.setUiZoom)

  const activeModalRef = useRef(activeModal)
  activeModalRef.current = activeModal
  const chatStateRef = useRef(chatState)
  chatStateRef.current = chatState
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId
  const appZoomLevelRef = useRef(uiZoom)
  appZoomLevelRef.current = uiZoom

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const zoomAction = getAppZoomKeyboardAction(e)
      if (zoomAction) {
        e.preventDefault()
        const nextZoom = nextAppZoomLevel(appZoomLevelRef.current, zoomAction)
        appZoomLevelRef.current = nextZoom
        setUiZoom(nextZoom)
        return
      }

      if (isDesktopRuntime && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        useTabStore.getState().openCollabTasksTab()
        return
      }

      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 'n') {
        e.preventDefault()
        setActiveSession(null)
        setActiveView('code')
      }
      if (meta && e.key === 'k') {
        e.preventDefault()
        openModal('globalSearch')
      }
      if (meta && e.key === 'f') {
        e.preventDefault()
        openModal('findInPage')
      }
      if (e.key === 'Escape' && activeModalRef.current) closeModal()
      if (meta && e.key === '.' && chatStateRef.current !== 'idle' && activeTabIdRef.current) {
        e.preventDefault()
        stopGeneration(activeTabIdRef.current)
      }
    }

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [closeModal, openModal, setActiveSession, setActiveView, setUiZoom, stopGeneration])
}
