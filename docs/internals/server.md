---
title: 本地 Server 与 API
nav_title: 本地 Server
description: 本地 Server 的启动参数、访问控制、REST 与 WebSocket 接口范围。
order: 2
---

# 本地 Server 与 API

本地 Server 是桌面端和 Claude CLI 之间的运行时边界。它提供 REST API、聊天 WebSocket、Provider 协议代理。打包后的桌面应用会自动管理它；只有源码开发或无界面部署才需要手工启动。

## 启动

在仓库根目录运行：

```bash
bun run src/server/index.ts
```

默认监听 `127.0.0.1:3456`。确认服务就绪：

```bash
curl http://127.0.0.1:3456/health
```

返回格式：

```json
{
  "status": "ok",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

`/health` 是启动探针，始终公开，不代表其他接口已通过认证。

## 启动参数

| 参数 | 环境变量 | 默认值 | 说明 |
|------|----------|--------|------|
| `--host <host>` | `SERVER_HOST` | `127.0.0.1` | 监听地址 |
| `--port <port>` | `SERVER_PORT` | `3456` | HTTP 和 WebSocket 端口 |
| `--cli-path <path>` | `CLAUDE_CLI_PATH` | 自动解析 | 指定 Server 拉起的 CLI |
| `--auth-required` | `SERVER_AUTH_REQUIRED=1` | 关闭 | 对能力接口强制显式鉴权 |

命令行的 host 和 port 优先于环境变量。开发时建议保留回环地址；`0.0.0.0` 只表示接受外部连接，并不会自动完成鉴权、TLS 或反向代理配置。

## 提供静态资源

源码运行时先构建桌面 Web 资源：

```bash
cd desktop
bun run build
cd ..
bun run src/server/index.ts
```

Server 会自动查找仓库的 `desktop/dist`。从其他目录启动时，用绝对路径指定构建产物：

```bash
CLAUDE_H5_DIST_DIR=/absolute/path/to/desktop/dist \
  bun run /absolute/path/to/src/server/index.ts
