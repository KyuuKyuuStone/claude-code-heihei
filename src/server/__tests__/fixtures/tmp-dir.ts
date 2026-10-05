import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * mkdtemp 后立即 realpath。
 *
 * 为什么：GitHub Windows runner 的 os.tmpdir() 返回 8.3 短路径形态
 * （C:\Users\RUNNER~1\...），而 createSession 等产品代码内部 fs resolve 成
 * 长路径（C:\Users\runneradmin\...）入账；测试若用短路径串做项目目录比对/
 * 过滤，normalizeProjectPath（只做 resolve+斜杠+小写，不识别 8.3）判不同
 * 目录 ⇒ 过滤 0 条。本地 %TEMP% 无短形态所以绿，只在 CI 红。
 * 见 HANDOVER.md「已查实待修缺陷」条目 0 与提交 0355134。
 */
export async function mkdtempReal(prefix: string): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
}
