import { describe, expect, test } from 'bun:test'
import { DISPATCH_PROTOCOL_MD } from '../../collaboration/dispatchProtocol.js'
import { renderRosterTable } from '../api/servants.js'

/**
 * 主管协议加强（v1.6.0，用户需求）：按花名册路由 + 辅助角色优先 + 省 token。
 *
 * 背景：用户换用便宜模型当主管后，主管不按花名册用人、且自己出技术/设计方案
 * （越权且烧 token）。用户定的硬约束：只有花名册中不存在架构师/设计师等辅助
 * 角色时，主管才可以自己出方案。
 */

describe('CLI 协议：原生协作工具与预算边界', () => {
  test('协议列出协作工具并保持职责路由', () => {
    for (const name of ['CollabDispatch', 'CollabReview', 'CollabListTasks', 'CollabReport']) {
      expect(DISPATCH_PROTOCOL_MD).toContain(name)
    }
    expect(DISPATCH_PROTOCOL_MD).toContain('仅协作会话注入工具')
    expect(DISPATCH_PROTOCOL_MD).toContain('普通会话不注入')
    expect(DISPATCH_PROTOCOL_MD).toContain('主管只负责拆解')
    expect(DISPATCH_PROTOCOL_MD).toContain('架构师')
    expect(DISPATCH_PROTOCOL_MD).toContain('设计师')
    expect(DISPATCH_PROTOCOL_MD).toContain('代码审查')
    expect(DISPATCH_PROTOCOL_MD).toContain('测试')
  })

  test('页脚是唯一汇报目标，缺失时必须停止，不得猜测', () => {
    expect(DISPATCH_PROTOCOL_MD).toContain('汇报目标唯一取该条派活页脚')
    expect(DISPATCH_PROTOCOL_MD).toContain('页脚缺失/不可读即停止并报告派活方')
    expect(DISPATCH_PROTOCOL_MD).not.toContain('照抄主管给的地址')
  })

  test('保留约 300 字手动安全兜底并锁定 UTF-8 字符预算', () => {
    const start = DISPATCH_PROTOCOL_MD.indexOf('## 安全手动兜底')
    const end = DISPATCH_PROTOCOL_MD.indexOf('## 失败处理与主管职责')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(Array.from(DISPATCH_PROTOCOL_MD.slice(start, end)).length).toBeLessThanOrEqual(650)
    expect(Array.from(DISPATCH_PROTOCOL_MD).length).toBeLessThanOrEqual(11439)
    expect(Buffer.byteLength(DISPATCH_PROTOCOL_MD, 'utf8')).toBeLessThanOrEqual(24715)
  })

  test('总量（协议 + 四个 Collab 工具的 description/prompt）不超 v1.5.1 基线 11266', async () => {
    // 预算口径（架构裁决 2026-09-30）：左 = 渲染后 DISPATCH_PROTOCOL_MD +
    // 四个 Collab 工具注入模型的 description 与 prompt 之和；右 = v1.5.1
    // DISPATCH_PROTOCOL_MD 全文 = 11266 码点（旧工具描述不存在，按 0 计）。
    // 计量统一 Array.from(text).length，非精确 tokenizer。
    // 复现：git show v1.5.1:src/collaboration/dispatchProtocol.ts，取出模板串后
    //      Array.from(串).length === 11266。常量改动须再次架构裁决。
    const V151_BASELINE_CHARS = 11266

    const { CollabDispatchTool } = await import('../../tools/CollabTools/CollabDispatchTool.js')
    const { CollabReviewTool } = await import('../../tools/CollabTools/CollabReviewTool.js')
    const { CollabListTasksTool } = await import('../../tools/CollabTools/CollabListTasksTool.js')
    const { CollabReportTool } = await import('../../tools/CollabTools/CollabReportTool.js')
    const tools = [CollabDispatchTool, CollabReviewTool, CollabListTasksTool, CollabReportTool]
    const toolChars = (
      await Promise.all(
        tools.map(async (tool) => {
          const [description, prompt] = await Promise.all([tool.description(), tool.prompt()])
          return Array.from(description).length + Array.from(prompt).length
        }),
      )
    ).reduce((sum, n) => sum + n, 0)

    const protocolChars = Array.from(DISPATCH_PROTOCOL_MD).length
    expect(protocolChars + toolChars).toBeLessThanOrEqual(V151_BASELINE_CHARS)
  })

  test('协议不引用回合态作为任务状态，也不承诺猜测性错误行为', () => {
    expect(DISPATCH_PROTOCOL_MD).not.toMatch(/turnInProgress|turnState|running\\s*=|turn state/i)
  })

  // ── D 项是用户硬要求，不得为省预算删除（架构裁决：协议瘦身与D项保留）──

  test('D 项：按花名册路由（选人依据、向用户说明、有人能做则主管禁止自己做、只派 enabled）', () => {
    const md = DISPATCH_PROTOCOL_MD
    expect(md).toContain('### 按花名册路由')
    expect(md).toContain('逐个子任务')
    expect(md).toContain('role')
    expect(md).toContain('description')
    expect(md).toContain('向用户说明')
    expect(md).toContain('花名册里有能做的员工时，禁止自己做')
    expect(md).toContain('enabled')
  })

  test('D 项：辅助角色优先是硬约束，含「员工结论冲突的裁决」与披露句', () => {
    const aux = DISPATCH_PROTOCOL_MD.slice(DISPATCH_PROTOCOL_MD.indexOf('### 辅助角色优先'))
    expect(aux).toContain('员工结论冲突的裁决')
    expect(aux).toContain('架构师')
    expect(aux).toContain('设计师')
    expect(aux).toContain('代码审查')
    expect(aux).toContain('测试')
    expect(aux).toContain('技术文档')
    // 兜底出口：只有花名册没有对应角色才可自拟，且必须写明缺哪个角色与依据
    expect(aux).toContain('花名册无')
    expect(aux).toContain('判断依据')
  })

  test('D 项：省 token（不深读代码、不跑大段排查、汇报简短）', () => {
    const md = DISPATCH_PROTOCOL_MD
    expect(md).toContain('### 省 token')
    expect(md).toContain('不深读代码')
    expect(md).toContain('不跑大段排查')
  })

  test('D 项：通用验收对照完成条件核实证据，且全文只出现一次', () => {
    expect(DISPATCH_PROTOCOL_MD).toContain('### 通用')
    expect(DISPATCH_PROTOCOL_MD).toContain('对照任务完成条件核实证据')
    expect(DISPATCH_PROTOCOL_MD.match(/对照任务完成条件核实证据/g)).toHaveLength(1)
    expect(DISPATCH_PROTOCOL_MD).toContain('已证实的结论')
  })

  test('D 项：中断与 DELETE 红线，且红线在「通用」节内', () => {
    const general = DISPATCH_PROTOCOL_MD.slice(DISPATCH_PROTOCOL_MD.indexOf('### 通用'))
    expect(general).toContain('interrupt')
    expect(general).toContain('DELETE /api/sessions/<id>')
    expect(general).toContain('不可逆')
    // Write 放行范围随报文变动迁到兜底一节，不再单列一节
    expect(DISPATCH_PROTOCOL_MD).not.toContain('主管通道：Write 收权的放行范围')
  })
})

