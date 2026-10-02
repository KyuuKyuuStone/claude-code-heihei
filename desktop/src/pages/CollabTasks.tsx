import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge, StatusDot } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Spinner } from '@/components/ui/Spinner'
import { IconButton } from '@/components/ui/IconButton'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { copyTextToClipboard } from '@/lib/clipboard'
import { api } from '../api/client'
import type { CollabTask, CollabTaskStatus } from '../api/collabTasks'
import { useTranslation } from '../i18n'

import { describeApiFailure } from '../lib/apiErrorMessage'
import type { ApiErrorWithKind, ApiFailureKind } from '../api/client'


import { useSessionStore } from '../stores/sessionStore'
import { useServantStore } from '../stores/servantStore'
import { useCollabTaskStore } from '../stores/collabTaskStore'

const OPEN_STATUSES = new Set<CollabTaskStatus>(['dispatched', 'accepted', 'in_progress', 'delivered', 'rework'])
const STATUS_DISPLAY: Record<CollabTaskStatus, { label: string; tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info' }> = {
  dispatched: { label: '待接单', tone: 'neutral' },
  accepted: { label: '已接单', tone: 'info' },
  in_progress: { label: '执行中', tone: 'brand' },
  delivered: { label: '已交付', tone: 'warning' },
  verified: { label: '验收通过', tone: 'success' },
  rework: { label: '返工中', tone: 'warning' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
}

type Filter = 'open' | 'closed' | 'all'
type TaskDetail = CollabTask & {
  report?: string
  verdict?: 'pass' | 'rework'
  history?: Array<{ at: number; from: CollabTaskStatus | null; to: CollabTaskStatus; note?: string }>
}

export function CollabTasks() {
  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const t = useTranslation()
  const tasksById = useCollabTaskStore((state) => state.tasksById)

  const activeProjectDir = useCollabTaskStore((state) => state.activeProjectDir)
  const isLoading = useCollabTaskStore((state) => state.isLoading)
  const error = useCollabTaskStore((state) => state.error)
  const errorKind = useCollabTaskStore((state) => state.errorKind)
  const connectionState = useCollabTaskStore((state) => state.connectionState)
  const serverReady = useCollabTaskStore((state) => state.serverReady)
  const [filter, setFilter] = useState<Filter>('open')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedTaskDetail, setSelectedTaskDetail] = useState<TaskDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailErrorKind, setDetailErrorKind] = useState<ApiFailureKind | undefined>(undefined)
  const detailRequestRef = useRef(0)
  const loadTaskDetail = (taskId: string) => {
    const requestId = ++detailRequestRef.current
    setSelectedTaskDetail(null)
    setDetailError(null)
    void api.get<{ task: TaskDetail }>(`/api/collab-tasks/${encodeURIComponent(taskId)}`)
      .then(({ task }) => { if (requestId === detailRequestRef.current) setSelectedTaskDetail(task) })
      .catch((fetchError: unknown) => {
        if (requestId === detailRequestRef.current) setDetailErrorKind((fetchError as ApiErrorWithKind).kind)
        if (requestId === detailRequestRef.current) setDetailError(fetchError instanceof Error ? fetchError.message : "详情加载失败")
      })
  }
  const retryTaskDetail = () => {
    if (selectedTaskId) loadTaskDetail(selectedTaskId)
  }
  const [previousSessionId, setPreviousSessionId] = useState<string | null>(activeSessionId)
  const previousProjectDirRef = useRef<string | null>(null)
  const [sessionSwitchNoticeDir, setSessionSwitchNoticeDir] = useState<string | null>(null)
  const projectDir = isLoading ? null : activeProjectDir
  useEffect(() => {
    if (previousSessionId !== null && previousSessionId !== activeSessionId) {
      setPreviousSessionId(activeSessionId)
      setSessionSwitchNoticeDir(null)
    }
  }, [activeSessionId, previousSessionId])
  useEffect(() => {
    if (!isLoading && projectDir) {
      if (previousProjectDirRef.current !== null && previousProjectDirRef.current !== projectDir) {
        setSessionSwitchNoticeDir(projectDir)
      }
      previousProjectDirRef.current = projectDir
    }
  }, [isLoading, projectDir])
  const sessionSwitchNotice = sessionSwitchNoticeDir === projectDir && projectDir !== null
  const offline = connectionState !== 'connected' || !serverReady

  const visibleTasks = useMemo(() => {
    const tasks = Object.values(tasksById).filter((task) => {
      if (filter === 'open') return OPEN_STATUSES.has(task.status)
      if (filter === 'closed') return !OPEN_STATUSES.has(task.status)
      return true
    })
    return tasks.sort((a, b) => Number(b.status === 'delivered') - Number(a.status === 'delivered') || b.updatedAt - a.updatedAt)
  }, [filter, tasksById])
  const deliveredCount = Object.values(tasksById).filter((task) => task.status === 'delivered').length
  const selectedTask = selectedTaskId ? tasksById[selectedTaskId] : undefined

  useEffect(() => {
    const store = useCollabTaskStore.getState()
    return store.subscribeTaskEvents()
  }, [])

  useEffect(() => {
    const store = useCollabTaskStore.getState()
    if (!activeSessionId) {
      store.clearProjectTasks()
      setPreviousSessionId(null)
      previousProjectDirRef.current = null
      setSessionSwitchNoticeDir(null)
      return
    }
    const changed = previousSessionId !== null && previousSessionId !== activeSessionId
    if (changed) setPreviousSessionId(activeSessionId)
    void store.refreshForSession(activeSessionId, { clear: changed })
    if (selectedTaskId) {
      setSelectedTaskId(null)
      setSelectedTaskDetail(null)
    }
  }, [activeSessionId])

  useEffect(() => {
    if (selectedTaskId) loadTaskDetail(selectedTaskId)
    return () => { detailRequestRef.current += 1 }
  }, [selectedTaskId])

  const copy = async (text: string) => {
    if (!offline) await copyTextToClipboard(text)
  }
  const refresh = () => {
    if (activeSessionId) void useCollabTaskStore.getState().refreshForSession(activeSessionId)
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--color-surface)]">
      <div className="mx-auto flex w-full max-w-6xl min-h-0 flex-1 flex-col px-8 py-7">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">协作任务台账</h1>
            <p className="mt-1 truncate text-xs text-[var(--color-text-secondary)]" title={projectDir ?? undefined}>
              当前目录：{isLoading ? '加载中' : projectDir ?? '无活动会话目录'}
            </p>
            {sessionSwitchNotice && (
              <p role="status" className="mt-1 text-xs text-[var(--color-warning)]">活动会话已切换，当前项目目录：{sessionSwitchNoticeDir}。任务列表已按该目录筛选。</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {deliveredCount > 0 && <Badge tone="warning" size="sm">已交付 {deliveredCount}</Badge>}
            <Button size="sm" onClick={refresh} disabled={!activeSessionId}>刷新</Button>
          </div>
        </div>

        <div className="mb-3 flex items-center gap-2 border-b border-[var(--color-border)]">
          {(['open', 'closed', 'all'] as const).map((value) => (
            <button key={value} type="button" onClick={() => setFilter(value)} aria-pressed={filter === value} className={`px-3 py-2 text-sm ${filter === value ? 'border-b-2 border-[var(--color-brand)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'}`}>
              {value === 'open' ? '进行中' : value === 'closed' ? '已结束' : '全部'}
            </button>
          ))}
        </div>

        {error && <ErrorState title="加载失败，正在展示本地缓存" detail={describeApiFailure(errorKind, error, t)} onRetry={refresh} retryLabel="重试" />}

        <div className="min-h-0 flex-1 overflow-auto rounded-[var(--radius-xl)] border border-[var(--color-border)]">
          {!activeSessionId ? (
            <EmptyState title="打开一个协作会话即可查看该项目的任务" />
          ) : isLoading && Object.keys(tasksById).length === 0 ? (
            <div aria-label="正在加载协作任务" className="space-y-3 p-5">{[0, 1, 2, 3].map((row) => <div key={row} className="h-10 animate-pulse rounded bg-[var(--color-surface-container)]" />)}</div>
          ) : visibleTasks.length === 0 ? (
            <EmptyState title={error ? '加载失败' : filter === 'all' ? '该目录下没有任务' : '该目录下没有未结任务'} description={error ? '请检查协作服务连接后重试。' : '可以让主管会话使用 CollabDispatch 派活。'} />
          ) : (
            <table className="w-full table-fixed text-left text-sm">
              <thead className="sticky top-0 bg-[var(--color-surface-container)] text-xs text-[var(--color-text-secondary)]"><tr>
                <th className="w-32 px-3 py-2">任务 ID</th><th className="px-3 py-2">标题</th><th className="w-44 px-3 py-2">指派对象</th><th className="w-28 px-3 py-2">状态</th><th className="w-24 px-3 py-2">来源</th><th className="w-40 px-3 py-2">更新时间</th><th className="w-24 px-3 py-2">返工</th>
              </tr></thead>
              <tbody>{visibleTasks.map((task) => <TaskRow key={task.id} task={task} onOpen={() => setSelectedTaskId(task.id)} onCopy={() => void copy(task.id)} />)}</tbody>
            </table>
          )}
          {isLoading && Object.keys(tasksById).length > 0 && <div className="px-3 py-2 text-xs text-[var(--color-text-secondary)]">正在同步最新台账…</div>}
        </div>
        <p className="mt-3 text-xs text-[var(--color-text-secondary)]">共 {visibleTasks.length} 个{filter === 'open' ? '进行中' : filter === 'closed' ? '已结束' : ''}任务</p>
      </div>

      {selectedTaskId && selectedTask && <TaskDetails task={selectedTaskDetail ?? selectedTask} loading={!selectedTaskDetail && !detailError} error={detailError ? describeApiFailure(detailErrorKind, detailError, t) : null} offline={offline} onClose={() => setSelectedTaskId(null)} onRetry={retryTaskDetail} onCopy={copy} />}
      {offline && <div className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--color-surface)]/70 backdrop-blur-sm"><div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container)] px-5 py-4 text-sm text-[var(--color-text-secondary)]">协作服务未就绪，正在重新连接……</div></div>}
    </div>
  )
}

