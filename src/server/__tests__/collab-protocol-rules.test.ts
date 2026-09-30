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

describe('主管协议：按花名册路由 + 辅助角色优先（v1.6.0）', () => {
  test('协议含按花名册路由规则', () => {
    expect(DISPATCH_PROTOCOL_MD).toContain('按花名册路由')
    expect(DISPATCH_PROTOCOL_MD).toContain('description')
    expect(DISPATCH_PROTOCOL_MD).toContain('禁止自己做')
  })

  test('协议含辅助角色优先硬约束与三类角色的路由', () => {
    expect(DISPATCH_PROTOCOL_MD).toContain('辅助角色优先')
    expect(DISPATCH_PROTOCOL_MD).toContain('架构师')
    expect(DISPATCH_PROTOCOL_MD).toContain('设计师')
    expect(DISPATCH_PROTOCOL_MD).toContain('代码审查')
    // 兜底出口必须显式声明：仅当花名册无该角色，且要向用户写明是自拟
    expect(DISPATCH_PROTOCOL_MD).toContain('花名册无')
    expect(DISPATCH_PROTOCOL_MD).toContain('本方案由主管自拟')
  })

  test('协议含省 token 规则', () => {
    expect(DISPATCH_PROTOCOL_MD).toContain('省 token')
    expect(DISPATCH_PROTOCOL_MD).toContain('不深读代码')
  })

  test('协议明确系统临时目录放行（v1.6.0）', () => {
    expect(DISPATCH_PROTOCOL_MD).toContain('系统临时目录')
    // 不放行判定解释的细节——那是实现细节，写进协议只会误导模型
    expect(DISPATCH_PROTOCOL_MD).not.toContain('父目录')
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

  test('六个行业的路由表都在，行数与源稿一致', () => {
    const md = DISPATCH_PROTOCOL_MD
    // 行数取自源稿实测（软件开发 17、小说 6、其余各 5），不是凭印象写的 16/5
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

  test('辅助角色优先补充测试与技术文档，兜底出口仍要求写明缺失依据', () => {
    const aux = DISPATCH_PROTOCOL_MD.slice(DISPATCH_PROTOCOL_MD.indexOf('### 辅助角色优先'))
    expect(aux).toContain('测试')
    expect(aux).toContain('技术文档')
    expect(aux).toContain('花名册无')
  })

  test('验收与汇总要求并入通用规则（无两套说法）', () => {
    const general = DISPATCH_PROTOCOL_MD.slice(DISPATCH_PROTOCOL_MD.indexOf('### 通用'))
    expect(general).toContain('对照任务完成条件核实证据')
    expect(general).toContain('已证实的结论')
    // 源稿「主管默认职责」的同一要求不应在别处重复出现
    expect(DISPATCH_PROTOCOL_MD.match(/对照任务完成条件核实证据/g)).toHaveLength(1)
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
    // 描述里的换行被压平，表格行数不因此增加
    const dataRows = table.split('\n').filter((line) => line.startsWith('| ') && !line.includes('---'))
    expect(dataRows).toHaveLength(2) // 表头 + 1 行数据
  })

  test('未设角色时给出占位文字', () => {
    expect(renderRosterTable([{ sessionId: 'x' }])).toContain('未设角色')
  })
})
