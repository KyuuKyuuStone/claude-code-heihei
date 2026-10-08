/**
 * heihei OpenAI(Codex) OAuth 凭证文件路径（纯函数，无 server 依赖）。
 *
 * 2026-10-08 G2 B-d 批从 `server/services/heiheiOpenAIOAuthService.ts` 下沉到 L0：
 * `server/services/openaiOfficialProvider.ts` 只要这个路径，却得 import 整个 OAuth 服务，
 * 而环 `networkSettings → settingsService → persistentStorageMigrations →
 * openaiOfficialProvider → heiheiOpenAIOAuthService → networkSettings` 正是踩在这条边上
 * ⇒ 路径拼接是纯函数，放 L0 后环断开（与 B-c 的 grokOAuthPath 同款处理）。
 */
import * as os from 'os'
import * as path from 'path'

export function getHeiheiOpenAIOAuthFilePath(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'cc-heihei', 'openai-oauth.json')
}
