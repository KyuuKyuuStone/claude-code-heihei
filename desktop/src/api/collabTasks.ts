import { api } from './client'

/**
 * 协作任务台账（服务端 collabTaskService）。**唯一权威源**——前端只读，靠推送更新，
 * 不本地另存一份状态（架构决策_侧栏运行指示统一数据源）。
 */
export type CollabTaskStatus =
  | 'dispatched'
  | 'accepted'
  | 'in_progress'
  | 'delivered'
  | 'verified'
  | 'rework'
  | 'failed'
  | 'cancelled'

export type CollabTask = {
  id: string
  projectDir: string
  fromSessionId: string
  toSessionId: string
  title: string
  content: string
  status: CollabTaskStatus
  deliverables: string[]
  createdAt: number
  updatedAt: number
}

export const collabTasksApi = {
  /**
   * 拉取全量「待接单」任务（status=dispatched）。这是「已投递、等待接单」的权威口径：
   * 派活接口返回成功本身不代表进入此状态，只有台账里的 dispatched 才算。
   */
  listDispatched() {
    return api.get<{ tasks: CollabTask[] }>('/api/collab-tasks?status=dispatched')
  },
}