describe('任务类型 → 应派角色路由表（v1.6.0 第 7 项，源稿 角色特性文案_v2.md）', () => {
  test('路由表位于「按花名册路由」之后', () => {
    const rosterIdx = DISPATCH_PROTOCOL_MD.indexOf('### 按花名册路由')
    const tableIdx = DISPATCH_PROTOCOL_MD.indexOf('### 任务类型 → 应派角色路由表')
    expect(rosterIdx).toBeGreaterThan(-1)
    expect(tableIdx).toBeGreaterThan(rosterIdx)
  })

  test('表头标注了「默认建议 / 以花名册为准 / 按辅助角色优先处理」', () => {
    const tableIdx = DISPATCH_PROTOCOL_MD.indexOf('### 任务类型 → 应派角色路由表')
    const head = DISPATCH_PROTOCOL_MD.slice(tableIdx, DISPATCH_PROTOCOL_MD.indexOf('#### 软件开发'))
    expect(head).toContain('默认建议')
    expect(head).toContain('实际以花名册里存在的角色为准')
    expect(head).toContain('辅助角色优先')
  })

  test('六个行业的路由表都在，行数按「任务类型 → 角色」计，与源稿一致', () => {
    const md = DISPATCH_PROTOCOL_MD
    // 行数取自源稿实测（软件开发 17、小说 6、其余各 5）；本版删去「边界与交接」列，
    // 只保留「任务类型 → 首选角色」两列，行数不变。
    const sections: Array<[string, number]> = [
      ['软件开发', 17],
      ['小说与长文写作', 6],
      ['内容运营与自媒体', 5],
      ['数据分析', 5],
      ['学术研究', 5],
      ['通用自定义', 5],
    ]
    const starts = sections.map(([name]) => md.indexOf(`#### ${name}`))
    starts.forEach((idx) => expect(idx).toBeGreaterThan(-1))
    const tableEnd = md.indexOf('### 辅助角色优先')
    sections.forEach(([, rows], i) => {
      const from = starts[i]!
      const to = i + 1 < starts.length ? starts[i + 1]! : tableEnd
      const dataRows = md
        .slice(from, to)
        .split('\n')
        .filter(
          (line) =>
            line.startsWith('| ') && !line.includes('---') && !line.includes('任务类型与可判断条件'),
        )
      expect(dataRows).toHaveLength(rows)
    })
  })
})

