import { describe, expect, test } from 'bun:test'
import {
  SUPERVISOR_DISPATCH_ONLY_REASON,
  isSupervisorSession,
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
    const reason = supervisorWriteDeniedReason('C:/proj/src/main.ts', ENV_ON)
    expect(reason).toBe(SUPERVISOR_DISPATCH_ONLY_REASON)
    expect(reason).toContain('派给员工')
    expect(supervisorEditDeniedReason(ENV_ON)).toBe(SUPERVISOR_DISPATCH_ONLY_REASON)
  })

  test('dispatch protocol write paths stay allowed for supervisors', () => {
    // Windows 与 POSIX 风格都要放行
    expect(supervisorWriteDeniedReason('C:/proj/.dispatch-payload.json', ENV_ON)).toBeNull()
    expect(supervisorWriteDeniedReason('C:\\proj\\report-payload.json', ENV_ON)).toBeNull()
    expect(supervisorWriteDeniedReason('C:/proj/.heihei/dispatch/dispatch-1.json', ENV_ON)).toBeNull()
    expect(supervisorWriteDeniedReason('/home/u/proj/.heihei/dispatch/report-2.json', ENV_ON)).toBeNull()
  })

  test('similar-looking filenames are NOT allowed (strict allowlist)', () => {
    expect(supervisorWriteDeniedReason('C:/proj/dispatch-payload.json', ENV_ON)).not.toBeNull()
    expect(supervisorWriteDeniedReason('C:/proj/.dispatch-payload.json.bak', ENV_ON)).not.toBeNull()
    // .heihei 下但不是 dispatch 子目录
    expect(supervisorWriteDeniedReason('C:/proj/.heihei/notes.txt', ENV_ON)).not.toBeNull()
  })
})
