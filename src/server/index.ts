/**
 * Claude Code Desktop App — HTTP + WebSocket Server
 *
 * 为桌面端 UI 提供 REST API 和 WebSocket 实时通信。
 * 读写与 CLI 完全相同的文件系统，确保 CLI/UI 数据互通。
 */

import { handleApiRequest } from './router.js'
import { handleWebSocket, type WebSocketData } from './ws/handler.js'
import { resolveCors, type CorsResolution } from './middleware/cors.js'
import { requireAuth } from './middleware/auth.js'
import { teamWatcher } from './services/teamWatcher.js'
// side-effect import（v1.3.0 阶段2 · 5e）：触发 servantIncidentNotifier 顶层
// 订阅 phase_changed(→crashed)。不放在 conversationService——避免
// conversationService → notifier → sessionMessenger → conversationService
// 静态依赖环（notifier 的崩溃观察者订阅需在服务启动时即就绪）。
import './services/servantIncidentNotifier.js'
import { cronScheduler } from './services/cronScheduler.js'
import { handleProxyRequest } from './proxy/handler.js'
import { ProviderService } from './services/providerService.js'
import { handleHeiheiOAuthCallback } from './api/heihei-oauth.js'
import { handleHeiheiOpenAIOAuthCallback } from './api/heihei-openai-oauth.js'
import { handlePreviewFs } from './api/previewFs.js'
import { handleLocalFile } from './api/localFile.js'
import { sessionService } from './services/sessionService.js'
import { localIndexCoordinator } from './services/localIndex/coordinator.js'
import { searchContentCoordinator } from './services/localIndex/searchContentCoordinator.js'
import { conversationService } from './services/conversationService.js'
// v1.3.0 阶段4 · 7a：花名册信息源装配（断 conversationService ⇄ servantService 环）——
// conversationService.isRegisteredSupervisor 经注入点查花名册，启动时即注入
import { servantService } from './services/servantService.js'
import { registerServantInfoSource } from './services/servantInfoSource.js'
// 端口自发现 + 身份探活（v1.4.0 阶段1-A ①②）：启动落盘 ~/.claude/cc-heihei/
// desktop-server.json（员工投递前读取自愈，不再依赖启动时注入的 env），
// whoami 端点的身份同源。
import {
  clearDesktopServerInfo,
  clearDesktopServerInfoSync,
  startDesktopServerInfoGuard,
  writeDesktopServerInfo,
} from './services/serverIdentity.js'
registerServantInfoSource((sessionId) => servantService.getServant(sessionId))
// 崩溃通知的 deliver 经注入缝装配（v1.3.1 · R2b 断环）：servantIncidentNotifier
// 不再静态 import sessionMessenger（conversationService → notifier →
// sessionMessenger → conversationService 静态依赖环消失）——本模块是 L4 汇聚
// 点，由它反向把两侧接起来。
import { sessionMessenger } from './services/sessionMessenger.js'
import { registerServantIncidentDeliver } from './services/servantIncidentNotifier.js'
registerServantIncidentDeliver((targetSessionId, content, serverHost) =>
  sessionMessenger.deliver(targetSessionId, content, serverHost),
)
// v1.7.4 B1-2 断环：rosterDigest 的花名册读取改为注入缝（原在服务内动态 import
// servantService，触发 no-dynamic-import-in-services，且为绕开
// conversationService → rosterDigest → servantService 静态环）。本模块是 L4 汇聚点。
import { registerRosterDigestDeps } from './services/rosterDigest.js'
registerRosterDigestDeps({ listServants: () => servantService.listServants() })
// v1.7.4 B1-2 批③断环：getSessionChatActivityState 上提到 ws/sessionActivity.ts，
// 它对 computer-use 待批请求数的读取经注入缝由本模块（L4 汇聚点）反向接线——
// computerUseApprovalService 已 import ws/handler，若该模块直接 import 它会闭合出
// 新的 no-circular。
import { computerUseApprovalService } from './services/computerUseApprovalService.js'
import { registerSessionActivityDeps } from './ws/sessionActivity.js'
registerSessionActivityDeps({
  pendingComputerUseApprovals: (sessionId) =>
    computerUseApprovalService.getPendingRequests(sessionId).length,
})
// G2 批：三处 L2 → L4 上行 import 改注入缝（本模块是 L4 汇聚点，反向接线）。
// ① computerUseApprovalService 的权限请求投递（窄类型结构可赋值给 ServerMessage）。
import { registerComputerUseApprovalTransport } from './services/computerUseApprovalService.js'
import { sendToSession, getActiveSessionIds } from './ws/sessionTransport.js'
registerComputerUseApprovalTransport({
  sendPermissionRequest: (sessionId, payload) => sendToSession(sessionId, payload),
})
// ② teamWatcher 的广播（适配器见下方 teamWatcher.start() 之前，逐字搬原内联体）
import { registerTeamWatcherBroadcast } from './services/teamWatcher.js'
// ③ sessionComponentReloadService 的斜杠命令同步（返回值本服务只取 .length）
import { registerSessionComponentReloadDeps } from './services/sessionComponentReloadService.js'
import { updateSessionSlashCommands } from './ws/cliMessageTranslation.js'
registerSessionComponentReloadDeps({
  syncSlashCommands: (sessionId, commands) => updateSessionSlashCommands(sessionId, commands),
})
import { dispatchMailboxService } from './services/dispatchMailboxService.js'
// v1.6.0 任务台账：订阅 sessionRegistry 的回合事件，把「员工回合开始消费」
// 落成任务状态 accepted → in_progress。L1 → 本模块（L4 汇聚点）单向订阅，
// 台账本身不反向依赖任何业务模块。
import { collabTaskService } from './services/collabTaskService.js'
collabTaskService.startTurnSubscription()
import { OPENAI_CODEX_REDIRECT_PATH } from '../services/openaiAuth/client.js'
import { ensureDesktopCliLauncherInstalled } from './services/desktopCliLauncherService.js'
import { enableConfigs } from '../utils/config.js'
import { diagnosticsService } from './services/diagnosticsService.js'
import { ensurePersistentStorageUpgraded } from './services/persistentStorageMigrations.js'
import {
  classifyRequest,
  shouldBlockRemoteAccess,
  type RequestContext,
} from './localRequestPolicy.js'
import {
  hasConfiguredLocalAccessToken,
  isLocalAccessAuthorized,
} from './localAccessAuth.js'
import { settleResponseOnRequestAbort } from './requestLifecycle.js'

