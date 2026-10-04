import { expect, test } from 'bun:test'
import * as os from 'node:os'
import * as path from 'node:path'
import { defaultDeps } from './collabToolClient.js'
import { getCcHeiheiDir } from '../utils/envUtils.js'

/**
 * v1.7.3 #3 读侧**接线**用例：锁住「默认 portFileDir 确实接上 config 目录解析」这一层
 * （此前只覆盖了 helper 的三态行为，没断言调用点接没接上）。
 */
test('defaultDeps().portFileDir 接上 getCcHeiheiDir（隔离实例读自己的端口文件）', () => {
  const original = process.env.CLAUDE_CONFIG_DIR
  try {
    delete process.env.CLAUDE_CONFIG_DIR
    // 未设 env：与旧写法 join(homedir(), '.claude/cc-heihei') 逐字相同 ⇒ 真实用户零影响
    expect(defaultDeps().portFileDir).toBe(getCcHeiheiDir())
    expect(defaultDeps().portFileDir).toBe(path.join(os.homedir(), '.claude', 'cc-heihei'))

    // 隔离实例：解析到自己的 config 目录，不落真实 home
    const iso = path.join(os.tmpdir(), 'cc-iso-portfile-probe')
    process.env.CLAUDE_CONFIG_DIR = iso
    expect(defaultDeps().portFileDir.startsWith(iso)).toBe(true)
    expect(defaultDeps().portFileDir.includes(`${path.sep}.claude${path.sep}`)).toBe(false)
  } finally {
    if (original) process.env.CLAUDE_CONFIG_DIR = original
    else delete process.env.CLAUDE_CONFIG_DIR
  }
})