```

## 访问控制

Server 根据请求来源和能力路径决定是否允许访问：

| 请求 | 默认行为 |
|------|----------|
| `GET /health` | 公开，用于启动探针 |
| 直接回环请求 | 仅当客户端地址、Host 和 Origin 都是本机，且没有反向代理跟踪头时视为本机可信 |
| `--auth-required` / `SERVER_AUTH_REQUIRED=1` | 对能力接口要求显式认证 |

“连接来自 `127.0.0.1`”本身不足以证明是本机用户。反向代理必须保留公开 `Host`，或传递 `Forwarded`、`X-Forwarded-*`、`X-Real-IP`、`Via` 中至少一种，让 Server 能区分反代流量和直接回环流量。

### Token 传递

- REST、协议代理和文件接口：`Authorization: Bearer <token>`
- 浏览器 WebSocket：`/ws/<session-id>?token=<token>`

显式 `--auth-required` 模式接受与服务端 `ANTHROPIC_API_KEY` 相同的 Bearer Token，但不建议为了远程访问暴露模型密钥。

CORS 只限制浏览器读取响应，不是身份认证。非浏览器客户端不会因为 CORS 而安全。

## HTTP 接口范围

业务 REST API 位于 `/api/*`，主要覆盖：

- 会话、对话、搜索和文件系统；
- 设置、权限、模型、effort 和 Providers；
- Agents、任务和团队；
- Skills、插件和市场；
- Computer Use；
- 诊断、Doctor、活动统计、记忆和 traces。

内部 `/sdk/<session-id>` WebSocket 是 Server 为自己拉起的 Claude CLI 使用的通道，不是第三方客户端 API。

### 协作接口与任务台账

协作接口由花名册、会话消息投递和任务台账组成。台账路由为 `/api/collab-tasks`，不要与上游 CLI Task V2 的 `/api/tasks` 混淆。以下实现依据：`src/server/api/servants.ts`、`src/server/api/collabTasks.ts`；API 行为测试：`src/server/__tests__/servants.test.ts`、`src/server/__tests__/collab-tasks-api.test.ts`。

#### 花名册：`/api/servant-sessions`

| 方法与路径 | 行为 |
|---|---|
| `GET /api/servant-sessions` | 返回 `{ servants, rosterTable }`。默认只列启用成员；`?all=1` 包含未启用成员；`?forSession=<sessionId>` 仅返回与该会话同项目的成员。 |
| `PUT /api/servant-sessions/:sessionId` | 设置该会话的协作身份；请求至少应包含当前 `enabled` 值，支持更新 `role`、`description`、`supervisor` 等已定义字段。 |
| `DELETE /api/servant-sessions/:sessionId` | 移除协作身份，成功返回 `{ ok: true }`。 |

`servant-sessions` 的实现：`src/server/api/servants.ts:44-53,56-74,120-152`。员工汇报的台账解析失败时，回退到同项目主管是 CLI 针对“旧服务端无台账能力”的受限兼容行为：只有花名册明确找到恰好一名主管时才投递；0 名、多名或花名册查询失败均拒绝。该回退不代表新旧服务端混装受支持。测试：`src/server/__tests__/collab-cli-tools.test.ts:560-634`。

#### 消息投递与广播：`/api/session-messages`

| 方法与路径 | 请求与行为 |
|---|---|
| `POST /api/session-messages`（单播） | 请求 `{ targetSessionId, content, fromSessionId?, taskId?, title? }`。投递到已登记目标后返回 `201`，包含 `messageId`、目标信息；成功派活时还包含 `taskId`。成功投递的派活会在员工消息末尾追加系统汇报页脚，并以 taskId 幂等登记台账。投递成功只表示消息送达，不表示目标已经消费。 |
| `POST /api/session-messages`（广播） | 请求 `{ broadcast: true, content, fromSessionId, broadcastId? }`。对本项目启用且非主管、非发起者的员工逐个单播并逐目标建账；响应包含 `broadcastId`、`delivered`、`targets`，每个成功目标有独立 `taskId`。信箱不支持广播。 |
| `GET /api/session-messages?messageId=<id>` | 查询单条派活消费回执，返回 `{ ok, receipt }`；未知 ID 返回 404。消费回执是进程内记录。 |
| `GET /api/session-messages?targetSessionId=<id>` | 返回该目标最近最多 20 条回执 `{ ok, receipts }`。 |

收到员工汇报时，服务端按 taskId/员工未结任务解析实际派活方，并在主管交接后按同项目现任主管改投；若同一员工未结任务来自多个派活人，服务端只告警而不替员工选择。改投响应可包含 `redirectedFrom`、`resolvedBy`。系统页脚的准确文本与解析顺序见 `src/server/services/reportTargetResolver.ts:32-53,90-203`；HTTP 实现见 `src/server/api/servants.ts:203-245,281-346`；HTTP 与信箱一致性测试见 `src/server/__tests__/servants.test.ts:802-807,dispatch-mailbox.test.ts:91-125`。

广播的 `broadcastId` 仅在同一服务端进程内按 ID 串行；成功目标重试时复用已有任务结果，失败目标可重试。不同 ID 互不阻塞；未显式提供 ID 不加锁；跨进程/多实例并发幂等不保证，属计划 v1.7 的已知边界。详见下文“广播任务的 `broadcastId` 幂等边界”。实现与测试：`src/server/services/broadcastLock.ts:1-39`、`src/server/api/servants.ts:401-414,445-531`、`src/server/__tests__/servants.test.ts:1211-1355`。

#### 任务台账：`/api/collab-tasks`

| 方法与路径 | 请求与行为 |
|---|---|
| `GET /api/collab-tasks?project=<dir>&status=<status>` | 按服务端 `path.resolve` 后的项目目录及可选具体状态筛选，返回 `{ tasks, projectDir }`，按最近更新排序。`projectDir` 回显服务端实际用于过滤的解析目录。`status` 接受 `dispatched`、`accepted`、`in_progress`、`delivered`、`verified`、`rework`、`failed`、`cancelled`。 |
| `GET /api/collab-tasks?forSessionId=<id>&status=<status>` | 用会话工作目录限定项目，再按可选状态筛选；响应 `projectDir` 回显解析后的过滤目录；找不到会话工作目录返回 404。 |
| `GET /api/collab-tasks/:id` | 返回 `{ task }`；不存在返回 404。 |
| `POST /api/collab-tasks` | 显式建任务，请求需含 `fromSessionId`、`toSessionId`、`title`，并以 `project` 或可解析的 `forSessionId` 指定项目；可选 `id` 为幂等键。相同 ID 重复请求返回首次创建的任务，不覆盖原记录。返回 `{ task }`。CLI 正常派活不直接调用此端点，而走 `POST /api/session-messages` 让服务端在投递后记账。 |
| `POST /api/collab-tasks/:id/report` | 员工报告请求 `{ summary, deliverables?, callerSessionId? }`；summary 必须非空。`callerSessionId` 存在时要求其为受派员工；缺省时当前版本保持兼容，不做该身份校验。成功返回 `{ task }` 并推进为 `delivered`。 |
| `POST /api/collab-tasks/:id/review` | 验收请求 `{ verdict: "pass" | "rework", note?, callerSessionId? }`；当前 `callerSessionId` 若提供，须为原派活人或该项目现任主管。`pass` 进入 `verified`；`rework` 进入 `rework`。成功返回 `{ task }`。 |

省略 `project` 与 `forSessionId` 时维持既有行为：不按项目过滤，返回本机任务台账中的全部项目任务，响应 `projectDir: null`。此行为不是 v1.6.1 新增。实现：`src/server/api/collabTasks.ts:68-90`；测试：`src/server/__tests__/collab-tasks-api.test.ts:314-399`。另外，`project` 优先于 `forSessionId`；具体解析顺序见 `src/server/api/collabTasks.ts:74-81`。

任务状态：`dispatched` → `accepted` → `in_progress` → `delivered` → `verified`；验收返工为 `delivered` → `rework` → `in_progress`。`failed`、`cancelled` 也为终态，三种终态都没有后续状态。其他非法流转返回 `409`。对已 `verified` 任务重复提交相同 `pass` 时，HTTP 操作仍成功；CLI 工具额外返回 `already_final` 告警。对已结单任务提交其他 verdict（如 `verified` 后 rework）返回 `409`；要继续工作应重新派活。员工尚未接受/开始任务时，报告通常不可直接推进；但在 `dispatched` 状态下提交有效报告时，服务端会将其补推进至 `delivered`（详见下文）。回合开始事件将该员工会话名下的任务推进为 `accepted` 再进入 `in_progress`。依据：`src/server/services/collabTaskService.ts:471-519,643-694`；开工事件测试：`src/server/__tests__/collab-task-service.test.ts:210-238`；状态定义与正常转换：`src/server/services/collabTaskService.ts:84-108,398-453`、`src/server/__tests__/collab-task-service.test.ts:48-113`。

`accepted` / `in_progress` 表示服务端此后观察到**该员工会话**有过开工信号，不精确证明某一条具体任务自身已收到开工信号：开工事件按员工会话推进其在办任务。员工忙碌时新收到的任务可能没有收到单独的开工事件；如果员工在任务仍为 `dispatched` 时汇报，服务端会一次性补推进 `dispatched → accepted → in_progress → delivered`。补推进的前两条 history 使用固定 note「汇报时补推进：回合中途入队未收到开工信号」并标记 `by: system`；三条 history 共用同一汇报时刻，通知只推送最终 `delivered` 一次。实现：`src/server/services/collabTaskService.ts:471-519,527-582`；测试：`src/server/__tests__/collab-task-service.test.ts:355-401`。

台账按项目目录分别写入 `~/.claude/cc-heihei/tasks/<项目hash>.jsonl`，进程启动时重放；客户端生成的 taskId 同时用于派活页脚和台账幂等。依据：`src/server/services/collabTaskService.ts:13-21,145-157,285-314`；持久化与幂等测试：`src/server/__tests__/collab-task-service.test.ts:118-160`。

#### 服务端能力协商：`GET /api/whoami`

返回服务身份及 `capabilities` 字符串数组。当前协作相关能力名包括 `collab-tasks`、`report-caller-check`、`mailbox-report`、`broadcast-ledger`、`broadcast-lock`。客户端优先按能力名检测台账、callerSessionId 校验、信箱 report 及广播能力；collab-context 能力表示协作上下文快照，不属于任务台账接口。旧服务端没有 `capabilities` 时，CLI 降级探测协作台账路由是否返回“Unknown API resource”的 404。能力名只增不改；能力实现见 `src/server/services/serverIdentity.ts:37-70`，协商测试见 `src/server/__tests__/api-router.test.ts:75-99`。

#### 信任边界与限制

协作服务默认仅监听本机地址 `127.0.0.1`；对非本机访问，服务端默认按本机访问策略拒绝受保护的 `/api/*` 等能力路径。桌面默认未启用通用 `--auth-required` / `SERVER_AUTH_REQUIRED` 认证；因此同一台机器上、以同一用户权限运行的其他程序仍处于本机信任域，可直接调用本地 API 并读写协作数据。依据：`src/server/index.ts:92-103,226-231,277-285`、`src/server/localRequestPolicy.ts:281-307`。部署配置了 `CC_HEIHEI_LOCAL_ACCESS_TOKEN` 时存在可选本机访问令牌，但这不改变 `taskId` 的含义：**taskId 是任务标识符，不是访问凭证**，不得据此推断任务接口存在基于 taskId 的访问控制。

`callerSessionId` 当前为可选字段：`POST /api/collab-tasks/:id/report` 带该值时校验它是否为受派员工；`POST /api/collab-tasks/:id/review` 带该值时校验它是否为派活人或该项目现任主管；缺省时两端点都跳过调用者身份校验。`GET /api/collab-tasks`、`GET /api/collab-tasks/:id` 不做调用者身份校验，显式 `POST /api/collab-tasks` 也不校验 `fromSessionId` 的调用者身份。`/api/session-messages` 接收请求体中的 `fromSessionId` 用于协作语义，但不做进程级调用者认证。文件信箱 `report` payload 不含 `callerSessionId`，服务端代调 `reportTask` 不验证操作进程身份。依据：`src/server/api/collabTasks.ts:68-95,98-120,124-174,187-201`、`src/server/api/servants.ts:186-211`、`src/server/services/dispatchMailboxService.ts:31-49,382-414`。HTTP 调用者校验测试：`src/server/__tests__/collab-tasks-api.test.ts:79-137,142-248`。

#### 汇报 taskId 归属不符的防误投

`POST /api/session-messages` 员工汇报带有 `taskId` 时，服务端仅当该台账任务的 `toSessionId` 与发送方 `fromSessionId` 一致，才按 `taskId` 改投给记录中的派活人（`resolvedBy=task-id`）。若任务属于其他员工，不按该任务改投，记 `collab_report_task_mismatch` 诊断，并回退解析：发送方名下只有一个派活人来源时改投给该派活人；发送方名下没有未结任务时尝试同项目现任主管；若未结任务来自多个派活人，则不猜测并保留原目标。主管自己发出的消息不进入员工汇报改投解析。查不到显式 `taskId` 时记 `collab_report_task_not_found`，不按该 ID 改投，保持原有解析行为。缺失或空白 `fromSessionId` 时解析直接保留原目标、不进行改投。实现：`src/server/services/reportTargetResolver.ts:90-108,115-170,173-227`；测试：`src/server/__tests__/report-target-resolver.test.ts:103-121,123-146,148-192,194-222,224-270,272-293`。

文件信箱 `report` 字段另有台账推进前归属检查：仅当 payload 的 `fromSessionId` 与任务 `toSessionId` 一致时推进到 `delivered`；不一致（包括发送方 ID 缺失或空白）时不更新该任务，记录 `collab_report_task_mismatch`（`channel=mailbox`，发送方缺省/空白时记为 `unknown`），但仍投递汇报消息；一致时正常推进。实现：`src/server/services/dispatchMailboxService.ts:382-424`；测试：`src/server/__tests__/dispatch-mailbox.test.ts:238-290,292-350`。信箱台账归属检查与 HTTP 汇报目标解析是两项独立校验。

> 使用提示：汇报时请使用对应派活系统页脚里的 `taskId`。若抄成他人任务 ID，服务端会拒绝按该 ID 改投；该条汇报不会推进你名下的真实任务，主管验收时会因任务尚未 `delivered` 而遇到 `409`，从而暴露问题。无效或缺失的 `fromSessionId` 也不能用于信箱任务归属确认。上述逻辑是防误操作，不是访问控制；`taskId` 仍不是访问凭证。实现和测试位置同上。

计划 v1.7 将 `callerSessionId` 改为必填；若未来支持远程访问，再引入本机 API 令牌作为扩展信任边界的前置条件。依据：`src/server/api/collabTasks.ts:133-135`、`src/server/services/dispatchMailboxService.ts:41-49`、架构决策 `D:/xxw_p/cc-heihei-plan/架构决策_taskId信任边界.md:35-42`。

### `callerSessionId` 的未来兼容跟进

当前 `/api/collab-tasks/:id/report` 与 `/review` 允许请求省略 `callerSessionId`，以兼容旧调用方；带值时服务端按上文校验调用者。若 v1.7 将该字段改为必填，必须同步更新文件信箱 report payload 格式及服务端代调路径，确保携带 `callerSessionId` 或明确等价的调用身份来源，否则信箱汇报会因缺少身份而失败。此项是未来兼容待办，不改变当前接口行为。依据：`src/server/api/collabTasks.ts:133-189`、`src/server/services/dispatchMailboxService.ts:31-49,379-405`、`src/server/__tests__/collab-tasks-api.test.ts:77-137,140-248`。

### 广播任务的 `broadcastId` 幂等边界

`POST /api/session-messages` 的广播请求可带 `broadcastId`。在同一服务端进程内，服务端按 `broadcastId` 串行执行广播的幂等检查、逐目标投递和记账；后续相同 ID 的请求会跳过已成功投递的目标，并复用对应的任务结果。若前次仅部分目标成功，重试仍可处理尚未成功的目标。未提供 `broadcastId` 时不加锁；不同 ID 的广播互不阻塞。


此并发幂等保障仅限**单进程**。多个服务端进程或实例同时处理相同 ID 时，不保证共享台账上的并发幂等；这是已知边界，计划留待 v1.7 处理，不应据此依赖跨进程安全。

`/proxy/*` 是 Provider 的协议转换入口，包含运行时认证和模型路由状态。不要把它当成通用的、无状态 OpenAI 代理公开出去。

## 聊天 WebSocket

客户端连接：

```text
ws://127.0.0.1:3456/ws/<session-id>
```

常用客户端消息包括：

- `user_message`、`stop_generation`
- `permission_response`、`computer_use_permission_response`
- `set_permission_mode`、`set_runtime_config`
- `sync_state`、`prewarm_session`
- `ping`

服务端会发送连接与会话状态、文本增量、思考、工具调用与结果、权限请求、重试/降级状态、错误、任务/团队更新和 `pong`。完整字段以 `src/server/ws/events.ts` 为准。

桌面客户端每 30 秒发送一次 ping；等待 pong 10 秒后会主动重连。重连退避上限为 30 秒，并不会在固定次数后永久停止。自定义客户端应能重复连接、重新同步状态，并忽略未知的新增消息字段。

## 反向代理清单

需要对外提供服务时至少完成：

1. 使用 HTTPS，不在公开网络传输明文凭据。
2. 转发静态页面、`/api/*`、`/proxy/*` 和 `/ws/*`。
3. 为 `/ws/*` 开启 WebSocket upgrade。
4. 保留公开 Host 和标准代理头。
5. 不向公网转发内部 `/sdk/*`。

## 排查

| 现象 | 检查 |
|------|------|
| 端口无法监听 | `SERVER_PORT` 是否被占用；是否传入了有效数字 |
| API 或 WebSocket 为 `401` | Token 过期、缺失，或 WebSocket 没有 query token |
| 浏览器提示 CORS | 当前请求的精确 Origin 是否在允许列表 |
| WebSocket 反复重连 | 代理是否支持 upgrade、Token 是否传入、空闲连接是否被代理关闭 |
| 页面 `404` | 尚未构建 `desktop/dist`，或静态资源路径指向错误 |
| 远程请求被当成本机 | 反向代理是否删除了公开 Host 和全部代理跟踪头 |
