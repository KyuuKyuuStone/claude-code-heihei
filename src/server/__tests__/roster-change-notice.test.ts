import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  buildRosterChangeNotice,
  detectRosterChange,
  notifySupervisorsOfRosterChange,
  setRosterChangeNoticeDeps,
} from '../services/rosterChangeNotice.js'

// v1.7.5：员工被删除 / 取消员工身份 / 降级为普通会话 / 角色变更 ⇒ 通知同项目
// **正在运行**的主管（否则主管的 B2 花名册摘要会过期，继续给失效目标派活）。
//
// 依赖走注入缝（同 setSupervisorNoticeDeps 形态，禁 mock.module）。
// **判红点**：删掉 servants.ts 里的 detectRosterChange 分支或本模块的投递循环，
// 本文件与 servants.test.ts 的对应用例必红。

afterEach(() => {
  setRosterChangeNoticeDeps(null)
  mock.restore()
})

function makeDeps(overrides: Record<string, unknown> = {}) {
  const events: Array<Record<string, unknown>> = []
  return {
    events,
    deps: {
      getServerPort: () => 53100,
      recordEvent: (input: Record<string, unknown>) => {
        events.push(input)
      },
      ...overrides,
    },
  }
}

describe('detectRosterChange（跃迁判定 = 幂等闸门）', () => {
  test('取消员工身份：enabled true→false ⇒ disabled', () => {
    expect(detectRosterChange({ enabled: true }, { enabled: false })).toBe('disabled')
  })

  test('卸任主管：supervisor true→false ⇒ demoted（降级为普通会话）', () => {
    expect(detectRosterChange({ enabled: true, supervisor: true }, { enabled: true, supervisor: false })).toBe(
      'demoted',
    )
  })

  test('角色变更（仍在册）⇒ role_changed', () => {
    expect(detectRosterChange({ enabled: true, role: '前端' }, { enabled: true, role: '后端' })).toBe(
      'role_changed',
    )
  })

  test('首次登记 / 重新启用 / 无实质变化 ⇒ null（不通知）', () => {
    expect(detectRosterChange(undefined, { enabled: true, role: '前端' })).toBeNull()
    expect(detectRosterChange(null, { enabled: true })).toBeNull()
    expect(detectRosterChange({ enabled: false }, { enabled: true })).toBeNull()
    expect(detectRosterChange({ enabled: true, role: '前端' }, { enabled: true, role: '前端' })).toBeNull()
    // 未在册时改角色不算（不产生派活认知问题）
    expect(detectRosterChange({ enabled: false, role: '前端' }, { enabled: false, role: '后端' })).toBeNull()
  })

  test('优先级：取消员工 > 卸任主管 > 改角色', () => {
    expect(
      detectRosterChange(
        { enabled: true, supervisor: true, role: '前端' },
        { enabled: false, supervisor: false, role: '后端' },
      ),
    ).toBe('disabled')
    expect(
      detectRosterChange({ enabled: true, supervisor: true, role: '前端' }, { enabled: true, supervisor: false, role: '后端' }),
    ).toBe('demoted')
  })
})

describe('buildRosterChangeNotice', () => {
  test('四种变化各自说清「谁 / 什么变化 / 别再派活」', () => {
    const removed = buildRosterChangeNotice({ sessionId: 's1', kind: 'removed', role: '前端', description: '画界面' })
    expect(removed).toContain('已被移除')
    expect(removed).toContain('不要再给它派活')
    expect(removed).toContain('s1')

    const disabled = buildRosterChangeNotice({ sessionId: 's1', kind: 'disabled', role: '前端' })
    expect(disabled).toContain('取消员工身份')
    expect(disabled).toContain('不再受理派活')

    const demoted = buildRosterChangeNotice({ sessionId: 's1', kind: 'demoted', role: '主管' })
    expect(demoted).toContain('卸任主管')
    expect(demoted).toContain('降级为普通会话')

    const roleChanged = buildRosterChangeNotice({
      sessionId: 's1',
      kind: 'role_changed',
      role: '后端',
      previousRole: '前端',
    })
    expect(roleChanged).toContain('前端')
    expect(roleChanged).toContain('后端')
  })
})

