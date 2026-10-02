/**
 * 测试夹具：**起得来、但永不建立 SDK 连接**的假 CLI（v1.7.2 裁决二十一④ 用例专用）。
 *
 * 用途：验证「CLI 进程活着 + SDK 未连上」时的收口语义——
 *   · 3s 竞速先返回 ⇒ 不得宣称成功、不得 markRunning，phase 保持 starting；
 *   · 子预算到点 ⇒ 记 cli_start_unconfirmed（warn）。
 *
 * 故意**忽略 --sdk-url**：不连 sidecar（真实缺陷里 CLI 拨了不可达地址正是这种形态）。
 * 由 MOCK_SDK_IDLE_HOLD_MS 控制存活时长，缺省 60s，足够测试收尾时被 stopSession 杀掉。
 */
const holdMs = Number(process.env.MOCK_SDK_IDLE_HOLD_MS || '60000')
setTimeout(() => process.exit(0), Number.isFinite(holdMs) && holdMs > 0 ? holdMs : 60000)
// 保持事件循环存活（否则进程会因无待处理任务而退出，落进「启动期退出」分支）
setInterval(() => {}, 1000)
