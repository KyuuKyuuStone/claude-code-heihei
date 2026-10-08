import { afterEach, describe, expect, test } from 'bun:test'
import {
  appendRosterDigestIfSupervisor,
  formatRosterDigest,
  ROSTER_DIGEST_MARK,
  setRosterDigestDepsForTests,
  type RosterDigestEntry,
} from '../services/rosterDigest.js'
import { setDiagnosticsLogWriterForTests } from '../../utils/diagLogs.js'

/** v1.7.4 B2：给在册主管的注入消息捎带花名册摘要（只对主管、幂等、插在页脚之前）。 */

const sup: RosterDigestEntry = { sessionId: 'sup-1', supervisor: true, enabled: true }
const emp = (role: string, i = 0): RosterDigestEntry => ({ sessionId: `emp-${role}-${i}`, role, enabled: true })

function withRoster(entries: RosterDigestEntry[]) {
  setRosterDigestDepsForTests({ listServants: async () => entries })
}
afterEach(() => {
  setRosterDigestDepsForTests(null)
  setDiagnosticsLogWriterForTests(null)
})

describe('rosterDigest（B2）', () => {
  test('① 出现位置：主管注入⇒摘要落在正文之后；非主管⇒原样不注入', async () => {
    withRoster([sup, emp('前端'), emp('后端')])
    const out = await appendRosterDigestIfSupervisor('sup-1', '帮我看看进度')
    expect(out.startsWith('帮我看看进度')).toBe(true)
    expect(out.endsWith(`${ROSTER_DIGEST_MARK}主管 1 人；员工 2 人：前端、后端`)).toBe(true)
    // 员工侧不注入
    expect(await appendRosterDigestIfSupervisor('emp-前端-0', '干活')).toBe('干活')
    // 未在册会话不注入
    expect(await appendRosterDigestIfSupervisor('nobody', 'x')).toBe('x')
  })

  test('② 超 8 截断：只列前 8 个 role + 「等 N 人」（N = role 总数）', async () => {
    const roles = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10']
    withRoster([sup, ...roles.map((r) => emp(r))])
    const out = await appendRosterDigestIfSupervisor('sup-1', 'x')
    expect(out).toContain('员工 10 人：r1、r2、r3、r4、r5、r6、r7、r8等 10 人')
    expect(out).not.toContain('r9')
  })

  test('③ 空册形态：员工 0 人（暂无可用员工）', async () => {
    withRoster([sup])
    expect(formatRosterDigest([sup])).toBe(`${ROSTER_DIGEST_MARK}主管 1 人；员工 0 人（暂无可用员工）`)
    const out = await appendRosterDigestIfSupervisor('sup-1', '有人吗')
    expect(out).toContain('员工 0 人（暂无可用员工）')
  })

  test('④ 与页脚共存：页脚仍是**最后一个非空行**（摘要插在它之前）', async () => {
    withRoster([sup, emp('后端')])
    const withFooter = '派活正文\n\n任务 ID：abc-123；完工汇报目标：sup-1；\n'
    const out = await appendRosterDigestIfSupervisor('sup-1', withFooter)
    const lines = out.split('\n')
    const nonEmpty = lines.filter((l) => l.trim())
    expect(nonEmpty[nonEmpty.length - 1]).toContain('任务 ID：abc-123')
    // 摘要必须出现在页脚之前
    expect(out.indexOf(ROSTER_DIGEST_MARK)).toBeLessThan(out.indexOf('任务 ID：abc-123'))
  })

  test('⑤ 幂等：正文已含摘要⇒不重复追加', async () => {
    withRoster([sup, emp('前端')])
    const once = await appendRosterDigestIfSupervisor('sup-1', 'hi')
    expect(await appendRosterDigestIfSupervisor('sup-1', once)).toBe(once)
  })

  test('⑥ 花名册读失败 ⇒ 降级不阻塞：原样送达 + 留痕（不静默）', async () => {
    const logs: Array<{ level: string; event: string; data: Record<string, unknown> }> = []
    setDiagnosticsLogWriterForTests((level, event, data) => {
      logs.push({ level, event, data })
    })
    setRosterDigestDepsForTests({
      listServants: async () => {
        throw new Error('roster read boom')
      },
    })

    const original = '派活正文\n\n任务 ID：abc-123；完工汇报目标：sup-1；'
    const out = await appendRosterDigestIfSupervisor('sup-1', original)
    // 降级：一字不改、不含摘要、页脚仍是最后非空行（投递不被阻塞）
    expect(out).toBe(original)
    expect(out).not.toContain(ROSTER_DIGEST_MARK)
    // 留痕：warn 级 + 明确事件名 + 可诊断的错误信息
    const hit = logs.find((l) => l.event === 'roster_digest_list_failed')
    expect(hit).toBeTruthy()
    expect(hit?.level).toBe('warn')
    expect(hit?.data.error).toBe('roster read boom')
  })
})
