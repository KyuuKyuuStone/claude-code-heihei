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

## 我做的工作（本会话）

1. 删除桌面宠物功能全部代码（桌面端；服务端 petAccessPolicy 等死代码有意保留）
2. 本地模型大改版（见上节）+ 修复启动 ErrorDeviceLost + 跑分 IPC 校验修复确认
3. 更新文档（docs/desktop/local-model.md、README 中英、本文件）
4. **发布 v1.0.2**：Release 附 exe + latest.yml + blockmap（曾漏传 latest.yml 导致旧版检查不到更新，已补并写入发版清单）

## GitHub 信息

- **仓库**：`https://github.com/KyuuKyuuStone/claude-code-heihei`
- **当前版本**：`v1.0.2`（2026-09-06 发布，Latest；v1.0.1 的安装包含跑分 IPC bug 和宠物代码，建议用户升级）
- **主分支**：`main`（与 GitHub 完全同步，工作区干净）

## 当前状态

### 能工作的
- 本地模型全流程（设置页、跑分、启动、下载中心、多模态、自定义引擎）都能用
- 站点和 README 已更新本地模型介绍
- llama.cpp b10786（比上游 release v0.3.0 新）

### 已知问题 / 待办
- **桌面端 vitest 有约 38 个历史失败**（generalSettings/BrandSeal/主题等，main 上就有；CI 只测 adapters+docs 所以没暴露）——改桌面代码时先跑基线对比
- **GTX 750 机器**：GPU 加速不可用（无 fp16），跑分自动降级 CPU 是预期行为
- **服务端宠物死代码**：`src/server/petAccessPolicy.ts`、localAccessAuth 的 pet token、desktop-ui 偏好 pet 端点、sessions.ts 的 PET_SESSION_LIMIT——桌面端已不调用，可择期清理
- **线程 67% vs 物理核**：待找有 NVIDIA 的机器 A/B 实测
- **本地模型的图片输入**：mmproj 支持已上线但用户尚未实测看图效果；纯 CPU 处理一张图要几分钟属预期

### 关键文件位置
- **本地模型设置页**：`desktop/src/pages/LocalModelSettings.tsx`（能力档/上下文规划/跑分报告都在这）
- **跑分服务**：`desktop/electron/services/localModelBenchmark.ts`
- **本地模型服务**：`desktop/electron/services/localModelService.ts`（OOM 重试/GPU 分层解析）
- **精选模型清单**：`desktop/src/constants/localModelCatalog.ts`
- **GPU 探测守卫**：`desktop/electron/main.ts` 的 `startLocalModelWithGpuGuard`
- **IPC 校验**：`desktop/electron/ipc/capabilities.ts`
- **服务端 Zod 校验**：`src/server/types/provider.ts`、`src/server/config/providerPresets.ts`
- **桌面端类型**：`desktop/src/lib/desktopHost/types.ts`

### 构建和运行
- 开发：`cd desktop && bun run electron:dev`
- 打包：`cd desktop && bun run electron:build && node ./node_modules/electron-builder/out/cli/cli.js --publish never -c.directories.output=C:/xxw_p/cc-heihei-dist`
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
5. **改桌面代码先跑测试基线**——桌面 vitest 有历史失败，先 `git stash` 跑一遍干净基线再对比。
6. **发版时注意**——llama.cpp 二进制版本和安装包要一致；打包输出目录放工作区外。
7. **push 前必须用户实测批准**——用户说「可以更新了」才能推。

## 联系方式

- 作者邮箱：`511829667@qq.com`
- GitHub：`https://github.com/KyuuKyuuStone/claude-code-heihei`

---

*交接时间：2026-09-06*
*当前版本：v1.0.2（已发布，Latest）*
*交接状态：本地模型策略定型（实测诚实派），全部工作已推 GitHub，工作区干净，可随时接手新任务*
