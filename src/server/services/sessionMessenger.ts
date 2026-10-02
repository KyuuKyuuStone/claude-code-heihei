/**
 * SessionMessenger — 会话间消息投递
 *
 * 会话级上下级模型的通信层：把一条消息注入任意会话并确保其 CLI 在运行。
 * 主管会话用它给员工会话派活；员工会话用它给主管会话汇报。
 *
 * 参照 ws/handler.ts 的 ensureCliSessionStarted：sdkUrl 由服务端生成
 * 随机 token，CLI 连接 /sdk/:id 时凭它鉴权（authorizeSdkConnection）；
 * CLI 不在运行时按会话元数据恢复其 provider/model/权限设置再拉起。
 */

import * as crypto from 'crypto'
import { conversationService } from './conversationService.js'
import { diagnosticsService } from './diagnosticsService.js'
import {
  beginTurn,
  isTombstoned,
  registerSession,
  settleTurnIfOwner,
} from './sessionRegistry.js'
import { sessionService } from './sessionService.js'
import { ApiError } from '../middleware/errorHandler.js'

/**
 * 投递地址校验（v1.7.2 P0-a 裁决二十③）：必须是 `host:port` 且端口在 1–65535。
 *
 * 背景：`127.0.0.1:0` 这类假值曾被 supervisorProtocolNotice 用于「不需要真地址」的场景，
 * 而 deliver 对未运行会话会 startSession(..., buildSdkUrl(host)) —— 端口 0 的 SDK URL 让 CLI
 * 永远连不上，产生**静默僵尸会话**（CLI 活着、零日志、消息滞留）。此处**入口 fail-fast**，
 * 让同类问题显形为错误而不是静默。
 */
