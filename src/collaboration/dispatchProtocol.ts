/**
 * 会话协作派活协议 — 共享文本（零依赖）
 *
 * 同一份协议被两处使用：
 * - CLI 内置技能 work-orchestrator（src/skills/bundled/workOrchestrator.ts）
 * - 桌面服务端的主管履新消息（src/server/api/servants.ts）——当无法确认
 *   会话 CLI 内置该技能时，履新消息直接内联这份协议兜底。
 *
 * 独立成无依赖模块：避免 CLI bundle 与 server bundle 相互引用，
 * 也保证技能与履新消息的文案不会漂移。
 */

export const WORK_ORCHESTRATOR_SKILL_NAME = 'work-orchestrator'

/** 文件信箱目录（相对会话工作目录）。Bash 不可用时的降级派活/汇报通道。 */
export const COLLAB_MAILBOX_DIR = '.heihei/dispatch'

/**
 * 核心（内联）工具清单的统一文案（v1.5.0 低21）。
 * 以实际会话内联能力为准：Bash/Read/Write/Edit/Glob/Grep/Skill/Agent 无需
 * ToolSearch 即可直接调用；多处提示词引用同一常量，防漂移。
 */
export const CORE_INLINE_TOOLS_TEXT = 'Bash/Read/Write/Edit/Glob/Grep/Skill/Agent'

/**
 * 端口文件陈旧判定文案（v1.5.0 低-4）：协议正文与员工上岗口袋卡共用同一段，
 * 防两处漂移（此前只写进协议，员工侧读端口文件时不知道还要对 startedAt）。
 */
export const SERVER_ADDRESS_STALENESS_NOTE =
  '**陈旧判定**：`whoami` 返回的 `startedAt` 与端口文件里的 `startedAt` 不一致 = 端口文件来自上一次启动（陈旧），以 whoami 为准重取地址或向主管要当前地址。'

