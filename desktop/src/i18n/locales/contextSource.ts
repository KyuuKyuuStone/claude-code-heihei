/**
 * 上下文用量「数据基准」文案表 —— 独立于五个 locale 主表。
 *
 * 为什么单开一个模块：`i18n/locales/{en,zh,zh-TW,jp,kr}.ts` 已到 2495–2497 行，
 * file-size 门禁（LIMIT=2500，scripts/check-file-size.ts）要求未超标文件不得超限，
 * 且基线表「条目集合只许缩小」——无处安放这几个新键。故与 `speech.ts` 同款：
 * 按语言各出一份显式字典，由 `i18n/index.ts` 合并进对应语言的翻译表。
 *
 * 用途：上下文面板的主标/明细有两种基准 —— `provider_usage`（上一轮 API 调用实测）
 * 与 `estimate`（转写粗估）。徽标、基准说明、以及 `Output tokens`（上一轮输出，不
 * 计入上下文）都靠这几个键表达。
 *
 * 纪律：per-语言显式字典 + 逐键断言（禁元组解包推导——2026 年曾因拆包错位导致
 * 五语言整体错一环）；五语言键集合必须完全一致，由 contextSource.test.ts 逐键断言。
 */

export const contextSourceEn = {
  'contextIndicator.sourceProvider': 'Measured',
  'contextIndicator.basisProvider': 'Based on the measured usage of the last API call',
  'contextIndicator.basisEstimate': 'Estimated from the transcript',
  'contextIndicator.outputNotCounted': 'Previous turn output — not counted in context',
} as const

export const contextSourceZh = {
  'contextIndicator.sourceProvider': '实测',
  'contextIndicator.basisProvider': '基于上一轮调用实测',
  'contextIndicator.basisEstimate': '基于转写估算',
  'contextIndicator.outputNotCounted': '上一轮输出，不计入上下文',
} as const

export const contextSourceZhTW = {
  'contextIndicator.sourceProvider': '實測',
  'contextIndicator.basisProvider': '基於上一輪呼叫實測',
  'contextIndicator.basisEstimate': '基於轉寫估算',
  'contextIndicator.outputNotCounted': '上一輪輸出，不計入上下文',
} as const

export const contextSourceJp = {
  'contextIndicator.sourceProvider': '実測',
  'contextIndicator.basisProvider': '直近の API 呼び出しの実測値',
  'contextIndicator.basisEstimate': 'トランスクリプトからの推定値',
  'contextIndicator.outputNotCounted': '前回の出力 — コンテキストには含まれません',
} as const

export const contextSourceKr = {
  'contextIndicator.sourceProvider': '실측',
  'contextIndicator.basisProvider': '직전 API 호출의 실측 사용량',
  'contextIndicator.basisEstimate': '트랜스크립트 기반 추정',
  'contextIndicator.outputNotCounted': '직전 출력 — 컨텍스트에 포함되지 않음',
} as const

/** 本模块定义的键集合（en 为准；其余语言与此逐键对齐）。 */
export type ContextSourceKey = keyof typeof contextSourceEn
