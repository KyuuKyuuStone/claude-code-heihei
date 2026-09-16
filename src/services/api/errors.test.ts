import { describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { BUSINESS_ERROR_CODES } from '../../constants/businessErrors.js'
import {
  buildQuotaExhaustedMessage,
  extractQuotaExhaustedDetail,
  getAssistantMessageFromError,
  getImageUnsupportedErrorMessage,
  isUnsupportedImageInputErrorMessage,
} from './errors.js'

describe('image unsupported API errors', () => {
  test('detects provider-specific text-only model image rejections', () => {
    const unsupportedImageErrors = [
      'This model does not support image blocks',
      'unsupported modality: image input is not available',
      'Failed to deserialize the JSON body into the target type: messages[1]: unknown variant `image_url`, expected `text` at line 1 column 394097',
      "Invalid value for 'messages[0].content[1].type': 'image_url' is not one of ['text']",
      "messages.0.content.1.type: Input should be 'text'; received 'image_url'",
      'image_url content parts are not allowed for this model',
    ]

    for (const message of unsupportedImageErrors) {
      expect(isUnsupportedImageInputErrorMessage(message)).toBe(true)
    }
    expect(isUnsupportedImageInputErrorMessage('image exceeds maximum')).toBe(false)
  })

  test('maps unsupported image rejections to a recoverable synthetic error', () => {
    const msg = getAssistantMessageFromError(
      new Error('This model does not support image blocks'),
      'mimo-v2.5-pro',
    )

    expect(msg.isApiErrorMessage).toBe(true)
    expect(msg.businessErrorCode).toBe(BUSINESS_ERROR_CODES.IMAGE_UNSUPPORTED)
    expect(msg.errorDetails).toBe('This model does not support image blocks')
    expect(msg.message.content[0]).toMatchObject({
      type: 'text',
      text: getImageUnsupportedErrorMessage(),
    })
  })
})

/** 智谱 code 1308「5 小时使用上限已用完」的实测响应体 */
const ZHIPU_QUOTA_BODY = {
  type: 'error',
  error: {
    type: 'rate_limit_error',
    code: '1308',
    message:
      '[1308][已达到 5 小时的使用上限。您的限额将在 2026-09-16 13:42:53 重置。][2026091609090851fe27aff1f94ed9]',
  },
}

function rateLimitError(body: unknown): APIError {
  return new APIError(429, body, `429 ${JSON.stringify(body)}`, undefined)
}

describe('quota / rate limit visibility (non-subscriber)', () => {
  test('surfaces a third-party 429 that used to fall through silently', () => {
    const msg = getAssistantMessageFromError(rateLimitError(ZHIPU_QUOTA_BODY), 'glm-5.3')

    expect(msg.isApiErrorMessage).toBe(true)
    expect(msg.error).toBe('rate_limit')
    const text = (msg.message.content[0] as { text: string }).text
    // provider 原文要点（配额耗尽）与重置时间都要出现在用户可见文案里
    expect(text).toContain('已达到 5 小时的使用上限')
    expect(text).toContain('2026-09-16 13:42:53')
    expect(text).toContain('重置')
  })

  test('falls back to an explicit message when no reset time can be parsed', () => {
    const msg = getAssistantMessageFromError(
      rateLimitError({ type: 'error', error: { type: 'rate_limit_error', message: 'Too many requests' } }),
      'glm-5.3',
    )

    const text = (msg.message.content[0] as { text: string }).text
    expect(text).toContain('Too many requests')
    expect(text).toContain('未能从响应中解析出重置时间')
    // 绝不静默、绝不空串
    expect(text.length).toBeGreaterThan(0)
  })

  test('extractQuotaExhaustedDetail parses the provider body', () => {
    expect(extractQuotaExhaustedDetail(`429 ${JSON.stringify(ZHIPU_QUOTA_BODY)}`)).toEqual({
      detail: ZHIPU_QUOTA_BODY.error.message,
      resetsAt: '2026-09-16 13:42:53',
    })
    expect(extractQuotaExhaustedDetail('429 服务不可用').resetsAt).toBeNull()
  })

  test('buildQuotaExhaustedMessage never returns an empty body', () => {
    expect(buildQuotaExhaustedMessage('').length).toBeGreaterThan(0)
    expect(buildQuotaExhaustedMessage('')).toContain('未能从响应中解析出重置时间')
  })
})
