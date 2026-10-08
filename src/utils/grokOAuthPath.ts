/**
 * heihei Grok OAuth 凭证文件路径（纯函数，无 server 依赖）。
 *
 * 2026-10-08 G2 批从 `server/services/heiheiGrokOAuthService.ts` 下沉到 L0：
 * `server/services/grokOfficialProvider.ts` 只要这个路径，却得 import 整个 OAuth 服务
 * （L2→L2），而该服务经 networkSettings 等绕回 provider ⇒ `no-circular`。
 * 路径拼接是纯函数 ⇒ 放 L0，两侧都向下引用，环消失。
 */
import * as os from 'os'
import * as path from 'path'

export function getHeiheiGrokOAuthFilePath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'cc-heihei', 'grok-oauth.json')
}
