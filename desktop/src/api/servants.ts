import { api } from './client'

/** 员工花名册条目（含会话实时信息） */
export type ServantInfo = {
  sessionId: string
  role?: string
  description?: string
  enabled: boolean
  supervisor?: boolean
  /** 约束档位：readonly=只读观察；whitelist=目录白名单（仅 writeDirs 内可写） */
  constraint?: 'readonly' | 'whitelist'
  /** whitelist 档的可写目录（服务端已规范化） */
  writeDirs?: string[]
  updatedAt: number
  title: string
  workDir?: string
  running: boolean
  /** 当前是否有进行中回合（服务端真实信号，与假死 watcher 同源）——状态灯 busy 判定依据 */
  turnInProgress: boolean
  /** 会话最后一次活动时间（transcript 修改时间）——主管区分"执行中"与"假活" */
  lastActivityAt?: string
}

export type ServantEntry = {
  sessionId: string
  role?: string
  description?: string
  enabled: boolean
  supervisor?: boolean
  constraint?: 'readonly' | 'whitelist'
  writeDirs?: string[]
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
  /** 约束档位：readonly=只读观察；whitelist=目录白名单（需 writeDirs） */
  constraint?: 'readonly' | 'whitelist'
  /** whitelist 档可写目录（每行一个绝对路径；服务端校验规范化） */
  writeDirs?: string[]
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
