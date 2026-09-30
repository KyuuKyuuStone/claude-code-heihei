---
title: 会话协作与任务台账
nav_title: 会话协作
description: 设置主管与员工会话，使用原生工具派活、汇报、验收和返工。
order: 9
---

# 会话协作与任务台账

会话协作让一个主管会话负责拆分和验收，员工会话负责执行并汇报。v1.6.0 起，协作工具与任务台账记录贯穿派活、执行、交付和验收；状态以台账为准，而不是根据会话是否正在运行推断。

## 主管与员工

协作身份按项目工作目录隔离。每个项目可登记主管和员工：主管负责安排、验收和汇总；员工按自己的角色与特性执行任务。普通会话不注入协作工具。

主管会话可调用：

- `CollabDispatch`：派发任务。
- `CollabReview`：通过验收或要求返工。
- `CollabListTasks`：查看任务台账。

员工会话可调用：

- `CollabReport`：汇报任务。
- `CollabListTasks`：查看派给自己的任务。员工没有派活或验收工具。

这些工具按协作身份注入：主管有 3 个、员工有 2 个、普通会话没有协作工具。角色与注入规则可在 `src/collaboration/collabToolContract.ts:31-73` 查看，并由 `src/server/__tests__/collab-cli-tools.test.ts:782-851` 验证。

## 典型工作流程

### 1. 主管派活

主管先按项目花名册中的角色与特性选择员工，再调用：

```text
CollabDispatch({
  to: "员工 sessionId 或唯一角色名",
  title: "可选标题",
  content: "背景、交付内容和验收条件"
})
```

同名角色有歧义时使用员工 `sessionId`。通常不传 `taskId`，工具会生成并返回任务 ID；只有返工重发或幂等重试才复用原 `taskId`。派活正文无需写回邮地址，服务端会在消息末尾追加系统页脚，包含任务 ID 与唯一有效的完工汇报目标。员工汇报时按该页脚目标操作；页脚缺失或不可读时应停止并通知派活方，不要猜测收件人。服务端还会按台账解析和修正汇报目标。实现与测试：`src/tools/CollabTools/CollabDispatchTool.ts:37-49`、`src/server/services/reportTargetResolver.ts:32-53`、`src/server/__tests__/servants.test.ts:802-807`。

### 2. 员工执行并汇报

员工处理任务后调用：

```text
CollabReport({
  taskId: "派活返回的任务 ID",
  summary: "结论与验证证据",
  deliverables: ["产出文件路径"]
})
```

如果省略 `taskId`，工具仅在员工名下有唯一未结任务时自动选择；有多个候选时会列出候选并要求指定，不会猜。汇报会先尝试将台账推进到 `delivered`，再投递给派活方；主管交接后，服务端可按当前项目主管解析改投。接口、目标解析依据：`src/tools/CollabTools/CollabReportTool.ts:170-203,245-258`、`src/server/services/reportTargetResolver.ts:12-24,149-196`。

### 3. 主管验收或返工

员工汇报后，主管用返回或台账中的 `taskId` 调用：

```text
CollabReview({ taskId: "任务 ID", verdict: "pass" })
```

通过验收后任务进入 `verified`。需要返工时提供说明：

```text
CollabReview({ taskId: "任务 ID", verdict: "rework", note: "补充缺少的测试" })
```

工具会向原员工发送同一任务的返工消息，不创建新的台账任务。员工重新开始后可继续执行并再次汇报。只有 `delivered` 任务可由主管验收；状态尚未推进到交付时，工具会返回 `not_reviewable`。`rework` 必须填写 `note`。证据：`src/tools/CollabTools/CollabReviewTool.ts:38-49`、`src/server/__tests__/collab-cli-tools.test.ts:638-681`。

### 4. 查看台账

```text
CollabListTasks({ status: "open", limit: 20 })
```

不传过滤条件默认按最近更新顺序查看摘要。`status: "open"` 包含 `dispatched`、`accepted`、`in_progress`、`rework`、`delivered`。员工只能看到派给自己的任务。指定 `taskId` 可读取该任务正文和汇报全文。工具输入与实现：`src/tools/CollabTools/CollabListTasksTool.ts:35-48`、`src/collaboration/collabToolContract.ts:75-113`。

## 任务状态