describe('notifySupervisorsOfRosterChange', () => {
  test('投递给同项目正在运行的主管；地址用真实端口', async () => {
    const deliverMock = mock(async (_t: string, _c: string, _h: string) => true)
    const listMock = mock(async () => [
      { sessionId: 'sup-1', supervisor: true, enabled: true, running: true },
      { sessionId: 'emp-1', supervisor: false, enabled: true, running: true },
    ])
    const { deps } = makeDeps({ listServants: listMock as never, deliver: deliverMock as never })
    setRosterChangeNoticeDeps(deps as never)

    await notifySupervisorsOfRosterChange({ sessionId: 'emp-1', kind: 'removed', role: '前端' })

    // 项目隔离经 forSessionId 透传（花名册按 workDir 过滤）
    expect(listMock).toHaveBeenCalledWith({ includeAll: true, forSessionId: 'emp-1' })
    expect(deliverMock).toHaveBeenCalledTimes(1)
    expect(deliverMock.mock.calls[0][0]).toBe('sup-1')
    expect(deliverMock.mock.calls[0][1]).toContain('已被移除')
    expect(deliverMock.mock.calls[0][2]).toBe('127.0.0.1:53100')
  })

  test('未运行的主管不被拉起，只记跳过诊断', async () => {
    const deliverMock = mock(async () => true)
    const { deps, events } = makeDeps({
      listServants: async () => [{ sessionId: 'sup-idle', supervisor: true, enabled: true, running: false }] as never,
      deliver: deliverMock as never,
    })
    setRosterChangeNoticeDeps(deps as never)

    await notifySupervisorsOfRosterChange({ sessionId: 'emp-1', kind: 'disabled' })

    expect(deliverMock).not.toHaveBeenCalled()
    const skipped = events.filter((e) => e.type === 'roster_change_notice_skipped')
    expect(skipped).toHaveLength(1)
    expect((skipped[0]!.details as { change?: string }).change).toBe('disabled')
  })

  test('被变更的会话自身不会被通知（它可能仍是主管）', async () => {
    const deliverMock = mock(async () => true)
    const { deps } = makeDeps({
      listServants: async () => [{ sessionId: 'self', supervisor: true, enabled: true, running: true }] as never,
      deliver: deliverMock as never,
    })
    setRosterChangeNoticeDeps(deps as never)

    await notifySupervisorsOfRosterChange({ sessionId: 'self', kind: 'disabled' })
    expect(deliverMock).not.toHaveBeenCalled()
  })

  test('无主管 ⇒ 不投递', async () => {
    const deliverMock = mock(async () => true)
    const { deps } = makeDeps({ listServants: async () => [] as never, deliver: deliverMock as never })
    setRosterChangeNoticeDeps(deps as never)
    await notifySupervisorsOfRosterChange({ sessionId: 'emp-1', kind: 'removed' })
    expect(deliverMock).not.toHaveBeenCalled()
  })

  test('投递抛错 / 花名册读失败 ⇒ 都不冒泡（通知是体验项）', async () => {
    const { deps: throwingDeliver } = makeDeps({
      listServants: async () => [{ sessionId: 'sup-1', supervisor: true, enabled: true, running: true }] as never,
      deliver: (async () => {
        throw new Error('boom')
      }) as never,
    })
    setRosterChangeNoticeDeps(throwingDeliver as never)
    await expect(
      notifySupervisorsOfRosterChange({ sessionId: 'emp-1', kind: 'removed' }),
    ).resolves.toBeUndefined()

    const { deps: throwingList } = makeDeps({
      listServants: (async () => {
        throw new Error('roster down')
      }) as never,
    })
    setRosterChangeNoticeDeps(throwingList as never)
    await expect(
      notifySupervisorsOfRosterChange({ sessionId: 'emp-1', kind: 'removed' }),
    ).resolves.toBeUndefined()
  })
})
