import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { servantService } from '../services/servantService.js'

/**
 * 协作身份约束档位的三态契约（v1.6.0，配合协作设置弹窗重设计）。
 *
 * 缺口：PUT 花名册不传 constraint 即继承旧值，于是受限档（readonly/whitelist）
 * 一旦设置，前端没有任何办法恢复成「完全执行」。
 *
 * 契约：
 * - 传值     → 设为该档位
 * - null     → 清除约束（同时清空 writeDirs）
 * - undefined → 继承旧值
 */

const ID = 'dddd4444-4444-4444-8444-444444444444'

describe('servantService 约束档位三态', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let rosterPath: string
  let projectDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-constraint-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    rosterPath = path.join(tmpDir, 'servant_sessions.json')
    projectDir = path.join(tmpDir, 'projects', 'D--xxw-p-demo')
    await fs.mkdir(projectDir, { recursive: true })
    // setServant 要求会话真实存在
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u-1',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'hi' },
    })
    await fs.writeFile(path.join(projectDir, `${ID}.jsonl`), `${line}\n`, 'utf-8')
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function readPersisted(): Promise<Array<Record<string, unknown>>> {
    const raw = JSON.parse(await fs.readFile(rosterPath, 'utf-8')) as {
      servants: Array<Record<string, unknown>>
    }
    return raw.servants
  }

  it('constraint 传 null → 清除约束并清空 writeDirs（恢复完全执行）', async () => {
    await servantService.setServant(ID, {
      enabled: true,
      constraint: 'whitelist',
      writeDirs: ['D:/xxw_p/allowed'],
    })
    expect((await readPersisted())[0]!.constraint).toBe('whitelist')

    const cleared = await servantService.setServant(ID, { enabled: true, constraint: null })

    expect(cleared.constraint).toBeUndefined()
    expect(cleared.writeDirs).toBeUndefined()
    const persisted = await readPersisted()
    expect(persisted[0]!.constraint).toBeUndefined()
    expect(persisted[0]!.writeDirs).toBeUndefined()
  })

  it('constraint 不传（undefined）→ 继承旧约束', async () => {
    await servantService.setServant(ID, { enabled: true, constraint: 'readonly' })

    const inherited = await servantService.setServant(ID, { enabled: true, role: '前端' })

    expect(inherited.constraint).toBe('readonly')
    expect((await readPersisted())[0]!.constraint).toBe('readonly')
  })

  it('whitelist 需要 writeDirs；清除后重设 whitelist 不传目录会被拒', async () => {
    const set = await servantService.setServant(ID, {
      enabled: true,
      constraint: 'whitelist',
      writeDirs: ['D:/xxw_p/a', 'D:/xxw_p/b'],
    })
    expect(set.constraint).toBe('whitelist')
    // 服务端会规范化路径（Windows 下分隔符可能被改写），只断言数量与归一结果
    expect(set.writeDirs).toHaveLength(2)
    expect(set.writeDirs?.every((dir) => dir.includes('xxw_p'))).toBe(true)

    await servantService.setServant(ID, { enabled: true, constraint: null })
    // 约束已清除 → 白名单也清空，此时再设 whitelist 不带目录应报错
    await expect(
      servantService.setServant(ID, { enabled: true, constraint: 'whitelist' }),
    ).rejects.toThrow(/write directory/)
  })

  it('非法 constraint 值仍被拒绝', async () => {
    await expect(
      // @ts-expect-error 故意传非法值
      servantService.setServant(ID, { enabled: true, constraint: 'readonly-ish' }),
    ).rejects.toThrow(/constraint/)
  })
})
