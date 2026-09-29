import { describe, expect, test } from 'bun:test'
import {
  SERVANT_CONSTRAINT_ENV,
  SERVANT_WRITE_DIRS_ENV,
  SUPERVISOR_DISPATCH_ONLY_REASON,
  isSupervisorSession,
  parseServantWriteDirs,
  servantConstraintWriteDeniedReason,
  servantWhitelistWriteDeniedReason,
  supervisorEditDeniedReason,
  supervisorWriteDeniedReason,
} from '../../collaboration/supervisorGuard.js'

const ENV_ON = { CC_HEIHEI_SUPERVISOR: '1' } as NodeJS.ProcessEnv
const ENV_OFF = {} as NodeJS.ProcessEnv

describe('supervisorGuard', () => {
  test('supervisor flag detection', () => {
    expect(isSupervisorSession(ENV_ON)).toBe(true)
    expect(isSupervisorSession(ENV_OFF)).toBe(false)
    expect(isSupervisorSession({ CC_HEIHEI_SUPERVISOR: '0' } as NodeJS.ProcessEnv)).toBe(false)
  })

  test('non-supervisor sessions are never restricted', () => {
    expect(supervisorWriteDeniedReason('C:/proj/src/main.ts', ENV_OFF)).toBeNull()
    expect(supervisorEditDeniedReason(ENV_OFF)).toBeNull()
  })

  test('supervisor code writes are denied with dispatch guidance', () => {
    const reason = supervisorWriteDeniedReason('C:/proj/src/main.ts', ENV_ON, { cwd: 'C:/proj' })
    expect(reason).toBe(SUPERVISOR_DISPATCH_ONLY_REASON)
    expect(reason).toContain('派给员工')
    expect(supervisorEditDeniedReason(ENV_ON)).toBe(SUPERVISOR_DISPATCH_ONLY_REASON)
  })

  test('dispatch protocol write paths stay allowed for supervisors', () => {
    // Windows 与 POSIX 风格都要放行（cwd 注入=C:/proj 与 /home/u/proj 各自的工作目录内）
    expect(supervisorWriteDeniedReason('C:/proj/.dispatch-payload.json', ENV_ON, { cwd: 'C:/proj' })).toBeNull()
    expect(supervisorWriteDeniedReason('C:\\proj\\report-payload.json', ENV_ON, { cwd: 'C:/proj' })).toBeNull()
    expect(supervisorWriteDeniedReason('C:/proj/.heihei/dispatch/dispatch-1.json', ENV_ON, { cwd: 'C:/proj' })).toBeNull()
    expect(supervisorWriteDeniedReason('/home/u/proj/.heihei/dispatch/report-2.json', ENV_ON, { cwd: '/home/u/proj', platform: 'linux' })).toBeNull()
  })

  test('similar-looking filenames are NOT allowed (strict allowlist)', () => {
    expect(supervisorWriteDeniedReason('C:/proj/dispatch-payload.json', ENV_ON, { cwd: 'C:/proj' })).not.toBeNull()
    expect(supervisorWriteDeniedReason('C:/proj/.dispatch-payload.json.bak', ENV_ON, { cwd: 'C:/proj' })).not.toBeNull()
    // .heihei 下但不是 dispatch 子目录
    expect(supervisorWriteDeniedReason('C:/proj/.heihei/notes.txt', ENV_ON, { cwd: 'C:/proj' })).not.toBeNull()
  })

  // ── v1.4.1：工作目录之外的 Write 放行（主管写临时 payload / 桌面汇总文档）──
  test('writes OUTSIDE the working directory are allowed for supervisors', () => {
    // 用户桌面 / 临时目录等 cwd 外位置整体放行
    expect(supervisorWriteDeniedReason('C:/Users/x/Desktop/doc.md', ENV_ON, { cwd: 'C:/proj' })).toBeNull()
    expect(supervisorWriteDeniedReason('C:/Users/x/AppData/Local/Temp/payload.json', ENV_ON, { cwd: 'C:/proj' })).toBeNull()
    expect(supervisorWriteDeniedReason('/home/u/desktop/report.md', ENV_ON, { cwd: '/proj', platform: 'linux' })).toBeNull()
  })

  test('cwd-outside allowance does NOT leak to non-supervisor semantics (still denied inside cwd)', () => {
    // cwd 内普通文件：v1.4.1 后仍拒（回归）
    expect(supervisorWriteDeniedReason('C:/proj/notes.md', ENV_ON, { cwd: 'C:/proj' })).toBe(SUPERVISOR_DISPATCH_ONLY_REASON)
    // cwd 内 payload basename / 信箱：v1.4.1 后仍放行（回归）
    expect(supervisorWriteDeniedReason('C:/proj/report-payload.json', ENV_ON, { cwd: 'C:/proj' })).toBeNull()
    expect(supervisorWriteDeniedReason('C:/proj/.heihei/dispatch/report-9.json', ENV_ON, { cwd: 'C:/proj' })).toBeNull()
  })

  test('directory boundary is prefix-aware: sibling directories are OUTSIDE cwd', () => {
    // C:/proj-evil、C:/project 是 C:/proj 的兄弟目录——isInsideDir 的 dir+'/'
    // 前缀判定必须把它们判为 cwd 外（cwd 外整体放行）。若前缀误判把它们当
    // cwd 内，下面的普通文件名会被 SUPERVISOR_DISPATCH_ONLY_REASON 拒掉——
    // 用 null 断言锁死正确的目录边界。
    expect(supervisorWriteDeniedReason('C:/proj-evil/x.md', ENV_ON, { cwd: 'C:/proj' })).toBeNull()
    expect(supervisorWriteDeniedReason('C:/project/notes.md', ENV_ON, { cwd: 'C:/proj' })).toBeNull()
    // 反向确认：真在 cwd 内的同名文件仍拒
    expect(supervisorWriteDeniedReason('C:/proj/notes.md', ENV_ON, { cwd: 'C:/proj' })).toBe(SUPERVISOR_DISPATCH_ONLY_REASON)
  })

  test('win32 path comparison is case-insensitive (NTFS semantics)', () => {
    // cwd=C:/Proj 与目标 c:/proj/src/a.ts 同一目录：cwd 内 → 仍拒
    expect(supervisorWriteDeniedReason('c:/proj/src/a.ts', ENV_ON, { cwd: 'C:/Proj', platform: 'win32' })).toBe(SUPERVISOR_DISPATCH_ONLY_REASON)
    // 大小写不同的 cwd 外路径照常放行
    expect(supervisorWriteDeniedReason('C:/USERS/x/Desktop/a.md', ENV_ON, { cwd: 'c:/proj', platform: 'win32' })).toBeNull()
  })

  test('non-absolute paths are denied (defense in depth)', () => {
    expect(supervisorWriteDeniedReason('src/main.ts', ENV_ON, { cwd: 'C:/proj' })).toBe(SUPERVISOR_DISPATCH_ONLY_REASON)
    expect(supervisorWriteDeniedReason('../outside/a.md', ENV_ON, { cwd: 'C:/proj' })).toBe(SUPERVISOR_DISPATCH_ONLY_REASON)
  })

  test('non-supervisor sessions are unaffected by the cwd-outside rule (regression)', () => {
    expect(supervisorWriteDeniedReason('C:/anywhere/file.md', ENV_OFF, { cwd: 'C:/proj' })).toBeNull()
  })
})

