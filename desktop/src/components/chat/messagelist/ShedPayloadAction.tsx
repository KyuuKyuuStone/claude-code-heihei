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
//
// 两处裁决（2026-10-10）：
// 1) 409 一律走**本地化文案**（chat.shedPayload.nothingToClean），不读服务端 message——
//    服务端那条是 errorHandler 拼的 `NOTHING_TO_SHED: …` 开发者串，不能上界面（日志/诊断仍留）。
// 2) 释放量做 KB/MB 自适应（<1 MiB 用 KB、<1 KiB 用 B），避免出现「已释放 0.0 MB」；
//    单位不是硬编码在代码里的英文字面量，而是取自 i18n 的 unit* 键（各语言可各自改）。

import { memo, useCallback, useState } from 'react'

import { useTranslation } from '../../../i18n'
import { ApiError } from '../../../api/client'
import { sessionsApi } from '../../../api/sessions'
import { Button } from '@/components/ui/Button'

type FreedUnitKey =
  | 'chat.shedPayload.unitMb'
  | 'chat.shedPayload.unitKb'
  | 'chat.shedPayload.unitB'

/**
 * 释放量取单位：≥1 MiB → MB（一位小数）；≥1 KiB → 整数 KB；更小 → 整数 B。
 * 单位键由调用方 t() 译为当前语言的文本，避免把英文单位写死在组件里。
 */
function freedSize(bytes: number): { size: string; unitKey: FreedUnitKey } {
  if (bytes >= 1024 * 1024) {
    return { size: (bytes / (1024 * 1024)).toFixed(1), unitKey: 'chat.shedPayload.unitMb' }
  }
  if (bytes >= 1024) {
    return { size: String(Math.round(bytes / 1024)), unitKey: 'chat.shedPayload.unitKb' }
  }
  return { size: String(bytes), unitKey: 'chat.shedPayload.unitB' }
}

type ShedPayloadState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; size: string; unit: string }
  | { kind: 'nothing' }
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
      const { size, unitKey } = freedSize(freed)
      setState({ kind: 'done', size, unit: t(unitKey) })
    } catch (error) {
      // 409 = 无可清理内容：终态、不给重试（重试必然同结果），且**不读服务端 message**
      // （那是开发者串），展示本地化文案。
      if (error instanceof ApiError && error.status === 409) {
        setState({ kind: 'nothing' })
        return
      }
      const message =
        error instanceof Error && error.message.trim() !== '' ? error.message : t('common.error')
      setState({ kind: 'failed', message })
    }
  }, [sessionId, t])

  if (state.kind === 'done') {
    return (
      <div data-shed-payload="done" className="mt-1.5 text-xs">
        {t('chat.shedPayload.done', { size: state.size, unit: state.unit })}
      </div>
    )
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
      {state.kind === 'running' && <span data-shed-payload="running">{t('chat.shedPayload.running')}</span>}
      {state.kind === 'nothing' && (
        <span data-shed-payload="nothing">{t('chat.shedPayload.nothingToClean')}</span>
      )}
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
