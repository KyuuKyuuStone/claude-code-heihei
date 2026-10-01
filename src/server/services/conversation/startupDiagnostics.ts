/**
 * 启动/运行期诊断文本子系统（v1.7 结构拆分第①批 · 纯移动）。
 *
 * 原来住在 conversationService.ts 的 ConversationService 类里（2274-2520 区间
 * 的纯函数部分），本批逐字搬到这里。搬来的都是**不碰实例状态**的纯函数；
 * 依赖 this.sessions 的两个（buildStartupError / buildRuntimeExitMessage）留在
 * 原类——它们要用实例状态，搬走只能改签名，不在本批（纯移动）范围内。
 * buildCapturedProcessOutputDetail 也留下了：它的参数类型 SessionProcess 是
 * 门面文件里的**未导出**本地类型，搬过来就得给那个类型加 export，会改变门面
 * 的导出面（验收清单第 3 条）。
 *
 * 唯一的机械变换：`this.foo(...)` → `foo(...)`（同模块直调）。
 */

const MAX_CAPTURED_PROCESS_LINES = 80
const MAX_CAPTURED_SDK_MESSAGES = 40
const MAX_CAPTURED_SDK_SUMMARY = 20
export const MAX_CAPTURED_SDK_MESSAGE_BYTES = 64 * 1024
export const MAX_CAPTURED_SDK_TOTAL_BYTES = 512 * 1024
const MAX_CAPTURED_SDK_DIAGNOSTIC_TEXT_BYTES = 4 * 1024

export { MAX_CAPTURED_PROCESS_LINES, MAX_CAPTURED_SDK_MESSAGES, MAX_CAPTURED_SDK_DIAGNOSTIC_TEXT_BYTES }

export function redactProcessOutput(line: string): string {
  return line
    .replace(/(ANTHROPIC_(?:API_KEY|AUTH_TOKEN)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|auth[_-]?token|access[_-]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]')
}

export function extractStartupDetail(message: any): string {
  if (!message) return ''

  if (typeof message.result === 'string') return message.result
  if (typeof message.status === 'string') return message.status
  if (typeof message.message === 'string') return message.message

  if (Array.isArray(message?.errors)) {
    return message.errors
      .filter((value: unknown): value is string => typeof value === 'string')
      .join('\n')
  }

  return ''
}

export function isAssistantApiErrorMessage(message: any): boolean {
  return (
    message?.type === 'assistant' &&
    (message.isApiErrorMessage === true || typeof message.error === 'string')
  )
}

export function extractAssistantApiErrorDetail(message: any): string {
  if (!isAssistantApiErrorMessage(message)) return ''

  const text = extractAssistantText(message)
  const error = typeof message.error === 'string' ? message.error : ''
  if (text && error) return `${error}: ${text}`
  return text || error
}

export function extractAssistantText(message: any): string {
  const content = message?.message?.content
  if (!Array.isArray(content)) return ''
  const textBlock = content.find(
    (block: unknown): block is { type: string; text: string } =>
      !!block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
  )
  return textBlock?.text || ''
}

export function extractSdkErrorEvent(message: any): {
  type: string
  summary: string
  details: Record<string, unknown>
} | null {
  if (isAssistantApiErrorMessage(message)) {
    const summary = redactProcessOutput(
      extractAssistantApiErrorDetail(message) || 'Assistant API error',
    )
    return {
      type: 'sdk_api_error',
      summary,
      details: {
        sdkType: message.type,
        error: typeof message.error === 'string' ? message.error : undefined,
        isApiErrorMessage: message.isApiErrorMessage === true,
        messageText: extractAssistantText(message)
          ? redactProcessOutput(extractAssistantText(message))
          : undefined,
        errorDetails:
          typeof message.errorDetails === 'string'
            ? redactProcessOutput(message.errorDetails)
            : undefined,
      },
    }
  }

  if (message?.type === 'result' && message.is_error) {
    const summary = redactProcessOutput(
      extractStartupDetail(message) || 'SDK result error',
    )
    return {
      type: 'sdk_result_error',
      summary,
      details: {
        sdkType: message.type,
        subtype: message.subtype,
        isError: true,
        result:
          typeof message.result === 'string'
            ? redactProcessOutput(message.result)
            : undefined,
        status:
          typeof message.status === 'string'
            ? redactProcessOutput(message.status)
            : undefined,
        usage: message.usage,
      },
    }
  }

  return null
}

export function summarizeSdkMessages(messages: any[]): unknown[] {
  return messages.slice(-MAX_CAPTURED_SDK_SUMMARY).map((message) => {
    if (!message || typeof message !== 'object') {
      return { type: 'unknown' }
    }
    return {
      type: typeof message.type === 'string' ? message.type : 'unknown',
      ...(typeof message.subtype === 'string' ? { subtype: message.subtype } : {}),
      ...(typeof message.is_error === 'boolean' ? { is_error: message.is_error } : {}),
      ...(isSafeSdkStatus(message.status) ? { status: message.status } : {}),
      ...(sdkErrorCategory(message) ? { errorCategory: sdkErrorCategory(message) } : {}),
    }
  })
}

export function isSafeSdkStatus(value: unknown): value is string {
  return typeof value === 'string' && /^(?:failed|error|success|completed|cancelled|canceled|pending|running)$/i.test(value)
}

export function sdkErrorCategory(message: any): string | undefined {
  if (message?.type === 'assistant' && (message.isApiErrorMessage === true || message.error !== undefined)) {
    return 'api_error'
  }
  if (message?.type === 'result' && message.is_error === true) return 'result_error'
  if (message?.type === 'auth_status') return 'authentication'
  return undefined
}
