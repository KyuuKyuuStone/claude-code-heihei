import { api } from './client'

export type CollabTaskStatus =
  | 'dispatched'
  | 'accepted'
  | 'in_progress'
  | 'delivered'
  | 'verified'
  | 'rework'
  | 'failed'
  | 'cancelled'

export type CollabTaskHistoryEntry = {
  at: number
  from: CollabTaskStatus | null
  to: CollabTaskStatus
  note?: string
}

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
  fromRole?: string
  report?: string
  verdict?: 'pass' | 'rework'
  history?: CollabTaskHistoryEntry[]
}

export type CollabServerIdentity = {
  app: 'cc-heihei'
  version: string
  pid: number
  startedAt: string
  capabilities: string[]
}

export const collabTasksApi = {
  listForSession(sessionId: string) {
    return api.get<{ tasks: CollabTask[]; projectDir: string }>(`/api/collab-tasks?forSessionId=${encodeURIComponent(sessionId)}`)
  },

  listForProject(projectDir: string) {
    return api.get<{ tasks: CollabTask[] }>(`/api/collab-tasks?project=${encodeURIComponent(projectDir)}`)
  },

  get(id: string) {
    return api.get<{ task: CollabTask }>(`/api/collab-tasks/${encodeURIComponent(id)}`)
  },

  whoami() {
    return api.get<CollabServerIdentity>('/api/whoami')
  },

  listDispatched() {
    return api.get<{ tasks: CollabTask[] }>('/api/collab-tasks?status=dispatched')
  },
}
