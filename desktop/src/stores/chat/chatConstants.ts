// v1.7.0 结构拆分第⑦批（chatStore 第①批：与拓扑无关的常量/枚举 + 纯注册表）：
// 顶层常量从 stores/chatStore.ts 逐字移出（原 356-357、413-420、1131-1132、
// 3080-3090、3101-3105、3241-3248、3702、3946-3947、4482 行），逻辑零改动；
// 门面保留为入口。HISTORY_PAGE_SIZE 原为导出，此处保持 export，门面重导出。

import type { GoalEventAction } from '../../types/chat'

export const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TodoWrite'])
export const TASK_STOP_TOOL_NAMES = new Set(['TaskStop', 'KillShell'])

export const AGENT_COMPLETION_NOTIFICATION_PREVIEW_CHARS = 160
export const COMPACT_SUMMARY_PREFIX =
  'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.'
export const COMPACT_SUMMARY_CUTOFFS = [
  '\n\nIf you need specific details from before compaction',
  '\n\nContinue the conversation from where it left off',
  '\nContinue the conversation from where it left off',
]

/** v1.5.0 首开窗口大小：只拉最近一页历史，向上滚动再按游标翻更早页。 */
export const HISTORY_PAGE_SIZE = 200

export const TASK_NOTIFICATION_RE = /^<task-notification>\s*[\s\S]*<\/task-notification>$/i
export const GOAL_EVENT_ACTIONS = new Set<GoalEventAction>([
  'created',
  'replaced',
  'status',
  'paused',
  'resumed',
  'completed',
  'cleared',
  'message',
])

export const SIMPLE_IMAGE_SOURCE_RE = /^\[Image source: (.+)\]$/
export const DETAILED_IMAGE_SOURCE_RE = /^\[Image: source: (.+?)(?:, original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.)?\]$/
export const IMAGE_RESIZE_METADATA_RE = /^\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.\]$/
export const VISUAL_SELECTION_PROMPT_HEADER = '请根据截图中编号 1 的蓝色标注修改本地前端。'
export const VISUAL_SELECTION_PROMPT_FOOTER = '请优先依据截图里的编号标注定位元素，selector 只作为辅助线索。'

export const COMMAND_METADATA_TAGS = new Set([
  'command-name',
  'command-message',
  'command-args',
  'local-command-caveat',
  'skill-format',
])
export const COMMAND_METADATA_BLOCK_RE = /<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/gi

export const TEAMMATE_CONTENT_REGEX = /<teammate-message\s+teammate_id="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/teammate-message>/g

export const MATERIALIZED_UPLOAD_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-(.+)$/i
export const IMAGE_ONLY_REPLAY_FALLBACK = 'Please analyze the attached image.'

export const TASK_RELATED_TOOL_NAMES = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'])
