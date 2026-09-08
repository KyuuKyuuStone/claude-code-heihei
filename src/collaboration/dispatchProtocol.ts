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

export const DISPATCH_PROTOCOL_MD = `## 第一步：看花名册（只看本项目的员工）

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
  "content": "【上级派活】你的角色：<员工的role>——<员工的description>（你的会话 ID：<员工sessionId>）\\n\\n任务：<背景与交付物，写清楚>\\n\\n收到后立即开始执行，先回复一句确认（如"收到，开始执行"）再干活，不要等待确认。\\n\\n完工后必须汇报，**不要用 curl 内联中文（Windows 控制台会把中文按 GBK 编码发出，服务端收到乱码）**，统一用写文件方式：用 Write 把 {\\"targetSessionId\\":\\"<主管会话ID>\\",\\"content\\":\\"【汇报】<一句话结果+产出路径>\\",\\"fromSessionId\\":\\"<你的会话ID>\\"} 写到 <工作目录>/report-payload.json，再用 Bash 执行：curl -s -X POST \\"$CC_HEIHEI_DESKTOP_SERVER_URL/api/session-messages\\" -H \\"Content-Type: application/json\\" --data-binary @report-payload.json && rm -f report-payload.json；若你的 Bash 也不可用，直接用 Write 把同样的 JSON 写到 <工作目录>/.heihei/dispatch/report-<序号>.json，服务端会自动投递。\\n汇报后任务即告结束。",
  "fromSessionId": "<你的会话ID>"
}
\`\`\`

其中 \`<你的会话ID>\` 用 \`echo $CC_HEIHEI_SESSION_ID\` 先查到再填进去。

2. 提交并删除临时文件：

\`\`\`bash
curl -s -X POST "$CC_HEIHEI_DESKTOP_SERVER_URL/api/session-messages" \\
  -H "Content-Type: application/json" \\
  --data-binary @.dispatch-payload.json && rm -f .dispatch-payload.json
\`\`\`

返回 \`{"ok":true}\` 即派活成功；返回错误就把错误内容告诉用户，不要重试同一个错误。

要点：
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

## 第三步：收汇报、判断、继续

- 员工汇报会以一条「【汇报】」消息出现在你的会话里，**收到后你必须响应**：验收结果，然后向用户总结交付，或把返工意见再用第二步派回同一个员工。
- 多件活可并行派给不同员工，也可串行：一件验收通过再派下一件。

### 假活检查（派活后 3~5 分钟主动做一次）

\`{"ok":true}\` 只代表消息**投递**成功，不代表员工真的在干活。派活几分钟后查一次花名册，用 \`lastActivityAt\`（员工会话最后一次活动时间）区分"执行中"与"假活"：

\`\`\`bash
curl -s "$CC_HEIHEI_DESKTOP_SERVER_URL/api/servant-sessions?forSession=$CC_HEIHEI_SESSION_ID"
\`\`\`

- 员工的 \`lastActivityAt\` 在派活之后有更新 = 已开工，继续等汇报；
- 一直没更新 = 员工可能卡住（工具缺失/权限等待），**发一条带排障线索的催促**，不要只施压。催促模板要点：① 用 ToolSearch 查询 \`select:Bash,Read,Write,Glob,Grep\` 精确加载核心工具（关键词搜索失效时这是唯一有效路径）；② 汇报改用文件信箱（写 JSON 到 \`.heihei/dispatch/report-<序号>.json\`）；③ 汇报命令不要内联中文。
- 员工长期（10 分钟以上）无活动且催促无回应：告知用户该员工会话可能异常，建议用户在 UI 点开该会话查看现场。

## 故障自检（派活/汇报失败时按序执行）

1. Bash 输出 \`?????\` 或命令毫无效果 = shell 不可用：放弃 curl，全程改用「文件信箱」通道（只需 Write/Read 工具）。
2. 工具找不到时（ToolSearch 报 "No matching deferred tools found"）：**关键词搜索可能失效，直接用精确名加载**——ToolSearch 查询 \`select:Bash,Read,Write,Glob,Grep,Skill\`。
3. 环境变量检查：\`$CC_HEIHEI_DESKTOP_SERVER_URL\` 与 \`$CC_HEIHEI_SESSION_ID\` 应在你的 Bash 里可用（\`echo\` 验证）。HTTP 通道依赖这两个变量；这两个值也写在你的上岗消息里。
4. 端口疑似过期时，用 Read 查看桌面服务状态文件 \`~/.claude/desktop-server-state.json\` 的 \`lastPort\` 字段取真实端口；文件信箱通道不依赖端口。
5. computer-use 系列工具在无人值守的协作会话中不可用（审批需要桌面连接）：**不要尝试**，别在这条路上浪费轮次。
6. 所有通道都失败时，明确告诉用户"协作环境异常"及失败原因，请用户在应用的「设置 → 诊断」里运行环境体检。

## 规则

- 只向花名册里 \`enabled\` 的会话派活。
- 派活内容要自包含：角色特性、背景、交付物、汇报方式都要写清，员工看不到你和用户的对话。
- 不要替员工干活；你的职责是分解、派遣、验收、继续安排。`