function isValidServerHostPort(serverHost: string): boolean {
  const matched = /^(.+):(\d+)$/.exec((serverHost ?? '').trim())
  if (!matched) return false
  const port = Number(matched[2])
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

function buildSdkUrl(serverHost: string, sessionId: string): string {
  const url = new URL(`ws://${serverHost}/sdk/${sessionId}`)
  url.searchParams.set('token', crypto.randomUUID())
  return url.toString()
}

/**
 * 注入回合的收尾登记（v1.3.0 阶段4 · 7b：自 ws/handler.ts 迁入）。
 * handler 的 deferred 权限/重启收尾经 resetInjectedTurnsForTests / 事件订阅
 * 协作，L4 → L3 单向合法；sessionMessenger 不再知道 handler 存在。
 */
const injectedTurnCleanups = new Map<string, () => void>()

/** 测试收尾：清理全部注入回合（测试环境无 WS turn，不会误伤） */
export function resetInjectedTurnsForTests(): void {
  for (const cleanup of [...injectedTurnCleanups.values()]) cleanup()
  injectedTurnCleanups.clear()
}

/**
 * 建轻量 turn（turn_in_progress：注入消息即刻送达 CLI）并挂 result 监听清理；
 * WS 路径的 deferred 权限/重启收尾不适用（无 WS 客户端），跳过。
 * 幂等：该会话已有活跃 turn 时返回 null、不覆盖、不重复挂监听。
 */
export function beginInjectedUserTurn(sessionId: string): {
  abort: () => void
} | null {
  registerSession(sessionId)
  const handle = beginTurn(sessionId, { awaitSend: false })
  if (!handle) return null
  void diagnosticsService
    .recordEvent({
      type: 'turn_started',
      severity: 'info',
      summary: 'Injected user turn started',
      sessionId,
      details: { sessionId, source: 'injected' },
    })
    .catch(() => {})
  const cleanup = () => {
    conversationService.removeOutputCallback(sessionId, callback)
    injectedTurnCleanups.delete(sessionId)
    settleTurnIfOwner(sessionId, handle)
  }
  const callback: (msg: any) => void = (cliMsg: any) => {
    if (cliMsg?.type !== 'result') return
    cleanup()
    void diagnosticsService
      .recordEvent({
        type: 'turn_finished',
        severity: 'info',
        summary: 'Injected user turn finished',
        sessionId,
        details: {
          sessionId,
          source: 'injected',
          is_error: cliMsg.is_error === true,
        },
      })
      .catch(() => {})
  }
  conversationService.onOutput(sessionId, callback)
  injectedTurnCleanups.set(sessionId, cleanup)
  return { abort: cleanup }
}

/**
 * deliver 测试注入缝（v1.3.0 阶段4：替代跨文件不安全的 mock.module）：
 * bun 的 mock.module 替换全局模块注册表且跨文件残留（mock.restore 不还原），
 * 全量套件互污染。测试经本缝替换 deliver 行为，afterEach 传 null 复原。
 * 短路语义注意：API 层（api/servants.ts）的 tombstone/roster 短路发生在
 * deliver 调用之前，不受本缝影响——override 只拦「真投递」段。
 */
type DeliverFn = (
  targetSessionId: string,
  content: string,
  serverHost: string,
) => Promise<boolean>

let deliverOverride: DeliverFn | null = null

export function setDeliverOverrideForTests(fn: DeliverFn | null): void {
  deliverOverride = fn
}

export class SessionMessenger {
  /**
   * 向目标会话注入一条用户消息；目标 CLI 未运行时先拉起。
   * 返回是否成功送达 SDK。
   */
  async deliver(
    targetSessionId: string,
    content: string,
    serverHost: string,
  ): Promise<boolean> {
    if (deliverOverride) {
      return deliverOverride(targetSessionId, content, serverHost)
    }
    if (!isValidServerHostPort(serverHost)) {
      // 裁决二十③：无效 host（含 port===0）一律**拒绝并显形**，绝不带着坏地址去拉起会话。
      void diagnosticsService
        .recordEvent({
          type: 'deliver_invalid_server_host',
          severity: 'error',
          summary: `投递被拒：serverHost 无效（${serverHost}）`, 
          details: { serverHost, targetSessionId },
        })
        .catch(() => {})
      throw ApiError.badRequest(
        `Invalid serverHost: ${JSON.stringify(serverHost)} (expected host:port with port 1-65535)`,
      )
    }
    if (!targetSessionId || !targetSessionId.trim()) {
      throw ApiError.badRequest('Field "targetSessionId" is required')
    }
    if (!content || !content.trim()) {
      throw ApiError.badRequest('Field "content" is required')
    }

    // tombstone 短路（v1.3.0 阶段3 · 6a 操作类）：仅拦**显式删除**的会话，
    // 直接拒绝——不进 notFound 拉起链（防软删除会话被投递复活）。
    // 不能用 !exists()：registry 是内存态、启动不重放，重启后存量会话全处于
    // 「未登记」态，exists() 会对它们返回 false，从而误拦存活会话（v1.3.0 回归）。
    if (isTombstoned(targetSessionId)) {
      throw ApiError.notFound(`Session not found: ${targetSessionId}`)
    }

    if (!conversationService.hasSession(targetSessionId)) {
      const workDir = await sessionService.getSessionWorkDir(targetSessionId)
      if (!workDir) {
        throw ApiError.notFound(`Session not found: ${targetSessionId}`)
      }
      const launchInfo = await sessionService
        .getSessionLaunchInfo(targetSessionId)
        .catch(() => null)
      await conversationService.startSession(
        targetSessionId,
        workDir,
        buildSdkUrl(serverHost, targetSessionId),
        {
          // 裁决二十一④：投递链路自动拉起——诊断据此区分「谁拉起的」。
          startSource: 'delivery',
          ...(launchInfo?.permissionMode
            ? { permissionMode: launchInfo.permissionMode }
            : {}),
          ...(launchInfo?.runtimeProviderId !== undefined
            ? { providerId: launchInfo.runtimeProviderId }
            : {}),
          ...(launchInfo?.runtimeModelId
            ? { model: launchInfo.runtimeModelId }
            : {}),
          // 员工无人值守拉起也要用上协作弹窗选定的思考强度
          ...(launchInfo?.effortLevel ? { effort: launchInfo.effortLevel } : {}),
        },
      )

      // CLI 是刚被程序化拉起的：已连接的桌面客户端此前绑定输出回调时
      // CLI 不存在（bindClientSessionOutput 提前返回），必须补绑。
      // v1.3.0 阶段4 · 7b：补绑改由 handler 订阅 phase_changed(→running) 事件
      // 自触发——sessionMessenger 不再知道 ws/handler 存在。
    }

    // 注入式回合也要建 turn（冻结根因报告 §2.3 环节 C）：interrupt/stall
    // watcher/deferred-restart 都以 activeUserTurns 判定「回合进行中」，
    // 信箱与 HTTP 派活/汇报此前从不建 turn → interrupt 误报 already idle。
    // sendMessage 失败（false/抛错）时对称清理，否则 turn 泄漏 → interrupt 永久 busy。
    // v1.3.0 阶段4 · 7b：回合建立逻辑自 ws/handler 迁入本模块，直调（动态 import 删除）。
    const turnHandle = beginInjectedUserTurn(targetSessionId)
    let sent: boolean
    try {
      sent = await conversationService.sendMessage(targetSessionId, content)
    } catch (error) {
      turnHandle?.abort()
      throw error
    }
    if (!sent) turnHandle?.abort()
    return sent
  }
}

export const sessionMessenger = new SessionMessenger()