/**
 * 员工假死 watcher 模块的运行期引用：
 * 启动时经动态 import 拉起，关闭时由 stopServerRuntimeForShutdown 调用 stop。
 * （index.ts 不静态导入该模块，避免其依赖在 CLI 纯构建场景被拖入）
 */
let servantStallWatcherModule: typeof import('./services/servantStallWatcher.js') | null = null

function readArgValue(flag: string): string | undefined {
  const args = process.argv.slice(2)
  const index = args.indexOf(flag)
  if (index === -1) return undefined
  return args[index + 1]
}

function hasArgFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag)
}

function resolveServerOptions() {
  const portArg = readArgValue('--port')
  const port = Number.parseInt(portArg || process.env.SERVER_PORT || '3456', 10)
  const host = readArgValue('--host') || process.env.SERVER_HOST || '127.0.0.1'
  const cliPath = readArgValue('--cli-path')
  const authRequired = hasArgFlag('--auth-required')

  if (cliPath) {
    process.env.CLAUDE_CLI_PATH = cliPath
  }

  return { port, host, authRequired }
}

const SERVER_OPTIONS = resolveServerOptions()
const PORT = SERVER_OPTIONS.port
const HOST = SERVER_OPTIONS.host
const SEARCH_INDEX_PRIMARY_WAIT_MS = 30_000
const SEARCH_INDEX_PRIMARY_POLL_MS = 50
export const HTTP_CONNECTION_IDLE_TIMEOUT_SECONDS = 0

type BackgroundIndexStartupOptions = {
  startPrimary?: () => Promise<void>
  getPrimaryState?: () => string
  startSearch?: () => Promise<void>
  wait?: () => Promise<void>
  now?: () => number
  maxPrimaryWaitMs?: number
  signal?: AbortSignal
}

/** Give the session-list projection first access to cold-start I/O. */
export async function startBackgroundIndexesInPriorityOrder(
  options: BackgroundIndexStartupOptions = {},
): Promise<void> {
  const startPrimary = options.startPrimary ?? (() => localIndexCoordinator.start())
  const getPrimaryState = options.getPrimaryState ?? (
    () => localIndexCoordinator.getPublicStatus().state
  )
  const startSearch = options.startSearch ?? (() => searchContentCoordinator.start())
  const wait = options.wait ?? (
    () => new Promise<void>(resolve => setTimeout(resolve, SEARCH_INDEX_PRIMARY_POLL_MS))
  )
  const now = options.now ?? Date.now
  const deadline = now() + Math.max(
    0,
    options.maxPrimaryWaitMs ?? SEARCH_INDEX_PRIMARY_WAIT_MS,
  )

  await startPrimary()
  while (
    !options.signal?.aborted &&
    getPrimaryState() === 'building' &&
    now() < deadline
  ) await wait()
  if (!options.signal?.aborted) await startSearch()
}

