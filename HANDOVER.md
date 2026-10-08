# Claude Code Heihei — 项目交接文档

> 写给接手的 AI：这份文档告诉你这个项目是什么、我做了什么、现在是什么状态、接下来要做什么。

## 项目是什么

**Claude Code Heihei** 是一个 **Windows 专属、自用为主的「主管/员工」AI 协作工作台**（fork 自 cc-haha）。核心差异化是**会话级协作编排**——主管派活、员工会话无人值守执行、完工自动汇报、主管验收，全程审计留痕。**本地大模型为冻结的可选功能**：能用（内置 llama.cpp），但不再新增功能、**不参与协作会话**。

核心技术栈：
- **桌面壳**：Electron + React + Vite
- **本地推理**：llama.cpp（GGUF 模型，CPU + Vulkan 双构建）
- **构建**：bun 1.3.14 + TypeScript
- **CI**：GitHub Actions（`ci.yml` + `deploy-pages.yml`）

## 本地模型功能现状（2026-09-06 大改版）

这一版把本地模型策略做成了「实测诚实派」：

- **档位体系已砍**（低配~帝王没有了，别找回来）：新建方案按硬件自动填参数起点（67% 线程甜点比例、无独显纯 CPU、32K 上下文），跑分实测一键应用
- **跑分**：GPU 真探测（实跑一次推理，GTX 750 这类无 fp16 老卡自动退纯 CPU，不会启动后崩 ErrorDeviceLost）；67%/100% 两档每档测 2 次取平均；报告给运行方式结论（纯 CPU/GPU 全量/混合）、能力档、首字延迟预估（30K 提示词 ÷ 实测 pp 速度）、KV 缓存账单
- **上下文规划**：f16 装不下 32K 先自动换 q8_0 KV（学 Ollama），还不够才降上下文；内存预算按 67%
- **OOM 自动降档重试**：GPU 配置启动失败退纯 CPU 重试 → 上下文砍半重试；超时不重试
- **多模态**：方案可配 mmproj 投影文件（--mmproj），配了才能看图
- **长对话加速**：默认带 --cache-reuse 256
- **自定义引擎目录**：N 卡用户可外接 llama.cpp 官方 CUDA 版（不随应用打包，1GB+ 太大）
- **精选模型清单**：`desktop/src/constants/localModelCatalog.ts` 静态文件随应用打包（用户否决了应用内下载器——服务器和维护负担承受不起），5 款官方模型 + HF/ModelScope 直链
- 进阶参数：投机解码草稿模型（--model-draft）、MoE 专家权重 CPU 层数（--n-cpu-moe）

**用户拍板的红线**：67% 是甜点比例（线程、内存预算都按它）；不做应用内下载器；CUDA 不打包让用户官方下载；跑分别加回用户选目标速度。

## 我做的工作（v1.0.2 周期，历史记录）

1. 删除桌面宠物功能全部代码（桌面端；服务端 petAccessPolicy 等死代码有意保留）
2. 本地模型大改版（见上节）+ 修复启动 ErrorDeviceLost + 跑分 IPC 校验修复确认
3. 更新文档（docs/desktop/local-model.md、README 中英、本文件）
4. **发布 v1.0.2**：Release 附 exe + latest.yml + blockmap（曾漏传 latest.yml 导致旧版检查不到更新，已补并写入发版清单）

## GitHub 信息

- **仓库**：`https://github.com/KyuuKyuuStone/claude-code-heihei`
- **当前版本**：`v1.7.3`（代码侧 2026-10-04 收口；**未发布**——tag/Release/出包**均待用户当次口令**）
- **主分支**：`main`（本轮只更新文档，不执行 git 写操作）

## 当前状态

### 版本快照（v1.0.3 → v1.5.0，2026-09-07 ~ 09-30）

- **v1.0.3**：会话协作实战韧性第一轮——`.heihei/dispatch` 文件信箱（Bash 不可用时的派活/汇报降级通道）、主管履新承诺前实测 CLI 技能、Doctor 新增 shell/协作技能体检、prewarm 回收日志正名
- **v1.0.4**：本地模型上下文规划重做（32K 是下限非目标，预算内逐级上探至 128K q8_0，`desktop/src/lib/localModelPlan.ts`）；跑分运行方式判定修复（全 GPU 不再误标混合）
- **v1.0.5**：协作实战可靠性——员工汇报模板改 Write+--data-binary（修 GBK 乱码）、上岗/履新消息注入随身档案、ToolSearch select: 自救提示、花名册 lastActivityAt + 假活检查
- **v1.0.6**：`POST /api/sessions/:id/interrupt`（中断保留历史）、`GET /api` 端点名录、主管广播（broadcast:true）、登记消息带 sessionId+workDir
- **v1.0.7**：`/api/session-messages` 请求体严格 UTF-8 失败回退 GBK 解码（乱码服务端兜底）；诊断主文件被锁时降级写 fallback 文件 + stdout 留痕；主管默认派活约束；空协作会话替换时身份过继；**模型目录更新至 2026-09 官方最新**（Claude Fable 5.1 / GPT-6 Astra / Grok 4.6 / GLM-5.3 / 新增 Gemini 预置）
- **v1.0.8**：DeepSeek 主力切 `deepseek-flash`（官方 9/14 12:00 起 v4-pro 强制路由并按 Flash 计费）
- **v1.0.9**：主管会话工具面**结构性收权**——Edit/Write/NotebookEdit 被拒绝并返回派活指引（角色边界从提示词约束升级为机制兜底，`src/collaboration/supervisorGuard.ts`）；存量主管启动时一次性收到协议更新通知；指令歧义规范（"你来实施"默认理解为派活）
- **v1.1.0**：多会话协作大版本——员工状态灯、唤醒按钮、主管广播、派活撞车提醒；员工报错自动续跑（连错 ≤2 注入续跑提示 → 第 3 轮升级主管，成功轮清零）、崩溃自动上报、假死自动重推（10 分钟无活动，最多 3 次）；只读观察约束档位（`CC_HEIHEI_SERVANT_CONSTRAINT=readonly`）；ToolSearch 关键词搜索空结果回扫全量工具集 + 诊断探针；**CI 新增服务端测试门禁**（后收编为 windows runner + 协作核心子集）；本地模型流式硬上限放宽至 30 分钟（baseUrl 指向本机 llama-server 时，云端保持 600s，`src/server/services/conversationService.ts`）
- **v1.1.1**：员工状态灯修复——花名册 20 秒轮询刷新（此前仅启动时取一次，员工拉起后状态点仍是旧快照、恒灰）+ 状态语义三态修正（忙碌/待命/未运行，卡死判定收敛到服务端假死 watcher）
- **v1.1.2**：**ToolSearch 误用修复**（实战事故 Top1 根因）——核心工具恒 inline 说明 + `select:` 命中显式回执 + 协作侧 4 处文案五语言同步（`src/tools/ToolSearchTool/`、`src/collaboration/dispatchProtocol.ts`）；**桌面测试基线清零**（14 失败文件 / 40 失败用例 → 0，其中 generalSettings 25 条显式豁免待接线＝条目 B1-D2）；Sidebar 未定义 token 修复（`--color-text-quaternary` → `--color-text-tertiary`）
- **v1.2.0**：协作安全与可靠性加固——**目录白名单约束档**（第三档，按目录放行文件工具写入，`CC_HEIHEI_SERVANT_WRITE_DIRS`；**Bash 不受此约束**，属文件工具级边界非安全沙箱）、**连续调用不存在工具自动熔断并通知主管**、**文件信箱 watcher 周期兜底扫描**（默认 45 秒，顺带重建缺失 watcher）、员工忙碌态转圈动画；工程质量——**CI 新增 `desktop-tests` 门禁 job**（windows runner，18 文件子集起步）、协作测试环境隔离修复
- **v1.2.1**：**假死自动重推真正修复**——旧状态机 4 行确定性 TypeError（新建的 state 未落 map → 下一行 `get(key)!` 抛 `Cannot read properties of undefined`），异常冒泡出 `watch()` 被 `start()` 的 `.catch(() => {})` 吞掉：**该功能自 v1.1.0 起从未成功重推过任何会话**，且异常打断循环会跳过其后所有会话、旧实现零日志。修复＝状态机取不到就建并落 map + 拆「非 running 一律跳过」的死路（改为**只告警主管、不自动拉起**）+ `servant_stall` 诊断事件全覆盖（`list-failed` / `nudge` / `nudge-failed` / `no-process-alert` / `escalate` / `scan-failed` 等 action）+ **投递成功才计重推额度** + 主管会话豁免 + 依赖注入缝（新增 10 条单测）。另含：**配额/限流 429 错误可见化**（非订阅者门后新增兜底，文案含重置时间，绝不空串）、**诊断日志每条带 sessionId + 启动锚点 `server_started`**（消除「安静 ≠ 写坏」盲区）、**派活消费回执**（POST 返回 `messageId` + GET 查询——投递 ≠ 消费）、**诊断 fallback 保留策略**（天数 + 个数双上限）、**pet 死代码清理**（11 文件、净删 619 行）、**角色多语言**（14 角色 × 五语言）+ **非 ASCII 路径提示**（提示不阻断）
- **v1.2.2**：假死重推**降噪**——修复 v1.2.1 上线后实测发现的「**待命会话被循环戳**」：旧判定只看「无活动时长」，已正常结束回合、处于待命的会话也被当作疑似卡死反复重推；而重推触发的回复本身就是活动、又重置计时，于是形成「戳 → 回复 → 重置 → 再 10 分钟 → 再戳」的循环，**每轮白白消耗一个模型回合**。现重推条件收紧为「**回合进行中 + 10 分钟无活动**」才触发——回合已正常结束的待命会话**不戳也不告警**，真·卡死仍会被自动重推（自愈能力不受影响）。回合态判定复用**派活回执**已有的观察（`isSessionTurnInProgress`，`src/server/services/dispatchReceiptService.ts`），**状态同源不漂移**（不引入第二套状态来源）
- **v1.2.3**：**系统消息分流（用户定的产品规则）**——对话流只保留**需要人响应的消息**（员工汇报），员工登记 / 假死告警 / 崩溃上报 / 报错升级 / 熔断通知等系统事件一律**降为诊断日志**（维护可查，不再打扰会话窗口）；**告警二期**——无进程提醒仅在「**有未被消费派活**」这类**可行动场景**记录（文案中性化，正常闲置零打扰）；协议真源同步（熔断的「会给你发通知」承诺 → **诊断自查指引**，事件名 `servant_unknown_tool_circuit`，`src/collaboration/dispatchProtocol.ts`）；信箱投递补记消费回执；闲置诊断去重
- **v1.2.4**：**员工生命周期（增删 / 重入）**——**移除留痕**（两条移除路径均写 `servant_removed` 诊断、含身份快照：显式删除 `explicit-delete` + 会话死亡自动清理 `session-deleted-auto-cleanup`——后者是此前更隐蔽的静默移除点）；**「删除」真正生效修复**（DELETE 分支补 `invalidateSupervisorCache`，被删员工重启后不再按旧身份注入收权 env）；派活到已移除会话从不可行动的 500 改为**可行动 404**（提示查花名册改派、勿重试；**主管汇报路径与禁用员工天然放行**）；同 workDir 同 role 重复登记写 `servant_duplicate_role` warn（**不阻断**——role 是自由文本，同名不同分工合法）；**重新加入 = 全新登记**（新 sessionId、新条目，不复用旧身份），历史靠诊断链 `registered → removed（含快照）→ registered（同 role）` 复盘；协作设置新增「**删除 vs 禁用**」差异说明（五语言）。设计真源见 `D:/xxw_p/cc-heihei-docs/v1.2.x/员工生命周期_增删重入设计_20260916.md`；顺带 **`.gitignore` 补瞬态文件**（`.heihei/` 等协作运行时文件）
- **v1.2.5**：**Onboarding 修复 + 未接线三特性移除**。① **Onboarding 修复**——主管上岗消息新增「花名册为空 / 明显不全时**等 60 秒重查（最多 5 次）**」兜底（主管往往最先被拉起，员工会话创建在其后 78~193 秒）；`forSession` 花名册**自排除请求者**（防主管把自己当员工自派）；员工会话 **title 按角色生成**（走 custom-title；仅新会话，用户改名 / 编辑路径不覆盖用户命名，失败不阻断登记）；`GET /api`（**无斜杠**）修复为与 `/api/` 同返回 JSON 名录（外层分流补条件 + 新增路由测试锁两路）。② **未接线三特性移除**（用户拍板「都不要，干净删掉」）——H5 设置区（含服务端 h5 栈 `api/h5-access` / `h5AccessPolicy` / `h5AccessService` / `staticH5` 与 4 个测试文件）、官方 provider 登录卡片（3 组件 + 3 OAuth store + api）、cc-switch 导入：**25 文件删除 + 119 键 × 5 语言清理，净删 10568 行**（发布前 `git diff --shortstat` 实测：80 files changed, +244 insertions, -10568 deletions；补刀前初审时点为 9015）；通用「本机受信 vs 远程」判定收窄为 `src/server/localRequestPolicy.ts` 保留（**非本机仍被拒**）；桌面 25 条 skip 用例随之移除（基线 skip 27 → 2）。③ 两个行为变化：**断连宽限不再可配（恒 30 秒）**——原值存在 H5 设置中；**非本机 CORS 拒绝点前移到 CORS 层**（远程仍 403）。④ 移除范围含**浏览器运行时残留与 OAuth 端点**——`desktopRuntime` 的 H5 令牌门 / `H5ConnectionView` / AppShell 渲染分支一并移除（浏览器客户端改为**直连**，非 loopback 由服务端**通用鉴权拒绝**）；服务端 `heihei-oauth` **3 个端点**移除（**回调处理器与 OAuth 服务层保留**——官方 provider 的运行时鉴权仍在用）；侧车构建探针、`src-tauri/src/lib.rs` 与 `CLAUDE_H5_*` 环境变量的 h5 残留清理（纯删除，**未 `cargo check`**——该 Rust 宿主不参与构建管线）
- **v1.2.6**：**冻结根因收尾 + 体积抑制 + 门禁扩容**。① **CLI 工具生命周期埋点**（`tool_exec_started` / `tool_result_emitted` / `tool_exec_finished`，覆盖「结果生成 → 回传」这段**此前完全无埋点**的路径；走 `logForDiagnosticsNoPII`，自带 sessionId 归因）；② **工具超时兜底**（`TOOL_EXEC_HARD_TIMEOUT_MS = 600s`，超时**强制注入 `is_error` tool_result**——消灭孤儿 tool_use / 永久悬挂；`for-await` 改 `Promise.race` 手动迭代，`iterator.return` fire-and-forget 避免清理挂死）；③ **turn 状态与 CLI 同步**（注入式回合补齐 turn：`beginInjectedUserTurn`（幂等），**interrupt 对注入回合生效**）。④ **体积抑制 S1+S3**：trace preview 上限 **240K → 32K**（日志侧约 **−87%**；只影响新写入、不动请求体）、pending 记录改记**真实体积**（修 A5a「1.2MB 记成 4.3KB」的观测盲区）、preview 改**头尾双段采样**（尾部 SSE usage 可见）。⑤ **CI `desktop-tests` 18 → 37 文件**（达「连续 ≥3 次全绿」标准；1104 tests 逐字一致）。⑥ **P3 清理**：local-index-corpus 超时与计时语义修正（套件 7 假红 → **14/14**）、`client.test.ts` 环境确定性化（9 变量保 / 清 / 还）、H5 键名兼容注释。全量桌面套件 **3565 通过 / 0 失败**。⑦ **上下文治理（批次 7 核心批）**——**M1** 单条 >48KB 截断 + **逐单元原文落盘可回查**（多块独立落盘、失败逐条如实标注，标记与落盘一致性有测试锁）；**M2** 每请求字节 debug 诊断 + 滚动 p50/p90/p99 + **60%/80% 双阀告警**（含 episode 去重）；**L1** 原子轮次历史裁剪（**恒保留首轮 + 末 2 组**、防裁散 tool 配对、可观测）；**L2** 按 model 动态窗口预算（运行时探测另立批次）；**正常会话零行为变化**（整条 ≤48KB 原样返回、L1 预算内原样返回、M2 纯观测不阻断）。⑧ **遗留清理**——两条既有测试失败**根因修复**：trace-capture ＝**宿主 env 污染**（`CC_HEIHEI_TRACE_API_CALLS=1` 由协作宿主注入；**更正批次 6 的「顺序依赖」判断**）、workspace-service ＝ `registeredRoots` **模块级跨文件残留**——**B2 报告的两个既有失败至此全部闭合**（trace-capture 单跑 66/66、desktop-ui-preferences + workspace-service 34/34）；pet 偏好端点清理 + **schema 4 → 5 迁移**（旧键剥离不回潮 + 旧夹具回归 + 404 锁定）；`check:persistence-upgrade` 脚本补注册（指向既有迁移回归测试，6/6）。⑨ **CI** 新增 `server-tests-linux-exp` **实验 job**（ubuntu、`continue-on-error`、一次性采集 Linux 失败清单、用完即撤；**与 windows 门禁并列不替换**）。全量服务端 **1628 通过 / 0 失败**
- **v1.2.7**：**三处实测反馈修复**（候选包以 `1.2.6-beta.1` 送实测通过——过程注记：`1.2.6.1` 被 electron-builder 拒，semver 仅支持三段版本号）。① **员工列表转圈图标残留**——根因 `turnInProgress` 字段在回合结束时未复位：`servantService.ts` 补回合态复位 + `Sidebar.tsx` 状态灯按真实回合态渲染（服务端 **61/61** + 桌面 **83/83** 通过）。② **「Session not found」轮询刷屏**——根因会话移除 / 进程退出后客户端无记忆、反复轮询报错：`client.ts` 增 `isSessionGone` 登记表（404 即登记）、`cliTaskStore.ts` / `teamStore.ts` 轮询按登记表短路（测试 **28+158=186** 通过）。③ **CLI 静默退出诊断增强**——根因 CLI 静默退出（如 stream read error）无任何诊断留痕：`conversationService.ts` 标记退出原因写入诊断 + 新增 `cli-exit-diagnostics.test.ts`（**5/5**；回归 **74 通过 / 1 skip / 0 fail**）
- **v1.3.0**：**地基重构——协作状态单一权威源**。`sessionRegistry`（`src/server/services/sessionRegistry.ts`：六态 `SessionPhase` registered/starting/running/crashed/stopped/deleted-tombstone + 三态 `TurnPhase` + `SessionSnapshot` 快照；硬约束 C1 仅内存态不落盘、C5 先改状态后发事件、C7 无 mock.module）+ `sessionEvents`（自写 typed 事件总线 ~60 行，不用 EventEmitter，`emitSessionEvent` 仅 registry 可调 + `assertNotReentrant` 重入断言）。把散落在 7 处的回合/忙碌判定收敛为单一权威源、断开 2 组真实依赖环（`conversationService⇄servantService`、`sessionMessenger⇄ws/handler`，经注入缝）、加 `dependency-cruiser` 分层门禁（`lint:layers`）。五阶段迁移（0 骨架 → 1 turn 收编 → 2 观察者迁移+crashed 中间态 → 3 存在性判定三分类 → 4 断环+分层门禁），每阶段独立可验证可回滚。**v1.3.1** 修复派活短路回归：tombstone 短路 + 内存态 registry 启动不重放 ⇒ 磁盘在册但未登记的会话被误判「不存在」（所有派活返回 Session not found）；新增 `isTombstoned()` 只对显式 tombstone 为真。全量服务端 **1743 pass / 10 skip / 0 fail**
- **v1.4.0**：**地基收口**。① 端口自发现：`~/.claude/cc-heihei/desktop-server.json` 契约 `{url,port,pid,startedAt}`（陈旧可识别）+ `GET /api/whoami` 探活验身份（防本机冒名服务）——解决「app 重启换端口后员工会话汇报发不出」的头号问题；② 信箱 `.ack` 回执（员工可 Read 确认送达，不必等主管口头确认）；③ `renameWithRetry` 原子落盘（`src/utils/atomicFs.ts`，EPERM/EBUSY 重试，修「保存 agent 偶发 500」）；④ 微信 `quietPoll` 节流（`adapters/wechat/quietPoll.ts`，治理 `getupdates error: -14` 刷屏）；⑤ `keep_alive` 协议对齐（心跳不再误报未知消息类型）；⑥ 花名册轮询直查提速；⑦ 验收脚本 `scheduleRunIndex/acceptance.ts` + `known-flaky` 口径（安静双跑连续两轮全绿 + 失败自动隔离复跑、flaky 三分类）。详见 `D:/xxw_p/cc-heihei-docs/v1.4.x/批次10_v1.4.0地基收口_计划_20260928.md`
- **v1.4.1**：**主管通道放行**——主管 Write 收权**放行工作目录外任意位置**（写派活 payload 到临时目录、写汇总文档到桌面等直接 Write 完成，不再绕道）；派活协议补「主管通道」说明（`src/collaboration/dispatchProtocol.ts`：明确 Write 放行范围 + 禁 heredoc 内联 JSON 防反斜杠折叠，实测 6 连 400 的根因）
- **v1.5.0**：**花名册高危数据丢失修复 + Windows/打包收口**。① `servantService.listServants()` 读路径改为**零写入**：摘要暂时不可用时仍保留花名册条目、标题退化为 sessionId 前缀；清理只由明确删除事件触发。② 新增 `pruneForDeletedSessions(sessionIds)` 兜底：一次清理涉及 ≥2 条或会清空整册时整批跳过并写 warn 诊断 `servant_roster_mass_cleanup_skipped`，采用「宁留脏条目、不静默丢协作身份」策略。③ 花名册与会话统一用 `getClaudeConfigHomeDir()` 解析配置目录。受影响版本：**v1.4.1 及更早**；根因是暂时查不到会话摘要被误判为会话删除，一个普通 GET 读请求便会写盘清空花名册。④ 收口为 Windows + Electron，移除 macOS/Linux 平台支持面与外部 IM 适配器，构建链统一到 bun；修复平台清理造成的测试断链。用户从 **v1.2.7 升级并实测通过，无 bug**。**打包/排障教训**：经运维复核，v1.5.0 首包 `win-unpacked` 内的 sidecar **确实包含修复**（命中特征 `pruneForDeletedSessions` 与 `servant_roster_mass_cleanup_skipped`）；此前因 `session-deleted-auto-cleanup` 也合法存在于新源码（作为 prune 路径的 reason 值），被误当成旧逻辑残留，导致误判打漏。今后排查必须先确认 grep 的是**当前运行的那份二进制**：按端口文件中的 pid 找到对应进程及其实际路径；诊断日志会混入多个实例事件，须依据 pid/startedAt 区分来源。打包验证只使用稳定的字符串字面量 / 日志事件名（如 `pruneForDeletedSessions`、`servant_roster_mass_cleanup_skipped`）；函数名 `getClaudeConfigHomeDir` 可能被 bundle 内联或改名，**不得作为产物验证判据**。GUI 整包首启未由运维独立验证（单实例锁阻止第二实例）；用户随后安装升级实测通过。发布说明：`release-notes/v1.5.0.md`。相关方案与执行证据保存在仓库外私有文档归档中。**版本快照只记变更结论，不外放本机绝对路径或事故细节。**

