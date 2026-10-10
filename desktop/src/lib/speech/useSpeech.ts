/**
 * useSpeech —— 组件与 speechService（模块单例）之间的 React 订阅桥。
 *
 * 组件只经本 hook 消费朗读能力，不直接碰 speechService 的内部状态机。
 * 语速与代码块占位语由调用方传入：本模块属 lib 层，不得 import stores/i18n
 * （settingsStore 的 speechRate 与 t('speech.codeBlockPlaceholder') 都在组件侧取）。
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

import { extractSpeakableText, type SpeakableExtraction } from './extractSpeakableText'
import { speechService, type SpeechStatus } from './speechService'

/** 绑定在单条消息上的朗读状态。 */
export type MessageSpeechState = {
  /** 仅当「当前朗读的就是本条消息」时才非 idle，其它消息一律 idle。 */
  status: SpeechStatus
  /** 是否应渲染喇叭键（引擎+voice 可用，且该消息有可读文本）。 */
  visible: boolean
  /** 文本超长被截断（轻提示用）。 */
  truncated: boolean
  toggle: () => void
}

export type UseSpeechOptions = {
  messageId?: string | null
  text: string
  /** 由调用方从 settingsStore 读出（lib 不得依赖 stores）。 */
  rate: number
  /** 代码块占位语，由调用方从 i18n 取。 */
  codeBlockPlaceholder: string
}

export function useSpeech(options: UseSpeechOptions): MessageSpeechState {
  const { messageId, text, rate, codeBlockPlaceholder } = options

  const snapshot = useSyncExternalStore(
    speechService.subscribe,
    speechService.getSnapshot,
    speechService.getSnapshot,
  )

  // 提取是纯计算：文本或占位语变化时才重算（每次渲染重算会拖慢长消息列表）。
  const extraction = useMemo<SpeakableExtraction>(
    () => extractSpeakableText(text, { codeBlockPlaceholder }),
    [text, codeBlockPlaceholder],
  )
  const segments = extraction.segments

  // 变速：service 内部记住段索引并按新 rate 重建队列续播——设置页改档位后立即生效，
  // 不必等下一次点击。渲染期调用会违反 React 纯函数约束，故放 effect。
  useEffect(() => {
    speechService.setRate(rate)
  }, [rate])

  const isMine = Boolean(messageId) && snapshot.currentMessageId === messageId
  const status: SpeechStatus = isMine ? snapshot.status : 'idle'

  const toggle = useCallback(() => {
    if (!messageId) return
    if (isMine && status === 'speaking') {
      speechService.pause()
      return
    }
    if (isMine && status === 'paused') {
      speechService.resume()
      return
    }
    // 点另一条 = 停旧读新（play 内部先 cancel）。变速取当前设置值。
    speechService.setRate(rate)
    speechService.play(messageId, segments, rate)
  }, [messageId, isMine, status, rate, segments])

  return {
    status,
    visible: snapshot.canSpeak && segments.length > 0,
    truncated: extraction.truncated,
    toggle,
  }
}
