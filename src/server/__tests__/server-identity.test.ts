import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  DESKTOP_SERVER_INFO_FILENAME,
  clearDesktopServerInfo,
  desktopServerInfoDir,
  desktopServerInfoPath,
  getServerIdentity,
  isPidAlive,
  readDesktopServerInfo,
  writeDesktopServerInfo,
} from '../services/serverIdentity.js'

/**
 * 端口自发现 + 身份探活（v1.4.0 阶段1-A ①②）。
 *
 * 端口文件的路径与字段是对外契约（员工侧读取方按它实现自发现），这里的测试
 * 锁住：写/读往返、无效内容拒绝、清理、陈旧识别（pid 判活）与 whoami 身份。
 * 全部经 home 参数注入临时目录，绝不触碰真实 ~/.claude。
 */

async function makeTmpHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-server-id-'))
}

describe('desktop-server.json port discovery', () => {
  // v1.5.0：端口文件写/清受 CC_HEIHEI_DESKTOP_SIDECAR 门控——只有桌面 app
  // 拉起的正式 sidecar 才允许占用槽位。本组测试覆盖「有标记」的正常路径。
  let originalMarker: string | undefined
  beforeEach(() => {
    originalMarker = process.env.CC_HEIHEI_DESKTOP_SIDECAR
    process.env.CC_HEIHEI_DESKTOP_SIDECAR = '1'
  })
  afterEach(() => {
    if (originalMarker === undefined) delete process.env.CC_HEIHEI_DESKTOP_SIDECAR
    else process.env.CC_HEIHEI_DESKTOP_SIDECAR = originalMarker
  })
  test('write then read round-trips url/port/pid/startedAt', async () => {
    const home = await makeTmpHome()
    try {
      await writeDesktopServerInfo(63451, { home })
      const info = await readDesktopServerInfo({ home })

      expect(info).not.toBeNull()
      expect(info?.url).toBe('http://127.0.0.1:63451')
      expect(info?.port).toBe(63451)
      expect(info?.pid).toBe(process.pid)
      // startedAt 是 ISO8601（可被 Date 解析且无损回写）
      expect(Number.isNaN(Date.parse(info?.startedAt ?? ''))).toBe(false)
      expect(new Date(info?.startedAt ?? '').toISOString()).toBe(info?.startedAt)
      // 文件落在契约路径 <home>/.claude/cc-heihei/desktop-server.json
      const raw = await fs.readFile(desktopServerInfoPath(home), 'utf-8')
      expect(JSON.parse(raw)).toMatchObject({ port: 63451, pid: process.pid })
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test('read returns null when the file does not exist', async () => {
    const home = await makeTmpHome()
    try {
      expect(await readDesktopServerInfo({ home })).toBeNull()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test('read returns null on corrupt JSON', async () => {
    const home = await makeTmpHome()
    try {
      await fs.mkdir(desktopServerInfoDir(home), { recursive: true })
      await fs.writeFile(path.join(desktopServerInfoDir(home), DESKTOP_SERVER_INFO_FILENAME), '{not json', 'utf-8')
      expect(await readDesktopServerInfo({ home })).toBeNull()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test('read rejects structurally invalid payloads (bad/missing port)', async () => {
    const home = await makeTmpHome()
    try {
      const dir = desktopServerInfoDir(home)
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, DESKTOP_SERVER_INFO_FILENAME)

      await fs.writeFile(file, JSON.stringify({ url: 'http://127.0.0.1:1', port: 'not-a-number', pid: 1, startedAt: 'x' }), 'utf-8')
      expect(await readDesktopServerInfo({ home })).toBeNull()

      await fs.writeFile(file, JSON.stringify({ url: 'http://127.0.0.1:70000', port: 70000, pid: 1, startedAt: 'x' }), 'utf-8')
      expect(await readDesktopServerInfo({ home })).toBeNull()

      await fs.writeFile(file, JSON.stringify({}), 'utf-8')
      expect(await readDesktopServerInfo({ home })).toBeNull()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test('clear removes the file so readers fall back (stale-file hygiene)', async () => {
    const home = await makeTmpHome()
    try {
      await writeDesktopServerInfo(12345, { home })
      expect(await readDesktopServerInfo({ home })).not.toBeNull()

      await clearDesktopServerInfo({ home })
      expect(await readDesktopServerInfo({ home })).toBeNull()

      // 幂等：再清一次不抛
      await clearDesktopServerInfo({ home })
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  // ── v1.5.0 C3：清理的 pid 归属校验 + 写入原子性 ──
  test('clear only removes a file written by THIS process (C3)', async () => {
    const home = await makeTmpHome()
    try {
      const dir = desktopServerInfoDir(home)
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, DESKTOP_SERVER_INFO_FILENAME)

      // 别的（正整数）pid 写的文件：不许删（多实例/接力启动的后来者不能被清掉）
      await fs.writeFile(
        file,
        JSON.stringify({ url: 'http://127.0.0.1:1', port: 1, pid: process.pid + 1, startedAt: 'x' }),
        'utf-8',
      )
      await clearDesktopServerInfo({ home })
      expect(await readDesktopServerInfo({ home })).not.toBeNull()

      // 自己的文件：照删
      await writeDesktopServerInfo(12345, { home })
      await clearDesktopServerInfo({ home })
      expect(await readDesktopServerInfo({ home })).toBeNull()

      // 坏文件（解析不出 pid）：照删（防永久残留误导读取方）
      await fs.writeFile(file, '{not json', 'utf-8')
      await clearDesktopServerInfo({ home })
      expect(await readDesktopServerInfo({ home })).toBeNull()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  // ── v1.5.0 低-2：启动写入前清扫死进程留下的陈旧 tmp ──
  test('sweeps stale .tmp files from dead pids on write (low-2)', async () => {
    const home = await makeTmpHome()
    try {
      const dir = desktopServerInfoDir(home)
      await fs.mkdir(dir, { recursive: true })
      const staleTmp = path.join(dir, `${DESKTOP_SERVER_INFO_FILENAME}.2147483647.tmp`)
      const garbageTmp = path.join(dir, `${DESKTOP_SERVER_INFO_FILENAME}.notapid.tmp`)
      await fs.writeFile(staleTmp, '{"partial"', 'utf-8')
      await fs.writeFile(garbageTmp, '{"partial"', 'utf-8')

      await writeDesktopServerInfo(12345, { home })

      // 死 pid 的残留被清；非法 pid 名的 tmp 不在清扫范围（保守：只清可判定的）
      await expect(fs.access(staleTmp)).rejects.toThrow()
      expect(await fs.readFile(garbageTmp, 'utf-8')).toBe('{"partial"')
      // 写入本身正常：端口文件落盘、无 .tmp 残留（自己的 tmp 已被 rename 消费）
      expect((await readDesktopServerInfo({ home }))?.port).toBe(12345)
      const leftovers = (await fs.readdir(dir)).filter((entry) => entry.endsWith('.tmp'))
      expect(leftovers).toEqual([`${DESKTOP_SERVER_INFO_FILENAME}.notapid.tmp`])
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test('write is atomic: no .tmp residue, final file always complete JSON (C3)', async () => {
    const home = await makeTmpHome()
    try {
      await writeDesktopServerInfo(12345, { home })
      const entries = await fs.readdir(desktopServerInfoDir(home))
      expect(entries).toContain(DESKTOP_SERVER_INFO_FILENAME)
      expect(entries.some((entry) => entry.includes('.tmp'))).toBe(false)
      // 内容完整可解析
      const parsed = JSON.parse(await fs.readFile(desktopServerInfoPath(home), 'utf-8'))
      expect(parsed.port).toBe(12345)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})

describe('stale-file detection via pid liveness', () => {
  test('reports the current process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true)
  })

  test('reports a pid that cannot exist as dead', () => {
    // 2^31-1 远超 Windows/POSIX 常见 pid 上限：进程不存在 → ESRCH → false
    expect(isPidAlive(2147483647)).toBe(false)
  })

  test('rejects non-positive and non-integer pids', () => {
    expect(isPidAlive(0)).toBe(false)
    expect(isPidAlive(-1)).toBe(false)
    expect(isPidAlive(Number.NaN)).toBe(false)
    expect(isPidAlive(1.5)).toBe(false)
  })
})

describe('getServerIdentity (whoami payload)', () => {
  test('identifies the app with version, pid and ISO startedAt', () => {
    const identity = getServerIdentity()
    expect(identity.app).toBe('cc-heihei')
    // v1.5.0 C3：version 改从 desktop/package.json（真实版本）或 env
    // CC_HEIHEI_APP_VERSION 解析——不再依赖打包 sidecar 下读不到的仓库根
    // package.json（那会返回 unknown）。此处断言非空且非 unknown。
    expect(identity.version.length).toBeGreaterThan(0)
    expect(identity.version).not.toBe('unknown')
    // 与真实版本源一致性（env 未注入时等于 desktop/package.json 的 version）
    if (!process.env.CC_HEIHEI_APP_VERSION) {
      const desktopPkg = JSON.parse(
        readFileSync(new URL('../../../desktop/package.json', import.meta.url), 'utf-8'),
      ) as { version: string }
      expect(identity.version).toBe(desktopPkg.version)
    }
    expect(identity.pid).toBe(process.pid)
    expect(Number.isNaN(Date.parse(identity.startedAt))).toBe(false)
    // 端口文件与 whoami 同源：两次取值 startedAt 不变（模块加载时定格）
    expect(getServerIdentity().startedAt).toBe(identity.startedAt)
  })
})

/**
 * v1.5.0：端口文件槽位门控。
 *
 * 事故背景（2026-09-29 实测）：测试套件里 startServer(0) 的用例（conversations /
 * tasks）会拉起非服务的服务端实例，它覆盖了 ~/.claude/cc-heihei/desktop-server.json，
 * 把正在服务的桌面 app 从端口文件上挤掉；测试进程退出后文件残留，所有按契约
 * 读文件的员工先撞死地址（ECONNREFUSED）。修法：只有带 CC_HEIHEI_DESKTOP_SIDECAR=1
 * 标记的正式 sidecar 才写/清，其它进程一律只读。
 */
describe('desktop-server.json slot gate (sidecar marker)', () => {
  let originalMarker: string | undefined
  beforeEach(() => {
    originalMarker = process.env.CC_HEIHEI_DESKTOP_SIDECAR
    delete process.env.CC_HEIHEI_DESKTOP_SIDECAR
  })
  afterEach(() => {
    if (originalMarker === undefined) delete process.env.CC_HEIHEI_DESKTOP_SIDECAR
    else process.env.CC_HEIHEI_DESKTOP_SIDECAR = originalMarker
  })

  test('without the marker, write is a no-op (non-sidecar instance cannot claim the slot)', async () => {
    const home = await makeTmpHome()
    try {
      await writeDesktopServerInfo(63451, { home })

      // 文件不得出现
      expect(await readDesktopServerInfo({ home })).toBeNull()
      await expect(fs.readFile(desktopServerInfoPath(home), 'utf-8')).rejects.toThrow()
      // 连 tmp 残留也不该有
      const dir = desktopServerInfoDir(home)
      const entries = await fs.readdir(dir).catch(() => [] as string[])
      expect(entries.filter((e) => e.startsWith(DESKTOP_SERVER_INFO_FILENAME))).toEqual([])
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test('with the marker set, write does claim the slot', async () => {
    const home = await makeTmpHome()
    try {
      // 先由「正式 sidecar」写，再用无标记进程尝试覆盖 → 覆盖必须失败
      process.env.CC_HEIHEI_DESKTOP_SIDECAR = '1'
      await writeDesktopServerInfo(11111, { home })
      expect((await readDesktopServerInfo({ home }))?.port).toBe(11111)

      delete process.env.CC_HEIHEI_DESKTOP_SIDECAR
      await writeDesktopServerInfo(22222, { home })
      expect((await readDesktopServerInfo({ home }))?.port).toBe(11111)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test('without the marker, clear is a no-op (non-sidecar cannot delete the live slot)', async () => {
    const home = await makeTmpHome()
    try {
      process.env.CC_HEIHEI_DESKTOP_SIDECAR = '1'
      await writeDesktopServerInfo(33333, { home })
      delete process.env.CC_HEIHEI_DESKTOP_SIDECAR

      await clearDesktopServerInfo({ home })
      expect((await readDesktopServerInfo({ home }))?.port).toBe(33333)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test('isDesktopSidecarProcess reflects the env marker', async () => {
    const mod = await import('../services/serverIdentity.js')
    delete process.env.CC_HEIHEI_DESKTOP_SIDECAR
    expect(mod.isDesktopSidecarProcess()).toBe(false)
    process.env.CC_HEIHEI_DESKTOP_SIDECAR = '1'
    expect(mod.isDesktopSidecarProcess()).toBe(true)
    process.env.CC_HEIHEI_DESKTOP_SIDECAR = '0'
    expect(mod.isDesktopSidecarProcess()).toBe(false)
  })

  // ── v1.6.0：端口文件被非正式实例覆盖的事故（2026-09-30 死实例 pid 5264 覆盖在用的 18908）──

  test('自愈：文件被已死进程覆盖后，巡检把它夺回', async () => {
    const mod = await import('../services/serverIdentity.js')
    const home = await makeTmpHome()
    try {
      // 本 describe 的 beforeEach 会删掉该标记（它专测门控），巡检需要它
      process.env.CC_HEIHEI_DESKTOP_SIDECAR = '1'
      await fs.mkdir(desktopServerInfoDir(home), { recursive: true })
      // 死实例残值（pid 用一个必然不存在的大值）——2026-09-30 事故现场的形状
      await fs.writeFile(
        desktopServerInfoPath(home),
        JSON.stringify({
          url: 'http://127.0.0.1:57094',
          port: 57094,
          pid: 999999999,
          startedAt: '2026-09-30T03:08:45.325Z',
        }),
        'utf-8',
      )

      const stop = mod.startDesktopServerInfoGuard(63452, { home, intervalMs: 20 })
      try {
        await Bun.sleep(120)
        const info = await readDesktopServerInfo({ home })
        expect(info?.pid).toBe(process.pid)
        expect(info?.port).toBe(63452)
      } finally {
        stop()
      }
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test('自愈不抢活着的实例：文件 pid 仍存活时保持原样', async () => {
    const mod = await import('../services/serverIdentity.js')
    const home = await makeTmpHome()
    try {
      process.env.CC_HEIHEI_DESKTOP_SIDECAR = '1'
      await fs.mkdir(desktopServerInfoDir(home), { recursive: true })
      // 借用本进程 pid 当作「活着的另一个实例」（多实例并行时不互相刷写）
      await fs.writeFile(
        desktopServerInfoPath(home),
        JSON.stringify({
          url: 'http://127.0.0.1:11111',
          port: 11111,
          pid: process.pid,
          startedAt: '2026-09-30T03:08:45.325Z',
        }),
        'utf-8',
      )

      const stop = mod.startDesktopServerInfoGuard(63453, { home, intervalMs: 20 })
      try {
        await Bun.sleep(120)
        const info = await readDesktopServerInfo({ home })
        expect(info?.port).toBe(11111) // 未被夺回
      } finally {
        stop()
      }
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})