**版本快照补记（v1.5.1 → v1.7.2，2026-09-30 ~ 10-03）**：

- **v1.5.1**：协作设置弹窗重设计；角色特性文案 v2（新增架构师，35 个模板角色）；主管按花名册路由派活（内置路由表 + 动态 rosterTable 降 token）；任务台账服务端第一批（`/api/collab-tasks`）；花名册写入加队列防 lost update。
- **v1.6.0**：协作大版本——**任务台账与协作闭环**（状态机 `dispatched→accepted→in_progress→delivered→verified/rework`）、**CLI 原生协作工具**（`CollabDispatch` / `CollabReview` / `CollabListTasks` / `CollabReport`）、广播逐目标记账、文件信箱降级。本机信任边界（`127.0.0.1`、无进程级鉴权，`taskId` 非访问凭证）。
- **v1.6.1**：桌面端协作任务面板 + compact 后协作上下文续接；并行派活台账闭环。
- **v1.7.0**：六个巨型文件结构拆分（纯移动；六门面合计 **22642 → 13819** 行）；错误提示人话化；默认超时 120s → 320s；协作通知消息默认折叠；会话启动加 180s 总超时兜底。
- **v1.7.1**：错误态「人话标题 + 可折叠技术详情」、26 处瞬时提示人话化、409 文案接入；**首次跑通全量自动化测试**（src 286 / desktop 240 文件）；新增 `scripts/preflight-release.mjs` 与 `scripts/check-import-semantics.ts`。
- **v1.7.2**：修两个「会话静默假死」根因——① 协议通知用假地址（`127.0.0.1:0`）拉起主管；② 权限等待无超时（现 **有客户端 15 分钟 / 无客户端 90 秒**到期自动拒绝 + 五语言可见性）；看门狗扩覆盖「被投递程序化拉起的主管会话」；转录读取缓存（整读 3 → 1）；体积门禁口径修复（豁免 cap 优先于基线）。

**当前缺口与债务（不美化）**：

- `sessionService.ts` 未拆（豁免 `cap 3846`，续签 **1.7.3**，附条件「1.7.3 须含红灯区批次」）；`handler.ts` 豁免 `cap 3372`，同样续至 1.7.3。
- ~~**服务端（root）从来没有有效类型关卡**（root tsconfig 因 TS6 无效；类型关卡目前只覆盖 desktop 子项目）。~~ → **2026-10-08 收口（G9 类型关卡落地）**：① `tsconfig.json` 去 `baseUrl`——TS6 下带它 = 仅 1 条 TS5101、**0 文件被检的真空检查**（exit 2）；去后全量 tsc 与 `--ignoreDeprecations 6.0` 对照组**签名多重集逐项持平（5558 签名 / 7255 条，0 新增 0 消失 0 计数差）**，depcruise 3649 模块不变，`paths` 不受影响；② 闸门 `bun run lint:types`（`scripts/check-tsc-baseline.ts`）：签名 = `文件::错误码::归一化message`（数字占位、**行号不入签名**），只紧不松四规则（子集 PASS / 新增或计数超 FAIL / `--update` 同提交下调 / CI 基线相对 origin/main 防倒转）+ 真空自毁（0 诊断 exit≠0 判红）+ sanity 下限（总数 < 基线 50% 判红，拦「1 ≤ 7255」式假绿）+ 自带 node 堆旗标 `--max-old-space-size=12288`（默认堆全量 OOM exit 134）；③ 基线 `scripts/tsc-baseline.json`：**total=7255，存量=长期债务，本批只立闸门不清算**（逾期销账 = 7255 长期挂账，不设还款期）；④ 判别力双段自证：单测段 `scripts/check-tsc-baseline.test.ts` **14 pass**（新增红/计数+1 红/收敛不拦/真空红/TS5101 形态红/骤降红/全清红）+ 管道段种子补丁 `scripts/g9-seed-error.patch`（注入必红且差异清单精确指认、`git apply -R` 复原必绿、apply 失败判红）；⑤ CI 接入 `layer-lint` job 两步（主步带 `--baseline-ref origin/main` + 种子演练步）；**pre-commit 不接**（全量 tsc 分钟级，file-size <2s 才配进钩子）。
- ~~会话列表/索引族红灯批、30 处瞬时 toast 分类、第 4 处长驻点（`desktop/src/main.tsx:62` 根崩溃屏）等仍待办。~~ → **2026-10-08 收口**：红灯批＝**v1.7.3 完成**（5 缺陷 4 修 1 挂档）；30 处瞬时 toast 分类＝v1.7.1 落地 **26 处已全覆盖**（「30」为原始估算，另 4 处经复核为**排除项、非待办**——**无「4 处待补」**，见条目 12 勘误）；第 4 处长驻点（`main.tsx` 根崩溃屏）＝**按设计稿排除、非缺口**（见条目 12 勘误）。
- **「320 秒超时」专项排查进行中**：已定位为 `turn-checkpoints` 结构性 `O(m·n)` 循环的候选成因，**O(n²) 尚未证实、修法未落地**（据主管口径，未在代码/提交中核到物证）。
- v1.7.2 未验证项：渲染层视觉未真机走查、720px 短版降级未做、转录缓存「同尺寸重写 + mtime 精度」风险、`startedByDelivery` 不持久化、无客户端 15 分钟档未做 e2e。

