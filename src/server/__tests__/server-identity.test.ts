import { describe, expect, test } from 'bun:test'
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
    // version 来自 package.json（本地开发为 999.0.0-local 之类），非空即可
    expect(identity.version.length).toBeGreaterThan(0)
    expect(identity.version).not.toBe('unknown')
    expect(identity.pid).toBe(process.pid)
    expect(Number.isNaN(Date.parse(identity.startedAt))).toBe(false)
    // 端口文件与 whoami 同源：两次取值 startedAt 不变（模块加载时定格）
    expect(getServerIdentity().startedAt).toBe(identity.startedAt)
  })
})
