/**
 * 会话投递缝（G2 收官 · B-b 批）。
 *
 * 动机：三家 L2 服务（`dispatchMailboxService` / `servantStallWatcher` /
 * `supervisorProtocolNotice`）都静态 import `./sessionMessenger.js`（L3）取 `deliver`
 * ⇒ 三条 `layer-L2-no-upward` 存量违规。三者要的是**同一个能力**（把一条消息投给某会话、
 * 返回是否送达），故共用这一条缝，而不是各自复制一份同形接缝。
 *
 * 与 `registerServantIncidentDeliver`（R2b 为 servantIncidentNotifier 单独立的同能力缝）
 * 的关系：那条是单消费者、留原地不动；本条服务这三家多消费者 ⇒ 共用。
 *
 * 依赖方向保持**单向**：本模块不 import 任何模块（连 sessionMessenger 也不）。
 * 装配根 `server/index.ts` 启动序注册；**缺注册 ⇒ 首次投递即抛错（fail-fast）**，
 * 不静默丢弃（静默会让"派活/重推/协议升级"三条链路一起哑掉且无痕迹）。
 */

export type SessionDeliverFn = (
  targetSessionId: string,
  content: string,
  serverHost: string,
) => Promise<boolean>

let deliverFn: SessionDeliverFn | null = null

/** 装配根注入（生产）：`server/index.ts` 启动序调用。 */
export function registerSessionDelivery(fn: SessionDeliverFn): void {
  deliverFn = fn
}

/** 测试注入（传 null 复位为「未装配」）。 */
export function setSessionDeliveryForTests(fn: SessionDeliverFn | null): void {
  deliverFn = fn
}

/**
 * 取投递函数；未装配 ⇒ 抛错（fail-fast）。调用点须**延迟**调用（放在默认 deps 的
 * 具名函数体内，不要在模块加载期求值），否则单测 import 即炸。
 */
export function requireSessionDelivery(): SessionDeliverFn {
  if (!deliverFn) {
    throw new Error(
      'sessionDelivery: 投递未装配 —— 装配根 server/index.ts 缺少 registerSessionDelivery 调用',
    )
  }
  return deliverFn
}