**豁免续签记（2026-10-04）**：两条豁免（`sessionService` cap 3846 / `handler` cap 3372）`expiresInVersion` 由 1.7.3 续至 **1.7.4**，理由＝「1.7.3 已含红灯区缺陷批 ⇒ 条件达成」。**如实记录**：两文件当前**已超自身基线**（`sessionService` 3796 > 基线 3795；`handler` 3351 > 基线 3322）——续签后由 **cap 覆盖**（豁免条目按裁决二十二只按 cap 判）；该状态是「红灯批为修复批、非减行批」的直接结果，非新债。

### 已查实待修缺陷（v1.7.3+ 候选）

本轮（v1.7.2 收尾）查实、**按用户指示暂不修**的六条，逐条留档（含文件与行号；未实测的已标注）：

0. **`normalizeProjectPath` 不展开 8.3 短路径 ⇒ 同一目录两种字符串形态对不上**（**v1.7.4 候选**；CI 根因的产品侧对偶）
   - 位置：`src/collaboration/projectPath.ts:16`——归一化只做 resolve + 反斜杠转正斜杠 + 小写，**不做 8.3 短名（`RUNNER~1` 式）展开**；`sameProject`/`collabTaskService.projectHash`（`collabTaskService.ts:163`）等全部沿用该口径。
   - **CI 实证**（2026-10-04 起 multiple runs）：GitHub Windows runner 的 `os.tmpdir()` 返回 `C:\Users\RUNNER~1\…`（8.3 形态），`createSession` 内部 fs resolve 成长路径（`runneradmin`）入账，而测试以短路径串查询 → 归一化判不同项目 → 台账/会话过滤 0 条。首修 `0355134` 只治 dispatch-mailbox 一个文件，full suite 其余 **10 个测试文件 / 27 条**（searchService.sessions、collab-tasks-api、report-target-resolver、sessions、collabContext、settings、conversations、collab-cli-tools、agents-api）仍同因红（本地全绿，复跑 0绿/3红）。
   - **CI 测试侧对偶修法（已验证可行）**：各测试文件 mkdtemp 后对 `tmpDir` 过 `fs.realpath`（`0355134` 模式，逐文件套用）。
   - **影响面（真实用户场景）**：常规用户目录（`C:\Users\<名>\`）无 8.3 形态、不触发；触发面＝路径经 subst/网络映射/旧安装器残留短名/第三方工具以短路径传入 workDir 的场景 ⇒ 会出现「同一项目被拆成两个台账 hash」「花名册按项目过滤漏会话」。
   - **方向（未实施）**：归一化前对存在性路径做 `fs.realpathSync` 展开，或比较时两侧都 resolve；产品改动需后端实施并补用例。

0b. **server-full 残余 20 条＝runner 环境型已知家族（挂账，停止追查）**（**v1.7.4 候选**；2026-10-05 止，主管停止线裁决）
   - 现状：**真失败 0**——四道 gate 全绿（server-tests/desktop/layers/docs）、**本地全量全绿**；仅 CI runner 的 `Server full suite (scheduled)` 稳定红 **20 条**（searchService.sessions ×18、sessions ×4、settings ×2、collab-cli-tools ×2，聚合=文件×轮次口径），复跑 0绿/3红。
   - **已修复部分（8.3 根因，实证清零）**：collab-tasks-api、report-target-resolver、conversations、agents-api、collabContext、dispatch-mailbox 共 6 文件（`0355134` + `83575c3` 的 `mkdtempReal` 模式，RUNNER~1 日志 1059→177 次）。
   - **已排除候选（逐项有据）**：① ripgrep 可用性/版本（诊断 diff 证明 rg 阶段根本未执行）；② bun test 模块串扰（acceptance 复跑为单文件独立进程）；③ CLAUDE_CONFIG_DIR 构造时缓存（`searchService.ts:329` 为调用时直读）；④ env 注入/路径形态（trace 实测 runner 上 `fn=async () => null` 注入生效、env 为 realpath 长路径、projects stat 正常、`results` 内容正常）。
   - **保留疑点**：runner 上「`results` 正常但 `phaseAArgs`（rg mock 调用数）=0」并存——结果走了非 rg 路径且注入 null 未改变它，内部分支未明；需产品侧断点级 trace（超出测试侧取证能力）。
   - **诊断基建（已上线，`2e6ba71`）**：acceptance 复跑仍红时打印 bun test stderr 断言关键行（此前 stderr 被 pipe 丢弃）——后续任何红都可先看 diff 再动手。
   - **恢复条件**：产品侧愿意加内部 trace/断点，或 Bun/runner 环境变化后复测；在此之前每次 push 的 server-full 红按本条挂账口径解读，**不视为新回归**（真回归仍会以「红文件清单变化」形式显现，对照本条清单即可分辨）。

0c. **系统代理桥（systemProxyBridge）随 app 异常退出留下「死代理 env」⇒ 窗口期连累一切走代理的请求**（**v1.7.4+ 候选 / 偶发崩溃触发 / 用户明确指示后期再议**；2026-10-06 事故取证，未实施）
   - 机制（实证）：electron 主进程起本机代理桥并监听 127.0.0.1:<port>（`desktop/electron/services/systemProxyBridge.ts`，自 v1.0.0 `b22af51` 就存在），`sidecarManager.ts:523` 把 `CC_HEIHEI_SYSTEM_PROXY_URL` 连同 `HTTP(S)_PROXY`/`ALL_PROXY` 注入 server 与子进程环境；**app 异常退出时 bridge socket 随进程消失（无死进程残留），但已派生的 shell/CLI 子进程仍持有指向死端口的代理 env** ⇒ 窗口期内一切走代理的请求 ECONNREFUSED（投递超时、台账报「桌面服务不可用」）；重启后新主进程重建 bridge，自愈。
   - 逃逸现象（实证，2026-10-06 事故）：终端 curl 60–90s 超时 0 回执；`--noproxy '*'` 立即恢复；代理挂了会**连累所有走代理的请求**（不只 app 自身）。
   - 错误兜底疑点（候选缺陷）：日志见「System proxy bridge failed … direct: connect ECONNREFUSED 127.0.0.1:80」——**直连兜底把目标解析到 :80**，实现位置未读码定行。
   - **与 v1.7.3 无证据相关**：bridge 早于 v1.7.3 多版存在；v1.7.3 的端口文件读写统一（c09ae36/ab078e5）与 truncate 重写（d853213/2f615a0）均不触及代理路径；崩溃直接原因日志未捕获（未确定）。
   - **方向（未实施，用户裁决后期再议）**：① 客户端对 `CC_HEIHEI_SYSTEM_PROXY_URL` 先探活、不可达则剥离代理 env 直连；② `before-quit` 补 bridge 显式 stop（现只 dispose tray）；③ 协作脚本投递统一 `--noproxy 127.0.0.1` 或把 127.0.0.1 并入 NO_PROXY。

1. **Bun 1.3.14 的 `fs` 系 `truncate` 永不返回 ⇒ 两处产品路径静默挂死**（全仓 `fs` 系 truncate 共 **3 处**：`src/history.ts:391`、`src/utils/sessionStorage.ts:949`、以及已修的测试 `79b2ffe`）
   - 路径甲 `src/history.ts:391`（`await truncate(...)`）：**提示历史写入器的回滚分支**，其 `catch` 以 `historyWriterPoisoned` 兜底（标志定义 `:305`，置位点 `:371`/`:394`/`:401`）⇒ 命中即 `await` 永不返回、`catch` 不执行、毒化标记不置位 ⇒ **静默挂死**（不报错、不自愈）。
   - 路径乙 `src/utils/sessionStorage.ts:949`（`await fh.truncate(absLineStart)`）：会话存储**「按 uuid 移除单条会话条目」**路径（定位块 `:928` 起：尾部窗口找 `"uuid":"<targetUuid>"` → 前后换行定行 `:931-942` → 记 `absLineStart` 与 `afterLen = bytesRead - lineEnd` `:944-945`）。**两个分支都会挂**：`afterLen === 0`（删的是**最后一条**，常见）**直接命中**——纯 ftruncate 即挂死；`afterLen > 0` 时 truncate 即便成功，随后 `await fh.write(tail, lineEnd, afterLen, absLineStart)`（`:950-952`）**补尾部时挂住 ⇒ 尾部永久丢失**。**发生情形＝删除/移除一条会话条目时，不是每次写文件**。⚠ 注释里「afterLen 为 0 时这是一次 ftruncate」（`:946-948`）**只是注释、不是免死金牌**——**读注释不等于执行**：0 与 >0 **两条路径都命中该缺陷**（后果不同：前者直接挂死、后者尾部丢失）。
   - 探针结论（后端，**9/9**）：**3 种 API × 3 个方向（缩短 / 等长 / 变长）全部挂死**，三种 API 无差别 ⇒ **缺陷在 Bun 底层（同一 syscall 封装），不在 JS 糖层** ⇒ **「换 API 绕开」不可行**，只能**换操作方式**（如重写语义）**或升级 / 降级 Bun**。
   - 触发：需走到上述任一分支 + 该 Bun 版本。
   - 证据来源：后端探针（逐步耗时：该步 3000ms 触发守卫、同序列其余每步 0–3ms；**9/9 全挂**）+ 代码阅读（行号如上）；提交 `79b2ffe`（测试侧 `sourceFingerprint.test.ts` 已改 `writeFile` 绕过，正文点名产品侧同 API 命中 `src/history.ts:391`，已单独立项）。
   - 方向（未实施）：**换操作方式**（重写语义、绕开 truncate）或**升级 / 降级 Bun**；**「换 API」已被 9/9 证伪**。
   - 上游：**1.4.2 / 1.4.1 / 1.3.1 changelog 页均未见对应修复条目**；**issue 库未搜** ⇒ **升级能否根治未证实**（保持未确认口径）。

2. **端口文件跨实例污染**（隔离实例覆盖真实应用的端口记录）
   - 根因：端口文件目录由 `desktopServerInfoDir(home = os.homedir())` 决定（`src/server/services/serverIdentity.ts:152-154`），**`CLAUDE_CONFIG_DIR` 与 `--user-data-dir` 都不参与**；写入点 `writeDesktopServerInfo`（`:164-193`）**唯一门控**是 `isDesktopSidecarProcess()`（`:168-174`），只拦「非正式 sidecar」。
   - 后果：跑一个隔离实例**必然覆盖**真实应用的端口记录 ⇒ 任何读该文件的工具（员工汇报路径、CLI 投递）打到错实例。
   - 触发：真实应用与一个被判为「正式 sidecar」的隔离实例并存。
   - 现状/缓解：v1.6.0 的 60s 巡检自愈（`:196`、`:211-215`）能夺回，但**污染期间**别人已读错。
   - 证据来源：代码阅读；旁证 `serverIdentity.ts:201-204` 记载 **2026-09-30** 同类覆盖事故（当时只加 `NODE_ENV !== 'test'` 门控 ⇒ 同一坑漏了两次）。主管另给 `src/server/index.ts:512-524` 注释（**此项我未逐行核**）。
   - 方向：端口文件路径纳入 config 目录参与；或增加实例身份校验。

3. **台账 replay 零容错**（缺字段即整份台账加载失败）
   - 根因：`src/server/services/collabTaskService.ts` 的 `cloneTask`（`:181-187`）对 `deliverables`/`history` 直接 `[...task.deliverables]` / `task.history.map(...)`，**无任何兜底**。
   - 后果：任何缺这两个字段的台账行（手写行、旧版本写的行）会让**整份台账加载失败**（而非跳过坏行）。同模块对 `fromRole` 有旧数据兼容先例（`:74`/`:149` 可选、`:423` `?? 'other'`）⇒ 兼容口径未覆盖全。
   - 触发：台账 JSONL 出现缺 `deliverables` 或 `history` 的行。
   - 证据来源：代码阅读（行号如上）。
   - 方向：缺失字段 `?? []` 归一 + 单行解析失败隔离跳过并记诊断。

4. **`turn-checkpoints` 结构性 O(m·n)**（「320 秒超时」根因候选）
   - 根因：`src/server/services/sessionRewindService.ts:919` 起的 `listSessionTurnCheckpoints` 逐轮 `findIndex`（`:933`）+ `hasCompletedTurn`（定义 `:400`，调用 `:937`）⇒ 每轮线性扫全量消息，合计 O(m·n)；服务端无 in-flight 合并 ⇒ 并发双发放大。
   - 后果：长会话下 checkpoint 拉取排队变慢；客户端那条 `Request timed out after 320s` 是**误报**（只断连接、业务仍在跑）⇒ 另有「**误导性报错**」应独立修（区分超时与业务失败）。
   - 触发：轮数与消息数都大时。
   - 证据来源：代码阅读 + 后端整目录副本重测（进行中）。
   - **口径更正（2026-10-04，后端实测）**：**`O(n²)` 已证伪** —— 三个真实会话（6664 / 12939 / 20303 行，只读副本）实测：
     `listSessionTurnCheckpoints` 耗时 **2.1s / 70.7s / 54.5s**，**中档比大档慢**（非单调），且小→中 checkpoints 只 +4% 而耗时 ×34
     ⇒ **与规模无关、与条目数无关**；同一测量里 `getSessionMessages` 258/376/647ms 呈 **≈O(n)** 作对照。
   - **新结论（CPU profiler，仓库外副本 + `bun --cpu-prof`）**：该端点 68.8s 的一次跑里 **82.9% 采样落在运行时正则引擎内部**
     （`execEditLength` @ base.js:65；`addToPath` 2.9%、`equals` 1.4%、`regExpSplitFast`/`stringSplitFast`），
     而产品逻辑帧合计 <1%（`sessionRewindService.ts:391` 0.56%、`:933` 0.30%、`sessionService.ts:3400` 0.30%）
     ⇒ **「几十秒」= 内容相关的正则匹配代价**（疑 `:88` 全文 `replace(/
/g)` / `:449` 全文 `split(/
||
/)`，
     **未逐一证实**）——这也解释了「与规模不单调」「大档反而更快」与那次 >10min 无返回。
   - **修法仍未落地**：方向从「Map 索引替代逐轮扫描」改为「**定位并替换引发运行时正则爆炸的调用**」（逐正则微探针 → 换实现，如手写扫描/预normalize 一次）。
   - **收口（2026-10-04，后端；本批到此为止）**：**已知慢点·成因未定** —— ① 逐正则微探针：三条候选正则（`:88` 全文 replace / `:449` 全文 split / `:500` 逐行 match）实测 **14 / 37 / 15 ms**（输入 83MB，合计 ≈0.1% 于端到端）⇒ **全部排除**；
     ② 调用树归因（重跑 profiler，取热点运行时帧的父帧）：**未归因到产品帧**（该次快跑 4.1s 内根本不出现 `execEditLength` 大占比）；
     ③ **关键新事实：同一输入耗时极不稳定** —— 同一份 83MB 转录，四次实测 **4.1s / 54.5s / 68.8s / 70.7s（差 ~17×）** ⇒ **不是稳定的算法复杂度问题**，
     更像**外部状态相关**（磁盘/页缓存/内存压力或 JIT/GC 状态）；上轮那条 82.9% `execEditLength` 的 profile 取自 68.8s 慢跑，**在快跑里不出现** ⇒ 
     「正则热点」可能是**果而非因**（推断，需更多样本才能证实）。
   - **实测口径（供后续复查）**：`listSessionTurnCheckpoints` 在 6.6k/12.9k/20.3k 行三个真实会话上 **2.1s / 70.7s / 54.5s**（中档>大档，非单调），同测 `getSessionMessages` 258/376/647ms≈O(n) 作对照。
   - **下一步（未实施）**：若要继续追，需要**多次采样 + 记录同刻的系统状态**（内存/磁盘/负载）来区分「状态相关」与「内容相关」；
     **本轮零代码改动**（`sessionRewindService.ts` 一行未动）。
5. **协作设置弹窗对「不在花名册的会话」永久停在加载态**（无失败态）
   - 症状：对**不在花名册里的会话**打开「协作设置…」，弹窗永久停在「正在加载原设置…」（隔离演示实例观察 25s 不消失），无错误态、无超时、无重试；提交按钮同时被锁死。
   - 代码位置：`desktop/src/components/servants/ServantSessionModal.tsx:75`（`editingLoading = mode === 'edit' && !existing`）、`:428-431`（渲染仅「加载中 / 表单」两分支，无 error 分支）、`:319`（`canSubmit` 被 `!editingLoading` 连带锁死）。
   - 根因：`!existing` **无法区分**「花名册未加载完」与「花名册无此条」⇒ 后者恒真 ⇒ 永久加载态。
   - 复现：**API 建出的野会话**右键 →「协作设置…」，**必现**（隔离演示实例两轮复现）；等价做法＝把会话移出花名册，或让花名册接口不返回它。
   - 影响面：**已实证**＝花名册无此条时必现；**推测（未实测）**＝花名册接口失败/返回空时，用户同样会永久转圈且无提示。
   - 修复方向（未实施）：用 store 的 loading/error 标志区分「加载中 / 加载失败 / 确实没有」，给出明确失败态 + 重试或转新建，并给加载上限兜底。
   - 证据来源：本轮（2026-10-04）换截图时由运维脚本在**隔离演示实例**发现，后端读码定性。
6. **`removeMessageByUuid` 快路径的历史数据丢失面**（**既有债务、非本批引入**）
   - 现象：快路径只读文件**最后 64KB**（`LITE_READ_BUF_SIZE`）找 needle；若「needle 落在窗口内、而其后的内容超出窗口」，则算出的 `afterLen` 覆盖不到窗口外的尾部 ⇒ **旧的 truncate 版与新的重写版同样丢尾巴**。
   - 依据：`sessionStorage.ts:902-904` 的注释「the target is almost always the most recently appended entry」是其放行理由——**这是概率假设，不是保证**。
   - 影响：既有数据丢失面（**不是本批引入**）；触发条件窄（目标行不在末尾且其后存量 > 64KB）。
   - 方向：v1.7.4 候选——needle 不在窗口末尾时**回退慢路径**（慢路径已有 `MAX_TOMBSTONE_REWRITE_BYTES` 上限保护）。
   - 证据来源：独立审查 def979f9 + 后端读码（2026-10-04）。
7. **`rosterDigest` 用动态 import 取 servantService ⇒ `lint:layers` 真红（B2 遗留）**（**已修**，2026-10-08；单开一条＝本项，与 B1-1 结构拆分同批顺手做掉）
   - 症状：`lint:layers` 在 HEAD 上稳定红 1 条——`no-dynamic-import-in-services: src/server/services/rosterDigest.ts → src/server/services/servantService.ts`；`--no-ignore-known` 全量 19 条违规里**唯一未登记**的那条（另 18 条为既有 known，含两条 servantIncidentNotifier）。
   - 根因：`bc55ac0`（B2 花名册摘要）用**动态 import** 取 `servantService` 以绕开 `conversationService → rosterDigest → servantService` 静态环——环绕开了，却踩了服务层「禁动态 import」的门禁规则。
   - 修法（`4f89606`）：改**注入缝**——`rosterDigest` 不再 import 任何业务模块，由装配根 `src/server/index.ts:52-56` 的 `registerRosterDigestDeps({ listServants: () => servantService.listServants() })` 注入，形态与既有 `registerServantInfoSource` / `registerServantIncidentDeliver` 同款；未装配 ⇒ 不注入（单测直调等价于无摘要）。
   - 降级加固（`3d36d43` + `9328a65`）：`listServants()` 读失败**不得冒泡**——摘要挂在**每条注入消息**通路上，读失败会阻塞**所有投递**（严重故障面）⇒ catch 后返回**原文、不加摘要**（对齐 `servantInfoSource` 的「加强项不得阻塞」口径）；并按 `diagLogs` 的无 PII 契约**只记 `error.name`**（事件名 `roster_digest_list_failed`，warn 级），**不记可能带路径的 `error.message`**。
   - 实测：`lint:layers` 由 1 error → ✔ 无违规；`--no-ignore-known` 违规 **19 → 18（净减 1、零新增）**⇒ 无其他环；用例⑥（注入器抛含路径的错 ⇒ 原样送达 + 有痕迹 + data 不含路径）；判别力自证两轮＝摘掉 try/catch 仅⑥ 判红、改回 error.message 仅⑥ 判红。
   - 同风险既有用法见条目 8。

8. **候选：`data.error` 落 `error.message` 的同类 PII 风险**（**候选，未动**；2026-10-08 登记）
   - 位置：`src/server/api/computer-use.ts:243` 与 `:258`（事件 `computer_use_runtime_files_failed` / `computer_use_permission_parse_failed`）、`src/server/api/servants.ts:221` 与 `:244`（事件 `collab_report_redirected` / `collab_report_target_ambiguous`）。
   - 风险：这些 `data.error` 直接落 `error.message`，而 fs 类错误的 message 可能带路径 ⇒ 与 `diagLogs` 的「MUST NOT 含 PII（含路径）」契约同风险（条目 7 同款缺陷的遗漏面）。
   - 现状：**未动**（2026-10-08 主管裁决「本轮别去动」）；如需收口，改法与条目 7 同款（改记 `error.name` 或固定串）。
   - 证据来源：代码阅读（行号如上）。

9. **B1-3 任务通知持久化组外移**（**已实施** ✓；2026-10-08 登记、当日作为 B1-3 落地）
   - **落地形态**：新模块 `src/server/ws/taskNotificationPersistence.ts`（59 行）：表 `taskNotificationPersistence` + 函数 `persistCliTaskNotification`（**逐字节搬移**，比对口径＝去掉 `export ` 前缀后与 `HEAD` 原文完全一致；原文 962 字符 / 新 969 字符，差值恰为 `export ` 7 字符）+ 三个控制原语：`forgetSessionTaskNotifications`（原 handler `delete(sessionId)` 点）、`resetTaskNotificationPersistenceForTests`（原 `__resetWebSocketHandlerStateForTests` 内 `clear()` 点）、`__persistCliTaskNotificationForTests`（同名再导出给测试用）。
   - **handler 走线（读写点已 grep 列全后逐个改调）**：定义 `:312`（删）→ 迁出；`normalizeCliTaskNotification` 的 import（`:115`，搬走后 handler 内零使用 → 同时删除该 import 项）；会话销毁 `:1589`（→ `forgetSessionTaskNotifications`）；函数体 `:2521-2552`（删）；调用点 `:2600`（保留原调用，改由新模块 import）；测试复位 `:3198`（→ `resetTaskNotificationPersistenceForTests()`）；再导出 1 条（`export { __persistCliTaskNotificationForTests } from './taskNotificationPersistence.js'`）。
   - **实测结果**：handler **3251 → 3227（−24）**（新模块 59 行不计入 handler）；**导出面机检 31 → 31、丢失 0、新增 0**（机检在动笔前先跑基线确认含目标符号）；表定义点全仓**唯一**（`grep "new Map<string, Map<string, Promise<void>>>()"` 命中 1 处，在 新模块 `:16`）。
   - **承重性自证**（破坏必判红）：把去重分支改成 `if (false && existing) return existing` ⇒ **恰好一条用例判红**（`background task notification persistence > normalizes and persists one terminal SDK event for multiple observers`，`Expected: Promise { <pending> } / Received: serializes to the same string`），另 2 条仍绿 ⇒ 证明新模块的去重真在判定路径上、handler 内无残留副本；复原后 `sha256` 逐字节校回 `e1775780…`、3 pass / 0 fail。
   - **测试**：`task-notification-persistence` + `websocket-handler` + `conversations` + `collab-push` + `conversation-status` 合并跑 **169 pass / 0 fail**（`env -u CLAUDE_COMPUTER_USE_ENABLED`）；三绿门禁 PASS（layers 3636 模块 / file-size / import-semantics）；`tsc --ignoreDeprecations 6.0` **总数 7255 == 基线、零新增**（handler 仍 4 条既有错误、仅行号前移 472→481 等）。
   - **未并入 B1-2 的理由**（主管采纳）：语义属「转录持久化」而非「活动状态」；且它比前两批多一条导出面再导出 + 两条新依赖边，混做会把两件事的验收搅在一起。
   - **新增依赖边 2 条**（已核实不成环）：`services/sessionService.js`（`appendSessionTaskNotification`）、同目录 `handlerPures.js`（`normalizeCliTaskNotification`）。
   - **方法论教训（本轮踩到）**：`tsc` **不可与文件改动并发跑** —— 我这次的破坏性实验与后台 tsc 并发，tsc 读到半破坏态文件、多报 1 条（`taskNotificationPersistence.ts(34,26) TS2322 … 'Promise<void> | undefined'`）；安静态重跑即 7255/零新增。凡「零新增」类证据，必须在**代码静止**后测。

10. **【测试卫生真缺陷·已修】协作推送 250ms 合并窗口未随用例复位 ⇒ 跨文件顺序依赖假红**（2026-10-08 登记并修复；**不进 `scripts/known-flaky.json`**——它是**确定性**缺陷，登记进去会误导后人以为「重跑就好」）
   - **现象**：`bun test <文件A> <文件B>` 单进程多文件跑时，若先跑的文件里有用例在 C12 之前 ~250ms 内发过 `session_list` 信号，则 `websocket-handler.test.ts` 的 C12（`merges bursty session_list signals into one epoch broadcast`）必红：**Expected 5 / Received 193~199**。单跑该文件恒绿 ⇒ 典型「顺序依赖假红」（与产品行为无关）。
   - **污染源定位（探针实测，非推断）**：`src/server/ws/handler.ts` 的 `pendingListEpoch` + `listMergeTimer` 是**模块级**合并窗口状态，只有专用钩子 `resetCollabPushBroadcastForTests()`（`:3111`）会清；而共享的每用例复位钩子 `__resetWebSocketHandlerStateForTests()`（`:3195`）清掉了十几项状态却**漏了这一对** ⇒ 上一个用例残留的**未超时窗口**把下一个用例自己的信号并了进去。探针输出（原序跑，修前）：
     `[PROBE] signal e=199 timerPending=true pending=198 t=…567` → C12 自己的 `e=3/5/4 timerPending=true pending=199`（三次发射全被吞）→ `[PROBE] timerFire e=199` ⇒ 广播出「别人的」epoch 199（期望 5）。
   - **修法**（`3251` 行，+4）：在 `__resetWebSocketHandlerStateForTests()` 末尾追加一行 `resetCollabPushBroadcastForTests()`（含 3 行注释说明成因）；未动门禁、未加白名单、未改产品行为（该钩子是 `__` 前缀的测试缝，生产不调用）。
   - **原序复跑证据（修后，探针同步显示窗口已独立）**：`[PROBE] signal e=3 timerPending=false pending=null` → `e=5 pending=3` → `e=4 pending=5` → `timerFire e=5` ⇒ **C12 绿**。
     · 序A（`conversations.test.ts` → `websocket-handler.test.ts`，修前必红）：修后 **17/17 连绿**（146 pass / 0 fail）
     · 序B（`conversation-status`/`websocket-handler`/`ws-memory-events`/`task-notification-persistence`/`conversations`/`agents-api`，上轮失误序）：**206 pass / 0 fail**
     · 另序（`collab-push`+`collab-task-service`+`websocket-handler`）：87 pass / 0 fail
   - **残留未确定项**：修后另有 **2 次**（序A 1/18、5 文件批 1/15）出现过「1 fail」，我**只读了 tail 未留失败行**（自曝失误）。此后共 ~30 次连跑均未复现；怀疑是同批内既有的 harness 级偶发（`conversations.test.ts:3459` socket closed 在修前也见过一次），**与合并窗口泄漏无关**（泄漏路径已被探针证伪）。
   - **通用纪律（2026-10-08 主管采纳，适用于全部后续批次）**：凡「改动后需证明测试行为」的交付，**必须捕获失败行原文**——`tail`/计数摘要**不算证据** ✗（上面的残留偶发正是因为只读了 tail，才至今无法定位）。跑测试时一律重定向到文件、失败时 `grep` 出 `(fail)` 行 + `Expected/Received` + 调用栈原文再回报。
   - **通用纪律·第二批（2026-10-08 主管升级，适用全部后续批次）**：凡「**零新增**」类证据（tsc 错误数、门禁计数、导出面差集、行数基线…）**必须在代码静止后测** ✗ —— 反例实证：我曾在后台跑 `tsc` 的同时做破坏性实验，tsc 读到**半破坏态**文件而多报 1 条（`taskNotificationPersistence.ts(34,26) TS2322`），我差点据此去「修」一个不存在的 +1，靠最小复现探针才拦住；安静态重跑即 7255 == 基线。**口径：产出结论性数字之前，不得有并发的文件改动（含自己的实验插桩）。**
   - **记名排队**：「潜伏偶发」专项批次（2026-10-08 主管裁决**记名 + 排队**，**本轮不做** ✗，还债批优先）——目标：定位上述 2 次未留证的「1 fail」；执行纪律＝失败行原文捕获（见上）。
   - 证据来源：探针插桩实测（插桩后已逐字节撤净，`git diff` 只余 +4 行）+ 序列复跑。

11. **handler 剩余可外移域普查（2026-10-08，B1-3 之后；只普查不动手）**
   - **口径（可复核）**：`node D:/xxw_p/hh-dispatch/handler-survey.js`（只读脚本，仓库外）。定义：**跨度** = 本顶层声明首行 → 下一顶层声明前一行（含块间空行与紧贴下一块的注释，故略偏高）；**净估** = 跨度 × 0.73（由 B1-3 实测校准：表 1 行 + 函数 32 行 = 跨度 33 ⇒ handler 净 −24）。实测总量：文件 **3228** 行 = import/常量段 151 + 顶层块 3077（135 个 declaration）。基线表 `src/server/ws/handler.ts = 3322, kind: own`（**own ⇒ 文字标准 ≤2500**，现 3227 已比基线低 95）；豁免条目 cap 3372 / 过期版 1.7.4。
   - **域清单（跨度 / 净估 / 跨域引用个数 = 域体出现的域外顶层名计数）**：
     | 域 | 跨度 | 净估 | 跨域引用 | 判断 |
     |---|---|---|---|---|
     | **T0 传输枢纽族**（sendToSession/broadcastGlobalEvent/broadcastTurnChangeListener/add-removeActiveClient/bind*ClientSessionOutput/sendError/closeSessionConnection/…13 块） | 196 | ≈143 | 11（activeSessions×8、WebSocketData×5、sendMessage×4、clientOutputCallbacks×3、globalEventClients…） | **必先做**：叶子模块，附带走三张连接表 + `sendMessage`/`WebSocketData`；做完后其余域才可能不踩新环 |
     | **D1 CLI 消息翻译域**（translateCliMessage 562 + 4 小件） | 610 | ≈445 | 10（SessionStreamState/getStreamState/resetCurrentStreamAttempt/cliParentToolUseId/sessionStopRequested/sessionSlashCommands…） | **单域最大**；零服务 token（不碰任何 services）⇒ 环险最低；需把流状态小件一起下沉 |
     | D2 标题生成域（7 块） | 185 | ≈135 | 7（sessionTitleState×4、WebSocketData×4…） | 低-中；需带走 sessionTitleState 表 |
     | D3 运行时配置/权限/重启域（15 块） | 468 | ≈342 | 18（WebSocketData×8、sendMessage×6、sendToSession×3、runtimeOverrides×3…） | **与 D4 双向交织**（D3↔D4 互引 buildSessionStartupDiagnosticMessage/getRuntimeSettings/isKnownRuntimeProviderId）⇒ 建议与 D4 **合成一批**，否则拆开必成新环 |
     | D4 运行时设置读取/诊断域（6 块） | 254 | ≈185 | 12（providerService×3、settingsService×2、runtimeOverrides、sessionStreamStates…） | 同 D3 |
     | D5 断开清理/回合看护域（5 块） | 148 | ≈108 | 12（sessionCleanupTimers×3、hasPendingOrActiveUserTurn×3、hasActiveClients×3…） | 中；**依赖 D3/D9/D11**，批序靠后 |
     | D6 预热域（6 块） | 165 | ≈120 | 15（sessionStartupPromises、prewarm*、prewarmedSessions、runtimeOverrideVersions…） | 中；需先下沉「会话生存期状态族」 |
     | D7 权限重放/computer-use 域（4 块） | 84 | ≈61 | 3（WebSocketData、sendToSession、sendMessage） | 体量小但**环险最高**（见下）⇒ 必须走注入缝 |
     | D8 广播域（协作推送/花名册/权限超时，4 块） | 103 | ≈75 | 5（broadcastGlobalEvent×2、pendingListEpoch×2、SESSION_LIST_MERGE_MS…） | T0 之后即易做 |
     | **D9 主循环/分派**（handleWebSocket 228 + handleUserMessage 166 + …4 块） | 445 | ≈325 | **43** | **建议不动**（43 个跨域引用 = 它就是汇聚点，动它收益最低、风险最高） |
     | D10 斜杠命令域（2 块） | 49 | ≈36 | 3 | 易做；被 `api/sessions.ts` + `sessionComponentReloadService` 消费 ⇒ 需再导出 `getSlashCommands`/`updateSessionSlashCommands` |
     | D11 会话清理/测试缝（3 块） | 52 | ≈38 | 21（复位器必然触全表） | **最后做**（等各表随域搬走后复位器自然瘦身） |
   - **依赖边风险（三类环，都是「新增即门禁红」）**：
     1. **新模块 ⇄ handler**：新模块**不得** import handler 的任何符号（`sendToSession` 等）——handler 已 import 新模块 ⇒ 反向 import 即 `no-circular` 新违规。**这就是 T0 必须先下沉的原因**（T0 一旦成为叶子，D3/D5/D7/D8 里那 3 处 `sendToSession` 引用才合法）。
     2. **新模块 → computerUseApprovalService / sessionComponentReloadService / teamWatcher**：这三个 L2 服务**import 了 `ws/handler`**（既有冻结），新模块若 import 它们 ⇒ 组环。**既有断环先例**：`sessionActivity.ts:16-21,191` 用注入缝 `registerSessionActivityDeps`（装配根注入）——**D7（computer-use 请求）与 D5（`scheduleDisconnectCleanup` 触 `computerUseApprovalService.cancelSession`）必须走同一口径**，不得直连。
     3. **L2 → L4 禁令**：任何新模块必须留在 `src/server/ws/**`（L4）。若下沉到 `services/**` 则 3 个服务反向依赖会变成层级违规。
   - **冻结清单 18 条中涉 handler 的 4 条**（`.dependency-cruiser-known-violations.json` 实测，条数以该文件为准）：`layer-L2-no-upward` ×3（computerUseApprovalService / sessionComponentReloadService / teamWatcher → `ws/handler`）+ `no-circular` ×1（computerUseApprovalService → `ws/handler`）。本专项只需**不新增**；T0 下沉后**可**让这 3 个服务改指叶子模块从而收敛冻结，但**收敛＝改动 L2 服务 import 面，需另行裁决**。
   - **handler 导出面必须逐批保住**（非测试外部消费方实测 11 个绑定 + 1 类型）：`api/conversations.ts` ← `clearLegacySessionChatState, getSessionChatActivityState, markSessionChatQueued`；`api/sessions.ts` ← `closeSessionConnection, getSlashCommands, interruptSessionRuntime`；`index.ts` ← `handleWebSocket, WebSocketData`；`computerUseApprovalService` ← `sendToSession`；`sessionComponentReloadService` ← `updateSessionSlashCommands`；`teamWatcher` ← `sendToSession, getActiveSessionIds`。**口径不变：机器机检「HEAD 导出面 vs 工作区导出面」差集为空（当前 31 项）。**
   - **总判断：可达 ≤2500 ✓，但绝非一批之功**。需净减 ≥728。最小可行组合实测推演：T0(143) + D1′(≈490，含下沉小件) = 633 ⇒ 2595 **仍不达标**；再叠 D8(75) → 2520 **仍差一点**；再叠 D10(36) → **2484 ✓（余量仅 16，不建议就此收手）**。稳妥组合：T0 + D1′ + D4(+D3) + D8 + D10 ≈ 929 ⇒ **≈2299**（余量 201）。彻底组合再叠 D2(135) + D6(120) ⇒ **≈2044**。**建议批序：T0 → D1′ → (D3+D4) → D8 → D10 → D2 → D6 → 视余量收口；D5/D7 走注入缝，D11 最后，D9 不动。**
   - **未确定项**：① 跨度口径含块间空行，**净估误差 ±10–15%**，实际以每批落地后 `wc -l` 实测为准；② `sendMessage`/`getActiveSessionIds`/`getSlashCommands`/`clearLegacySessionChatState` 等小符号的**当前定义点未逐一确认**（T0 批开工前须 grep 确认是 handler 本地还是已外部化）；③ D3/D4 交织的具体最小拆分点需在开工前做一次跨域引用复查；④ 本清单未覆盖 handler 头部 151 行 import/常量段里可下沉的实例（`settingsService`/`providerService` 等）。

12. **G11 勘误（2026-10-08）：根崩溃屏非缺口；toast 无「4 处待补」**（只读核账纠错，**代码零改动**；主管同日裁决 A+D 结案）
   - **背景**：还债批 G11 开工项据《框架改造目标对账_2026-10-08.md》把「`main.tsx` 未套 `describeApiFailure`（grep 0 命中）＝未做」与「toast 26/30、剩余约 4 处待补」列为缺口。全量普查后**两条前提均与代码不符**，故登记本勘误更正对账/交接口径。
   - **勘误①（根崩溃屏）——按设计稿排除、非缺口**：`main.tsx` 的兜底**套不了也无需套**。① `main.tsx:56-77` 自有兜底在生产是**死路径**：`desktop/index.html:196` 内联脚本已在**模块加载前**注册 `window.__CC_HEIHEI_SHOW_STARTUP_ERROR__`，`main.tsx:59` 命中即 delegate ⇒ 自有兜底**永不执行**（仅测试删 hook 才走到）。② **真·生产根崩溃屏 = `desktop/index.html:196` 的 `renderStartupError`**（监听 `error`/`unhandledrejection` + 8s watchdog），该处**在模块之前、只能内联双语，无法访问 `describeApiFailure`/i18n**。③ bootstrap 错误（动态 import 失败、root 缺失）**非 `ApiError`**，kind 恒 `undefined` ⇒ 套用**近零作用**（仅 `KNOWN_SERVER_MESSAGES` 分支，而该处不可能命中）。④ 设计稿 `设计_v1.7.1_错误技术详情折叠.md` §5 **已显式排除**该处（「React 挂载前的根崩溃屏，无 i18n 上下文，属另一套」），且 v1.7.1 的「双语静态标题 + `<pre>` 原始串」已获设计师裁决**「接受」**。⇒ **非缺口，不改代码**（此处白屏已由 index.html watchdog + ErrorBoundary + 死兜底三层覆盖）。
   - **勘误②（toast）——26 处已全覆盖，无待补**：v1.7.1 的「**30**」是**原始估算**（《架构决策_v1.7结构拆分边界.md》:612/640 要求产「30 处 toast 清单」，估算值）；`5819f20` 以 **addToast 实锚**重勘 = **26 真 toast + 4 非 toast**（`TraceSession:145`、`FilePreview:116` 为 `setState` 内联，`EmptySession:354` 已走 `resolveCreateSessionErrorMessage`）。⇒ 「30−26=4 处待补」是**对估算值的误读**——那 4 处是**排除项、非待办**。**现行全量普查（70 处 addToast）确认无「未接映射表」的 API 错误 toast**：27 处走 `describeApiFailure` + 1 处 `resolveCreateSessionErrorMessage` + 余为 i18n 键/成功提示/结果计数。

13. **G11 收尾两笔债务（2026-10-08 登记，本批不改）**
   - **债① `Market.tsx:75` 卸载错误直出原始串**（**真缺口**，待设计师出稿后单开一小批）：位置 `desktop/src/pages/Market.tsx:75`（`addToast({ type: 'error', message: error.message })`）。与**同页安装态 `:50`**（走市场自有分类 `market.installError.*`）及 **skills 页姊妹路径 `SkillDetail.tsx:111`**（同调 `marketApi.uninstall`，**已走 `describeApiFailure`**）**不一致**。修法＝需**卸载专用 6 键 × 5 语言 + 设计师定文案**（现有 `market.installError.*` 六键文案均为「**安装**失败：…」，`zh.ts:2284-2289`，直接复用到卸载会出错文案）；市场为**自有分类** `MarketInstallErrorKind`（`marketStore.ts:15/26`），非 `describeApiFailure` 的三类口径。证据：代码阅读 + 全量 toast 普查。
   - **债② `PluginDetail.tsx:138` 的 kind 已在 store 丢失**（登记待议）：位置 `desktop/src/components/plugins/PluginDetail.tsx:138`（`addToast({ type: 'error', message: error })`，`error` 取自 `skillStore.error`）。`skillStore.ts:61,87` 只存 `err instanceof Error ? err.message : String(err)` ⇒ **kind 在 store 丢失**，机械套 `describeApiFailure(undefined, …)` 仅 `KNOWN_SERVER_MESSAGES` 分支可能生效（而 skill 详情失败不会产生跨项目 409）⇒ **用户可见改善≈0**。真修需 **store 保留 kind**（形状变更）⇒ 登记待议。证据：代码阅读 + 全量 toast 普查。
   - （另有 2 处 borderline 未列修，如实记：`PluginDetail.tsx:80` 的 `reloadWarning` 原文嵌入「已应用但重载失败」警告＝**有意暴露原因**；`:156/:183` 的 `Unable to locate agent/MCP server` 为**开发向英文、非 API 错误**。）

### 能工作的
- **v1.5.0 用户实测**：用户从 v1.2.7 升级后确认无 bug。`release-notes/v1.5.0.md` 与 README 定位一致：花名册高危修复、Windows 专属、移除外部 IM 适配器、bun 打包链；本地模型仍可用但已冻结，不参与协作会话。
- **本地模型（冻结的可选功能）**：现有设置页、跑分、启动、下载中心、多模态、自定义引擎仍可用；不再新增功能、不参与协作会话。核心产品方向是会话级协作。
- llama.cpp b10786（比上游 release v0.3.0 新）

**v1.5.0 花名册修复与打包教训**：`servantService.listServants()` 读路径零写入；`pruneForDeletedSessions` 仅响应明确删除事件，批量 ≥2 条或清空整册时拒绝并记诊断；配置目录统一使用 `getClaudeConfigHomeDir()`。运维复核确认首包 `win-unpacked` 内的 sidecar 已包含修复；此前误判是把新源码中仍合法存在的 `session-deleted-auto-cleanup` reason 字符串当成旧逻辑证据。**以后排查先按端口文件 pid 找到当前服务进程的实际二进制路径，再对那份二进制 grep 稳定的修复字符串字面量 / 日志事件名**（本次用 `pruneForDeletedSessions`、`servant_roster_mass_cleanup_skipped`）；不要把函数名 `getClaudeConfigHomeDir` 当判据（bundle 可能内联或改名）。诊断日志可能混入多个实例的事件，必须结合 pid/startedAt 区分来源，避免误归因。不能只凭构建命令成功或 exe 存在认定修复已进包。**以后打包必须对正在运行的实际产物验证修复特征串，避免只查错产物。** 用户随后安装 v1.5.0 从 v1.2.7 升级实测通过。发布说明见 `release-notes/v1.5.0.md`。相关过程材料已在仓库外私有归档。 GUI 整包首启未由运维独立验证（Electron 单实例锁阻止第二实例）；之后用户安装 v1.5.0 从 v1.2.7 升级实测通过。发布说明见 `release-notes/v1.5.0.md`。相关过程材料已在仓库外私有归档。 

### 已知问题 / 待办
- ~~**v1.6.0 路线：原生协作 + 任务台账**~~ → **已交付（v1.6.0 / v1.6.1）**：持久化任务台账 + 原生协作工具 + 任务面板已上线，流程保持全自动、**不增加人工审批点**。当前协作缺口见上方「版本快照补记」的缺口与债务。
- **新增需求：协作设置弹窗重设计**——提供行业/场景模板（至少软件开发、小说写作等），便于用户按用途快速配置主管与员工角色；交互与模板范围待产品设计细化。
- **桌面 vitest 基线已清零，豁免也已清理**（v1.1.2 → v1.2.5）：历史遗留 14 失败文件 / 40 失败用例于 v1.1.2 全部处理完毕；其中 generalSettings 25 条（H5 设置区 / 官方 provider 卡片 / cc-switch 入口）曾按用户拍板「应存在」转为**显式 skip**（条目 **B1-D2**）——**v1.2.5 用户改判「都不要，干净删掉」**：三特性实为**初始快照自带的未接线半成品、不接线**，**代码与 25 条 skip 用例已一并移除**（基线 skip 27 → 2）。分诊与加固记录见 `D:/xxw_p/cc-heihei-docs/v1.2.x/批次0_B1分诊报告_20260914.md`、`批次1_B1修复进度_20260914.md`
- **ToolSearch 误用：已修复并发布（v1.1.2）**：根因是**语义误导**而非注册时序——「核心工具中途才进工具集」已被探针**证伪**（核心工具从首轮请求起 100% inline 发送、从未 defer）；修复 = 文案改真 deferred 示例 + `select:` 命中 inline 时显式回执 + 协作侧 4 处文案五语言同步。证据见 `D:/xxw_p/cc-heihei-docs/v1.2.x/批次0_A1探针报告_20260914.md`
- **CI 现有 4 个 job：server-tests / adapters / docs / desktop-tests**：v1.2.0 新增 `desktop-tests`（windows runner，18 文件起步），**v1.2.6 扩容至 37 文件**（达「连续 ≥3 次全绿」标准，1104 tests 逐字一致）；`server-tests-linux-exp` 实验 job 于 v1.2.6 加入、**v1.2.7 后按用户拍板移除**（**放弃 Linux 平台支持、专注 Windows**——采集到的 195 条失败清单存档 `D:/xxw_p/cc-heihei-docs/v1.2.x/批次7_Linux实测清单_20260919.md`，收编评估存档 `批次7_Linux收编评估_20260919.md`）
- **会话冻结根因：三链路叠加（2026-09-16 查清）→ 三条已全部收口**：① **配额耗尽静默化**（provider 429 / 智谱 code 1308 仅记 warning、不向会话注入提示）→ **已修复（v1.2.1）**：非订阅者路径新增兜底，429 现会注入含**重置时间**的可见提示；② **长工具执行的 tool_result 丢失**（transcript 实测唯一孤儿 tool_use = 超时 600s 的 vitest 长命令，26.9 分钟断层）→ **已修复（v1.2.6）**：补 CLI 工具生命周期埋点（`tool_exec_started` / `tool_result_emitted` / `tool_exec_finished`，覆盖此前无埋点的「结果生成 → 回传」段，**埋点可查**）+ **超时兜底**（`TOOL_EXEC_HARD_TIMEOUT_MS = 600s` 超时强制注入 `is_error` tool_result，消灭孤儿 tool_use）；③ **服务端 turn 状态与 CLI 不同步**（信箱/HTTP 注入的回合可能未建 `activeUserTurns` → interrupt 报 already idle）→ **已修复（v1.2.6）**：注入式回合补齐 turn（`beginInjectedUserTurn`）。**WS 断连已排除**。详见 `D:/xxw_p/cc-heihei-docs/v1.2.x/批次2_会话冻结根因调查报告_20260916.md`、`冻结收尾_进度_20260917.md`
- **诊断日志曾停写（观测盲区）→ 已消除（v1.2.1）**：09-14 22:37 后 `runtime-errors.log` / `diagnostics.jsonl` 曾零记录；现在**每条日志带 sessionId**（经 `CC_HEIHEI_SESSION_ID` 注入），服务端启动写 `server_started` 锚点事件（含 port/pid/platform）——「安静 ≠ 写坏」可直接判别
- **诊断主文件被外部进程锁住会静默停写**：v1.0.7 已加 fallback 旁路文件（diagnostics-fallback-<日期>.jsonl）+ stdout 留痕，排障时见到 fallback 文件即主文件被锁。v1.2.1 补上**保留策略**（天数 + 个数双上限；窗口内每类最多 7 个、最旧优先删，**当天旁路不删**以防删掉当前写入目标）
- **GTX 750 机器**：GPU 加速不可用（无 fp16），跑分自动降级 CPU 是预期行为
- ~~服务端宠物死代码~~ → **已清理（v1.2.1）**：11 文件纯删除 + 解引用，**净删 619 行**（`petAccessPolicy.ts`、`localAccessAuth` pet token、`ws/handler` 的 clientKind 过滤、`sessions.ts` 的 PET_SESSION_LIMIT 等），全仓聚焦 grep 零残留。**例外**：desktop-ui 的 pet 偏好端点是 UI 功能、有意保留（仅摘除 pet-token 响应分支）
- **线程 67% vs 物理核**：待找有 NVIDIA 的机器 A/B 实测
- **本地模型的图片输入**：mmproj 支持已上线但用户尚未实测看图效果；纯 CPU 处理一张图要几分钟属预期
- ~~`src/services/api/client.test.ts` 2 条既有 env 依赖失败~~ → **已修复（v1.2.6）**：环境确定性化（9 个相关变量「保 / 清 / 还」，不再受本机凭据影响）
- **上下文体积抑制（S1 + S3 已做，v1.2.6）**：实测体积构成——**固定开销 ≈ 67 KB**（system ≈ 27 + tools ≈ 40）**不随对话增长**，**messages 是唯一无界增长项**（长会话中约占 95%）。已做 **S1**（trace preview 240K → 32K，日志侧约 −87%）、**S3**（pending 记真实体积 + preview 头尾双段采样）。**M1**（超长单条消息截断 + 可回查，阈值待拍板）/ **M2**（请求体积分位统计与告警）**待拍板**；**L1**（历史消息裁剪）/ **L2**（动态 token 预算）属**架构级**。设计真源见 `D:/xxw_p/cc-heihei-docs/v1.2.x/上下文体积抑制_设计方案_20260917.md`（含两条红线：不为省字节削减工具描述语义；**不宣称「抑制体积可消除悬挂」**——体积与「工具结果未回传型悬挂」无关）
- ~~`tool-execution-diagnostics` 负载偶发~~ → **已修复（v1.2.6，批次 6 补刀）**：原 `mock.module` + `afterEach restore` 组合时序不确定（首跑 2 fail / 随后 4 连跑全过），改为**依赖注入缝**（`setDiagnosticsLogWriterForTests`）+ 静态 import；原本冷热不一致的组合 **3 连跑 8/8 全绿**
- ~~服务端两条顺序依赖失败~~ → **已修复（v1.2.6），且真根因并非「顺序依赖」**：trace capture「managed settings」＝**宿主 env 污染**（`CC_HEIHEI_TRACE_API_CALLS=1` 由协作宿主注入，而 `isTraceCaptureEnabled` 先看 env 再看 settings——**批次 6 的「顺序依赖」判断据此更正**）；`WorkspaceService` outside-workspace preview ＝ `registeredRoots` **模块级跨文件残留**（sessions.test.ts 的 home-dir 用例经 createSession 注册 home、覆盖 `os.tmpdir()`）。修复后 trace-capture 单跑 **66/66**、desktop-ui-preferences + workspace-service **34/34**——**B2 报告的两个既有失败至此全部闭合**
- **（小项记录）`check:persistence-upgrade` 覆盖范围**：v1.2.6 补注册该脚本（`package.json:19`，指向既有迁移回归测试，6/6）。**语义目前只覆盖迁移回归**——其它持久化面各有测试，是否并入该脚本另议
- **v1.4.0 收口后仍存的遗留问题**：一轮 6 路架构/代码全面分析（2026-09-29）产出 **2 高危 / 12 中危 / 22 低危 / 2 机会项**；安全三专项（路径穿越/命令注入/密钥硬编码）**全部通过、无漏洞**。汇总与 6 份分域详情（backend / review / test / ops / docs / frontend）见**仓库外私有目录** `D:/xxw_p/cc-heihei-docs/v1.4.x/分析报告/`（过程文档已整体迁出仓库，入口见该目录下的 `索引.md`）。高危两项：验收脚本 `scripts/acceptance.ts:133` 复跑判绿漏洞（崩溃半跑被误判绿）、两份交接文档落后两个大版本（本文件已补；旧交接文档与新 `2026-09-29` 版均已在 `D:/xxw_p/cc-heihei-docs/`）
- **依赖升级对比材料（2026-10-06，技术文档实测，供用户决策、不做推荐）**：root `npm audit` **25 条**（1 critical = shell-quote；9 high 含 axios SSRF / undici TLS 绕过 / ws 内存泄露 / lodash-es 注入，23 条可直修、2 条需 major）；**site 文档站 0 漏洞**（首次实测，此前无既有评估记录）；**desktop 侧已用 `bun audit`（读实装 bun.lock）补审：111 条告警（去重 GHSA 87 条，bun 按引入链重复计数）跨 18 包 = 2 critical / 53 high / 44 moderate / 12 low**——进运行时的是 electron（4 high，修于 42.9.2）、electron-updater 的 js-yaml / builder-util-runtime、dompurify（**已专项钉死：进运行时的直接依赖 3.4.16 对 bun 所列全部 14 条 advisory 均不在受影响区间 ⇒ 不受影响**（GitHub Advisory DB 逐条核对）；bun 命中的实为 stub 类型包 `@types/dompurify` 之下嵌套的 `dompurify@3.3.3`（14/14 全命中、含一条无修复版，但该包无任何 JS 产物、不进运行时）；逐条区间表见材料「dompurify 专项核查」节；vite 及其余 13 个打包/测试链包按裁决不逐一核），其余均在打包/下载/dev/测试链；主线 latest 对照（TS 7.0.2 / Electron 44.5.1 / React 19.3.0 / Vite 8.3.2 / Vitest 5.0.3 等）与逐项风险/影响面/回滚代价见 `D:/xxw_p/cc-heihei-plan/依赖升级对比材料_2026-10-06.md`
- **「两条既有路径口径」核实（2026-10-06，推定对应 Bun truncate 两处产品路径；编号 #83 在 HANDOVER/issue/规划材料均查无出处，如非此条请以原文为准）**：两处（`src/history.ts` 回滚分支、`src/utils/sessionStorage.ts` 按 uuid 移除单条）**均已随 v1.7.3 改重写语义并带短读守卫**（`d853213` + `2f615a0`），本次实测全仓 FS truncate **0 调用点残留** ⇒ **可结案**；其关联子项「快路径 64KB 窗口丢尾」（第 6 条）仍开放（v1.7.4 候选）。核实记录：`D:/xxw_p/cc-heihei-plan/遗留核实_两条既有路径口径_2026-10-06.md`
- **v1.7 结构拆分专项目标对账（2026-10-08，技术文档只读核账；用户新功能开发前确认）**：主体完成（门面 22642→13819、行数门禁双接线全绿、纯移动逐字复核、冒烟/验收设施在册、chatStore 豁免已还清 2504→2490）。**三项未收口**：① sessionService 3796/cap3846 与 handler **3267**/cap3372 豁免续签至 1.7.4；② 分层违规 18 条仍 `--ignore-known` 整体放行，未按补充裁决 §2.2 清零或登记永久例外（**其中 rosterDigest 那条已于 2026-10-08 真修，见条目 7，存量 19→18**）；③ 服务端（root）类型关卡仍缺（债务到期 1.7.1，已逾期——ci.yml 与 package.json 均无 tsc；**2026-10-08 补：本机 TS 6.0.3 + 根 tsconfig 含 `baseUrl` ⇒ 该关卡若直接上棘轮会「假绿真空检查」，须带 `--ignoreDeprecations 6.0` 或去掉 `baseUrl`，且须配判别力自证**）。另有 A10（后台任务状态上提，原定 handler 第⑥批）：**2026-10-08 团队裁决拆两半——**
① **状态上提：照做**（属 handler 瘦身的一部分，B1 批执行；**✅ 已落地 2026-10-08**——B1-1 ＝ 会话活动三表/三原语/三只读访问器上提（`3d061ae`，另 `9abc47e` 把类型 `SessionChatActivityState` 原样再导出、回到导出面字面零变化）；B1-2 ＝ 后台任务子域上提（`1a9981d`：`CliBackgroundTaskLifecycle` 类型 + `activeBackgroundTaskIds` 活跃集 + `getCliBackgroundTaskLifecycle`/`trackCliBackgroundTaskLifecycle`/`hasActiveBackgroundTasks` + 两个收敛原语，全部迁往 `src/server/ws/sessionActivity.ts`，被搬 54 行逐字一致）。**handler 3351 → 3247**（净 −104），导出面 **31 → 31 逐项不变**；批③（`0d00b99`）＝组合函数 `getSessionChatActivityState` 也搬入该模块，其「待批 computer-use 权限请求数」经**注入缝** `registerSessionActivityDeps` 由装配根 `server/index.ts` 反向接线（形态同 `registerServantInfoSource`/`registerRosterDigestDeps`）——直接 import 该服务会闭合出新的 `no-circular`（实测判红：handler → sessionActivity → computerUseApprovalService → handler，不在 18 条 known 内），handler 原位**同名再导出** ⇒ 导出面仍逐项不变）；
② **新增 `/api/session-activity` 端点：经裁决放弃** —— 理由：**找不到具体消费方**
（界面侧 `desktop/src/components/activity/SessionActivityPanel.tsx` 存在、但**不调任何 HTTP 端点**
（无 fetch/api/store 调用，数据经 props/WS），全仓 `session-activity` 的 HTTP 引用零命中；CLI/工具亦无调用）
⇒ 不造没人用的接口。**本条即放弃留痕**（含理由与日期），不再悬着。逐条状态表与证据：`D:/xxw_p/cc-heihei-plan/框架改造目标对账_2026-10-08.md`
- **v1.7.4 sessionService 族外移（B2/B3/B4/B5，2026-10-08，四族全部落地）**：按方案「每族一批」把四个族整簇外移到同层（L2）新模块 `src/server/services/transcriptDerivation.ts`，注入缝为 `TranscriptDerivationHost`（最终 9 项：`providerService` / `readJsonlFile`〔**测试接缝**，必须注入〕/ `findSessionFile` / `getSessionLaunchInfo` / `sessionEffortLevels` / `invalidateSessionListCache` / `findSessionFiles` / `readTargetedJsonlEntries` / `now`；后 4 项均因**族外另有调用点或重依赖**而不随族搬），**依赖单向**（新模块不 import sessionService，含 `import type`）。已落：**B2 族①** 上下文窗口/用量族（`37595c3`，3796 → 3301）；**B3 族②** 检查快照族（`3d4c103`，→ 2984）；**B4 族③** 消息窗口/用量族（`d6d3b81`，→ 2660）；**B5 族④** 会话写入/维护族（`449aed9`，→ **2343**）。各族均：门面导出类型**按名再导出**（导出面逐项不变：sessionService 20/20、handler 31/31）、逐字保真比对（320/320、338/338…）、tsc 错误签名多重集净 0。**⇒ sessionService 已 2343 ≤ 2500，`file-size-allowlist.json` 里那条 sessionService 豁免（cap 3846）可撤**（撤除由架构师执行）。
- **v1.7.4 修缺陷·花名册摘要「模型可见、用户不可见」（2026-10-08，已落地 `8b62801`）**：用户报「主管会话每条用户消息尾部挂着 `【在册】…`」（实测 73 条含摘要、68 条挂用户消息尾）。**不删 B2 能力**，改机制为**独立系统段**：① 注入——`rosterDigest.appendRosterDigestIfSupervisor`（拼进正文尾部）→ `buildRosterDigestSegmentForSupervisor` 返回 `<system-reminder>\n【在册】…\n</system-reminder>` 整段（主管判定/幂等/读失败降级+诊断口径逐条不变），`conversationService.sendMessage` 改**前置**该段（不再追尾、不再关心页脚位置）；② 剥离（UI 读路径两处）——历史/转录链 `session/messageConversion.entryToMessage` → `stripRosterDigestFromContent`（历史 API / transcriptDerivation / 子链全走这条；string 与 block 数组都剥；无命中返回原引用），实时链 `ws/localCommandParsing.extractReplayUserText`（`user_message_replay` 取 CLI 回显原始正文）；剥离**只认带【在册】标记的段**（CLI 自己的 reminder 原样保留），**无包裹的历史裸行不动**（按裁决旧数据另行处置，用例 ⑦b 钉住）。唯一注入点不变：WS 上行 `ws/handler.ts:653` 与投递注入 `sessionMessenger.ts:214` 都汇入 `sendMessage`，两上游不自行注入（用例 ⑪ 源码守卫）。证据：用例 ⑨/⑫/⑬ 三处输出无 `【在册】` 且正文/页脚一字不动；用例 ⑩ 捕获送 CLI 的 user 消息**含**该段（B2 未退化）；roster-digest 14 pass；服务端全量 109 文件 2165 用例 0 fail（复跑）；门禁三绿。flake：`known-flaky.json` 追加同类 conversations ECONNRESET 第二例（隔离 108/108 绿、同批复跑 0 fail）。
- **G2 收官总账（2026-10-08，收官于 `ad04f1c`）**：起点 **18 条**（本地存档态 `b09ee5f` 实测 18）→ **现剩 0 条**、**永久例外 0 条**。逐批实测（每步以基线文件为准）：`4aeb3a0` 18→17（三行批）、`d7160f1` 17→14（B-a 注入缝 3）、`7561ed9` 14→11（B-b 共用投递缝 3）、`8792bdd` 11→6（B-c helper 下沉 5）、`ad04f1c` 6→0（B-d 环/动态/managedEnv 6）⇒ **修 18/18，例外 0**（门禁口径：`lint:layers` 现为「✔ no dependency violations found」，基线文件 = 空数组 `[]`）。收尾批 B-d 交付：起点 6 条（2 条 `layer-L0-no-server-deps` + 2 条 `no-circular` + 2 条 `no-dynamic-import-in-services`），做法 = ①`managedEnv` 的 cc-heihei env 实现**上提 L2** `services/ccHeiheiSettingsEnv.ts`（逐字保真 16/16），L0 开注入缝 `registerCcHeiheiSettingsEnvProvider`（装配点 `entrypoints/init.ts`；未注册 ⇒ 不合并且不炸进程 + **一次性**诊断，非静默）；②conversationService ⇄ servantIncidentNotifier 改**事件总线** `services/servantIncidentSignals.ts`（四类发射 + 顶层订阅，旧 `.catch` 留痕同事件名/字段；notifier 的 interrupt 改 `registerServantIncidentInterrupt` 由 index.ts 接线，未接线按旧语义记诊断）；③`getHeiheiOpenAIOAuthFilePath` 下沉 L0 `utils/openaiOAuthPath.ts`（同 B-c grok 款）。验收：服务端全量 **110 文件 2160 pass / 10 skip / 0 fail**；G2 缝⑤/⑥/⑥b 共 7 条新单测；tsc 7255 == 对照；导出面 11 文件零丢失。
- **【待处置】中间提交非原子（2026-10-08，bisect 隐患）**：`0d8baf3`（flake 登记）意外带上了先前已暂存的 `git mv src/server/api/computer-use-python.ts → src/server/services/computerUsePython.ts`，该笔单看会让旧路径消失、兼容门面要到 `8792bdd` 才补上 ⇒ **bisect 到该笔会看到一度不可导入的中间态**。终态树自洽（`8792bdd` 之后）✓、本地未 push ✓、未触红线（未改历史/未跳钩子）✓。**推之前由主管专门处置**（可 squash/reword 或按需拆分）。
- **G2 收官·B-c 批（5 条，2026-10-08，已落地 `8792bdd`）**：L4 同层 4 条走**共享 helper 下沉**、grok 环走**路径助手下沉 L0**。① `api/computer-use-python.ts`（纯 helper、零 import）整文件下沉 L2 `services/computerUsePython.ts`，原路径留**兼容门面**再导出 5 名；② `isAllowedFilesystemPath`（+私有 `isWithinRoot`）下沉 L2 `services/filesystemPathSecurity.ts`（localFile 本就 import 它的天然邻居）；③ 文件直传家族（`CONTENT_TYPES`/`contentTypeForPath`/`MAX_FILE_BYTES`/`PREVIEW_HTML_CSP`/`ParsedRange`/`parseRange`/`serveFileWithRange`，177 非空行）下沉新 L2 `services/fileServing.ts`；④ 搜索家族**整块连续区间**（438 非空行，含 `ProjectSearchDependencies`/`SearchIgnoreContext`/4 个 `FILE_SEARCH_*` 常量/`isVcsMetadataDirectoryName`）下沉新 L2 `services/filesystemSearch.ts`，`api/filesystem.ts` 677 → **178** 行；⑤ `getHeiheiGrokOAuthFilePath` 下沉 L0 `src/utils/grokOAuthPath.ts`（provider 改从 L0 取 ⇒ `no-circular` 消失）。**known-violations 11 → 6**（重生成 + 逐条 diff：移除正是这 5 条、新增 0）；`lint:layers` **✔ no dependency violations found**（3646 模块）；服务端全量 **109 文件 2141 pass / 0 fail**；保真：整文件 159/159、路径闸门 19/19、直传家族 177/177、搜索家族反向 438/438（行数账 607 = 156 + 438 + 13）；导出面 11 文件**零丢失**。**flake 登记**：`scripts/known-flaky.json` 新增 conversations prewarm 用例的并发 `ECONNRESET`（隔离 108/108 绿 + 重跑即变绿；真定位归「潜伏偶发专项批」）。
- **G2 收官·B-b 批（3 条，2026-10-08，已落地 `7561ed9`）**：`dispatchMailboxService` / `servantStallWatcher` / `supervisorProtocolNotice` 三家（L2）原先各自静态 import `./sessionMessenger.js`（L3）取 `deliver` ⇒ 3 条 `layer-L2-no-upward`。三者要的是**同一能力** ⇒ 建**共用投递缝** `services/sessionDelivery.ts`（L2、零 import：`registerSessionDelivery` / `setSessionDeliveryForTests` / `requireSessionDelivery`），装配根 `server/index.ts` 启动序注册（形态同 `registerServantIncidentDeliver`）；三家默认 deps 的 `deliver` 改为 `requireSessionDelivery()(…)` 且为 **async**（保 `=> Promise<boolean>` 契约），**缺注册 ⇒ 抛错 fail-fast**；三家各自的投递失败处置是既有行为且非静默（mailbox ⇒ markFailed + reason / stall ⇒ report(warn) / notice ⇒ console.warn）。**known-violations 14 → 11**（重生成 + 逐条 diff：移除正是这 3 条、新增 0）；三家对 `sessionMessenger` 的 import 归零。**与 R2b 的 `registerServantIncidentDeliver`（单消费者同能力缝）并存**——那条留原地；若架构师偏好「三家各一条同名缝」可换（改动局部）。
- **【更正】G2 B-a 批提交信息笔误（2026-10-08）**：`d7160f1` 的提交消息写「新增 **9** 条缝单测」，**实为 7 条**（`src/server/__tests__/g2-injection-seams.test.ts`：缝① 3 条 / 缝② 2 条 / 缝③ 2 条）。按纪律**不改历史、不动消息**，正确值以本行为准。（B-b 批后同文件共 **9** 条。）
- **G2 收官·B-a 批（3 条，2026-10-08，已落地 `d7160f1`）**：三条 `layer-L2-no-upward`（services → ws/*）按架构师规格《方案_G2收官3条与G9类型关卡_规格_2026-10-08.md》**走注入缝、不下沉原语**（下沉对象是 L4 传输态，错层）。缝：`registerComputerUseApprovalTransport`（① computerUseApprovalService → sessionTransport.sendToSession）/ `registerTeamWatcherBroadcast`（② teamWatcher → sendToSession + getActiveSessionIds）/ `registerSessionComponentReloadDeps`（③ sessionComponentReloadService → updateSessionSlashCommands），**注册点统一 `server/index.ts`**（② 的适配器 = 原 broadcast 内联体逐字搬）；消息一律用**服务文件本地窄类型**（不 import ws/events）；`TeamMemberStatus` **下沉 L0** `src/types/teamMember.ts`（ws/events 改 import type + **按名再导出**，导出面 14→14）。未注册语义逐服务：① **抛错 fail-fast**（不留 pending 半状态）、② 丢弃 + 一次性诊断、③ 诚实 failed。**known-violations 17 → 14**（`.dependency-cruiser-known-violations.json` 已重生成，逐条 diff 证明移除的正是这 3 条、新增 0）；三服务对 `../ws/` 的 import 计数 0/0/0，`services/*.ts` 一级目录对 `../ws/` 全仓归零。剩余 14 条按规格分批：B-b sessionMessenger 3 条（dispatchMailbox 已有 `deps.deliver ??` 雏形）、B-c L4 同层 4 条 + grok 1 条、B-d 环/动态/managedEnv 5 条。
- **G1「瘦身」完成（2026-10-08，架构师执行撤免）**：两文件均达标——handler **2384**（D1′ 累计 3227→2384 净 −843）、sessionService **2343**（四族合计 3796→2343 净 −1453；族① −495 / 族② −317 / 族③ −324 / 族④ −317）。`file-size-allowlist.json` 豁免 **2 条 → 0 条**（handler 条目撤于 `5e6b73f`，sessionService 条目本笔）；`file-size-baseline.json` 两文件条目按表头规则「降至 2500 以下应移出本表」一并移出（**21 → 19 项**，同 chatStore 先例）。撤后实测 `lint:file-size` **PASS**：2727 文件 0 失败（基线 19 项、豁免 0 项），两文件改按规则 1（≤2500 硬标准）管理。
- **`SessionLaunchInfo` 归属备忘（2026-10-08，B3 裁决遗留；B5 复核：生产者不在族④）**：该类型的**定义点**已随族② 搬到 `src/server/services/transcriptDerivation.ts`（族②本色构造它；搬回或复制都会违反「禁反向 import」/引漂移险），sessionService 仅**按名再导出**；其**生产者** `getSessionLaunchInfo` 是独立方法（`sessionService.ts` 族④ 区间之前），**不在已搬的 ①②③④ 任一族内** ⇒ **该类型暂由新模块持有，待其生产者所在批次再论归属**（B5 顺带把宿主的 `getSessionLaunchInfo` 返回类型由窄化的 `TranscriptDerivationLaunchHint` **加宽为完整 `SessionLaunchInfo`**——族④ 的 `metadataMatchesLaunchInfo` 需逐字段比对，类型两处使用点已同源）。

**待核实候选**（2026-09-14 协作实测发现；2026-09-16 更新处置状态）
- **文件信箱通道未消费** → **已加固（随 v1.2.0 发布）**：核实结论为「未复现失败、重启自愈、链路零代码差异」——失效机理是 watcher 未建立或事后失效，**无补建/重试/日志机制、完全静默**，故会复发；v1.2.0 已加**周期兜底扫描（默认 45 秒）+ 重建缺失 watcher**。见 `D:/xxw_p/cc-heihei-docs/v1.2.x/批次1_信箱通道核实报告_20260915.md`
- **假死重推未触发** → **已修复（v1.2.1）**：真根因比初版分析更硬——旧状态机 4 行**确定性 TypeError** + 异常被吞，**该功能自 v1.1.0 起从未生效**（不是偶发失效，是一次都没成功过）；修复同时补上 `running=false` 的可见告警与全链路诊断事件。见 `D:/xxw_p/cc-heihei-docs/v1.2.x/批次3_假死重推根因分析_20260916.md`、`批次3_假死重推_进度_20260916.md`。**v1.2.2 已降噪**（仅「回合进行中」才重推，待命会话不再被循环戳）；**v1.2.3 已收口**（告警类通知降为诊断日志级、正常闲置零打扰，对话流只留需要人响应的消息）
- **tool_result 丢失致会话冻结** → **已修复（v1.2.6）**：环节 ② 确证存在（唯一孤儿 tool_use 实测）且**重推类手段对该类冻结无效**（CLI 阻塞在长工具时，注入消息要等工具返回才被处理）——故改为**埋点可查**（`tool_exec_started` / `tool_result_emitted` / `tool_exec_finished`，见「已知问题」冻结条目）+ **超时兜底**（超时强制注入 `is_error` tool_result，不再永久悬挂）

### 关键文件位置
- **本地模型设置页**：`desktop/src/pages/LocalModelSettings.tsx`（能力档/上下文规划/跑分报告都在这）
- **跑分服务**：`desktop/electron/services/localModelBenchmark.ts`
- **本地模型服务**：`desktop/electron/services/localModelService.ts`（OOM 重试/GPU 分层解析）
- **精选模型清单**：`desktop/src/constants/localModelCatalog.ts`
- **GPU 探测守卫**：`desktop/electron/main.ts` 的 `startLocalModelWithGpuGuard`
- **IPC 校验**：`desktop/electron/ipc/capabilities.ts`
- **服务端 Zod 校验**：`src/server/types/provider.ts`、`src/server/config/providerPresets.ts`
- **会话协作**：`src/collaboration/dispatchProtocol.ts`（派活协议唯一真源）、`src/server/services/dispatchMailboxService.ts`（文件信箱：watcher + v1.2.0 周期兜底扫描 + v1.4.0 `.ack` 回执）、`collabEnvironmentService.ts`（协作环境体检）、`servants.ts`（花名册/interrupt/广播/约束档位）
- **协作状态权威源（v1.3.0 地基重构）**：`src/server/services/sessionRegistry.ts`（六态单一权威源 + `SessionSnapshot` 快照）、`src/server/services/sessionEvents.ts`（typed 事件总线）、`.dependency-cruiser.cjs`（分层门禁，`lint:layers`）
- **协作可靠性地基（v1.4.0 收口）**：`src/server/services/serverIdentity.ts`（端口自发现 `desktop-server.json` + `whoami` 探活）、`src/utils/atomicFs.ts`（`renameWithRetry` 原子落盘）、`adapters/wechat/quietPoll.ts`（微信节流）、`scripts/acceptance.ts` + `scripts/known-flaky.json`（验收口径）
- **协作加固（v1.2.0 / v1.2.1 / v1.2.2 / v1.2.3）**：`src/collaboration/supervisorGuard.ts`（三档约束 full / readonly / whitelist；白名单目录经 `CC_HEIHEI_SERVANT_WRITE_DIRS` 注入，仅拦文件工具、Bash 不受约束）、`src/server/services/servantIncidentNotifier.ts`（崩溃上报 + 报错续跑 + **连调不存在工具熔断**，阈值 `UNKNOWN_TOOL_STREAK_LIMIT`；以上系统事件 **v1.2.3 起一律只写诊断日志，不再注入会话消息**）、`src/server/services/servantStallWatcher.ts`（假死重推，**v1.2.1 修复致命状态机 bug**、**v1.2.2 降噪为仅回合进行中才重推**、**v1.2.3 告警降为诊断日志**）、`src/server/services/dispatchReceiptService.ts`（派活消费回执）、`src/services/api/errors.ts`（429 配额错误可见化兜底）
- **本地模型规划**：`desktop/src/lib/localModelPlan.ts`（上下文逐级上探）、`desktop/src/lib/modelChoices.ts`（供应商模型选项共享）
- **模型目录（2026-09）**：`desktop/src/constants/modelCatalog.ts`（Claude）、`openaiOfficialProvider.ts`、`grokOfficialProvider.ts`、`src/server/config/providerPresets.json`（DeepSeek/智谱/Kimi/MiniMax/Gemini 等）
- **桌面端类型**：`desktop/src/lib/desktopHost/types.ts`

### 构建和运行
- 开发：`cd desktop && bun run electron:dev`
- 打包：`cd desktop && bun run electron:build && bun ./node_modules/electron-builder/out/cli/cli.js --publish never -c.directories.output=D:/xxw_p/cc-heihei-dist/<版本号>`（统一产物父目录，每版本一个子目录，目录名即版本号；测试包另加 `-c.extraMetadata.version=<版本>`，见 D:/xxw_p/cc-heihei-dist/.keep.json）
  - **输出目录必须在 ZCode 工作区外**（工作区内会被 ZCode 索引锁死 app.asar）
  - ⚠️ **本机 node 24.19.0 跑大型 JS 负载会 JIT 崩溃**（SIGILL 132 / SIGSEGV 139，且零输出、小任务正常）——v1.3.0 曾因此「外层 exit=0 但产物缺失」。**改走 bun 直跑四步**（`build:preview-agent` / `tsc -b` / `vite build` / `electron-builder`）已实测兼容；症状特征是 node 链 exit 29/132/139 但 win-unpacked 缺 `resources/app.asar`
- 发布：`bun run scripts/release.ts <版本号>`（改版本号 + commit + tag，**不改 package.json 之外的版本**）
- **发版上传清单（缺一不可，漏了 latest.yml 旧版会检查不到更新）**：
  1. `bun run scripts/release.ts x.y.z` → push main + tag
  2. 用新版本号重新打包（脚本升版本在打包之后，先打的包文件名是旧版本）
  3. `gh release create vX.Y.Z --title ... --notes-file release-notes/vX.Y.Z.md`
  4. 上传三个文件：**exe + `latest.yml` + `exe.blockmap`**（后两个在打包输出目录；latest.yml 是 electron-updater 的版本元数据，blockmap 是增量更新差分）

## 交接给下一个 AI 的建议

1. **先读这份文档**，理解项目状态。
2. **本地模型已冻结**——能用但不再新增功能、**不参与协作会话**；别动 llama.cpp 二进制（`desktop/src-tauri/binaries/`），除非更新版本。核心是**会话级协作**（主管/员工）。
3. **67% 甜点比例是用户定的**——线程起点、内存预算、跑分档位都用它，别改。
4. **别恢复档位体系/应用内下载器**——用户明确否决过。
5. **改桌面代码先跑测试基线**——桌面 vitest 有历史失败，对照基线用 `git show HEAD:<文件>`、`git diff <文件>` 或把文件复制到临时目录比对（⚠️ 多人共享工作区时**不要**用 `git stash`/`checkout`/`restore`/`clean`/`reset` 等影响全局未提交改动的命令）。
6. **发版时注意**——llama.cpp 二进制版本和安装包要一致；打包输出目录放工作区外。
7. **push 前必须用户实测批准**——用户说「可以更新了」才能推。

## 联系方式

- 联系方式见仓库 README / GitHub Issues（本文件为公开仓库内容，不再放个人邮箱）
- GitHub：`https://github.com/KyuuKyuuStone/claude-code-heihei`

---

*交接时间：2026-09-13（v1.1.1 周期）；文档同步：2026-09-14 ~ 10-03（v1.2.0 ~ v1.7.2）*
*当前版本：v1.7.3（未发布：tag 待用户口令；README 与 release-notes 待更新）*
*交接状态：协作状态单一权威源（v1.3.0）+ 地基收口（v1.4.0）+ 主管通道放行（v1.4.1）+ 花名册高危修复及 Windows 瘦身（v1.5.0）+ 任务台账与原生协作（v1.6.0 / v1.6.1）+ 结构拆分与静默假死根因修复（v1.7.x）；后续版本快照与公告按用户确认节奏执行*
