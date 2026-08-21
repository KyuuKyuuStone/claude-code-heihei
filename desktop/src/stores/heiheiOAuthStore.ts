// desktop/src/stores/heiheiOAuthStore.ts

import { create } from 'zustand'
import { heiheiOAuthApi, type HeiheiOAuthStatus } from '../api/heiheiOAuth'

const POLL_INTERVAL_MS = 2_000

type HeiheiOAuthState = {
  status: HeiheiOAuthStatus | null
  isPolling: boolean
  isLoading: boolean
  error: string | null

  fetchStatus: () => Promise<void>
  login: () => Promise<{ authorizeUrl: string }>
  logout: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
}

export const useHeiheiOAuthStore = create<HeiheiOAuthState>((set, get) => {
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  return {
    status: null,
    isPolling: false,
    isLoading: false,
    error: null,

    fetchStatus: async () => {
      try {
        const status = await heiheiOAuthApi.status()
        set({ status, error: null })
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    login: async () => {
      set({ isLoading: true, error: null })
      try {
        const res = await heiheiOAuthApi.start()
        set({ isLoading: false })
        return { authorizeUrl: res.authorizeUrl }
      } catch (err) {
        set({
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },

    logout: async () => {
      get().stopPolling()
      set({ isLoading: true })
      try {
        await heiheiOAuthApi.logout()
        set({ status: { loggedIn: false }, isLoading: false })
      } catch (err) {
        set({
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },

    startPolling: () => {
      if (pollTimer) return
      set({ isPolling: true })

      const scheduleNext = () => {
        pollTimer = setTimeout(async () => {
          await get().fetchStatus()
          const cur = get().status
          if (cur && cur.loggedIn) {
            get().stopPolling()
            return
          }
          if (get().isPolling) {
            scheduleNext()
          }
        }, POLL_INTERVAL_MS)
      }
      scheduleNext()
    },

    stopPolling: () => {
      if (pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
      set({ isPolling: false })
    },
  }
})
