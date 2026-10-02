import { memo, useCallback, useMemo } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { UIAttachment } from '../../types/chat'
import { useTranslation } from '../../i18n'
import { openPreviewLink } from '../../lib/openPreviewLink'
import { splitTextByUrls } from '../../lib/urlBoundary'
import { AttachmentGallery } from './AttachmentGallery'
import { MessageActionBar, type MessageBranchAction } from './MessageActionBar'
import { InjectedCollabCard, parseCollabNotice } from './InjectedCollabCard'

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

  const handleLinkClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>, href: string) => {
      if (!sessionId) return
      if (openPreviewLink(href, sessionId)) event.preventDefault()
    },
    [sessionId],
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
      {segments.map((segment, index) =>
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
      )}
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