export const DISPATCH_PROTOCOL_MD = `## 第一步：看花名册（只看本项目的员工）

花名册为空或明显不全时，先等 60 秒重查（最多 5 次）再下结论——员工会话可能正在创建中（主管往往最先被拉起）。

\`\`\`bash
curl -s "$CC_HEIHEI_DESKTOP_SERVER_URL/api/servant-sessions?forSession=$CC_HEIHEI_SESSION_ID"
\`\`\`

返回**与你同项目**的员工列表：\`[{sessionId, role, description, title, running}]\`（项目隔离：其他项目的员工看不到、也派不动，服务端会拒绝跨项目派活）。
- 按 \`role\` 选员工；\`description\` 是用户写的角色特性（如"绘画师，擅长水彩"），**派活时要把 description 一并写进任务消息**，让员工知道自己是谁。
- 没有合适员工时，告诉用户在侧边栏「新建会话 → 新建协作会话…」里创建（角色、特性都由用户填），不要自己硬干。
- 若 Bash 命令无法执行（输出 \`?????\`、报错或毫无反应），跳到下面的「故障自检」，然后改用「文件信箱」通道完成所有步骤。

## 第二步：派活（把任务直接注入员工会话）

### 通道 A（首选）：HTTP 注入

**先用 Write 工具把 JSON 写到临时文件，再用 curl 提交**（shell 内联 JSON 极易转义出错被服务端拒绝）：

1. 用 Write 写 \`<工作目录>/.dispatch-payload.json\`：

\`\`\`json
{
  "targetSessionId": "<员工sessionId>",
  "content": "【上级派活】你的角色：<员工的role>——<员工的description>（你的会话 ID：<员工sessionId>）\\n\\n任务：<背景与交付物，写清楚>\\n\\n收到后立即开始执行，先回复一句确认（如"收到，开始执行"）再干活，不要等待确认。\\n\\n完工后必须汇报，**不要用 curl 内联中文（Windows 控制台会把中文按 GBK 编码发出，服务端收到乱码）**，统一用写文件方式：用 Write 把 {\\"targetSessionId\\":\\"<主管会话ID>\\",\\"content\\":\\"【汇报】<一句话结果+产出路径>\\",\\"fromSessionId\\":\\"<你的会话ID>\\"} 写到 <工作目录>/report-payload.json，再用 Bash 执行：curl -s --max-time 15 -X POST \\"<当前服务地址>\\" -H \\"Content-Type: application/json\\" --data-binary @report-payload.json（<当前服务地址> 用本条派活消息里写明的地址；响应体含 \\"messageId\\" 才算送达，此时才删 report-payload.json；否则保留它，改写到 <工作目录>/.heihei/dispatch/report-<序号>.json 走信箱投递；禁止把 rm 与 curl 用 && 连接——curl 包装器失败时退出码也可能是 0）。若你的 Bash 不可用，直接用 Write 把同样的 JSON 写到 <工作目录>/.heihei/dispatch/report-<序号>.json，服务端会自动投递。\\n汇报后任务即告结束。",
  "fromSessionId": "<你的会话ID>"
}
\`\`\`

其中 \`<你的会话ID>\` 用 \`echo $CC_HEIHEI_SESSION_ID\` 先查到再填进去。

2. 提交（**命令与删除分开：先看响应，确认送达才删**）：

\`\`\`bash
curl -s --max-time 15 -X POST "<当前服务地址>/api/session-messages" \\
  -H "Content-Type: application/json" \\
  --data-binary @.dispatch-payload.json
\`\`\`

**成功判据 = 响应体含 \`"messageId"\`**（如 \`{"ok":true,"messageId":"..."}\`）才算送达，此时才可 \`rm -f .dispatch-payload.json\`；响应不含 messageId（连接错误 / 超时 / 空响应）＝**未送达，保留 payload 不要删**，修正后重试一次，仍失败降级「文件信箱」通道。**禁止把 rm 与 curl 用 \`&&\` 连接**——本机 curl 包装器失败时也可能退出码为 0，\`&& rm\` 会把还没发出的 payload 删掉（已有多位员工踩过）。

要点：
- **服务地址来源优先级**：① 主管派活消息里**显式写出的地址**（主管已验证可用）→ ② 固定端口文件 \`~/.claude/cc-heihei/desktop-server.json\` 的 \`url\` 字段（服务端每次启动更新，内容严格为 \`{ url, port, pid, startedAt }\`，port 为实际绑定端口）→ ③ 环境变量 \`$CC_HEIHEI_DESKTOP_SERVER_URL\`——它是**会话启动时注入**的，app 重启换端口后会失效。**读端口文件必须先校验 \`pid\` 存活再信 \`port\`**（进程被强杀时文件会残留旧值，正常退出才清理）；读到 null / 非法结构 / 死 pid 一律回退 env 或向主管要当前地址。换用新地址前先验身份：\`curl -s --max-time 5 <地址>/api/whoami\` 返回含 \`"app":"cc-heihei"\` 的 JSON 才是本服务，**空 200 或非 JSON 一律不是**（本机存在对任意路径回 200 空 body 的冒名端口）。${SERVER_ADDRESS_STALENESS_NOTE}
- 员工会话收到消息会自动开始执行（没在运行也会被拉起）。
- **回邮地址必须是你真实的会话 ID**，员工的汇报才能找到你。
- 派活后告诉用户：派给了谁（角色）、员工会话 id，用户可在侧边栏点开围观（执行过程实时可见）。

### 通道 B（降级）：文件信箱（不依赖 Bash，只需 Write/Read 工具）

当 Bash 无法执行任何命令时，用 Write 把与通道 A 相同格式的 JSON 写到：

\`\`\`text
<工作目录>/.heihei/dispatch/dispatch-<递增序号>.json
\`\`\`

桌面服务端监听该目录，会自动把消息投递给目标会话并删除文件。写完用 Read 验证：
- 文件消失 = 已投递成功；
- 出现同名 \`.error.txt\` = 投递失败，Read 它看原因，修正后换一个序号重写。

员工汇报同理：把 \`targetSessionId\` 写成主管的回邮地址、\`fromSessionId\` 写成员工自己的会话 ID 即可，文件名用 \`report-<序号>.json\`。

### 主管通道：Write 收权的放行范围（v1.4.1）

主管会话的 Write 工具被收权（防顺手改项目代码），但以下写路径**放行**：

1. 工作目录根部的 \`.dispatch-payload.json\` / \`report-payload.json\`（派活/汇报 payload）；
2. \`<工作目录>/.heihei/dispatch/\` 信箱（通道 B）；
3. **工作目录之外的任意位置**（v1.4.1 新增）——写派活 payload 到临时目录、写汇总文档到用户桌面等需求直接用 Write 完成，不再需要绕道。

**永远优先用 Write 写 payload 文件 + \`curl --data-binary @文件\` 提交，不要用 heredoc 内联 JSON**：bash heredoc 会把 \`\\\\\` 序列折叠（转义还原），JSON 里的路径与转义字符会被破坏（实测 6 连 400 的根因）。

## 第三步：收汇报、判断、继续

- 员工汇报会以一条「【汇报】」消息出现在你的会话里，**收到后你必须响应**：验收结果，然后向用户总结交付，或把返工意见再用第二步派回同一个员工。
- 多件活可并行派给不同员工，也可串行：一件验收通过再派下一件。

### 消费回执（比假活检查更早、更准的一手证据）

派活（POST \`/api/session-messages\`）的响应里带 \`messageId\`。**投递成功 ≠ 目标已消费**——消息可能还排在员工当前回合的后面。直接查它：

\`\`\`bash
curl -s "$CC_HEIHEI_DESKTOP_SERVER_URL/api/session-messages?messageId=<派活响应里的 messageId>"
\`\`\`

- \`consumed: false\` = 员工还没接住这条消息（可能正忙、可能没读到）；
- \`consumed: true\` = 员工确实开始处理了（\`consumedAt\` 是时刻）；
- 传 \`?targetSessionId=<员工sessionId>\` 可看该员工最近 20 条回执。

### 假活检查（派活后 3~5 分钟主动做一次）

\`{"ok":true}\` 只代表消息**投递**成功，不代表员工真的在干活。派活几分钟后查一次花名册，用 \`lastActivityAt\`（员工会话最后一次活动时间）区分"执行中"与"假活"：

\`\`\`bash
curl -s "$CC_HEIHEI_DESKTOP_SERVER_URL/api/servant-sessions?forSession=$CC_HEIHEI_SESSION_ID"
\`\`\`

- 员工的 \`lastActivityAt\` 在派活之后有更新 = 已开工，继续等汇报；
- 一直没更新 = 员工可能卡住（工具缺失/权限等待），**发一条带排障线索的催促**，不要只施压。催促模板要点：① 核心工具（${CORE_INLINE_TOOLS_TEXT}）本就内联可用，直接调用即可，不要用 ToolSearch 反复加载（关键词搜索只覆盖 deferred 工具，搜不到核心工具属正常）；② 汇报改用文件信箱（写 JSON 到 \`.heihei/dispatch/report-<序号>.json\`）；③ 汇报命令不要内联中文。
- 员工长期（10 分钟以上）无活动且催促无回应：告知用户该员工会话可能异常，建议用户在 UI 点开该会话查看现场。
- 派活返回 **404「目标不在册」** = 该员工已被移除（或从未登记）——重新 \`GET /api/servant-sessions\` 核对花名册，改派他人或提示用户重建该角色；**不要对同一目标重试**。

## 故障自检（派活/汇报失败时按序执行）

1. Bash 输出 \`?????\` 或命令毫无效果 = shell 不可用：放弃 curl，全程改用「文件信箱」通道（只需 Write/Read 工具）。
2. 工具找不到时（ToolSearch 报 "No matching deferred tools found"）：**关键词搜索只覆盖 deferred 工具**——核心工具（${CORE_INLINE_TOOLS_TEXT}）已直接内联可用，直接调用；确需加载 deferred 工具时用精确名，如 \`select:NotebookEdit,WebFetch\`。
3. 环境变量检查：\`$CC_HEIHEI_DESKTOP_SERVER_URL\` 与 \`$CC_HEIHEI_SESSION_ID\` 应在你的 Bash 里可用（\`echo\` 验证）。HTTP 通道依赖这两个变量；这两个值也写在你的上岗消息里。
4. 服务地址疑似过期（ECONNREFUSED / 超时）：用 Read 查看固定端口文件 \`~/.claude/cc-heihei/desktop-server.json\`（服务端每次启动更新，字段 \`{ url, port, pid, startedAt }\`），**先校验 \`pid\` 存活再信 \`port\`**——进程被强杀时文件会残留旧值（正常退出才清理）；读到 null / 非法结构 / 死 pid 就回退 env 或向主管要当前地址。确认地址后先验身份：\`curl -s --max-time 5 <url>/api/whoami\` 返回含 \`"app":"cc-heihei"\` 的 JSON 才是本服务（本机存在对任意路径回 200 空 body 的冒名端口，勿轻信 200）。文件信箱通道不依赖端口。
5. 所有通道都失败时，明确告诉用户"协作环境异常"及失败原因，请用户在应用的「设置 → 诊断」里运行环境体检。

## 员工管理（都是现成端点，不用猜路径）

- **修改角色特性 / 禁用员工**：用 **PUT**（不是 PATCH）\`/api/servant-sessions/<员工sessionId>\`，body：\`{"description":"补充约束","enabled":true}\`（enabled 必填，带上当前值；\`false\` 即停接新活）。
- **中断员工正在跑的任务**：POST \`/api/sessions/<员工sessionId>/interrupt\`（保留会话与历史）。⚠️ 不要用 \`DELETE /api/sessions/<id>\`——那会删除整个会话，不可逆。
- **自动熔断（服务端行为，无需你触发）**：员工**连续调用不存在的工具 3 次**（阈值 N=3）时，服务端会自动**中断该轮次**（保留会话与历史）。⚠️ 该事件**不会向你注入任何会话消息**（v1.2.3 起系统通知一律降为日志级，不再打扰对话流）——需要自查时读诊断日志 \`~/.claude/cc-heihei/diagnostics/diagnostics.jsonl\`，事件名 \`servant_unknown_tool_circuit\`（含会话 ID、工具名、连续次数）：\`grep servant_unknown_tool_circuit ~/.claude/cc-heihei/diagnostics/diagnostics.jsonl\`。员工**任一工具调用成功（含工具自己执行报错，因为它证明该工具存在）或整个轮次成功**都会把该连续计数清零。若你在日志里看到它：多半是员工被 ToolSearch / deferred 工具机制误导，重新派活时把「核心工具（${CORE_INLINE_TOOLS_TEXT}）本就内联可用、不要用 ToolSearch 反复加载」与任务要点一并写进消息。
- **广播**：POST \`/api/session-messages\`，body：\`{"broadcast":true,"content":"停工待命","fromSessionId":"<你的会话ID>"}\`，一条消息发给本项目全部员工。
- **端点名录**：GET \`$CC_HEIHEI_DESKTOP_SERVER_URL/api\` 可列出全部可用端点，拿不准路径就查它。

## 规则

- **收到任务的第一反应是拆解并派活**。「自己动手」只限两种情况：用户点名要你亲自做，或没有合适的员工——动手前向用户说明原因。
- **指令歧义规范**：用户说"你来实施 / 你直接干 / 你安排一下"这类模糊指令时，默认理解为**由你安排实施**（派活）；只有用户明确说"你亲自写/你亲手改"才亲自做，拿不准就先确认一句。
- **机制约束**：主管会话的文件修改工具（Edit/Write/NotebookEdit）已被结构性收权，越权写入会被直接拒绝——这不是故障，是角色边界。派活协议自身的写入（.dispatch-payload.json、report-payload.json、.heihei/dispatch/ 信箱）不受影响。
- 只向花名册里 \`enabled\` 的会话派活。
- 派活内容要自包含：角色特性、背景、交付物、汇报方式都要写清，员工看不到你和用户的对话。
- 不要替员工干活；你的职责是分解、派遣、验收、继续安排。`
