import { conversationService } from './conversationService.js'

/**
 * 2026-10-08 G2 批：对 `ws/cliMessageTranslation`（L4）的静态 import 已清 ——
 * `updateSessionSlashCommands` 改由装配根 `server/index.ts` 经
 * `registerSessionComponentReloadDeps` 反向接线（形态同 `registerRosterDigestDeps`）。
 * 本模块对返回值**只用 `.length`**，故缝的返回类型窄化为 `unknown[]`，零 ws 类型依赖。
 */
export type SessionComponentReloadDeps = {
  syncSlashCommands: (sessionId: string, commands: unknown[]) => unknown[]
}

let deps: SessionComponentReloadDeps | null = null

/** 装配根注入（生产）：`server/index.ts` 启动序调用。 */
export function registerSessionComponentReloadDeps(provider: SessionComponentReloadDeps): void {
  deps = provider
}

/** 测试注入（传 null 复位为「未装配」）。 */
export function setSessionComponentReloadDepsForTests(
  provider: SessionComponentReloadDeps | null,
): void {
  deps = provider
}

export type SessionComponentReloadSummary = {
  applied: boolean
  reason?: 'not_running' | 'failed'
  commands: number
  agents: number
  plugins: number
  mcpServers: number
  errors: number
  error?: string
}

/**
 * Refresh the disk-backed commands, agents, plugins, and MCP state captured by
 * an already-running CLI session. The control request updates the session in
 * place, so callers do not need to restart or replace the conversation.
 */
export async function reloadSessionComponents(
  sessionId: string,
): Promise<SessionComponentReloadSummary> {
  // 未装配（装配根缺接线）⇒ 诚实失败：不假装成功（不做 reload 却报 commands: 0）。
  // 放在「会话是否在跑」之前：装配坏比会话状态更该暴露，且生产路径恒已装配 ⇒ 行为不变。
  if (!deps) {
    return {
      ...emptySummary('failed'),
      error:
        'sessionComponentReloadService: syncSlashCommands 未装配 —— 装配根 server/index.ts 缺少 registerSessionComponentReloadDeps 调用',
    }
  }

  if (!conversationService.hasSession(sessionId)) {
    return emptySummary('not_running')
  }

  try {
    const response = await conversationService.requestControl(
      sessionId,
      { subtype: 'reload_plugins' },
      120_000,
    )
    const commands = Array.isArray(response.commands) ? response.commands : []
    const normalizedCommands = deps.syncSlashCommands(sessionId, commands)

    return {
      applied: true,
      commands: normalizedCommands.length,
      agents: Array.isArray(response.agents) ? response.agents.length : 0,
      plugins: Array.isArray(response.plugins) ? response.plugins.length : 0,
      mcpServers: Array.isArray(response.mcpServers) ? response.mcpServers.length : 0,
      errors: typeof response.error_count === 'number' ? response.error_count : 0,
    }
  } catch (error) {
    return {
      ...emptySummary('failed'),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function emptySummary(
  reason: 'not_running' | 'failed',
): SessionComponentReloadSummary {
  return {
    applied: false,
    reason,
    commands: 0,
    agents: 0,
    plugins: 0,
    mcpServers: 0,
    errors: 0,
  }
}
