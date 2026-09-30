// Source: src/server/services/cronService.ts

export type TaskNotificationConfig = {
  enabled: boolean
  // v1.5.0：外部 IM 适配器已移除，只剩桌面通知。存量数据里可能仍有
  // telegram/feishu（服务端清理前），读取侧需自行过滤（NewTaskModal 已处理）。
  channels: ('desktop' | 'telegram' | 'feishu')[]
}

export type CronTask = {
  id: string
  name: string
  description?: string
  cron: string
  prompt: string
  enabled: boolean
  recurring?: boolean
  permanent?: boolean
  createdAt: number
  lastRunAt?: number
  lastFiredAt?: string
  nextRunAt?: number
  permissionMode?: string
  model?: string
  providerId?: string | null
  folderPath?: string
  useWorktree?: boolean
  notification?: TaskNotificationConfig
}

export type CreateTaskInput = {
  name: string
  description?: string
  cron: string
  prompt: string
  enabled?: boolean
  recurring?: boolean
  permanent?: boolean
  permissionMode?: string
  model?: string
  providerId?: string | null
  folderPath?: string
  useWorktree?: boolean
  notification?: TaskNotificationConfig
}

export type TaskRun = {
  id: string
  taskId: string
  taskName: string
  startedAt: string
  completedAt?: string
  status: 'running' | 'completed' | 'failed' | 'timeout'
  prompt: string
  output?: string
  error?: string
  outputPreview?: string
  errorPreview?: string
  hasOutput?: boolean
  hasError?: boolean
  exitCode?: number
  durationMs?: number
  sessionId?: string
}
