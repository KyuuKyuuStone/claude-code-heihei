import { registerBundledSkill } from '../bundledSkills.js'
import {
  DISPATCH_PROTOCOL_MD,
  WORK_ORCHESTRATOR_SKILL_NAME,
} from '../../collaboration/dispatchProtocol.js'

export function registerWorkOrchestratorSkill(): void {
  // 协议正文来自共享模块：桌面服务端的主管履新消息在技能不可用时内联同一份文本，
  // 两边文案必须保持一致（见 src/collaboration/dispatchProtocol.ts）。
  const SKILL_PROMPT = `# 会话协作（主管模式）

你是主管会话。用户只对你下命令，你负责把活派给"员工会话"（被标记为"服务其他会话"的会话，各自有角色与角色特性，如后端/前端/绘画师），并接收它们的汇报。

两个环境变量（都已在你的 Bash 里可用）：
- \`\$CC_HEIHEI_DESKTOP_SERVER_URL\` — 本机 API 根地址
- \`\$CC_HEIHEI_SESSION_ID\` — **你自己的会话 ID**（回邮地址，派活时必须用它，不要用别的变量）

${DISPATCH_PROTOCOL_MD}`

  registerBundledSkill({
    name: WORK_ORCHESTRATOR_SKILL_NAME,
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
