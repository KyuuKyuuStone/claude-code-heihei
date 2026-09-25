import { describe, expect, it } from 'vitest'
import type { BackgroundAgentTask } from '../types/chat'
import {
  RUNNING_TASK_STALE_MS,
  formatDurationMs,
  formatDurationSeconds,
  hasRunningBackgroundTasks,
} from './backgroundTasks'
import { translate } from '../i18n'

/** 确定性时间基准：所有用例显式传 now，不依赖真实时钟 */
const NOW = Date.parse('2026-09-16T10:00:00.000Z')

function task(
  taskId: string,
  overrides: Partial<BackgroundAgentTask> = {},
): BackgroundAgentTask {
  return {
    taskId,
    status: 'running',
    startedAt: NOW - 60_000,
    updatedAt: NOW,
    ...overrides,
  }
}

describe('hasRunningBackgroundTasks', () => {
  it('does not treat AutoDream as foreground session activity', () => {
    expect(hasRunningBackgroundTasks({
      dream: task('dream', { taskType: 'dream' }),
    }, NOW)).toBe(false)
  })

  it('still reports user-started background tasks as running', () => {
    expect(hasRunningBackgroundTasks({
      shell: task('shell', { taskType: 'local_bash' }),
      dream: task('dream', { taskType: 'dream' }),
    }, NOW)).toBe(true)
  })

  it('treats a running task past the staleness threshold as finished', () => {
    // 断线漏接 task_completed：running 记录停在原地，updatedAt 不再刷新
    const stale = NOW - RUNNING_TASK_STALE_MS - 1
    expect(hasRunningBackgroundTasks({
      shell: task('shell', { taskType: 'local_bash', updatedAt: stale }),
    }, NOW)).toBe(false)
  })

  it('keeps a running task at exactly the threshold boundary as running', () => {
    const boundary = NOW - RUNNING_TASK_STALE_MS
    expect(hasRunningBackgroundTasks({
      shell: task('shell', { taskType: 'local_bash', updatedAt: boundary }),
    }, NOW)).toBe(true)
  })

  it('reports running when a fresh task coexists with a stale one', () => {
    const stale = NOW - RUNNING_TASK_STALE_MS - 1
    expect(hasRunningBackgroundTasks({
      staleShell: task('stale', { taskType: 'local_bash', updatedAt: stale }),
      freshShell: task('fresh', { taskType: 'local_bash', updatedAt: NOW - 1000 }),
    }, NOW)).toBe(true)
  })

  it('ignores staleness for non-running statuses', () => {
    const ancient = NOW - 10 * RUNNING_TASK_STALE_MS
    expect(hasRunningBackgroundTasks({
      done: task('done', { status: 'completed', updatedAt: ancient }),
    }, NOW)).toBe(false)
  })
})

describe('formatDurationSeconds', () => {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
    translate('en', key, params)

  it.each([
    [0, '0s'],
    [45, '45s'],
    [59.4, '59s'],
    [60, '1m 0s'],
    [739, '12m 19s'],
  ])('writes %ss as %s', (seconds, expected) => {
    expect(formatDurationSeconds(seconds, t)).toBe(expected)
  })

  it('carries into hours instead of printing three-digit minutes', () => {
    expect(formatDurationSeconds(75 * 60 + 30, t)).toBe('1h 15m')
    expect(formatDurationSeconds(2 * 3600, t)).toBe('2h 0m')
  })

  it('respects the minimum floor used by still-running tasks', () => {
    expect(formatDurationSeconds(0.2, t, 1)).toBe('1s')
  })
})

describe('formatDurationMs', () => {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
    translate('en', key, params)

  it('returns null for a missing or negative duration', () => {
    expect(formatDurationMs(undefined, t)).toBeNull()
    expect(formatDurationMs(-1, t)).toBeNull()
  })

  it('rounds milliseconds to whole seconds', () => {
    expect(formatDurationMs(739_000, t)).toBe('12m 19s')
  })
})