describe('servant whitelist constraint (A3)', () => {
  // realpath: null → 纯字符串比对，测试不依赖真实文件系统
  const NO_REALPATH = { realpath: null } as const
  const ENV_WL = {
    [SERVANT_CONSTRAINT_ENV]: 'whitelist',
    [SERVANT_WRITE_DIRS_ENV]: 'C:/proj',
  } as NodeJS.ProcessEnv
  const ENV_WL_MULTI = {
    ...ENV_WL,
    [SERVANT_WRITE_DIRS_ENV]: 'C:/proj\nC:/build-artifacts',
  } as NodeJS.ProcessEnv

  // W1/W2 白名单目录内放行（全等 + 子目录 + 反斜杠 W5）
  test('W1+W2+W5: paths inside whitelisted dirs are allowed (exact, nested, backslashes)', () => {
    expect(servantWhitelistWriteDeniedReason('C:/proj', ENV_WL, ENV_WL, NO_REALPATH)).toBeNull()
    expect(servantWhitelistWriteDeniedReason('C:/proj/src/a.ts', ENV_WL, ENV_WL, NO_REALPATH)).toBeNull()
    expect(servantWhitelistWriteDeniedReason('C:/proj/src/deep/nested/b.ts', ENV_WL, ENV_WL, NO_REALPATH)).toBeNull()
    expect(servantWhitelistWriteDeniedReason('C:\\proj\\src\\a.ts', ENV_WL, ENV_WL, NO_REALPATH)).toBeNull()
  })

  // W3/W4 白名单外拒绝（目录边界！/ 异盘）
  test('W3+W4: sibling dir with shared prefix and other drives are denied (boundary-aware)', () => {
    expect(supervisorWriteDeniedReason === undefined).toBe(false) // import sanity
    expect(servantWhitelistWriteDeniedReason('C:/proj-evil/x.ts', ENV_WL, ENV_WL, NO_REALPATH)).not.toBeNull()
    expect(servantWhitelistWriteDeniedReason('C:/project/x.ts', ENV_WL, ENV_WL, NO_REALPATH)).not.toBeNull()
    expect(servantWhitelistWriteDeniedReason('D:/other/x.ts', ENV_WL, ENV_WL, NO_REALPATH)).not.toBeNull()
  })

  // W6 大小写：win32 归一放行；POSIX 大小写敏感拒绝
  test('W6: case-insensitive on win32, case-sensitive on posix', () => {
    expect(
      servantWhitelistWriteDeniedReason('C:/PROJ/a.ts', ENV_WL, ENV_WL, {
        ...NO_REALPATH,
        platform: 'win32',
      }),
    ).toBeNull()
    expect(
      servantWhitelistWriteDeniedReason('/PROJ/a.ts', { ...ENV_WL, [SERVANT_WRITE_DIRS_ENV]: '/proj' }, { ...ENV_WL, [SERVANT_WRITE_DIRS_ENV]: '/proj' }, {
        ...NO_REALPATH,
        platform: 'linux',
      }),
    ).not.toBeNull()
  })

  // W7 信箱/payload 例外在 whitelist 档依旧生效（经 servantConstraintWriteDeniedReason 总入口）
  test('W7: mailbox and dispatch payload exceptions still apply under whitelist', () => {
    expect(servantConstraintWriteDeniedReason('C:/anywhere/.dispatch-payload.json', ENV_WL_MULTI)).toBeNull()
    expect(servantConstraintWriteDeniedReason('C:/outside/report-payload.json', ENV_WL_MULTI)).toBeNull()
    expect(servantConstraintWriteDeniedReason('C:/outside/.heihei/dispatch/report-9.json', ENV_WL_MULTI)).toBeNull()
  })

  // W8 路径穿越：expandPath 先归一（resolve 语义）后进 guard → 自然不在白名单
  test('W8: traversal via .. is normalized away before matching and denied', () => {
    // 模拟 expandPath('proj/../evil/a.ts') 的产物：C:/evil/a.ts
    expect(servantWhitelistWriteDeniedReason('C:/evil/a.ts', ENV_WL, ENV_WL, NO_REALPATH)).not.toBeNull()
  })

  // W9 符号链接：fake realpath 注入（前缀映射模拟系统对链接的解析）
  test('W9: symlink resolution via injectable realpath — target inside / outside / resolution failure', () => {
    // 白名单目录内的链接指向外部 → 真实路径在外 → 拒绝（字面比对不兜底）
    const linkOut: (p: string) => string = (p) =>
      p.startsWith('C:/proj/link') ? `D:/outside/real${p.slice('C:/proj/link'.length)}` : p
    expect(
      servantWhitelistWriteDeniedReason('C:/proj/link/file.ts', ENV_WL, ENV_WL, { realpath: linkOut, platform: 'win32' }),
    ).not.toBeNull()
    // 白名单外路径经链接进入白名单内 → 真实路径在内 → 放行
    const linkIn: (p: string) => string = (p) =>
      p.startsWith('C:/shortcut') ? `C:/proj/inside${p.slice('C:/shortcut'.length)}` : p
    expect(
      servantWhitelistWriteDeniedReason('C:/shortcut/file.ts', ENV_WL, ENV_WL, { realpath: linkIn, platform: 'win32' }),
    ).toBeNull()
    // realpath 双侧抛错（目录尚不存在）→ 各自回退字面路径比对（不炸、照常判定）
    const broken: (p: string) => string = () => {
      throw new Error('ENOENT')
    }
    expect(
      servantWhitelistWriteDeniedReason('C:/proj/a.ts', ENV_WL, ENV_WL, { realpath: broken, platform: 'win32' }),
    ).toBeNull()
  })

  // W10 env 解析：多根/空行容错；whitelist 档但列表缺失 → 全拒（最严格解释）
  test('W10: env parsing tolerates blank lines; missing list fails closed', () => {
    expect(parseServantWriteDirs('C:/a\n\n  C:/b  \n')).toEqual(['C:/a', 'C:/b'])
    expect(parseServantWriteDirs(undefined)).toEqual([])
    const envNoList = { [SERVANT_CONSTRAINT_ENV]: 'whitelist' } as NodeJS.ProcessEnv
    // 经总入口：无列表 → 等效 readonly 全拒
    expect(servantConstraintWriteDeniedReason('C:/proj/a.ts', envNoList)).not.toBeNull()
    // 全拒但信箱例外仍在
    expect(servantConstraintWriteDeniedReason('C:/proj/.heihei/dispatch/report-1.json', envNoList)).toBeNull()
  })

  // W11 非绝对路径（防御纵深）：拒绝
  test('W11: non-absolute paths are denied (defense in depth)', () => {
    expect(servantWhitelistWriteDeniedReason('relative/a.ts', ENV_WL, ENV_WL, NO_REALPATH)).not.toBeNull()
    expect(servantWhitelistWriteDeniedReason('a.ts', ENV_WL, ENV_WL, NO_REALPATH)).not.toBeNull()
  })

  // W12 回归：full/未设置不限制；readonly 行为不变
  test('W12: full/unset unrestricted; readonly behavior unchanged', () => {
    expect(servantConstraintWriteDeniedReason('C:/proj/a.ts', {} as NodeJS.ProcessEnv)).toBeNull()
    const envRo = { [SERVANT_CONSTRAINT_ENV]: 'readonly' } as NodeJS.ProcessEnv
    expect(servantConstraintWriteDeniedReason('C:/proj/a.ts', envRo)).not.toBeNull()
    expect(servantConstraintWriteDeniedReason('C:/proj/a.ts', { ...envRo, [SERVANT_WRITE_DIRS_ENV]: 'C:/proj' } as NodeJS.ProcessEnv)).not.toBeNull()
  })

  // 多根白名单：两个目录都放行
  test('W-multi: multiple whitelist roots all allowed', () => {
    expect(servantWhitelistWriteDeniedReason('C:/proj/a.ts', ENV_WL_MULTI, ENV_WL_MULTI, NO_REALPATH)).toBeNull()
    expect(servantWhitelistWriteDeniedReason('C:/build-artifacts/out.bin', ENV_WL_MULTI, ENV_WL_MULTI, NO_REALPATH)).toBeNull()
    expect(servantWhitelistWriteDeniedReason('C:/elsewhere/a.ts', ENV_WL_MULTI, ENV_WL_MULTI, NO_REALPATH)).not.toBeNull()
  })
})
