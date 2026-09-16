# Claude Code Heihei — 项目交接文档

> 写给接手的 AI：这份文档告诉你这个项目是什么、我做了什么、现在是什么状态、接下来要做什么。

## 项目是什么

**Claude Code Heihei** 是一个 Windows 桌面端 Claude Code 工作台（fork 自 cc-haha）。它在经典会话工作台之上加了 **本地大模型** 支持——用内置的 llama.cpp 在本机直接跑 GGUF 模型，不需要联网、不需要 API Key，适合普通学生电脑。

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
- **当前版本**：`v1.2.0`（2026-09-16 发布，Latest；v1.1.1 的安装包缺 ToolSearch 文案修复与桌面测试基线清零，建议升级）
- **主分支**：`main`（上一发布 v1.1.2 = `60a4e8e`；v1.2.0 为本次发布提交）

## 当前状态

### 版本快照（v1.0.3 → v1.2.0，2026-09-07 ~ 09-16）

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

### 能工作的
- 本地模型全流程（设置页、跑分、启动、下载中心、多模态、自定义引擎）都能用
- 站点和 README 已更新本地模型介绍
- llama.cpp b10786（比上游 release v0.3.0 新）

### 已知问题 / 待办
- **桌面 vitest 基线已清零**（v1.1.2）：历史遗留 14 失败文件 / 40 失败用例全部处理完毕。其中 generalSettings 25 条（H5 设置区 / 官方 provider 卡片 / cc-switch 入口）经用户拍板**「应存在」**，转为**显式 skip** 待接线（条目 **B1-D2**）——豁免是有意的、不掩盖真实回归。分诊与加固记录见 `cc-heihei-交接/批次0_B1分诊报告_20260914.md`、`批次1_B1修复进度_20260914.md`
- **ToolSearch 误用：已修复并发布（v1.1.2）**：根因是**语义误导**而非注册时序——「核心工具中途才进工具集」已被探针**证伪**（核心工具从首轮请求起 100% inline 发送、从未 defer）；修复 = 文案改真 deferred 示例 + `select:` 命中 inline 时显式回执 + 协作侧 4 处文案五语言同步。证据见 `cc-heihei-交接/批次0_A1探针报告_20260914.md`
- **CI 现有 4 个 job：server-tests / adapters / docs / desktop-tests**：v1.2.0 新增 `desktop-tests` 门禁（windows runner，18 文件子集起步 = 协作相关组件 + B1 已加固稳定项），桌面回归从此有自动防护；扩容按「连续 ≥3 次本地全绿」标准渐进。服务端 Linux 存量环境性失败（约 26 个）的收编仍另议
- **会话冻结根因：三链路叠加（2026-09-16 查清，修复待立项）**：① **配额耗尽静默化**——provider 429 / 智谱 code 1308 仅记 warning、**不向会话注入任何提示**，用户感知为「停止输出、无报错」；② **长工具执行的 tool_result 丢失**——transcript 实测唯一孤儿 tool_use = 超时 600s 的 vitest 长命令（26.9 分钟断层），机制未锁定（CLI 无工具生命周期埋点）；③ **服务端 turn 状态与 CLI 不同步**——信箱/HTTP 注入的回合可能未建 `activeUserTurns` → interrupt 报 already idle → 假死重推不触发。**WS 断连已排除**。P0 修复建议：配额/限流错误用户可见化（含重置时间）+ 恢复服务端错误日志写入并补 sessionId。详见 `cc-heihei-交接/批次2_会话冻结根因调查报告_20260916.md`
- **诊断日志停写（观测盲区，本身即缺陷）**：`~/.claude/cc-heihei/diagnostics/` 下 `runtime-errors.log` 与 `diagnostics.jsonl` 均**停在 2026-09-14 22:37**，此后（含全部 09-15/09-16 冻结事件）零记录——冻结发生时无服务端现场可查。另：`cli-diagnostics` 不含 sessionId、`electron-host.log` 无时间戳，均阻碍按会话归因
- **诊断主文件被外部进程锁住会静默停写**：v1.0.7 已加 fallback 旁路文件（diagnostics-fallback-<日期>.jsonl）+ stdout 留痕，排障时见到 fallback 文件即主文件被锁
- **GTX 750 机器**：GPU 加速不可用（无 fp16），跑分自动降级 CPU 是预期行为
- **服务端宠物死代码**：`src/server/petAccessPolicy.ts`、localAccessAuth 的 pet token、desktop-ui 偏好 pet 端点、sessions.ts 的 PET_SESSION_LIMIT——桌面端已不调用，可择期清理
- **线程 67% vs 物理核**：待找有 NVIDIA 的机器 A/B 实测
- **本地模型的图片输入**：mmproj 支持已上线但用户尚未实测看图效果；纯 CPU 处理一张图要几分钟属预期

**待核实候选**（2026-09-14 协作实测发现；2026-09-16 更新处置状态）
- **文件信箱通道未消费** → **已加固（随 v1.2.0 发布）**：核实结论为「未复现失败、重启自愈、链路零代码差异」——失效机理是 watcher 未建立或事后失效，**无补建/重试/日志机制、完全静默**，故会复发；v1.2.0 已加**周期兜底扫描（默认 45 秒）+ 重建缺失 watcher**。见 `cc-heihei-交接/批次1_信箱通道核实报告_20260915.md`
- **假死重推未触发** → **根因分析进行中（批次 3）**：与冻结报告环节 ③ 关联——`activeUserTurns` 未建立时服务端认为会话 idle，watcher 无活动信号可依
- **tool_result 丢失致会话冻结** → **结论见冻结调查报告**：环节 ② 确证存在（唯一孤儿 tool_use 实测）、机制未锁定；修复建议 P1 = CLI 补工具生命周期埋点 + 超时工具强制注入兜底 tool_result

