/**
 * speechRate —— 朗读语速偏好（纯 localStorage 模式，复刻 lib/appZoom.ts 的 uiZoom 先例）。
 *
 * 为什么走本地存储而不是服务端 updateUser：语速是纯客户端展示偏好，服务端 schema
 * 里没有该字段，为其加一列会把一次前端小特性变成跨端契约变更（设计裁定 §6）。
 */

export const SPEECH_RATE_STORAGE_KEY = 'cc-heihei-speech-rate'
export const SPEECH_RATE_MIN = 0.5
export const SPEECH_RATE_MAX = 2
export const SPEECH_RATE_DEFAULT = 1
/** 设置页分段按钮组的档位（设计裁定 §6）。 */
export const SPEECH_RATE_OPTIONS = [0.75, 1, 1.25, 1.5, 2] as const

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function getDefaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export function normalizeSpeechRate(value: unknown): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : SPEECH_RATE_DEFAULT
  if (!Number.isFinite(numeric)) return SPEECH_RATE_DEFAULT
  return round2(Math.min(Math.max(numeric, SPEECH_RATE_MIN), SPEECH_RATE_MAX))
}

export function readStoredSpeechRate(storage: StorageLike | null = getDefaultStorage()): number {
  if (!storage) return SPEECH_RATE_DEFAULT
  try {
    return normalizeSpeechRate(storage.getItem(SPEECH_RATE_STORAGE_KEY))
  } catch {
    return SPEECH_RATE_DEFAULT
  }
}

export function persistSpeechRate(
  rate: number,
  storage: StorageLike | null = getDefaultStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(SPEECH_RATE_STORAGE_KEY, String(normalizeSpeechRate(rate)))
  } catch {
    // localStorage 在某些受限上下文不可用：静默降级（偏好丢失，功能不受阻）。
  }
}

/** 档位文案：纯数字倍率，跨语言免翻译（设计裁定 §6）。 */
export function formatSpeechRateLabel(rate: number): string {
  return `${rate}×`
}
