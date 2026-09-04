# Claude Code Heihei — 项目交接文档

> 写给接手的 AI：这份文档告诉你这个项目是什么、我做了什么、现在是什么状态、接下来要做什么。

## 项目是什么

**Claude Code Heihei** 是一个 Windows 桌面端 Claude Code 工作台（fork 自 cc-haha）。它在经典会话工作台之上加了 **本地大模型** 支持——用内置的 llama.cpp 在本机直接跑 GGUF 模型，不需要联网、不需要 API Key，适合普通学生电脑。

核心技术栈：
- **桌面壳**：Electron + React + Vite
- **本地推理**：llama.cpp（GGUF 模型，CPU + Vulkan）
- **构建**：bun 1.3.14 + TypeScript
- **CI**：GitHub Actions（`ci.yml` + `deploy-pages.yml`）

## 我做的工作（本会话）

这次会话我做了三件事：

### 1. 本地模型功能（已有，我在此基础上做了改进）
- 本地模型设置页 `desktop/src/pages/LocalModelSettings.tsx`
- 跑分服务 `desktop/electron/services/localModelBenchmark.ts`
- 本地模型服务 `desktop/electron/services/localModelService.ts`
- 修复了跑分「没有产出结果」的问题（GTX 750 无 fp16 会崩 GPU，加了探测 + 降级到 CPU）
- 修复了启动校验的上下文下限（16000 → 8192）
- 修复了服务端 Zod 校验的上下文下限（16000 → 8192）
- 简化了跑分交互（去掉了目标速度/上下文/使用率的选择，改成自动测机器能力并推荐配置）

### 2. 下载模型中心
- 把「下载模型」按钮改成了内置下载中心（GGUF 网站跳转 + 介绍 + 使用说明）
- 删掉了「推荐的大模型」清单（用户决定不维护，让用户自己去论坛找）
- 更新了 5 个语言文件

### 3. 站点和文档
- 更新了 GitHub 首页 README（加了本地模型介绍）
- 更新了站点首页（加了本地模型截图展示）
- 删掉了站点里已不存在的功能文档（IM 接入、桌面宠物、定时任务、H5 远程）
- 新增了本地模型文档（开始使用 + 原理分析）

## GitHub 信息

- **仓库**：`https://github.com/KyuuKyuuStone/claude-code-heihei`
- **当前版本**：`v1.0.1`（本地模型 + 下载中心 + 截图展示）
- **主分支**：`main`
- **最近提交**：
  - `9d1205a` fix(local-model): 跑分 IPC 校验去掉已移除的 targetSpeed/usage 字段
  - `a5f41a8` refactor(local-model): 简化跑分交互——不再让用户选目标速度/上下文/使用率
  - `7bf821c` fix(local-model): 跑分时警告上下文太小装不下 Claude Code 真实负载
  - `3fc232c` fix(local-model): 降低 provider 校验的上下文下限到 8192
  - `6c482c6` fix(local-model): 降低启动校验的上下文下限到 8192
  - `08bc959` fix(local-model): 跑分 GPU 崩溃时自动降级到 CPU 并提示用户
  - `2e3cecf` fix(local-model): 跑分在弱显卡上崩溃时降级到 CPU
  - `e096840` docs(site): 首页与 README 加入本地模型截图展示
  - `0e85ac8` docs(site): 新增本地模型文档，移除已移除的 IM/宠物/定时/H5 页面
  - `f0ca490` feat(local-model): 本地大模型支持（GGUF 直接运行 + 跑分 + 下载模型中心）

## 当前状态

### 能工作的
- 本地模型功能（设置页、跑分、启动、下载中心）都能用
- 跑分简化了（只选模型，自动测机器能力）
- 站点和 README 都更新了本地模型介绍
- llama.cpp 已更新到 b10786（最新）

### 已知问题 / 待办
- **llama.cpp 更新**：当前二进制是 b10786，但 v1.0.1 发布的安装包里是 b10686。如果要发 v1.0.2，需要重新打包。
- **跑分 IPC 校验**：刚修复（`9d1205a`），跑分弹窗的 IPC 校验报错应该没了。
- **GTX 750 机器**：跑分现在能正常出结果（CPU 降级），但要注意这类无 fp16 的老卡 GPU 加速不可用。

### 关键文件位置
- **本地模型设置页**：`desktop/src/pages/LocalModelSettings.tsx`
- **跑分服务**：`desktop/electron/services/localModelBenchmark.ts`
- **本地模型服务**：`desktop/electron/services/localModelService.ts`
- **IPC 校验**：`desktop/electron/ipc/capabilities.ts`
- **服务端 Zod 校验**：`src/server/types/provider.ts`、`src/server/config/providerPresets.ts`
- **桌面端类型**：`desktop/src/lib/desktopHost/types.ts`

### 构建和运行
- 开发：`cd desktop && bun run electron:dev`
- 打包：`cd desktop && bun run electron:package`（会构建 Windows 安装包）
- 发布：`bun run scripts/release.ts <版本号>`（会创建 commit + tag）

## 交接给下一个 AI 的建议

1. **先读这份文档**，理解项目状态和当前版本（v1.0.1）。
2. **本地模型是核心**——别动 llama.cpp 二进制（`desktop/src-tauri/binaries/`），除非更新版本。
3. **跑分已简化**——只选模型，自动测机器能力。别加回用户选择。
4. **发版时注意**——llama.cpp 二进制版本和安装包要一致。
5. **GTX 750 这类老卡**——GPU 加速不可用，跑分会自动降级到 CPU。这是预期行为。

## 联系方式

- 作者邮箱：`511829667@qq.com`
- GitHub：`https://github.com/KyuuKyuuStone/claude-code-heihei`

---

*交接时间：2026-09-04*
*当前版本：v1.0.1*
*交接状态：本地模型功能完整，站点已更新，准备发 v1.0.2*