let backgroundIndexStartupController: AbortController | undefined
let backgroundIndexStartup: Promise<void> | undefined

function beginBackgroundIndexStartup(): void {
  backgroundIndexStartupController?.abort()
  const controller = new AbortController()
  backgroundIndexStartupController = controller
  const operation = startBackgroundIndexesInPriorityOrder({
    signal: controller.signal,
  }).catch(() => undefined)
  backgroundIndexStartup = operation
  void operation.finally(() => {
    if (backgroundIndexStartup === operation) backgroundIndexStartup = undefined
  })
}

function withCors(response: Response, cors: CorsResolution): Response {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(cors.headers)) {
    headers.set(key, value)
  }
  return new Response(response.body, {
    status: response.status,
    headers,
  })
}

function corsRejectedResponse(cors: CorsResolution): Response {
  return Response.json(
    { error: 'CORS origin not allowed' },
    { status: 403, headers: cors.headers },
  )
}

function remoteAccessRejectedResponse(): Response {
  return Response.json(
    {
      error: 'Forbidden',
      message: 'This server only accepts requests from the local desktop app.',
    },
    { status: 403 },
  )
}


export function startServer(port = PORT, host = HOST) {
  enableConfigs()
  // Don't hijack the global console / process handlers under `bun test`:
  // a test that boots the server would otherwise route every test-side
  // console.error/warn into the user's real diagnostics file.
  if (process.env.NODE_ENV !== 'test') {
    diagnosticsService.installConsoleCapture()
    diagnosticsService.installProcessCapture()
    // 启动锚点：让"诊断日志到底还在不在写"这件事在生产可自证——此前日志只在
    // warn/error 时才写，安静期看起来和"写坏了"完全一样（2026-09-14 之后
    // diagnostics.jsonl 停写两日的排查就卡在这里）。
    void diagnosticsService
      .recordEvent({
        type: 'server_started',
        severity: 'info',
        summary: `服务端启动：port=${port} pid=${process.pid} platform=${process.platform}`,
        details: { port, pid: process.pid, platform: process.platform },
      })
      .catch(() => {})
  }
  let serverPort = port
  const localConnectHost =
    host === '0.0.0.0' || host === '127.0.0.1' || host === 'localhost'
      ? '127.0.0.1'
      : host

  // Chromium can keep HTTP/1.1 sockets pooled longer than Bun's request idle
  // timeout. On Windows, reusing a socket after Bun timed it out can leave the
  // request waiting for response headers until the renderer's 120s deadline.
  // Let the client own the lifetime of these local pooled connections instead.
  /**
   * 部署侧显式鉴权（SERVER_AUTH_REQUIRED / authRequired）：打开时远程请求改走
   * 通用令牌校验，而不是被本机请求策略直接拒绝。
   */
  const forceAuth =
    SERVER_OPTIONS.authRequired ||
    process.env.SERVER_AUTH_REQUIRED === '1'

  let server: ReturnType<typeof Bun.serve<WebSocketData>>

  try {
    server = Bun.serve<WebSocketData>({
      port,
      hostname: host,
      idleTimeout: HTTP_CONNECTION_IDLE_TIMEOUT_SECONDS,

      async fetch(req, server) {
        const url = new URL(req.url)

        // Startup probes must not wait on migrations, config reads, or auth.
        // Electron deliberately uses this endpoint to decide when the sidecar
        // is ready, so keep it independent of every other runtime subsystem.
        if (url.pathname === '/health') {
          return Response.json(
            { status: 'ok', timestamp: new Date().toISOString() },
            {
              headers: {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store',
              },
            },
          )
        }

        await ensurePersistentStorageUpgraded()
        const origin = req.headers.get('Origin')
        const clientAddress = server.requestIP(req)?.address ?? null
        const localTokenOverride = url.searchParams.get('localToken') ?? url.searchParams.get('token')
        const sdkSessionId = url.pathname.startsWith('/sdk/')
          ? url.pathname.split('/').pop() || ''
          : ''
        const sdkToken = url.searchParams.get('token')
        const requestContext: RequestContext = {
          clientAddress,
          localAccessTokenConfigured: hasConfiguredLocalAccessToken(),
          localAccessAuthorized: isLocalAccessAuthorized(req, localTokenOverride),
          internalSdkAuthorized: Boolean(
            sdkSessionId && sdkToken && conversationService.authorizeSdkConnection(sdkSessionId, sdkToken),
          ),
        }
        const cors = await resolveCors(origin, url.origin)

        // 非本机受信客户端访问受保护能力路径 → 一律拒绝（服务默认监听 0.0.0.0，
        // 这是唯一的非本机访问边界；部署侧显式开启 authRequired 时改走通用令牌鉴权）。
        if (shouldBlockRemoteAccess({
          request: req,
          url,
          explicitAuthRequired: forceAuth,
          context: requestContext,
        })) {
          return remoteAccessRejectedResponse()
        }

        // Handle CORS preflight
        if (req.method === 'OPTIONS') {
          if (cors.rejected) {
            return corsRejectedResponse(cors)
          }
          return new Response(null, { status: 204, headers: cors.headers })
        }

        // WebSocket upgrade
        if (url.pathname.startsWith('/ws/')) {
          if (cors.rejected) {
            return corsRejectedResponse(cors)
          }

          // Enforce authentication when required
          if (forceAuth) {
            const authError = await requireAuth(req, url.searchParams.get('token'))
            if (authError) {
              return withCors(authError, cors)
            }
          }

          // Validate session ID format
          const sessionId = url.pathname.split('/').pop() || ''
          if (!sessionId || !/^[0-9a-zA-Z_-]{1,64}$/.test(sessionId)) {
            return new Response('Invalid session ID', { status: 400 })
          }
          const upgraded = server.upgrade(req, {
            data: {
              sessionId,
              connectedAt: Date.now(),
              channel: 'client',
              sdkToken: null,
              serverPort,
              serverHost: localConnectHost,
            },
          })
          if (upgraded) return undefined
          return new Response('WebSocket upgrade failed', { status: 400 })
        }

        // Internal SDK WebSocket used by the spawned Claude CLI.
        if (url.pathname.startsWith('/sdk/')) {
          if (classifyRequest(req, url, requestContext) !== 'internal-sdk') {
            return remoteAccessRejectedResponse()
          }

          if (cors.rejected) {
            return corsRejectedResponse(cors)
          }

          if (forceAuth) {
            const authError = await requireAuth(req, url.searchParams.get('token'))
            if (authError) {
              return withCors(authError, cors)
            }
          }

          const sessionId = url.pathname.split('/').pop() || ''
          if (!sessionId || !/^[0-9a-zA-Z_-]{1,64}$/.test(sessionId)) {
            return new Response('Invalid session ID', { status: 400 })
          }
          const upgraded = server.upgrade(req, {
            data: {
              sessionId,
              connectedAt: Date.now(),
              channel: 'sdk',
              sdkToken: url.searchParams.get('token'),
              serverPort,
              serverHost: localConnectHost,
            },
          })
          if (upgraded) return undefined
          return new Response('WebSocket upgrade failed', { status: 400 })
        }

        if (url.pathname === '/callback') {
          return handleHeiheiOAuthCallback(url)
        }

        if (
          url.pathname === OPENAI_CODEX_REDIRECT_PATH ||
          url.pathname === '/callback/openai'
        ) {
          return handleHeiheiOpenAIOAuthCallback(url)
        }

        // Preview filesystem — serve sandboxed workspace files for a session.
        if (url.pathname.startsWith('/preview-fs/')) {
          if (cors.rejected) {
            return corsRejectedResponse(cors)
          }

          if (forceAuth) {
            const authError = await requireAuth(req)
            if (authError) {
              return withCors(authError, cors)
            }
          }

          const response = await handlePreviewFs(
            url,
            async (sessionId) =>
              conversationService.getSessionWorkDir(sessionId) ||
              (await sessionService.getSessionWorkDir(sessionId)) ||
              null,
            req.headers,
          )
          return withCors(response, cors)
        }

        // Local filesystem — serve an ABSOLUTE local file ($HOME/tmp/registered
        // roots sandbox) so `file://` links / AI-emitted absolute paths open in
        // the in-app browser. Gated identically to /preview-fs above.
        if (url.pathname.startsWith('/local-file/')) {
          if (cors.rejected) {
            return corsRejectedResponse(cors)
          }

          if (forceAuth) {
            const authError = await requireAuth(req)
            if (authError) {
              return withCors(authError, cors)
            }
          }

          const response = await handleLocalFile(url, req.headers)
          return withCors(response, cors)
        }

        // REST API（/api 无斜杠也要进来——名录端点在 router.ts 两路匹配，
        // 此前只认 /api/ 前缀，无斜杠的 /api 落到 SPA fallback 返回 HTML）
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
          if (cors.rejected) {
            return corsRejectedResponse(cors)
          }

          // Enforce authentication when required
          if (forceAuth) {
            const authError = await requireAuth(req)
            if (authError) {
              return withCors(authError, cors)
            }
          }

          try {
            const response = await settleResponseOnRequestAbort(
              req,
              handleApiRequest(req, url),
            )
            return withCors(response, cors)
          } catch (error) {
            void diagnosticsService.recordEvent({
              type: 'api_request_failed',
              severity: 'error',
              summary: error instanceof Error ? error.message : String(error),
              details: { path: url.pathname, method: req.method, error },
            })
            console.error('[Server] API error:', error)
            return withCors(Response.json(
              { error: 'Internal server error' },
              { status: 500 },
            ), cors)
          }
        }

        // Proxy — protocol-translating reverse proxy for OpenAI-compatible APIs
        if (url.pathname.startsWith('/proxy/')) {
          if (cors.rejected) {
            return corsRejectedResponse(cors)
          }

          if (forceAuth) {
            const authError = await requireAuth(req)
            if (authError) {
              return withCors(authError, cors)
            }
          }
          try {
            const response = await handleProxyRequest(req, url)
            return withCors(response, cors)
          } catch (error) {
            void diagnosticsService.recordEvent({
              type: 'proxy_request_failed',
              severity: 'error',
              summary: error instanceof Error ? error.message : String(error),
              details: { path: url.pathname, method: req.method, error },
            })
            console.error('[Server] Proxy error:', error)
            return withCors(Response.json(
              { type: 'error', error: { type: 'api_error', message: 'Internal proxy error' } },
              { status: 500 },
            ), cors)
          }
        }

        return new Response('Not Found', { status: 404 })
      },

      websocket: handleWebSocket,
    })
    serverPort = server.port
    ProviderService.setServerPort(serverPort)
  } catch (error) {
    const message = error instanceof Error && error.message
      ? error.message
      : `Failed to start server. Is port ${port} in use?`
    throw new Error(message, { cause: error })
  }

  // Bun.serve is already accepting requests. Both projections remain
  // background work; session-list metadata gets priority on a cold start so
  // full-text backfill cannot make the sidebar slower on low-memory machines.
  beginBackgroundIndexStartup()

  // Start watching ~/.claude/teams/ for real-time WebSocket push
  // G2 批：广播能力经注入缝接线（teamWatcher 是 L2，不得 import ws/*）。
  // 适配器 = 原 `TeamWatcher.broadcast` 内联体逐字搬（getActiveSessionIds + 循环 sendToSession）。
  registerTeamWatcherBroadcast((message) => {
    for (const id of getActiveSessionIds()) {
      sendToSession(id, message)
    }
  })
  teamWatcher.start()

  // Start the cron scheduler to execute scheduled tasks
  cronScheduler.start()

  // Start the dispatch mailbox: file-based fallback channel for session
  // dispatch/report when a session's Bash is unusable (e.g. no Git Bash).
  dispatchMailboxService.start(serverPort)

  // 端口自发现落盘（v1.4.0 阶段1-A ①）：server.port 是实际绑定端口（port=0
  // 自动分配时与入参不同）。写入失败只降级自发现（读方走 env 兜底），不炸启动。
  // v1.6.0：测试进程（bun test 恒设 NODE_ENV=test）不碰端口文件。
  // 门控原本只看 CC_HEIHEI_DESKTOP_SIDECAR，但那是会被子进程继承的环境变量——
  // e2e 测试 import 本模块起服务时照样带着它，于是把真实用户目录下的端口文件
  // 覆盖成测试实例的地址（2026-09-30：死实例 pid 5264/57094 覆盖了在用的
  // 18908/56923，所有按端口文件寻址的会话投递失败）。同文件下方的
  // diagnostics console 捕获已有同样的判断先例。
  if (process.env.NODE_ENV !== 'test') {
    void writeDesktopServerInfo(serverPort).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[Server] Failed to write desktop-server.json (port discovery degraded): ${message}`)
    })
    // 自愈：端口文件可能被别的实例（尤其是已死进程的残值）覆盖，导致所有按端口
    // 文件寻址的会话投递失败。巡检只在「文件 pid 已死/文件缺失」时夺回，不抢活着的实例。
    startDesktopServerInfoGuard(serverPort)
  }

  // v1.5.0 A6：协作推送——花名册 lastActivityAt 巡检（5s 节流）。
  // 与其他后台任务同款动态 import：启动失败不影响服务器体。
  void import('./services/collabPushService.js')
    .then((mod) => {
      mod.collabPushService.startActivitySweep()
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[Server] collab push activity sweep failed to start: ${message}`)
    })

  // Watch for stalled servant sessions (running but no activity) and
  // auto-repush with troubleshooting hints, escalating to the supervisor.
  void import('./services/servantStallWatcher.js')
    .then((mod) => {
      servantStallWatcherModule = mod
      mod.servantStallWatcher.start()
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      // 启动失败必须留痕（诊断事件），否则"假死重推从未生效"这类问题现场无迹可查。
      console.error(`[Server] servant stall watcher failed to start: ${message}`)
      void diagnosticsService
        .recordEvent({
          type: 'servant_stall',
          severity: 'error',
          summary: `假死重推 watcher 启动失败：${message}`,
          details: { action: 'watcher-start-failed' },
        })
        .catch(() => {})
    })

  // One-time protocol update notice for already-registered supervisors:
  // orientation messages only fire on first appointment, continued
  // conversations never see upgraded rules otherwise.
  void import('./services/supervisorProtocolNotice.js')
    .then(({ notifySupervisorsOfProtocolUpdate }) => notifySupervisorsOfProtocolUpdate())
    .catch((error) => {
      console.warn(
        `[Server] supervisor protocol notice failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })

  void ensureDesktopCliLauncherInstalled().catch((error) => {
    console.error(
        '[desktop-cli-launcher] failed to install bundled launcher:',
        error instanceof Error ? error.message : error,
    )
  })

  console.log(`[Server] Claude Code API server running at http://${host}:${serverPort}`)
  return server
}

// ─── Graceful shutdown: kill all CLI subprocesses on exit ────────────────────

let shutdownInProgress: Promise<void> | null = null

export async function stopServerRuntimeForShutdown(
  options: { waitForCli?: boolean } = {},
): Promise<void> {
  teamWatcher.stop()
  cronScheduler.stop()
  dispatchMailboxService.stop()
  servantStallWatcherModule?.servantStallWatcher.stop()
  backgroundIndexStartupController?.abort()
  const pendingIndexStartup = backgroundIndexStartup
  await Promise.all([
    localIndexCoordinator.stop(),
    searchContentCoordinator.stop(),
    pendingIndexStartup,
  ])

  const active = conversationService.getActiveSessions()
  if (active.length > 0) {
    console.log(`[Server] Shutting down — killing ${active.length} CLI subprocess(es)`)
    if (options.waitForCli === false) {
      conversationService.stopAllSessions()
    } else {
      await conversationService.stopAllSessionsAndWait()
    }
  }
}

function cleanupAllSessions() {
  void stopServerRuntimeForShutdown({ waitForCli: false })
}

async function cleanupAllSessionsAndWait() {
  await stopServerRuntimeForShutdown({ waitForCli: true })
}

function shutdownAndExit(signal: 'SIGTERM' | 'SIGINT', exitCode: number) {
  if (shutdownInProgress) return

  shutdownInProgress = (async () => {
    console.log(`[Server] Received ${signal}`)
    await cleanupAllSessionsAndWait()
    await clearDesktopServerInfo()
    process.exit(exitCode)
  })().catch((error) => {
    console.error(
      `[Server] ${signal} shutdown cleanup failed:`,
      error instanceof Error ? error.message : error,
    )
    process.exit(1)
  })
}

process.on('SIGTERM', () => {
  shutdownAndExit('SIGTERM', 0)
})

process.on('SIGINT', () => {
  shutdownAndExit('SIGINT', 0)
})

process.on('exit', () => {
  cleanupAllSessions()
  // 端口文件同步兜底清理（v1.4.0 阶段1-A ①）：残留的旧文件靠 pid/startedAt
  // 仍可被读取方识别为陈旧，这里尽力而为之。
  clearDesktopServerInfoSync()
})

// Direct execution
if (import.meta.main) {
  startServer()
}