function TaskRow({ task, onOpen, onCopy }: { task: CollabTask; onOpen: () => void; onCopy: () => void }) {
  const isRunning = useServantStore((state) => state.turnInProgressBySessionId[task.toSessionId] === true)
  const status = STATUS_DISPLAY[task.status]
  const reworkCount = task.history?.filter((entry) => entry.to === 'rework').length ?? 0
  const updatedAt = new Date(task.updatedAt)
  return (
    <tr onDoubleClick={onOpen} className="cursor-pointer border-t border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]" data-testid={`collab-task-${task.id}`}>
      <td className="px-3 py-3"><button type="button" onClick={(event) => { event.stopPropagation(); onCopy() }} className="font-mono text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">{task.id}</button></td>
      <td className="truncate px-3 py-3 font-medium text-[var(--color-text-primary)]" title={task.title}><button type="button" onClick={onOpen} className="max-w-full truncate text-left">{task.title}</button></td>
      <td className="px-3 py-3"><span className="inline-flex items-center gap-2 truncate"><StatusDot tone="brand" pulse={isRunning} label={isRunning ? '会话执行中' : undefined} /><span className="truncate" title={task.toSessionId}>{task.toSessionId}</span></span></td>
      <td className="px-3 py-3"><Badge tone={status.tone} size="xs" pill={false} data-testid={`status-${task.status}`}>{status.label}</Badge></td>
      <td className="truncate px-3 py-3 font-mono text-xs" title={task.fromSessionId}>{task.fromSessionId.slice(0, 8)}</td>
      <td className="px-3 py-3 text-xs text-[var(--color-text-secondary)]" title={updatedAt.toLocaleString()}>{formatRelativeTime(updatedAt.getTime())}</td>
      <td className="px-3 py-3">{reworkCount > 0 && <Badge tone="neutral">返工 {reworkCount} 次</Badge>}</td>
    </tr>
  )
}

