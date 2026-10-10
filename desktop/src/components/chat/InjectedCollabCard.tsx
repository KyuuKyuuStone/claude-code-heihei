// v1.7.1 协作通知消息折叠（设计稿：设计_v1.7.1_协作通知消息折叠.md）。
// 判定唯一依据 = content 最后一个非空行命中协作页脚正则（§1.2，r3 既有裁决）；
// 长度只作摘要截断，不作折叠开关（§1.2/§7.3）。流式 pending 不折叠（§1.3，
// 由调用方在 pending 时不调用 parseCollabNotice 保证）。展开状态仅内存（§4）。

import { memo, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n/locales/en'
import { copyTextToClipboard } from '../../lib/clipboard'
import { useSpeech } from '../../lib/speech/useSpeech'
import { useSettingsStore } from '../../stores/settingsStore'
import { Badge } from '@/components/ui/Badge'
import { MessageActionBar, type MessageBranchAction } from './MessageActionBar'

const COLLAB_NOTICE_FOOTER_RE = /^【系统】(汇报 · )?任务 ID：([0-9a-fA-F-]{36})；/

// 未决项 1 的推导依据：主管派活正文的惯例首段「你的角色：前端。」——正文格式
// 不保证存在该句，未命中即降级隐藏 role 段（不编造默认值）。员工汇报正文无
// role 字段，故 report 一律无 role（已在派活单中如实上报）。
const ROLE_FROM_BODY_RE = /你的角色[:：]\s*([^\s。，,；;]{1,24})/

export type CollabNotice = {
  kind: 'dispatch' | 'report'
  taskId: string
  role: string | null
  summary: string
}

export function parseCollabNotice(content: string): CollabNotice | null {
  const lines = content.split('\n')

  let footerLine = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line) {
      footerLine = line
      break
    }
  }
  const footerMatch = COLLAB_NOTICE_FOOTER_RE.exec(footerLine)
  if (!footerMatch) return null

  const kind: CollabNotice['kind'] = footerMatch[1] ? 'report' : 'dispatch'
  const taskId = footerMatch[2]!

  // 摘要：首个非空行剥【…】标头，取首句（含句末标点），≤40 字截断（§2.1.4）。
  let summary = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (COLLAB_NOTICE_FOOTER_RE.test(trimmed)) break
    summary = trimmed.replace(/^【[^】]*】\s*/, '')
    break
  }
  const sentenceMatch = /^([\s\S]*?[。！？!?])(?:\s|$)/.exec(summary)
  if (sentenceMatch) summary = sentenceMatch[1]!
  if (summary.length > 40) summary = summary.slice(0, 40) + '…'

  let role: string | null = null
  if (kind === 'dispatch') {
    const roleMatch = ROLE_FROM_BODY_RE.exec(content)
    if (roleMatch) role = roleMatch[1]!
  }

  return { kind, taskId, role, summary }
}

// 相对时间：复用既有 session.time* i18n 键（Sidebar formatRelativeTime 同款
// 语义；其为模块私有，不为本卡搬移）。
function formatAge(timestamp: number | undefined, t: (key: TranslationKey, params?: Record<string, string | number>) => string): string {
  if (!timestamp) return ''
  const diff = Date.now() - timestamp
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('session.timeJustNow')
  if (min < 60) return t('session.timeMinutes', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('session.timeHours', { n: hr })
  const day = Math.floor(hr / 24)
  if (day < 30) return t('session.timeDays', { n: day })
  return ''
}

type NoticeHeaderProps = {
  notice: CollabNotice
  expanded: boolean
  meta: string
  onToggle: () => void
}

function NoticeHeader({ notice, expanded, meta, onToggle }: NoticeHeaderProps) {
  const t = useTranslation()
  const label = notice.kind === 'dispatch' ? t('collab.notice.dispatch') : t('collab.notice.report')
  const toggleLabel = expanded ? t('collab.notice.collapse') : t('collab.notice.expand')
  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onToggle()
    }
  }
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={handleKey}
      className="flex h-11 min-w-0 cursor-pointer select-none items-center gap-2 pl-4 pr-3 text-left"
    >
      <span
        aria-hidden="true"
        className="material-symbols-outlined shrink-0 text-[16px] text-[var(--color-text-tertiary)]"
      >
        {notice.kind === 'dispatch' ? 'outbox' : 'inbox'}
      </span>
      <Badge tone="brand" size="xs">{label}</Badge>
      <button
        type="button"
        title={notice.taskId}
        onClick={(event) => {
          event.stopPropagation()
          void copyTextToClipboard(notice.taskId)
        }}
        className="shrink-0 font-mono text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
      >
        task-{notice.taskId.slice(0, 4)}
      </button>
      <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-[var(--color-text-primary)]">
        {notice.summary || t('collab.notice.emptyBody')}
      </span>
      {meta ? (
        <span className="hidden shrink-0 text-[10px] tabular-nums text-[var(--color-text-tertiary)] sm:inline">
          {meta}
        </span>
      ) : null}
      <span className="shrink-0 text-[12px] text-[var(--color-text-secondary)]">{toggleLabel}</span>
    </div>
  )
}

type InjectedCollabCardProps = {
  notice: CollabNotice
  content: string
  timestamp?: number
  branchAction?: MessageBranchAction
  children: ReactNode
  /** 消息 id：用于朗读绑定（与操作条的朗读键同一 id）。 */
  messageId?: string
}

export const InjectedCollabCard = memo(function InjectedCollabCard({
  notice,
  content,
  timestamp,
  branchAction,
  messageId,
  children,
}: InjectedCollabCardProps) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const speechRate = useSettingsStore((state) => state.speechRate)
  // 朗读中的消息本体提示：本卡左缘已有常驻 3px brand 身份条（见下方 absolute span），
  // 描边故走**右缘**——左=identity 常驻、右=state 暂态，二者可区分（playing/paused 都保留）。
  const speech = useSpeech({
    messageId,
    text: content,
    rate: speechRate,
    codeBlockPlaceholder: t('speech.codeBlockPlaceholder'),
  })

  const dirLabel = notice.role
    ? notice.kind === 'dispatch'
      ? t('collab.notice.toDispatch', { role: notice.role })
      : t('collab.notice.fromReport', { role: notice.role })
    : ''
  const ageLabel = formatAge(timestamp, t)
  const meta = [dirLabel, ageLabel].filter(Boolean).join(' · ')

  return (
    <div className="mb-5 flex justify-start">
      <div
        data-collab-notice={expanded ? 'expanded' : 'collapsed'}
        className={`relative min-w-0 w-full max-w-[720px] overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] ${
          speech.status === 'idle' ? '' : 'shadow-[inset_-3px_0_0_var(--color-brand)]'
        }`}
      >
        <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-[var(--color-brand)]" />
        <NoticeHeader notice={notice} expanded={expanded} meta={meta} onToggle={() => setExpanded((value) => !value)} />
        {expanded && (
          <>
            <div className="min-w-0 border-t border-[var(--color-border)] px-4 py-3 text-[14px] leading-relaxed text-[var(--color-text-primary)]">
              {children}
            </div>
            <div className="px-2 pb-1">
              <MessageActionBar
                copyText={content}
                copyLabel={t('chat.copyPrompt')}
                messageId={messageId}
                branchAction={branchAction}
                align="start"
                timestamp={timestamp}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
})
