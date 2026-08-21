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
import { sessionService } from './sessionService.js'
import { ApiError } from '../middleware/errorHandler.js'

function buildSdkUrl(serverHost: string, sessionId: string): string {
  const url = new URL(`ws://${serverHost}/sdk/${sessionId}`)
  url.searchParams.set('token', crypto.randomUUID())
  return url.toString()
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
    if (!targetSessionId || !targetSessionId.trim()) {
      throw ApiError.badRequest('Field "targetSessionId" is required')
    }
    if (!content || !content.trim()) {
      throw ApiError.badRequest('Field "content" is required')
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
          ...(launchInfo?.permissionMode
            ? { permissionMode: launchInfo.permissionMode }
            : {}),
          ...(launchInfo?.runtimeProviderId !== undefined
            ? { providerId: launchInfo.runtimeProviderId }
            : {}),
          ...(launchInfo?.runtimeModelId
            ? { model: launchInfo.runtimeModelId }
            : {}),
        },
      )

      // CLI 是刚被程序化拉起的：已连接的桌面客户端此前绑定输出回调时
      // CLI 不存在（bindClientSessionOutput 提前返回），必须补绑，
      // 否则围观者只能断开重连才能看到执行过程。
      // 动态引入避免 services → ws 的静态依赖环。
      const { rebindClientOutputForSession } = await import('../ws/handler.js')
      rebindClientOutputForSession(targetSessionId)
    }

    return conversationService.sendMessage(targetSessionId, content)
  }
}

export const sessionMessenger = new SessionMessenger()
