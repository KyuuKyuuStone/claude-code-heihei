import type { BackgroundAgentTask } from '../types/chat'
import type { TranslationKey } from '../i18n'

type Translator = (key: TranslationKey, params?: Record<string, string | number>) => string

/**
 * running 状态陈旧阈值：WS 活着时服务端持续推 task_progress 刷新 updatedAt；
 * 只有断线漏接终止事件（task_completed/failed/stopped）才会让 running 记录
 * 变陈旧。超过阈值未刷新的 running 视为已终结，不再计入「有后台任务」
 * （转圈残留根治·方案B 第二步兜底）。
 */
export const RUNNING_TASK_STALE_MS = 15 * 60 * 1000

export function hasRunningBackgroundTasks(
  tasks?: Record<string, BackgroundAgentTask>,
  now: number = Date.now(),
): boolean {
  // AutoDream is detached maintenance work: it remains visible and stoppable
  // in Activity, but must not keep the foreground conversation marked busy.
  return Object.values(tasks ?? {}).some(
    (task) =>
      task.status === 'running' &&
      task.taskType !== 'dream' &&
      now - task.updatedAt <= RUNNING_TASK_STALE_MS,
  )
}

export function createBackgroundTaskDismissKey(task: BackgroundAgentTask): string {
  return `${task.taskId}:${task.status}:${task.startedAt}`
}

export function formatDurationSeconds(
  seconds: number,
  t: Translator,
  minimumSeconds = 0,
): string {
  const totalSeconds = Math.max(minimumSeconds, Math.round(seconds))
  if (totalSeconds < 60) {
    return t('chat.duration.seconds', { seconds: totalSeconds })
  }
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) {
    return t('chat.duration.minutesSeconds', {
      minutes: totalMinutes,
      seconds: totalSeconds % 60,
    })
  }
  // Past an hour "125 min 3 s" makes the reader divide by 60 themselves. Seconds
  // stop being interesting at that scale, so they are dropped rather than kept.
  return t('chat.duration.hoursMinutes', {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  })
}

export function formatDurationMs(durationMs: number | undefined, t: Translator): string | null {
  if (typeof durationMs !== 'number' || durationMs < 0) return null
  return formatDurationSeconds(durationMs / 1000, t)
}
