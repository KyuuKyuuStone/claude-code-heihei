/**
 * 转录条目可见性判定与标题提取（v1.7 结构拆分 · sessionService 第④批 · 纯移动）。
 *
 * 从 sessionService.ts 原样搬出的 3 个方法。选段理由：三者都是
 * (RawEntry) → 判定/字符串 的纯函数，不碰实例状态（体内无 this.<字段>），
 * 外部依赖全部来自 utils/ 与本目录/同层既有模块。
 *
 * 搬移规则：函数体逐字不变，仅两处形式调整——
 *   ① 缩进 −2（原 class 方法体缩进 4，模块级函数体缩进 2）；
 *   ② 组内与跨模块互调 this.foo( → foo(（原 this.isSyntheticUserInterruption 等指向
 *      第①批已委托的同名函数，此处直接 import 裸调用）。
 * 门面里这 3 个方法的位置改为同名类字段委托，**所有调用点（含组外
 * loadSubagentToolMessages / getSessionTitleAndMeta / getIndexedSessionSearchMetadata）
 * 的 `this.xxx(...)` 文本一行未改**。
 *
 * 未随本批搬走的相邻项（有意保留在门面）：
 *   · isGoalLocalCommandEntry / extractGoalCreationTitle 等：已属第②批模块或
 *     localIndex 职责，非本组；
 *   · `// Title extraction` 上方那条 `// ----` 节分隔线：属门面结构注释，不搬。
 *
 * 路径依赖预检：本段无 import.meta / __dirname / process.execPath（全文预检亦为零）。
 */

import { cleanSessionTitleSource } from '../../../utils/sessionTitleText.js'
import { shouldHideCommandMetadataContent } from '../../../utils/commandMetadata.js'
import {
  isSyntheticNoResponseAssistant,
  isSyntheticUserInterruption,
  isTaskNotificationContent,
} from './transcriptContent.js'
import {
  extractGoalCreationTitle,
  extractTranscriptUserTitle,
} from '../localIndex/transcriptReducer.js'
import type { RawEntry } from './transcriptAgents.js'

export function shouldHideTranscriptEntry(entry: RawEntry): boolean {
  const role = entry.message?.role
  const content = entry.message?.content

  if (role === 'user') {
    return (
      shouldHideCommandMetadataContent(content) ||
      isSyntheticUserInterruption(content) ||
      isTaskNotificationContent(content)
    )
  }

  if (role === 'assistant') {
    return isSyntheticNoResponseAssistant(content)
  }

  return false
}

export function isVisibleTranscriptMessageEntry(entry: RawEntry): boolean {
  if (!entry.message?.role || entry.isMeta) return false
  if (
    entry.type !== 'user' &&
    entry.type !== 'assistant' &&
    entry.type !== 'system'
  ) {
    return false
  }
  return !shouldHideTranscriptEntry(entry)
}

export function extractTitle(entries: RawEntry[]): string {
  // 1. Look for custom title entry (appended by renameSession) — highest priority
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.type === 'custom-title' && e.customTitle) {
      return e.customTitle
    }
  }

  // 2. Goal sessions should keep the original objective as the stable title.
  for (const e of entries) {
    const goalTitle = extractGoalCreationTitle(e)
    if (goalTitle) return goalTitle
  }

  // 3. Look for AI-generated title (written by titleService)
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.type === 'ai-title' && e.aiTitle) {
      const title = cleanSessionTitleSource(String(e.aiTitle))
      if (title) return title
    }
  }

  // 4. Look for first non-meta user message as title
  for (const e of entries) {
    if (e.type === 'user' && !e.isMeta && e.message?.role === 'user') {
      const title = extractTranscriptUserTitle(e.message.content)
      if (title) return title
    }
  }

  return 'Untitled Session'
}