| 状态 | 含义 |
|---|---|
| `dispatched` | 派活消息已投递并创建台账记录，尚未观察到员工开始处理。 |
| `accepted` | 服务端观察到该员工会话有开工信号；不精确对应某一条具体任务。 |
| `in_progress` | 服务端观察到该员工会话有开工信号并将相关在办任务推进；不精确对应某一条具体任务。 |
| `delivered` | 员工已提交汇报。 |
| `rework` | 主管要求返工，等待员工重新处理。 |
| `verified` | 主管验收通过，终态。 |
| `failed` | 任务标记失败，终态。 |
| `cancelled` | 任务已取消，终态。 |

正常路径为 `dispatched → accepted → in_progress → delivered → verified`。返工路径为 `delivered → rework → in_progress → delivered`，之后主管可以再次验收。`verified`、`failed`、`cancelled` 没有后续状态；已验收通过的任务不能退回 `rework`，如需继续工作应重新派活。状态定义与转换见 `src/server/services/collabTaskService.ts:35-43,84-108`，测试见 `src/server/__tests__/collab-task-service.test.ts:48-105`。

`accepted` / `in_progress` 表示服务端此后观察到**该员工会话**有过开工信号，不精确证明某一条具体任务自身已收到开工信号。员工忙碌时收到的新任务可能仍为 `dispatched`；若员工在此状态下汇报，服务端会在同一汇报时刻补推进 `dispatched → accepted → in_progress → delivered`。台账 history 的前两条补推进记录 note 固定为「汇报时补推进：回合中途入队未收到开工信号」，并记 `by: system`；三条共用同一汇报时刻，只推送最终 `delivered` 一次。实现：`src/server/services/collabTaskService.ts:471-519,527-582,643-694`；测试：`src/server/__tests__/collab-task-service.test.ts:210-238,355-401`。

