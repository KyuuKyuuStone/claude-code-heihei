import { api } from './client'

/** 员工花名册条目（含会话实时信息） */
export type ServantInfo = {
  sessionId: string
  role?: string
  description?: string
  enabled: boolean
  supervisor?: boolean
  updatedAt: number
  title: string
  workDir?: string
  running: boolean
}

export type ServantEntry = {
  sessionId: string
  role?: string
  description?: string
  enabled: boolean
  supervisor?: boolean
  updatedAt: number
}

export type ServantInput = {
  role?: string
  description?: string
  enabled: boolean
  supervisor?: boolean
}

export const servantsApi = {
  list(options?: { all?: boolean }) {
    const query = options?.all ? '?all=1' : ''
    return api.get<{ servants: ServantInfo[] }>(`/api/servant-sessions${query}`)
  },

  set(sessionId: string, input: ServantInput) {
    return api.put<{ servant: ServantEntry }>(
      `/api/servant-sessions/${encodeURIComponent(sessionId)}`,
      input,
    )
  },

  remove(sessionId: string) {
    return api.delete<{ ok: true }>(
      `/api/servant-sessions/${encodeURIComponent(sessionId)}`,
    )
  },

  sendMessage(input: {
    targetSessionId: string
    content: string
    fromSessionId?: string
  }) {
    return api.post<{ ok: true }>('/api/session-messages', input)
  },
}
