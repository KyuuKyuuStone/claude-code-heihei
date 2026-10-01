# 三种身份的环境快照规格（conversationService.buildChildEnv）

> **状态：只写未跑。** 本规格与同目录的 `conversationChildEnvSnapshot.ts` 是
> conversationService 结构拆分**第③批（childEnv / collabIdentity）**的前置规格
> 与追验基线，**从未被执行过**。写它的原因见下。

## 为什么先写这个

第③批要动 `buildChildEnv`——它承载 A7（协作会话不注入 computer-use）、协作角色
标记、`CC_HEIHEI_SERVANT_*` 约束注入等**安全与协作相关**的赋值。架构裁决
（《架构决策_v1.7结构拆分边界》第 4 节）把这一批定为**黄灯**：除逐字块相等外，
还要对三种身份逐一静态提取注入 env 键清单，拆分前后逐项一致。

而按补充裁决四第 4 节，fixture **必须在拆分合入前写好**——否则拆分后旧行为无法
重建，追验就没有对照基线了。当前测试禁令解除后，第一件事就是用这份 fixture 对
拆分前后两个提交各跑一次快照。

## 三种身份怎么定义

判定的唯一依据是花名册条目（`isRegisteredSupervisor`，`conversationService.ts:1761-1801`）：

| 花名册里的样子 | supervisor | registered | servant |
|---|---|---|---|
| 不在册（`entry === null`，含读取异常降级） | false | false | false |
| `supervisor: true` | **true** | true | false |
| `supervisor: false, enabled: true` | false | true | **true** |
| `supervisor: false, enabled: false` | false | true | **false** |

要点：
- `registered` 只看「在不在册」，主管和员工都算——A7 用它决定不注入 computer-use。
- `servant` 要求 `enabled !== false`（契约 §3.1 的「enabled && !supervisor」）。
- `enabled: false` 的员工仍然是 `registered`，所以**照样不注入 computer-use**，
  但**不注入** `CC_HEIHEI_SERVANT_NONINTERACTIVE`。
- 花名册读取抛错时按「非主管」降级（收权是加强项，不能阻塞会话启动）。

## 身份相关的注入（本规格的核心）

| env 键 | 注入条件 | 取值 | 主管 | 员工 | 普通会话 |
|---|---|---|---|---|---|
| `CC_HEIHEI_SESSION_ID` | 调用方传了 sessionId | sessionId | ✓ | ✓ | ✓ |
| `CC_HEIHEI_SUPERVISOR` | `supervisor` | `1` | **✓** | — | — |
| `CC_HEIHEI_COLLAB_ROLE` | `supervisor` → supervisor；否则 `registered` → servant | 见左 | `supervisor` | `servant` | — |
| `CLAUDE_COMPUTER_USE_ENABLED` | `registered`（A7） | `0` | **✓ `0`** | **✓ `0`** | — |
| `CC_HEIHEI_SERVANT_NONINTERACTIVE` | `servant` | `isServantNonInteractiveEnabled() ? '1' : '0'` | — | ✓（默认 `1`） | — |
| `CC_HEIHEI_SERVANT_CONSTRAINT` | `constraint === 'readonly'` | `readonly` | — | 视档位 | — |
| `CC_HEIHEI_SERVANT_CONSTRAINT` | `constraint === 'whitelist'` | `whitelist` | — | 视档位 | — |
| `CC_HEIHEI_SERVANT_WRITE_DIRS` | 同上（whitelist） | `writeDirs.join('\n')`，**缺列表时是空串** | — | 视档位 | — |

三条容易写错、必须固化的边界：

1. **主管拿不到 `CC_HEIHEI_SERVANT_NONINTERACTIVE`**。主管的 `AskUserQuestion`
   是唯一的升级出口，必须可用；误注入会让主管无法向用户提问。
2. **白名单为空时注入空串，而不是省略这个键**。guard 侧解析空串 → 全部拒绝
   （最严格解释）。省略键和空串在 guard 里语义不同。
3. **普通会话零注入**。`collabIdentity` 为 null 或未在册时，上表所有键都不出现
   ——这是 v1.6.0 契约 §三的明确要求，也是 fixture 里 `expectAbsent` 断言的部分。

## 与身份无关的部分

`buildChildEnv` 还注入两大类键，快照测试要先把它们固定住才能比对：

- **固定键**（值恒定或只依赖入参 `workDir`）：见 fixture 里的 `CHILD_ENV_FIXED_KEYS`，
  例如 `CALLER_DIR` / `PWD` / `CC_HEIHEI_WORK_DIR` 都是 workDir，
  `CC_HEIHEI_SKIP_DOTENV` 恒为 `1`。
- **条件键**（依赖 `sdkUrl` / 显式 provider / trace 开关 / 网络设置）：
  见 `CHILD_ENV_CONDITIONAL_RULES`。

`...cleanEnv` 是继承的进程环境（`getProcessEnvWithTerminalShellEnvironment()`），
逐键取决于运行环境。快照测试必须**显式构造 cleanEnv 输入**，否则同一个身份会有
多组合法输出，比对没有意义。

## 拆分第③批的验收怎么做

1. 固定输入：workDir、sessionId、sdkUrl、providerId、trace 开关、网络设置、
   `isServantNonInteractiveEnabled()` 的取值。
2. 对拆分前的提交跑一次，得到三份基线快照。
3. 对拆分后的提交跑同一 fixture，逐键比对键集合与取值。
4. 三份额外断言：主管无 `CC_HEIHEI_SERVANT_NONINTERACTIVE`；白名单为空串；
   普通会话上表全 absent。

## 相关代码位置（v1.6.1 / 258ed0a）

- `buildChildEnv`：`src/server/services/conversationService.ts:1821-2070`
- `isRegisteredSupervisor`：同文件 `:1761-1801`
- `getCollabIdentity`：同文件 `:1803-1811`（直接转调上面的）
- `isServantNonInteractiveEnabled`：同文件 `:90-92`
- 缓存：`supervisorSessionCache`（主管身份缓存，第③批要做单一定义核查）