以上是**台账层**的记录语义。**面板层**只显示状态徽标，因此此类任务可能从「待接单」直接跳到「已交付」；面板详情不渲染一般 history 条目，不会显示补推进说明。面板实现：`desktop/src/pages/CollabTasks.tsx:15-24,169-183,188-205`。详情见[任务面板限制说明](#限制与注意事项)。 

## 广播派活

主管或非员工会话可对本项目所有启用员工广播。每个员工都会得到独立 `taskId` 和任务记录；`broadcastId` 用于关联一次广播产生的任务。相同 `broadcastId` 的并发请求只在同一服务端进程中串行并复用已成功目标，不能据此依赖跨进程或多实例幂等。测试见 `src/server/__tests__/servants.test.ts:1169-1355`。

## 离线与文件信箱

当服务不可用时，`CollabDispatch` 和 `CollabReport` 可将 JSON 写入项目目录的 `.heihei/dispatch/`，服务恢复后由桌面服务消费。派活 payload 保留相同 `taskId`，重试时可幂等记账；汇报 payload 可携带 `report` 内容，服务端先更新台账再投递消息。接口实现：`src/tools/CollabTools/CollabDispatchTool.ts:115-166`、`src/tools/CollabTools/CollabReportTool.ts:119-158,207-212`、`src/server/services/dispatchMailboxService.ts:379-405`。

工具返回 `queued` 只代表 payload 已排入信箱，不代表员工已经收到或开始处理；不要因此重复派发或重复汇报。`Review` 是验收操作，`ListTasks` 是读取操作，两者不可达时会如实报错，不使用信箱代替。文件信箱不支持广播，广播应使用 HTTP 或逐个派发。测试见 `src/server/__tests__/collab-cli-tools.test.ts:427-449,542-558,692-704`、`src/server/__tests__/dispatch-mailbox.test.ts:127-160`。

新 CLI 连接旧版、无协作台账能力的服务端属于非支持场景：派活/汇报可能只能投递消息而没有台账；旧服务端回退汇报时，只有同项目花名册能确定唯一主管才投递，无法确定则安全拒绝。验收与台账列表需要新服务端。能力协商和回退细节见[本地 Server 与 API](../internals/server.md#协作接口与任务台账)，工具旧服务端测试见 `src/server/__tests__/collab-cli-tools.test.ts:401-409,560-634`。

## 限制与注意事项

- 协作服务默认仅限本机 `127.0.0.1` 使用，不做进程级鉴权；本机以同一用户权限运行的程序可读写协作数据。`taskId` 只是任务标识，不是访问凭证，请勿将它当作权限或访问控制。依据：`src/server/index.ts:92-103,226-231,277-285`、`src/server/localRequestPolicy.ts:281-307`。汇报误投防护细节见下方 taskId 使用说明。
- `broadcastId` 并发锁是进程内机制，多进程/多实例共享台账的并发幂等不保证。
- 对已 `verified` 的任务重复提交相同 `pass` 返回成功并附 `already_final`；对已结单任务提交其他验收结果（如对已通过任务要求返工）返回 `409`。终态任务没有出边，需要继续工作时重新派活。接口测试见 `src/server/__tests__/collab-cli-tools.test.ts:683-690`、状态转换测试见 `src/server/__tests__/collab-task-service.test.ts:85-105`。
- 任务处于 `dispatched` 时，员工的有效汇报可由服务端补推进至 `delivered`；其他报告身份或内容不符合要求时仍会被拒绝。补推进与归属校验：`src/server/services/collabTaskService.ts:471-519`、`src/server/api/collabTasks.ts:124-174`；测试：`src/server/__tests__/collab-task-service.test.ts:355-401`、`src/server/__tests__/collab-tasks-api.test.ts:402-455`。CLI 对特定冲突的一次重试见 `src/server/__tests__/collab-cli-tools.test.ts:490-524`。
- 汇报时请使用对应派活系统页脚中的 `taskId`，不要从正文或旧消息猜测。若误抄成他人任务 ID，HTTP 汇报不会按该 ID 改投；系统先尝试从你名下未结任务确定派活人，无未结任务时再尝试同项目主管，多个派活人来源时不猜并保留原目标。信箱汇报不会推进他人任务，但消息仍会投递。你的真实任务不会因此推进为 `delivered`，主管验收时会因未交付遇到 `409`。这是误操作防护，不是访问控制。实现/测试：`src/server/services/reportTargetResolver.ts:115-170,208-227`、`src/server/__tests__/report-target-resolver.test.ts:103-146,224-270`、`src/server/services/dispatchMailboxService.ts:382-424`、`src/server/__tests__/dispatch-mailbox.test.ts:238-290`。若 `taskId` 在台账中查不到，单独记录 `collab_report_task_not_found`，不按 taskId 改投且不触发他人任务回退；缺失/空白 `fromSessionId` 时 HTTP 不改投，信箱不推进台账、仍投递消息并把发送方记为 `unknown`。主管自己发消息不按员工汇报解析。实现/测试：`src/server/services/reportTargetResolver.ts:90-106,137-146`、`src/server/__tests__/report-target-resolver.test.ts:172-222,272-293`、`src/server/__tests__/dispatch-mailbox.test.ts:292-350`。具体行为见[Server API 文档](../internals/server.md#协作接口与任务台账)。
- **任务面板限桌面端**：协作任务台账面板通过桌面运行时的标签栏按钮打开；浏览器移动端选择非会话页签时会切回已有会话页签，若没有会话则回到空白/对话入口。依据：`desktop/src/components/layout/TabBar.tsx:277-280`、`desktop/src/components/layout/AppShell.tsx:180-189`；移动端回退测试：`desktop/src/components/layout/AppShell.test.tsx:449-464`。
- 无活动会话且没有可用项目目录时，面板不请求台账任务列表、不猜目录查询，直接显示空态；仍会发起 `whoami` 探活以判定连接状态。服务未就绪时显示磨砂遮罩与重连提示。实现：`desktop/src/pages/CollabTasks.tsx:71-95,143-165`、`desktop/src/stores/collabTaskStore.ts:125-127,169-171`。
- 正在处理任务的员工被继续派活时，新任务在面板会先显示为「待接单」；若员工随后完成并在该任务仍为 `dispatched` 时汇报，面板状态可能直接从「待接单」跳到「已交付」。面板详情只显示需求、交付物、汇报、验收结论与返工意见，不渲染一般 history 条目，因此不会显示补推进说明。实现：`desktop/src/pages/CollabTasks.tsx:15-24,169-183,188-205`；补推进状态与 history 证据见下方任务状态说明及 `src/server/__tests__/collab-task-service.test.ts:355-401`。 
- 文件信箱不支持广播；多实例下的 `broadcastId` 幂等，以及新 CLI 与旧服务端混装均不在支持保证内。
