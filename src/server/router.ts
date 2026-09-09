/**
 * API Router — 将请求路由到对应的 API handler
 */

import { handleSessionsApi } from './api/sessions.js'
import { handleSettingsApi } from './api/settings.js'
import { handleModelsApi } from './api/models.js'
import { handleScheduledTasksApi } from './api/scheduled-tasks.js'
import { handleSearchApi } from './api/search.js'
import { handleAgentsApi } from './api/agents.js'
import { handleStatusApi } from './api/status.js'
import { handleConversationsApi } from './api/conversations.js'
import { handleTeamsApi } from './api/teams.js'
import { handleFilesystemRoute } from './api/filesystem.js'
import { handleProvidersApi } from './api/providers.js'
import { handlePluginsApi } from './api/plugins.js'
import { handleSkillsApi } from './api/skills.js'
import { handleMarketApi } from './api/market.js'
import { handleComputerUseApi } from './api/computer-use.js'
import { handleHeiheiOAuthApi } from './api/heihei-oauth.js'
import { handleHeiheiOpenAIOAuthApi } from './api/heihei-openai-oauth.js'
import { handleHeiheiGrokOAuthApi } from './api/heihei-grok-oauth.js'
import { handleMcpApi } from './api/mcp.js'
import { handleDiagnosticsApi } from './api/diagnostics.js'
import { handleDoctorApi } from './api/doctor.js'
import { handleH5AccessApi } from './api/h5-access.js'
import { handleActivityStatsApi } from './api/activityStats.js'
import { handleOpenTargetsApi } from './api/open-targets.js'
import { handleMemoryApi } from './api/memory.js'
import { handleDesktopUiApi } from './api/desktop-ui.js'
import { handleTracesApi } from './api/traces.js'
import { handleServantsApi, handleSessionMessagesApi } from './api/servants.js'

export async function handleApiRequest(req: Request, url: URL): Promise<Response> {
  const path = url.pathname
  const segments = path.split('/').filter(Boolean) // ['api', 'sessions', ...]

  // GET /api — 端点名录：让会话内的 AI（和排障的人）不用穷举猜路径
  if (req.method === 'GET' && (path === '/api' || path === '/api/')) {
    return Response.json(buildApiCatalog())
  }

  // Route to appropriate handler based on the second segment
  const resource = segments[1]

  switch (resource) {
    case 'sessions': {
      // Route /api/sessions/:id/chat/* to conversations handler
      const subResource = segments[3]
      if (subResource === 'chat') {
        return handleConversationsApi(req, url, segments)
      }
      return handleSessionsApi(req, url, segments)
    }

    case 'conversations':
      return handleConversationsApi(req, url, segments)

    case 'settings':
      return handleSettingsApi(req, url, segments)

    case 'models':
    case 'effort':
      return handleModelsApi(req, url, segments)

    case 'permissions':
      return handleSettingsApi(req, url, segments) // permissions under settings

    case 'scheduled-tasks':
      return handleScheduledTasksApi(req, url, segments)

    case 'servant-sessions':
      return handleServantsApi(req, url, segments)

    case 'session-messages':
      return handleSessionMessagesApi(req, url, segments)

    case 'search':
      return handleSearchApi(req, url, segments)

    case 'agents':
    case 'tasks':
      return handleAgentsApi(req, url, segments)

    case 'status':
      return handleStatusApi(req, url, segments)

    case 'teams':
      return handleTeamsApi(req, url, segments)

    case 'providers':
      return handleProvidersApi(req, url, segments)

    case 'heihei-oauth':
      return handleHeiheiOAuthApi(req, url, segments)

    case 'heihei-openai-oauth':
      return handleHeiheiOpenAIOAuthApi(req, url, segments)

    case 'heihei-grok-oauth':
      return handleHeiheiGrokOAuthApi(req, url, segments)

    case 'adapters':
      // Adapter protocols pull in platform SDKs that are unnecessary for the
      // core server path. Load them only when this API is actually used.
      return (await import('./api/adapters.js')).handleAdaptersApi(req, url, segments)

    case 'skills':
      return handleSkillsApi(req, url, segments)

    case 'market':
      return handleMarketApi(req, url, segments)

    case 'mcp':
      return handleMcpApi(req, url, segments)

    case 'plugins':
      return handlePluginsApi(req, url, segments)

    case 'computer-use':
      return handleComputerUseApi(req, url, segments)

    case 'diagnostics':
      return handleDiagnosticsApi(req, url, segments)

    case 'doctor':
      return handleDoctorApi(req, url, segments)

    case 'h5-access':
      return handleH5AccessApi(req, url, segments)

    case 'activity-stats':
      return handleActivityStatsApi(req, url, segments)

    case 'open-targets':
      return handleOpenTargetsApi(req, url, segments)

    case 'memory':
      return handleMemoryApi(req, url, segments)

    case 'desktop-ui':
      return handleDesktopUiApi(req, url, segments)

    case 'traces':
      return handleTracesApi(req, url, segments)

    case 'filesystem':
      return handleFilesystemRoute(url.pathname, url)

    default:
      return Response.json(
        { error: 'Not Found', message: `Unknown API resource: ${resource}` },
        { status: 404 }
      )
  }
}

/**
 * GET /api 端点名录：协作会话里的 AI（主管/员工）和排障的人可以一次拿到
 * 可用端点清单，替代"穷举试错猜路径"。只收录会话协作与核心会话管理相关
 * 的稳定端点；完整能力仍以各资源端点为准。
 */
function buildApiCatalog() {
  return {
    name: 'Claude Code Heihei Desktop API',
    hint: '所有路径相对服务根地址。带 {sessionId} 的路径需替换为真实会话 ID。',
    endpoints: [
      {
        method: 'GET',
        path: '/api',
        description: '本名录',
      },
      {
        method: 'GET',
        path: '/api/servant-sessions?forSession={sessionId}',
        description: '员工花名册（本项目的员工，含 role/description/running/lastActivityAt）',
      },
      {
        method: 'PUT',
        path: '/api/servant-sessions/{sessionId}',
        description: '设置/更新协作身份；body: {role?, description?, enabled, supervisor?, runtimeProviderId?, runtimeModelId?, effortLevel?}。禁用员工用 enabled:false，修改角色特性直接改 description',
      },
      {
        method: 'DELETE',
        path: '/api/servant-sessions/{sessionId}',
        description: '移除协作身份（不删除会话本身）',
      },
      {
        method: 'POST',
        path: '/api/session-messages',
        description: '会话间消息投递（派活/汇报共用）；body: {targetSessionId, content, fromSessionId?}。中文必须写 JSON 文件后 --data-binary @file 提交；body 用 {broadcast:true, content, fromSessionId} 可发给本项目全部员工',
      },
      {
        method: 'POST',
        path: '/api/sessions/{sessionId}/interrupt',
        description: '中断该会话当前运行（保留会话与历史）。停止员工空转用这个，不要用 DELETE',
      },
      {
        method: 'DELETE',
        path: '/api/sessions/{sessionId}',
        description: '⚠️ 删除整个会话（含历史），不可逆。只想停止运行请用 POST /api/sessions/{sessionId}/interrupt',
      },
      {
        method: 'GET',
        path: '/api/sessions/{sessionId}',
        description: '会话详情（含 modifiedAt 最后活动时间）',
      },
      {
        method: 'GET',
        path: '/api/doctor/report?cwd={workDir}',
        description: '环境体检（shell/协作技能/配置文件完整性）',
      },
    ],
  }
}
