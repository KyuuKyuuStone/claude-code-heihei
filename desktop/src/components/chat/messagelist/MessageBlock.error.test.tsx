// v1.7.5：错误条上「修复会话」按钮的**触发条件**（正向 + 反向）与既有渲染回归。
// 按钮自身的三种结果在 ShedPayloadAction.test.tsx 里测；这里只管「哪条错误该有按钮」。

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { UIMessage } from '../../../types/chat'
import { MessageBlock } from './MessageBlock'

vi.mock('../../../api/sessions', () => ({
  sessionsApi: { shedPayload: vi.fn() },
}))

function renderError(message: UIMessage, sessionId: string | null = 's1') {
  return render(
    <MessageBlock
      sessionId={sessionId}
      message={message}
      activeThinkingId={null}
      agentTaskNotifications={{}}
    />,
  )
}

function errorMessage(overrides: Record<string, unknown>): UIMessage {
  return {
    id: 'err-1',
    type: 'error',
    message: 'Request payload too large',
    code: 'unknown',
    timestamp: Date.now(),
    ...overrides,
  } as UIMessage
}

describe('MessageBlock error strip', () => {
  it('renders the repair-session button for a request_too_large error', () => {
    renderError(errorMessage({ businessErrorCode: 'request_too_large' }))
    expect(screen.getByTestId('shed-payload-action')).toBeTruthy()
  })

  it('does not render it for any other business error code', () => {
    renderError(errorMessage({ businessErrorCode: 'image_unsupported' }))
    expect(screen.queryByTestId('shed-payload-action')).toBeNull()
  })

  it('does not render it for a plain error without a business code', () => {
    renderError(errorMessage({ code: 'unknown' }))
    expect(screen.queryByTestId('shed-payload-action')).toBeNull()
    // 既有行为回归：无 businessErrorCode 时原始 message 仍以详情形式展示。
    expect(screen.getByText('Request payload too large')).toBeTruthy()
  })

  it('does not render it when the session id is unknown', () => {
    renderError(errorMessage({ businessErrorCode: 'request_too_large' }), null)
    expect(screen.queryByTestId('shed-payload-action')).toBeNull()
  })
})
