/**
 * v1.3.0 阶段4 专项：断循环依赖 + 依赖注入两态 + running 标记语义对拍 +
 * rebind 事件触发时序。
 *
 * - 7a：conversationService ⇄ servantService 环——servantService 的 running
 *   标记改读 registry 快照；conversationService.isRegisteredSupervisor 的花名册
 *   查询经 servantInfoSource 注入点（未注入 = 按非主管处理 = 原 catch 降级）。
 * - 7b：sessionMessenger → ws/handler 动态 import 删除——注入回合建立迁入
 *   messenger（injected-turn.test.ts 覆盖生命周期）；handler 订阅
 *   phase_changed(→running) 自触发 rebindClientOutputForSession。
 * - 7c 分层门禁本身由 bun run lint:layers 红绿验证（不在本文件）。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  getServantEntry,
  registerServantInfoSource,
  resetServantInfoSourceForTests,
  type ServantInfoEntry,
} from '../services/servantInfoSource.js'
import { ConversationService } from '../services/conversationService.js'
import { ServantService } from '../services/servantService.js'
import { sessionService } from '../services/sessionService.js'
import {
  markCrashed,
  markRunning,
  markStarting,
  markStopped,
  registerSession,
  resetRegistryForTests,
} from '../services/sessionRegistry.js'
import { onSessionEvent } from '../services/sessionEvents.js'

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

async function createTmpDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `claude-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function cleanupTmpDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

function restoreConfigDir(): void {
  if (originalConfigDir) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
}

describe('stage4 · 7a servantInfoSource injection contract', () => {
  beforeEach(() => {
    resetServantInfoSourceForTests()
  })

  afterEach(() => {
    resetServantInfoSourceForTests()
  })

  test('not injected → null（= 原 catch 降级：花名册不可得按非主管处理）', async () => {
    expect(await getServantEntry('any-session')).toBeNull()
  })

  test('injected → returns roster entry（主管识别可收权）', async () => {
    const entry: ServantInfoEntry = {
      sessionId: 'boss-1',
      supervisor: true,
      constraint: 'whitelist',
      writeDirs: ['C:/proj'],
    }
    registerServantInfoSource(async (id) => (id === 'boss-1' ? entry : null))
    expect(await getServantEntry('boss-1')).toEqual(entry)
    expect(await getServantEntry('other')).toBeNull()
  })

  test('injected source throws → null（降级不阻塞会话启动）', async () => {
    registerServantInfoSource(async () => {
      throw new Error('roster unavailable')
    })
    expect(await getServantEntry('any-session')).toBeNull()
  })

  test('isRegisteredSupervisor two-state: injected supervisor vs not-injected non-supervisor', async () => {
    // 每态新实例：isRegisteredSupervisor 结果有 supervisorSessionCache，
    // 同实例第二次查询会命中首次缓存，无法观察注入态切换
    const call = () => {
      const svc = new ConversationService()
      return (svc as unknown as {
        isRegisteredSupervisor: (id: string) => Promise<{
          supervisor: boolean
          registered: boolean
          servant: boolean
          constraint?: 'readonly' | 'whitelist'
          writeDirs?: string[]
        }>
      }).isRegisteredSupervisor('session-x')
    }

    // 未注入：非主管、非在册（原 catch 行为等价）
    // v1.5.0 A7：返回值新增 registered（花名册在册即协作会话，据此禁 computer-use）
    // v1.6.1：新增 servant（在册且非主管）——员工会话免审批兜底的判定依据
    expect(await call()).toEqual({ supervisor: false, registered: false, servant: false })

    // 注入主管：收权生效（constraint/writeDirs 透传）+ 在册标记
    registerServantInfoSource(async () => ({
      sessionId: 'session-x',
      supervisor: true,
      constraint: 'whitelist',
      writeDirs: ['C:/proj/src'],
    }))
    expect(await call()).toEqual({
      supervisor: true,
      registered: true,
      servant: false,
      constraint: 'whitelist',
      writeDirs: ['C:/proj/src'],
    })

    // 注入只读员工：非主管但 constraint 透传（registered=true：在册即协作会话）
    registerServantInfoSource(async () => ({
      sessionId: 'session-x',
      supervisor: false,
      constraint: 'readonly',
    }))
    expect(await call()).toEqual({
      supervisor: false,
      registered: true,
      servant: true,
      constraint: 'readonly',
    })
  })
})

describe('stage4 · 7a servantService running flag reads registry snapshot', () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    resetRegistryForTests()
  })

  afterEach(async () => {
    resetRegistryForTests()
    restoreConfigDir()
    await cleanupTmpDir(tmpDir)
  })

  test('running flag follows phase transitions（语义对拍：running/crashed/stopped/deleted）', async () => {
    const svc = new ServantService()
    const created = await sessionService.createSession(tmpDir)
    const sessionId = created.sessionId
    await svc.setServant(sessionId, { role: '后端', enabled: true })

    const readRunning = async () => {
      const list = await svc.listServants()
      const entry = (Array.isArray(list) ? list : list.servants).find(
        (s: { sessionId: string }) => s.sessionId === sessionId,
      ) as { running?: boolean } | undefined
      return entry?.running
    }

    // 未登记 → false
    expect(await readRunning()).toBe(false)

    // running → true（原 hasSession 进程级语义的 registry 对拍）
    registerSession(sessionId)
    markStarting(sessionId)
    markRunning(sessionId)
    expect(await readRunning()).toBe(true)

    // crashed → false（有活进程语义：崩溃即非 running，但不影响存在性）
    markCrashed(sessionId, { exitCode: 1 })
    expect(await readRunning()).toBe(false)

    // stopped → false
    registerSession(sessionId)
    markStarting(sessionId)
    markRunning(sessionId)
    markStopped(sessionId)
    expect(await readRunning()).toBe(false)

    // tombstone → false
    markRunning(sessionId)
    const { tombstoneSession } = await import('../services/sessionRegistry.js')
    tombstoneSession(sessionId)
    expect(await readRunning()).toBe(false)
  })
})

describe('stage4 · 7b handler rebind subscribes phase_changed(→running)', () => {
  let unsubscribe: (() => void) | null = null

  beforeEach(() => {
    resetRegistryForTests()
  })

  afterEach(() => {
    // 只退订自己的监听器。禁止 resetSessionEventsForTests：它会清空全部
    // 订阅（含 handler 模块加载时注册的 rebind 订阅），而模块缓存使订阅
    // 无法重注册——跨文件残留污染后续文件（全量套件 13 fail 根因）。
    unsubscribe?.()
    unsubscribe = null
    resetRegistryForTests()
  })

  test('phase_changed(→running) event fires on markRunning and reaches subscribers', async () => {
    // handler 模块（含 7b 订阅）加载：import 即注册，订阅器对无 WS 客户端的
    // 会话 rebind 是 no-op（bindClientSessionOutput 提前返回）——不抛错即通过
    await import('../ws/handler.js')

    const seen: Array<{ sessionId: string; to: string }> = []
    unsubscribe = onSessionEvent((e) => {
      if (e.type === 'phase_changed' && e.to === 'running') {
        seen.push({ sessionId: e.sessionId, to: e.to })
      }
    })

    registerSession('rebind-target')
    markStarting('rebind-target')
    markRunning('rebind-target')

    // rebind 触发源 = 该事件：时序上 handler 订阅器与验证监听器同源同序，
    // 事件到达即 rebind 执行（其内部对无客户端会话 no-op）。
    expect(seen).toEqual([{ sessionId: 'rebind-target', to: 'running' }])
  })
})
