import { create } from 'zustand'
import {
  servantsApi,
  type ServantInfo,
  type ServantInput,
} from '../api/servants'

type ServantStore = {
  /** 协作身份：sessionId → 身份信息（含未启用条目，供徽标与编辑回显） */
  bySessionId: Record<string, ServantInfo>
  isLoading: boolean

  fetchServants: () => Promise<void>
  setServant: (sessionId: string, input: ServantInput) => Promise<void>
  removeServant: (sessionId: string) => Promise<void>
}

async function fetchAll(): Promise<Record<string, ServantInfo>> {
  const { servants } = await servantsApi.list({ all: true })
  return Object.fromEntries(servants.map((s) => [s.sessionId, s]))
}

export const useServantStore = create<ServantStore>((set) => ({
  bySessionId: {},
  isLoading: false,

  fetchServants: async () => {
    set({ isLoading: true })
    try {
      set({ bySessionId: await fetchAll(), isLoading: false })
    } catch {
      set({ isLoading: false })
    }
  },

  setServant: async (sessionId, input) => {
    await servantsApi.set(sessionId, input)
    // 以服务端为准整体刷新
    set({ bySessionId: await fetchAll() })
  },

  removeServant: async (sessionId) => {
    await servantsApi.remove(sessionId)
    set((s) => {
      const next = { ...s.bySessionId }
      delete next[sessionId]
      return { bySessionId: next }
    })
  },
}))
