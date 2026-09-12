import { api } from './client'

/** 员工花名册条目（含会话实时信息） */
export type ServantInfo = {
  sessionId: string
  role?: string
  description?: string
  enabled: boolean
  supervisor?: boolean
  /** 约束档位：readonly=只读观察（禁改文件，信箱汇报放行） */
  constraint?: 'readonly'
  updatedAt: number
  title: string
  workDir?: string
  running: boolean
  /** 会话最后一次活动时间（transcript 修改时间）——主管区分"执行中"与"假活" */
  lastActivityAt?: string
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
  /** 协作弹窗选择的运行时：写入会话元数据，员工被自动拉起时生效 */
  runtimeProviderId?: string | null
  runtimeModelId?: string
  effortLevel?: string
  /** 约束档位：readonly=只读观察（禁改文件，信箱汇报放行） */
  constraint?: 'readonly'
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

  /** 中断员工当前运行（保留会话与历史），用于唤醒卡死的员工 */
  interrupt(sessionId: string) {
    return api.post<{ ok: true; stopped: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/interrupt`,
    )
  },

  /** 主管广播：一条消息发给本项目全部 enabled 员工 */
  broadcast(content: string, fromSessionId: string) {
    return api.post<{ ok: true; broadcast: true; delivered: number }>(
      '/api/session-messages',
      { broadcast: true, content, fromSessionId },
    )
  },
}
