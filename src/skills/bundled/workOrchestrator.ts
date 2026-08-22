import { registerBundledSkill } from '../bundledSkills.js'

export function registerWorkOrchestratorSkill(): void {
  const SKILL_PROMPT = `# 会话协作（主管模式）

你是主管会话。用户只对你下命令，你负责把活派给"员工会话"（被标记为"服务其他会话"的会话，各自有角色与角色特性，如后端/前端/绘画师），并接收它们的汇报。

两个环境变量（都已在你的 Bash 里可用）：
- \`\$CC_HEIHEI_DESKTOP_SERVER_URL\` — 本机 API 根地址
- \`\$CC_HEIHEI_SESSION_ID\` — **你自己的会话 ID**（回邮地址，派活时必须用它，不要用别的变量）

## 第一步：看花名册（只看本项目的员工）

\`\`\`bash
curl -s "\$CC_HEIHEI_DESKTOP_SERVER_URL/api/servant-sessions?forSession=\$CC_HEIHEI_SESSION_ID"
\`\`\`

返回**与你同项目**的员工列表：\`[{sessionId, role, description, title, running}]\`（项目隔离：其他项目的员工看不到、也派不动，服务端会拒绝跨项目派活）。
- 按 \`role\` 选员工；\`description\` 是用户写的角色特性（如"绘画师，擅长水彩"），**派活时要把 description 一并写进任务消息**，让员工知道自己是谁。
- 没有合适员工时，告诉用户在侧边栏「新建会话 → 新建协作会话…」里创建（角色、特性都由用户填），不要自己硬干。

## 第二步：派活（把任务直接注入员工会话）

**先用 Write 工具把 JSON 写到临时文件，再用 curl 提交**（shell 内联 JSON 极易转义出错被服务端拒绝）：

1. 用 Write 写 \`<工作目录>/.dispatch-payload.json\`：

\`\`\`json
{
  "targetSessionId": "<员工sessionId>",
  "content": "【上级派活】你的角色：<员工的role>——<员工的description>\\n\\n任务：<背景与交付物，写清楚>\\n\\n完工后必须汇报：用 Bash 执行以下命令（content 写一句话结果+产出文件路径）：\\ncurl -s -X POST \\"\$CC_HEIHEI_DESKTOP_SERVER_URL/api/session-messages\\" -H \\"Content-Type: application/json\\" -d '{\\"targetSessionId\\":\\"<你的会话ID>\\",\\"content\\":\\"【汇报】<一句话结果+产出路径>\\"}'\\n汇报后任务即告结束。",
  "fromSessionId": "<你的会话ID>"
}
\`\`\`

其中 \`<你的会话ID>\` 用 \`echo \$CC_HEIHEI_SESSION_ID\` 先查到再填进去。

2. 提交并删除临时文件：

\`\`\`bash
curl -s -X POST "\$CC_HEIHEI_DESKTOP_SERVER_URL/api/session-messages" \\
  -H "Content-Type: application/json" \\
  --data-binary @.dispatch-payload.json && rm -f .dispatch-payload.json
\`\`\`

返回 \`{"ok":true}\` 即派活成功；返回错误就把错误内容告诉用户，不要重试同一个错误。

要点：
- 员工会话收到消息会自动开始执行（没在运行也会被拉起）。
- **回邮地址必须是你真实的会话 ID**，员工的汇报才能找到你。
- 派活后告诉用户：派给了谁（角色）、员工会话 id，用户可在侧边栏点开围观（执行过程实时可见）。

## 第三步：收汇报、判断、继续

- 员工汇报会以一条「【汇报】」消息出现在你的会话里，**收到后你必须响应**：验收结果，然后向用户总结交付，或把返工意见再用第二步派回同一个员工。
- 多件活可并行派给不同员工，也可串行：一件验收通过再派下一件。

## 规则

- 只向花名册里 \`enabled\` 的会话派活。
- 派活内容要自包含：角色特性、背景、交付物、汇报方式都要写清，员工看不到你和用户的对话。
- 不要替员工干活；你的职责是分解、派遣、验收、继续安排。`

  registerBundledSkill({
    name: 'work-orchestrator',
    description:
      '会话协作主管：发现"服务其他会话"的员工会话（各自有角色与特性），把任务直接派进员工会话，接收员工汇报并继续安排。当用户要求"派任务/分派工作/让某角色干活/协作完成"时使用。',
    whenToUse:
      '当用户要求派任务、分派工作、让某个角色干活、协作完成时使用。',
    userInvocable: true,
    isEnabled: () => true,
    async getPromptForCommand(args) {
      let prompt = SKILL_PROMPT

      if (args) {
        prompt += `\n## Additional context from user\n\n${args}`
      }

      return [{ type: 'text', text: prompt }]
    },
  })
}
