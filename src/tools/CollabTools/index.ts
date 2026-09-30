/**
 * Collab 工具集合与按角色注入（v1.6.0 第二批）。
 *
 * 注入条件（契约 §三）：进程环境里有 CC_HEIHEI_SESSION_ID，且角色为主管或员工。
 * 非协作会话（用户会话、普通会话）返回空数组——工具清单与改动前完全一致。
 */

import type { Tool } from '../../Tool.js'
import {
  COLLAB_TOOL_NAMES,
  collabToolNamesForRole,
  resolveCollabRole,
  type CollabToolName,
} from '../../collaboration/collabToolContract.js'
import { CollabDispatchTool } from './CollabDispatchTool.js'
import { CollabListTasksTool } from './CollabListTasksTool.js'
import { CollabReportTool } from './CollabReportTool.js'
import { CollabReviewTool } from './CollabReviewTool.js'

const TOOLS_BY_NAME: Record<CollabToolName, Tool> = {
  [COLLAB_TOOL_NAMES.dispatch]: CollabDispatchTool,
  [COLLAB_TOOL_NAMES.review]: CollabReviewTool,
  [COLLAB_TOOL_NAMES.listTasks]: CollabListTasksTool,
  [COLLAB_TOOL_NAMES.report]: CollabReportTool,
}

/** 当前会话可用的协作工具（按 CC_HEIHEI_COLLAB_ROLE / 主管标记判定） */
export function getCollabTools(env: NodeJS.ProcessEnv = process.env): readonly Tool[] {
  const role = resolveCollabRole(env)
  return collabToolNamesForRole(role).map((name) => TOOLS_BY_NAME[name])
}

export { CollabDispatchTool, CollabListTasksTool, CollabReportTool, CollabReviewTool }
