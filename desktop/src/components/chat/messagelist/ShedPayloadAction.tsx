// v1.7.5：请求体超限（413）错误条上的「修复会话」按钮。
//
// 背景：客户机上会话因请求体超限反复刷同一条红错、**彻底卡死**——用户在小字提示里
// 没法执行任何操作，所以引导必须是**按钮**而不是又一段文字。
//
// 契约（主管定死）：POST /api/sessions/:sessionId/shed-payload，体 `{}`；
// 200 返回 { ok, sessionId, bytesBefore, bytesAfter, … }；409 = NOTHING_TO_SHED。
// 触发面由调用方（MessageBlock）判定 businessErrorCode === 'request_too_large'——
// 判定留在消息流那一层，本组件只管「按下之后发生什么」。
//
// 三种结果就地展示：成功（按字节账算出释放量，按钮消失即不可再点）／409（无内容可清理，
// 终态、不给重试：重试必然同结果）／失败（可重试）。修完**不自动重试发送**，由用户自己重发。

import { memo, useCallback, useState } from 'react'

import { useTranslation } from '../../../i18n'
import { ApiError } from '../../../api/client'
import { sessionsApi } from '../../../api/sessions'
import { Button } from '@/components/ui/Button'

type ShedPayloadState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; freedMb: string }
  | { kind: 'nothing'; message: string }
  | { kind: 'failed'; message: string }

export const ShedPayloadAction = memo(function ShedPayloadAction({ sessionId }: { sessionId: string }) {
  const t = useTranslation()
  const [state, setState] = useState<ShedPayloadState>({ kind: 'idle' })

  const run = useCallback(async () => {
    setState({ kind: 'running' })
    try {
      const result = await sessionsApi.shedPayload(sessionId)
      // 释放量按契约给的字节账自算（bytesBefore − bytesAfter），不额外猜。
      const freed = Math.max(0, result.bytesBefore - result.bytesAfter)
      setState({ kind: 'done', freedMb: (freed / (1024 * 1024)).toFixed(1) })
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim() !== '' ? error.message : t('common.error')
      if (error instanceof ApiError && error.status === 409) {
        setState({ kind: 'nothing', message })
        return
      }
      setState({ kind: 'failed', message })
    }
  }, [sessionId, t])

  if (state.kind === 'done') {
    return (
      <div data-shed-payload="done" className="mt-1.5 text-xs">
        {t('chat.shedPayload.done', { mb: state.freedMb })}
      </div>
    )
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
      {state.kind === 'running' && <span data-shed-payload="running">{t('chat.shedPayload.running')}</span>}
      {state.kind === 'nothing' && <span data-shed-payload="nothing">{state.message}</span>}
      {state.kind === 'failed' && (
        <span data-shed-payload="failed">{t('chat.shedPayload.failed', { message: state.message })}</span>
      )}
      {state.kind !== 'nothing' && (
        <Button
          type="button"
          variant="danger-outline"
          size="xs"
          data-testid="shed-payload-action"
          disabled={state.kind === 'running'}
          onClick={() => {
            void run()
          }}
        >
          {state.kind === 'failed' ? t('common.retry') : t('chat.shedPayload.action')}
        </Button>
      )}
    </div>
  )
})
