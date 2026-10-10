// v1.7.0 结构拆分第②批（卡片 / selection / MessageBlock）：MessageBlock 从
// components/chat/MessageList.tsx 逐字移出（原 1931-2091 行），逻辑零改动；
// 门面保留为入口并重导出（消费方 SubagentRunPage / MessageList.test 依赖）。

import { memo } from 'react'
import { useTranslation } from '../../../i18n'
import type { TranslationKey } from '../../../i18n/locales/en'
import { UserMessage } from '../UserMessage'
import { AssistantMessage } from '../AssistantMessage'
import { ThinkingBlock } from '../ThinkingBlock'
import { ToolCallBlock } from '../ToolCallBlock'
import { ToolResultBlock } from '../ToolResultBlock'
import { PermissionDialog } from '../PermissionDialog'
import { AskUserQuestion } from '../AskUserQuestion'
import { InlineTaskSummary } from '../InlineTaskSummary'
import type { AgentTaskNotification, UIMessage } from '../../../types/chat'
import type { TurnCompletion } from '../../../lib/turnCompletion'
import {
  BackgroundTaskEventCard,
  CompactStatusDivider,
  GoalContinuationDivider,
  GoalEventCard,
  MemoryEventCard,
  SelectableChatMessage,
} from './cards'
import { ShedPayloadAction } from './ShedPayloadAction'

export const MessageBlock = memo(function MessageBlock({
  sessionId,
  message,
  activeThinkingId,
  agentTaskNotifications,
  toolResult,
  branchAction,
  turnChangedFiles,
  turnCompletion,
}: {
  sessionId?: string | null
  message: UIMessage
  activeThinkingId: string | null
  agentTaskNotifications: Record<string, AgentTaskNotification>
  toolResult?: { content: unknown; isError: boolean } | null
  branchAction?: {
    label: string
    loading?: boolean
    onBranch: () => void
  }
  turnChangedFiles?: string[]
  turnCompletion?: TurnCompletion
}) {
  const t = useTranslation()

  switch (message.type) {
    case 'user_text':
      return (
        <SelectableChatMessage
          sessionId={sessionId}
          messageId={message.id}
          role="user"
          content={message.content}
        >
          <UserMessage
            content={message.content}
            attachments={message.attachments}
            branchAction={branchAction}
            timestamp={message.timestamp}
            sessionId={sessionId ?? undefined}
            pending={message.pending}
            messageId={message.id}
          />
        </SelectableChatMessage>
      )
    case 'assistant_text':
      return (
        <SelectableChatMessage
          sessionId={sessionId}
          messageId={message.id}
          role="assistant"
          content={message.content}
        >
          <AssistantMessage
            content={message.content}
            branchAction={branchAction}
            sessionId={sessionId ?? undefined}
            timestamp={message.timestamp}
            messageId={message.id}
            turnChangedFiles={turnChangedFiles}
            turnCompletion={turnCompletion}
          />
        </SelectableChatMessage>
      )
    case 'thinking':
      return <ThinkingBlock content={message.content} isActive={message.id === activeThinkingId} />
    case 'tool_use':
      if (message.toolName === 'AskUserQuestion' && !message.isPending) {
        return (
          <AskUserQuestion
            sessionId={sessionId}
            toolUseId={message.toolUseId}
            input={message.input}
            result={toolResult?.content}
          />
        )
      }
      // No durationMs prop here on purpose: buildRenderModel only emits a
      // standalone tool_use item for AskUserQuestion, and this branch is reached
      // only while such a call is still pending — so there is never a result to
      // measure against. The badge is wired in ToolCallGroup, the path every
      // other tool call takes.
      return (
        <ToolCallBlock
          toolName={message.toolName}
          input={message.input}
          result={toolResult}
          isPending={message.isPending}
          status={message.status}
          partialInput={message.partialInput}
          agentTaskNotification={
            message.toolName === 'Agent'
              ? agentTaskNotifications[message.toolUseId]
              : undefined
          }
        />
      )
    case 'tool_result':
      return (
        <ToolResultBlock
          content={message.content}
          isError={message.isError}
          standalone
        />
      )
    case 'permission_request':
      return (
        <PermissionDialog
          sessionId={sessionId}
          requestId={message.requestId}
          toolName={message.toolName}
          input={message.input}
          description={message.description}
        />
      )
    case 'error': {
      const businessErrorKey = message.businessErrorCode
        ? `businessError.${message.businessErrorCode}` as TranslationKey
        : null
      const businessErrorText = businessErrorKey ? t(businessErrorKey) : null
      const errorKey = message.code ? `error.${message.code}` as TranslationKey : null
      const errorText = errorKey ? t(errorKey) : null
      const displayMessage =
        businessErrorText && businessErrorText !== businessErrorKey
          ? businessErrorText
          : (errorText && errorText !== errorKey)
            ? errorText
            : message.message
      const showRawDetail =
        !message.businessErrorCode &&
        Boolean(message.message) &&
        message.message.trim() !== '' &&
        message.message !== displayMessage
      return (
        <div className="mb-3 px-4 py-2.5 rounded-[var(--radius-lg)] border border-[var(--color-error)] bg-[var(--color-error-container)] text-sm text-[var(--color-on-error-container)]">
          <strong>{t('common.error')}:</strong> {displayMessage}
          {showRawDetail && (
            <div className="mt-1 whitespace-pre-wrap text-xs text-[var(--color-on-error-container)]">
              {message.message}
            </div>
          )}
          {/* v1.7.5：仅请求体超限（413）这一类错误条给「修复会话」按钮——它会反复刷
              同一条红错把会话卡死，必须给出可直接执行的出口（纯增量，其它错误条不渲染）。 */}
          {message.businessErrorCode === 'request_too_large' && sessionId ? (
            <ShedPayloadAction sessionId={sessionId} />
          ) : null}
        </div>
      )
    }
    case 'task_summary':
      return <InlineTaskSummary tasks={message.tasks} />
    case 'memory_event':
      return <MemoryEventCard message={message} />
    case 'compact_summary':
      return <CompactStatusDivider message={message} state={message.phase === 'compacting' ? 'compacting' : 'complete'} />
    case 'goal_event':
      return message.action === 'status' && message.status === 'continuing'
        ? <GoalContinuationDivider message={message} />
        : <GoalEventCard message={message} />
    case 'background_task':
      return <BackgroundTaskEventCard message={message} />
    case 'system':
      return (
        <div className="mb-3 text-center text-xs text-[var(--color-text-tertiary)]">
          {message.content}
        </div>
      )
    case 'permission_timeout':
      // v1.7.2 P0-b（设计稿 §1.1）：12px text-tertiary 中性灰、圆点前缀、左对齐，
      // 不 role=alert、不折叠、无动画；720px 列宽内自然换行。
      return (
        <div className="mb-3 flex items-start gap-2 px-4 text-left text-xs leading-5 text-[var(--color-text-tertiary)]">
          <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-text-tertiary)]" />
          <span className="min-w-0 whitespace-pre-wrap break-all">{message.content}</span>
        </div>
      )
  }
})
