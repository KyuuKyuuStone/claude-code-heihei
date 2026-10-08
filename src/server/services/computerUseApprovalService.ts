/**
 * Computer Use 权限审批服务（L2 领域层）。
 *
 * 2026-10-08 G2 批：对 `ws/sessionTransport`（L4 传输态）的静态 import 已清 ——
 * 改由装配根 `server/index.ts` 经 `registerComputerUseApprovalTransport` 反向接线
 * （形态同 `registerRosterDigestDeps` / `registerServantInfoSource`）。本模块**不再
 * import 任何 `ws/*`**（含 `import type`），`layer-L2-no-upward` 违规随之消失。
 */

import type { CuPermissionRequest, CuPermissionResponse } from '../../vendor/computer-use-mcp/types.js'

type PendingApproval = {
  sessionId: string
  request: CuPermissionRequest
  resolve: (response: CuPermissionResponse) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 发给桌面端的消息**窄类型**（本地定义，刻意不 import `ws/events`）：
 * 传输侧适配器（装配根）负责让它满足 `ServerMessage` 并集——结构可赋值即可。
 */
export type ComputerUsePermissionRequestMessage = {
  type: 'computer_use_permission_request'
  requestId: string
  request: CuPermissionRequest
}

/** 传输能力（装配根注入）：把权限请求推给该会话；未送达返回 false。 */
export type ComputerUseApprovalTransport = {
  sendPermissionRequest: (sessionId: string, payload: ComputerUsePermissionRequestMessage) => boolean
}

let transport: ComputerUseApprovalTransport | null = null

/**
 * 装配根注入（生产）：`server/index.ts` 启动序调用，形态同 `registerRosterDigestDeps`。
 * 本模块不 import 任何业务/传输模块。
 */
export function registerComputerUseApprovalTransport(provider: ComputerUseApprovalTransport): void {
  transport = provider
}

/** 测试注入（传 null 复位为「未装配」）。 */
export function setComputerUseApprovalTransportForTests(
  provider: ComputerUseApprovalTransport | null,
): void {
  transport = provider
}

/**
 * 未装配即用 ⇒ **抛错（fail-fast）**，不静默降级：生产缺注册 = 装配根坏了；
 * 静默丢弃会让 CLI 侧一直等到 5 分钟超时，把装配缺陷伪装成连接问题。
 * 取值放在创建 pending 之前 ⇒ 失败不留半状态。
 */
function requireTransport(): ComputerUseApprovalTransport {
  if (!transport) {
    throw new Error(
      'computerUseApprovalService: 传输未装配 —— 装配根 server/index.ts 缺少 registerComputerUseApprovalTransport 调用',
    )
  }
  return transport
}

class ComputerUseApprovalService {
  private pending = new Map<string, PendingApproval>()

  async requestApproval(
    sessionId: string,
    request: CuPermissionRequest,
  ): Promise<CuPermissionResponse> {
    const existing = this.pending.get(request.requestId)
    if (existing) {
      clearTimeout(existing.timeout)
      existing.reject(new Error('Computer Use approval request superseded'))
      this.pending.delete(request.requestId)
    }

    // fail-fast：未装配（装配根缺接线）直接抛，不留 pending 半状态。
    const approvalTransport = requireTransport()

    return await new Promise<CuPermissionResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.requestId)
        reject(new Error('Computer Use approval timed out'))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(request.requestId, {
        sessionId,
        request,
        resolve,
        reject,
        timeout,
      })

      const sent = approvalTransport.sendPermissionRequest(sessionId, {
        type: 'computer_use_permission_request',
        requestId: request.requestId,
        request,
      })

      if (!sent) {
        clearTimeout(timeout)
        this.pending.delete(request.requestId)
        reject(new Error('Desktop session is not connected'))
      }
    })
  }

  resolveApproval(requestId: string, response: CuPermissionResponse): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    clearTimeout(pending.timeout)
    this.pending.delete(requestId)
    pending.resolve(response)
    return true
  }

  getPendingRequests(sessionId: string): CuPermissionRequest[] {
    return Array.from(this.pending.values())
      .filter((pending) => pending.sessionId === sessionId)
      .map((pending) => pending.request)
  }

  cancelSession(sessionId: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.sessionId !== sessionId) continue
      clearTimeout(pending.timeout)
      this.pending.delete(requestId)
      pending.reject(new Error('Desktop session disconnected during Computer Use approval'))
    }
  }
}

export const computerUseApprovalService = new ComputerUseApprovalService()
