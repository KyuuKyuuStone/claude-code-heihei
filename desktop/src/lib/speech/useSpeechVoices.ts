import { useEffect, useState } from 'react'

/**
 * 首次「读取中」的宽限时长：引擎常在启动后才投递 voices（Chromium 会补发
 * voiceschanged），这段时间内空列表与「真的没有语音」不可区分 ⇒ 先显示读取中。
 */
export const VOICE_LOAD_GRACE_MS = 1200

export type SpeechVoicesState = {
  /** 引擎存在（无 speechSynthesis ⇒ 整个「朗读」section 不渲染）。 */
  supported: boolean
  /** 首次读取尚未归来（显示「正在读取系统语音…」）。 */
  loading: boolean
  voices: SpeechSynthesisVoice[]
}

type SynthLike = {
  getVoices?: () => SpeechSynthesisVoice[]
  addEventListener?: (type: string, listener: () => void) => void
  removeEventListener?: (type: string, listener: () => void) => void
}

function getSynth(): SynthLike | null {
  if (typeof window === 'undefined') return null
  const candidate = (window as unknown as { speechSynthesis?: SynthLike }).speechSynthesis
  return candidate && typeof candidate.getVoices === 'function' ? candidate : null
}

/** 设置页用：读系统 voices 并跟随 voiceschanged 刷新（不触碰朗读单例的状态机）。 */
export function useSpeechVoices(): SpeechVoicesState {
  const supported = getSynth() !== null
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [loading, setLoading] = useState(supported)

  useEffect(() => {
    const synth = getSynth()
    if (!synth) return
    const read = () => {
      let next: SpeechSynthesisVoice[] = []
      try {
        next = synth.getVoices?.() ?? []
      } catch {
        next = []
      }
      setVoices(next)
      if (next.length > 0) setLoading(false)
    }
    read()
    const grace = setTimeout(() => setLoading(false), VOICE_LOAD_GRACE_MS)
    try {
      synth.addEventListener?.('voiceschanged', read)
    } catch {
      // 不支持事件：退化为一次性读取。
    }
    return () => {
      clearTimeout(grace)
      try {
        synth.removeEventListener?.('voiceschanged', read)
      } catch {
        // 同上：清理失败不影响卸载。
      }
    }
  }, [supported])

  return { supported, loading, voices }
}