function TaskDetails({ task, loading, error, offline, onClose, onRetry, onCopy }: { task: TaskDetail; loading: boolean; error: string | null; offline: boolean; onClose: () => void; onRetry: () => void; onCopy: (text: string) => Promise<void> }) {
  const reworkNotes = task.history?.filter((entry) => entry.to === 'rework' && entry.note).map((entry) => entry.note!) ?? []
  return (
    <>
      <button type="button" aria-label="关闭任务详情" onClick={onClose} className="absolute inset-0 z-20 bg-black/20" />
      <aside aria-label="协作任务详情" className="absolute right-0 top-0 z-30 flex h-full w-[420px] max-w-full flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl">
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4"><div><h2 className="font-semibold">{task.title}</h2><code className="text-xs text-[var(--color-text-tertiary)]">{task.id}</code></div><IconButton icon="close" label="关闭详情" onClick={onClose} size="sm" /></header>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {loading ? <Spinner size={20} label="正在加载详情" /> : error ? <ErrorState title="详情加载失败" detail={error} onRetry={onRetry} retryLabel="重试" /> : (
            <>
              <section><h3 className="mb-2 text-xs font-semibold text-[var(--color-text-secondary)]">任务需求</h3><div className="max-w-none text-sm"><MarkdownRenderer content={task.content} /></div></section>
              {task.deliverables.length > 0 && <section><h3 className="mb-2 text-xs font-semibold text-[var(--color-text-secondary)]">交付物</h3><ul className="space-y-1">{task.deliverables.map((path) => <li key={path}><button type="button" disabled={offline} onClick={() => void onCopy(path)} className="break-all text-left font-mono text-xs text-[var(--color-brand)] disabled:opacity-50">{path}</button></li>)}</ul></section>}
              {task.report && <section><h3 className="mb-2 text-xs font-semibold text-[var(--color-text-secondary)]">汇报</h3><p className="whitespace-pre-wrap text-sm">{task.report}</p></section>}
              {task.verdict && <section><h3 className="mb-2 text-xs font-semibold text-[var(--color-text-secondary)]">验收结论</h3><Badge tone={task.verdict === 'pass' ? 'success' : 'warning'}>{task.verdict === 'pass' ? '通过' : '返工'}</Badge></section>}
              {reworkNotes.map((note, index) => <section key={`${index}-${note}`} className="rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-container)] p-3"><h3 className="mb-1 text-xs font-semibold">返工意见</h3><p className="whitespace-pre-wrap text-sm">{note}</p></section>)}
              {task.status === 'delivered' && <button type="button" disabled={offline} onClick={() => void onCopy(`请用 CollabReview 验收任务 ${task.id}`)} className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2 text-left text-sm disabled:opacity-50">复制指令：请用 CollabReview 验收任务 {task.id}</button>}
            </>
          )}
        </div>
      </aside>
    </>
  )
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86400)} 天前`
}
