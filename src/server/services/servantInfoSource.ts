/**
 * 花名册信息注入点（v1.3.0 阶段4 · 7a）。
 *
 * 断 conversationService ⇄ servantService 静态循环依赖的桥：conversationService
 * 的 isRegisteredSupervisor 需要查花名册，但 servantService 又引用
 * conversationService 做 running 标记——反向边经此模块的注入点消解。
 *
 * 模式与 servantIncidentNotifier 的 setServantInfoSource 同款（阶段2 · 5e）：
 * 服务模块只依赖本模块的纯函数；装配方（server/index.ts 启动序）注入
 * servantService.getServant。未注入时 getServantEntry 返回 null——与原先
 * catch 分支「花名册读取失败按非主管处理」的收权降级语义一致。
 *
 * 分层位置：零依赖（不 import 任何业务模块），可被 L2 领域服务安全引用。
 */

/** 花名册条目的最小结构面（结构类型，避免 import servantService 造成模块边） */
export interface ServantInfoEntry {
  sessionId: string
  supervisor?: boolean
  constraint?: 'readonly' | 'whitelist'
  writeDirs?: string[]
}

type ServantInfoLookup = (sessionId: string) => Promise<ServantInfoEntry | null>

let lookup: ServantInfoLookup | null = null

/** 启动装配：注入花名册查询源（幂等，后注入覆盖前注入） */
export function registerServantInfoSource(fn: ServantInfoLookup): void {
  lookup = fn
}

/** 测试收尾：清空注入 */
export function resetServantInfoSourceForTests(): void {
  lookup = null
}

/**
 * 查询花名册条目。未注入/查询抛错时返回 null（调用方按非主管处理——
 * 「收权是加强项，不能阻塞会话启动」的既有降级语义）。
 */
export async function getServantEntry(sessionId: string): Promise<ServantInfoEntry | null> {
  if (!lookup) return null
  try {
    return await lookup(sessionId)
  } catch {
    return null
  }
}
