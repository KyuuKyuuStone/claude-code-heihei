import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  buildRosterChangeNotice,
  detectRosterChange,
  notifySupervisorsOfRosterChange,
  setRosterChangeNoticeDeps,
} from '../services/rosterChangeNotice.js'

// v1.7.5：员工被删除 / 取消员工身份 / 降级为普通会话 / 角色变更 ⇒ 通知同项目
// 主管（否则主管的 B2 花名册摘要会过期，继续给失效目标派活）。
// **2026-10-10 裁决**：不再要求主管「正在运行」——一律投递，未加载者由 deliver 拉起。
//
// 依赖走注入缝（同 setSupervisorNoticeDeps 形态，禁 mock.module）。
// **判红点**：删掉 servants.ts 里的 detectRosterChange 分支或本模块的投递循环，
// 本文件与 servants.test.ts 的对应用例必红。

afterEach(() => {
  setRosterChangeNoticeDeps(null)
  mock.restore()
})

const PROJ = 'C:\\proj\\a'

function makeDeps(overrides: Record<string, unknown> = {}) {
  const events: Array<Record<string, unknown>> = []
  return {
    events,
    deps: {
      getServerPort: () => 53100,
      // 默认：被变更会话的 workDir 可解析（项目 = PROJ）
      getSessionWorkDir: async () => PROJ,
      recordEvent: (input: Record<string, unknown>) => {
        events.push(input)
      },
      ...overrides,
    },
  }
}

/** 主管桩：默认同项目（PROJ）且正在运行 */
function sup(sessionId: string, over: Record<string, unknown> = {}) {
  return { sessionId, supervisor: true, enabled: true, running: true, workDir: PROJ, ...over }
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

  test('加入：首次登记 / 重新启用 ⇒ added（2026-10-09 用户拍板恢复通知）', () => {
    expect(detectRosterChange(undefined, { enabled: true, role: '前端' })).toBe('added')
    expect(detectRosterChange(null, { enabled: true })).toBe('added')
    expect(detectRosterChange({ enabled: false }, { enabled: true })).toBe('added')
  })

  test('无实质变化 ⇒ null（不通知）', () => {
    expect(detectRosterChange({ enabled: true, role: '前端' }, { enabled: true, role: '前端' })).toBeNull()
    // 未在册时改角色不算（不产生派活认知问题）
    expect(detectRosterChange({ enabled: false, role: '前端' }, { enabled: false, role: '后端' })).toBeNull()
  })

  test('已存在在册员工改角色 ⇒ role_changed，**不是** added', () => {
    expect(detectRosterChange({ enabled: true, role: '前端' }, { enabled: true, role: '后端' })).toBe(
      'role_changed',
    )
    // 首次登记同时带角色：added 优先于 role_changed（旧状态无名可改）
    expect(detectRosterChange(undefined, { enabled: true, role: '前端' })).toBe('added')
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
  test('五种变化各自说清「谁 / 什么变化 / 该不该派活」', () => {
    const added = buildRosterChangeNotice({ sessionId: 's1', kind: 'added', role: '前端', description: '画界面' })
    expect(added).toContain('已加入花名册')
    expect(added).toContain('可以给它派活')
    expect(added).toContain('s1')

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
      sup('sup-1'),
      { sessionId: 'emp-1', supervisor: false, enabled: true, running: true, workDir: PROJ },
      sup('sup-other', { workDir: 'C:\\proj\\b' }), // 别的项目 ⇒ 不打扰
    ])
    const { deps } = makeDeps({ listServants: listMock as never, deliver: deliverMock as never })
    setRosterChangeNoticeDeps(deps as never)

    await notifySupervisorsOfRosterChange({ sessionId: 'emp-1', kind: 'removed', role: '前端' })

    // 裁决②：不再借 listServants({forSessionId})（workDir 未知时会退化为不过滤），
    // 改为自解析 workDir + sameProject 显式过滤
    expect(listMock).toHaveBeenCalledWith({ includeAll: true })
    expect(deliverMock).toHaveBeenCalledTimes(1)
    expect(deliverMock.mock.calls[0][0]).toBe('sup-1')
    expect(deliverMock.mock.calls[0][1]).toContain('已被移除')
    expect(deliverMock.mock.calls[0][2]).toBe('127.0.0.1:53100')
  })

  test('裁决②：workDir 解析不到 ⇒ 不通知（宁少通知不错通知），记 no-workdir 诊断', async () => {
    const deliverMock = mock(async () => true)
    const listMock = mock(async () => [sup('sup-1')])
    const { deps, events } = makeDeps({
      getSessionWorkDir: async () => null,
      listServants: listMock as never,
      deliver: deliverMock as never,
    })
    setRosterChangeNoticeDeps(deps as never)

    await notifySupervisorsOfRosterChange({ sessionId: 'emp-1', kind: 'removed' })

    expect(deliverMock).not.toHaveBeenCalled()
    expect(listMock).not.toHaveBeenCalled() // 解析不到就直接收手，不读花名册
    const skipped = events.filter((e) => e.type === 'roster_change_notice_skipped')
    expect(skipped).toHaveLength(1)
    expect((skipped[0]!.details as { reason?: string }).reason).toBe('no-workdir')
  })

  test('裁决②：显式传入 workDir 时不再二次解析（DELETE 复用已查值）', async () => {
    const deliverMock = mock(async () => true)
    const workDirMock = mock(async () => null)
    const { deps } = makeDeps({
      getSessionWorkDir: workDirMock as never,
      listServants: async () => [sup('sup-1')] as never,
      deliver: deliverMock as never,
    })
    setRosterChangeNoticeDeps(deps as never)

    await notifySupervisorsOfRosterChange({ sessionId: 'emp-1', kind: 'removed', workDir: PROJ })

    expect(workDirMock).not.toHaveBeenCalled()
    expect(deliverMock).toHaveBeenCalledTimes(1)
  })

  test('未运行的主管照常投递（2026-10-10 裁决去掉 not-running 闸门）', async () => {
    const deliverMock = mock(async (_sessionId: string, _notice: string, _serverHost: string) => true)
    const { deps, events } = makeDeps({
      listServants: async () => [sup('sup-idle', { running: false })] as never,
      deliver: deliverMock as never,
    })
    setRosterChangeNoticeDeps(deps as never)

    await notifySupervisorsOfRosterChange({ sessionId: 'emp-1', kind: 'disabled' })

    // 花名册变更是协作状态变化 ⇒ 一律投递；未加载的主管由 deliver 自动拉起
    expect(deliverMock).toHaveBeenCalledTimes(1)
    expect(deliverMock.mock.calls[0][0]).toBe('sup-idle')
    expect(deliverMock.mock.calls[0][1]).toContain('已取消员工身份')
    // 不得再有 not-running 跳过诊断
    const skipped = events.filter((e) => e.type === 'roster_change_notice_skipped')
    expect(skipped).toHaveLength(0)
  })

  test('被变更的会话自身不会被通知（它可能仍是主管）', async () => {
    const deliverMock = mock(async () => true)
    const { deps } = makeDeps({
      listServants: async () => [sup('self')] as never,
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
      listServants: async () => [sup('sup-1')] as never,
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
