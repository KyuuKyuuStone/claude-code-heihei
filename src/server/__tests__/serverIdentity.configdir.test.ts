import { afterEach, describe, expect, test } from 'bun:test'
import * as os from 'node:os'
import * as path from 'node:path'
import { desktopServerInfoPath } from '../services/serverIdentity.js'

/**
 * v1.7.3 #3：端口文件随 config 目录隔离。
 *
 * 旧实现把端口文件固定在 `os.homedir()/.claude/cc-heihei`（`CLAUDE_CONFIG_DIR` 不参与）
 * ⇒ 跑一个隔离实例**必然覆盖**真实应用的端口记录 ⇒ 员工汇报/CLI 投递打到错实例。
 * 现改为默认跟随 config 目录（未设 env 时结果与旧实现逐字相同 ⇒ 真实用户零影响）。
 */
describe('端口文件随 config 目录隔离（v1.7.3 #3）', () => {
  const original = process.env.CLAUDE_CONFIG_DIR
  afterEach(() => {
    if (original) process.env.CLAUDE_CONFIG_DIR = original
    else delete process.env.CLAUDE_CONFIG_DIR
  })

  test('设 CLAUDE_CONFIG_DIR ⇒ 端口文件落在隔离目录内、不碰真实 home', () => {
    const iso = path.join(os.tmpdir(), 'cc-demo-home-probe')
    process.env.CLAUDE_CONFIG_DIR = iso
    const p = desktopServerInfoPath()
    expect(p.startsWith(iso)).toBe(true)
    expect(p.includes(`${path.sep}.claude${path.sep}`)).toBe(false)
  })

  test('未设 ⇒ 与旧实现逐字一致（~/.claude/cc-heihei/desktop-server.json）', () => {
    delete process.env.CLAUDE_CONFIG_DIR
    expect(desktopServerInfoPath()).toBe(
      path.join(os.homedir(), '.claude', 'cc-heihei', 'desktop-server.json'),
    )
  })

  test('显式传 home ⇒ 仍走 home/.claude/cc-heihei（既有调用/测试契约不变）', () => {
    expect(desktopServerInfoPath(path.join('tmp', 'x'))).toBe(
      path.join('tmp', 'x', '.claude', 'cc-heihei', 'desktop-server.json'),
    )
  })
})