describe('renderRosterTable（花名册 → 表格，减少便宜模型漏看）', () => {
  test('渲染 角色 → 会话 ID → 角色特性摘要', () => {
    const table = renderRosterTable([
      { sessionId: 'aaaa-1111', role: '后端', description: '服务端开发与 API 设计' },
      { sessionId: 'bbbb-2222', role: '设计师', description: '界面/交互/视觉规范' },
    ])
    const lines = table.split('\n')
    expect(lines[0]).toContain('角色')
    expect(lines[0]).toContain('会话 ID')
    expect(lines[0]).toContain('角色特性摘要')
    expect(lines[2]).toContain('后端')
    expect(lines[2]).toContain('aaaa-1111')
    expect(lines[2]).toContain('服务端开发与 API 设计')
    expect(lines[3]).toContain('设计师')
    expect(lines[3]).toContain('bbbb-2222')
  })

  test('空花名册给出显式占位（不是空字符串）', () => {
    expect(renderRosterTable([])).toContain('花名册为空')
  })

  test('转义管道符与换行，避免破坏表格结构', () => {
    const table = renderRosterTable([
      { sessionId: 'x', role: 'a|b', description: 'line1\nline2' },
    ])
    expect(table).toContain('a\\|b')
    const dataRows = table.split('\n').filter((line) => line.startsWith('| ') && !line.includes('---'))
    expect(dataRows).toHaveLength(2)
  })

  test('未设角色时给出占位文字', () => {
    expect(renderRosterTable([{ sessionId: 'x' }])).toContain('未设角色')
  })
})

describe('净增预算：协议 + 4 个工具描述不超 v1.5.1 基线', () => {
  // 基线口径来自架构决策（架构决策_协议瘦身与D项保留.md）：比较对象是
  // 「v1.5.1 协议全文」再加 4 个工具的描述，净增 ≤ 0。计量用仓库可复现的
  // 码点（Array.from）与 UTF-8 字节数，非精确 tokenizer。
  const V151_PROTOCOL_BASELINE_CHARS = 11439
  const V151_PROTOCOL_BASELINE_BYTES = 24715
  const TOOL_PROMPTS_BUDGET_CHARS = 764

  test('协议全文不超 v1.5.1 基线（码点与 UTF-8 字节双口径）', () => {
    expect(Array.from(DISPATCH_PROTOCOL_MD).length).toBeLessThanOrEqual(V151_PROTOCOL_BASELINE_CHARS)
    expect(Buffer.byteLength(DISPATCH_PROTOCOL_MD, 'utf8')).toBeLessThanOrEqual(
      V151_PROTOCOL_BASELINE_BYTES,
    )
  })

  test('协议 + 4 工具描述合计仍不超基线', async () => {
    const { CollabDispatchTool } = await import('../../tools/CollabTools/CollabDispatchTool.js')
    const { CollabReviewTool } = await import('../../tools/CollabTools/CollabReviewTool.js')
    const { CollabListTasksTool } = await import('../../tools/CollabTools/CollabListTasksTool.js')
    const { CollabReportTool } = await import('../../tools/CollabTools/CollabReportTool.js')
    const toolPrompts = await Promise.all(
      [CollabDispatchTool, CollabReviewTool, CollabListTasksTool, CollabReportTool].map((tool) =>
        tool.prompt(),
      ),
    )
    const toolPromptChars = toolPrompts.reduce((sum, p) => sum + Array.from(p).length, 0)
    // 4 个工具描述自身也要在预留预算内，否则「净增 ≤ 0」是靠超支换来的
    expect(toolPromptChars).toBeLessThanOrEqual(TOOL_PROMPTS_BUDGET_CHARS)
    expect(Array.from(DISPATCH_PROTOCOL_MD).length + toolPromptChars).toBeLessThanOrEqual(
      V151_PROTOCOL_BASELINE_CHARS + TOOL_PROMPTS_BUDGET_CHARS,
    )
  })
})
