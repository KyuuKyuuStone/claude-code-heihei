import { memo, useCallback, useMemo } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { UIAttachment } from '../../types/chat'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n/locales/en'
import { openPreviewLink } from '../../lib/openPreviewLink'
import { splitTextByUrls } from '../../lib/urlBoundary'
import { AttachmentGallery } from './AttachmentGallery'
import { MessageActionBar, type MessageBranchAction } from './MessageActionBar'
import { InjectedCollabCard, parseCollabNotice } from './InjectedCollabCard'

/** 服务端注入通知的判头（四个通知源与协作页脚均为中文【系统】；无英文变体）。 */
const SYSTEM_NOTICE_PREFIX = '【系统】'

// 相对时间：与 InjectedCollabCard.formatAge 同款语义（复用既有 session.time* i18n
// 键，不新增 key）。彼处为模块私有且注释已写明「不为本卡搬移」——故此处就地复刻，
// 行为逐行一致；若将来要抽公共 util，两处须一并改。
function formatAge(
  timestamp: number | undefined,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
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

type Props = {
  content: string
  attachments?: UIAttachment[]
  branchAction?: MessageBranchAction
  timestamp?: number
  sessionId?: string
  /** v1.7.1 协作通知折叠：流式写入中的消息不折叠（设计稿 §1.3/§7.4）。 */
  pending?: boolean
}

export const UserMessage = memo(function UserMessage({ content, attachments, branchAction, timestamp, sessionId, pending }: Props) {
  const t = useTranslation()
  const hasText = content.trim().length > 0

  // The prompt is literal text, NOT markdown — `**`, `#` and file paths have to
  // stay exactly as the user typed them. So instead of running it through the
  // markdown renderer we only split the bare URLs out and wrap those.
  const segments = useMemo(() => splitTextByUrls(content), [content])

  // v1.7.1：协作通知判定（页脚正则，设计稿 §1.2）——pending 时不折叠。
  const collabNotice = useMemo(
    () => (pending ? null : parseCollabNotice(content)),
    [content, pending],
  )

  // v1.7.5（设计师规范 40d6d249）：系统通知判定 = **首个非空行**以「【系统】」开头。
  // ⚠ 判定顺序不可颠倒：协作页脚本身也以【系统】开头，必须先判协作卡（上面的分支
  // 先返回），否则折叠卡会被本分支吞掉。服务端通知正文可能带前导空行，故跳过空行。
  const isSystemNotice = useMemo(() => {
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) return trimmed.startsWith(SYSTEM_NOTICE_PREFIX)
    }
    return false
  }, [content])

  const handleLinkClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>, href: string) => {
      if (!sessionId) return
      if (openPreviewLink(href, sessionId)) event.preventDefault()
    },
    [sessionId],
  )

  // 正文片段三种形态（用户气泡 / 协作卡展开体 / 系统通知）共用，避免三份重复。
  const bodyInner = segments.map((segment, index) =>
    segment.type === 'url' ? (
      <a
        key={index}
        href={segment.value}
        target="_blank"
        rel="noreferrer noopener"
        className="text-[var(--color-text-accent)] underline decoration-[1px] underline-offset-[3px] decoration-[var(--color-text-accent)] [overflow-wrap:anywhere] hover:decoration-[2px]"
        onClick={(event) => handleLinkClick(event, segment.value)}
      >
        {segment.value}
      </a>
    ) : (
      segment.value
    ),
  )

  const promptBody = hasText ? (
    <div
      data-message-body="user"
      className="min-w-0 max-w-full whitespace-pre-wrap break-words"
      style={{
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
      }}
    >
      {bodyInner}
    </div>
  ) : null

  if (collabNotice) {
    return (
      <InjectedCollabCard
        notice={collabNotice}
        content={content}
        timestamp={timestamp}
        branchAction={branchAction}
      >
        {promptBody}
      </InjectedCollabCard>
    )
  }

  // v1.7.5：系统通知——居中无方向性的内条（与用户气泡的右对齐/米黄底色区分）。
  if (isSystemNotice) {
    const ageLabel = formatAge(timestamp, t)
    return (
      <div className="mb-5 flex justify-center">
        <div
          data-message-shell="system-notice"
          className="flex w-fit min-w-0 max-w-[85%] items-start gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface-container-highest)] px-3 py-1.5 text-[13px] leading-5 text-[var(--color-text-primary)]"
        >
          <span
            aria-hidden="true"
            className="material-symbols-outlined shrink-0 text-[14px] leading-5 text-[var(--color-text-secondary)]"
          >
            info
          </span>
          <div
            data-message-body="system-notice"
            className="min-w-0 whitespace-pre-wrap break-words"
            style={{
              overflowWrap: 'anywhere',
              wordBreak: 'break-word',
            }}
          >
            {bodyInner}
          </div>
          {ageLabel ? (
            <span className="shrink-0 text-[10px] leading-5 tabular-nums">{ageLabel}</span>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="mb-5 flex justify-end">
      <div
        data-message-shell="user"
        className="group flex min-w-0 max-w-[82%] flex-col items-end sm:max-w-[78%] lg:max-w-[640px]"
      >
        <div className="flex max-w-full flex-col items-end gap-2">
          {attachments && attachments.length > 0 && (
            <AttachmentGallery attachments={attachments} variant="message" />
          )}

          {promptBody && (
            <div className="min-w-0 max-w-full rounded-[var(--radius-lg)] bg-[var(--color-surface-user-msg)] px-[18px] py-[13px] text-[14.5px] leading-relaxed text-[var(--color-text-primary)]">
              {promptBody}
            </div>
          )}
        </div>

        {hasText && (
          <MessageActionBar
            copyText={content}
            copyLabel={t('chat.copyPrompt')}
            branchAction={branchAction}
            align="end"
            timestamp={timestamp}
          />
        )}
      </div>
    </div>
  )
})