### 关键文件位置
- **本地模型设置页**：`desktop/src/pages/LocalModelSettings.tsx`（能力档/上下文规划/跑分报告都在这）
- **跑分服务**：`desktop/electron/services/localModelBenchmark.ts`
- **本地模型服务**：`desktop/electron/services/localModelService.ts`（OOM 重试/GPU 分层解析）
- **精选模型清单**：`desktop/src/constants/localModelCatalog.ts`
- **GPU 探测守卫**：`desktop/electron/main.ts` 的 `startLocalModelWithGpuGuard`
- **IPC 校验**：`desktop/electron/ipc/capabilities.ts`
- **服务端 Zod 校验**：`src/server/types/provider.ts`、`src/server/config/providerPresets.ts`
- **会话协作**：`src/collaboration/dispatchProtocol.ts`（派活协议唯一真源）、`src/server/services/dispatchMailboxService.ts`（文件信箱：watcher + v1.2.0 周期兜底扫描）、`collabEnvironmentService.ts`（协作环境体检）、`servants.ts`（花名册/interrupt/广播/约束档位）
- **协作加固（v1.2.0）**：`src/collaboration/supervisorGuard.ts`（三档约束 full / readonly / whitelist；白名单目录经 `CC_HEIHEI_SERVANT_WRITE_DIRS` 注入，仅拦文件工具、Bash 不受约束）、`src/server/services/servantIncidentNotifier.ts`（崩溃上报 + 报错续跑 + **连调不存在工具熔断**，阈值 `UNKNOWN_TOOL_STREAK_LIMIT`）、`src/server/services/servantStallWatcher.ts`（假死重推）
- **本地模型规划**：`desktop/src/lib/localModelPlan.ts`（上下文逐级上探）、`desktop/src/lib/modelChoices.ts`（供应商模型选项共享）
- **模型目录（2026-09）**：`desktop/src/constants/modelCatalog.ts`（Claude）、`openaiOfficialProvider.ts`、`grokOfficialProvider.ts`、`src/server/config/providerPresets.json`（DeepSeek/智谱/Kimi/MiniMax/Gemini 等）
- **桌面端类型**：`desktop/src/lib/desktopHost/types.ts`

### 构建和运行
- 开发：`cd desktop && bun run electron:dev`
- 打包：`cd desktop && bun run electron:build && node ./node_modules/electron-builder/out/cli/cli.js --publish never -c.directories.output=D:/xxw_p/cc-heihei-dist`
  - **输出目录必须在 ZCode 工作区外**（工作区内会被 ZCode 索引锁死 app.asar）
- 发布：`bun run scripts/release.ts <版本号>`（改版本号 + commit + tag，**不改 package.json 之外的版本**）
- **发版上传清单（缺一不可，漏了 latest.yml 旧版会检查不到更新）**：
  1. `bun run scripts/release.ts x.y.z` → push main + tag
  2. 用新版本号重新打包（脚本升版本在打包之后，先打的包文件名是旧版本）
  3. `gh release create vX.Y.Z --title ... --notes-file release-notes/vX.Y.Z.md`
  4. 上传三个文件：**exe + `latest.yml` + `exe.blockmap`**（后两个在打包输出目录；latest.yml 是 electron-updater 的版本元数据，blockmap 是增量更新差分）

## 交接给下一个 AI 的建议

1. **先读这份文档**，理解项目状态。
2. **本地模型是核心**——别动 llama.cpp 二进制（`desktop/src-tauri/binaries/`），除非更新版本。
3. **67% 甜点比例是用户定的**——线程起点、内存预算、跑分档位都用它，别改。
4. **别恢复档位体系/应用内下载器**——用户明确否决过。
5. **改桌面代码先跑测试基线**——桌面 vitest 有历史失败，对照基线用 `git show HEAD:<文件>`、`git diff <文件>` 或把文件复制到临时目录比对（⚠️ 多人共享工作区时**不要**用 `git stash`/`checkout`/`restore`/`clean`/`reset` 等影响全局未提交改动的命令）。
6. **发版时注意**——llama.cpp 二进制版本和安装包要一致；打包输出目录放工作区外。
7. **push 前必须用户实测批准**——用户说「可以更新了」才能推。

## 联系方式

- 作者邮箱：`511829667@qq.com`
- GitHub：`https://github.com/KyuuKyuuStone/claude-code-heihei`

---

*交接时间：2026-09-13（v1.1.1 周期）；文档同步：2026-09-14（C1）、2026-09-16（v1.2.0 发布前）——均未改代码*
*当前版本：v1.2.0（Latest；上一发布 v1.1.2 = `60a4e8e`）*
*交接状态：本地模型策略定型（实测诚实派）+ 多会话协作体系加固（安全档位 / 自动熔断 / 门禁扩容）；代码全部已推 GitHub，可随时接手新任务*
