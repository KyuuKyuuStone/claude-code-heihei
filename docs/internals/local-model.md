---
title: 本地模型原理
nav_title: 本地模型原理
description: 桌面端怎么用内置 llama.cpp 跑 GGUF、怎么识别显卡、怎么估算 KV 缓存显存。
order: 6
---

# 本地模型原理

这一篇讲「为什么这么设计」：桌面端不把模型跑在网页里，而是拉起一个本机的 llama.cpp 服务，通过一个本地 HTTP 端口对话。读完你就明白「跑分」是怎么算出来的、为什么大上下文可能装不下。

## 进程模型

桌面端不把 GGUF 推理塞进 React 渲染进程，而是分包了一套二进制，独立启动：

```text
Electron main
└── llama-server（内置 llama.cpp，独立子进程）
    ├── 加载指定的 .gguf 模型
    ├── 在 127.0.0.1 上监听一个空闲端口
    └── 暴露 /health 与 OpenAI 兼容的 /v1 对话接口
```

- **Electron main** 负责找空闲端口、拉起 `llama-server`、轮询 `/health` 直到模型就绪。
- **llama-server** 是真正做推理的进程，加载模型后常驻内存。
- 就绪后，桌面端把 `http://127.0.0.1:<port>` 注册成一个 `anthropic` 格式的 Provider，于是对话、工具调用走的是和云端模型同一套协议。

包了两套 `llama-server`：

- `llama-server/` — 纯 CPU 版。
- `llama-server-vulkan/` — 用 Vulkan 走 GPU，跨 NVIDIA / AMD / Intel，比 CUDA 版小得多（约 95 MB vs 1.1 GB），更适合「普通学生电脑」这个目标。

## 显卡与内存检测

启动前，桌面端调用 `llama-server --list-devices` 拿到机器上可用的 Vulkan 设备，解析出显卡名和显存大小（例如 `Vulkan0: NVIDIA GeForce RTX 3050 (6216 MiB)`）；CPU 核数和总内存来自系统。把这些塞进推荐档位：内存或显存越大，推荐的档位越高。

## KV 缓存与上下文

大模型推理时，每个 token 都要在注意力层保留一份 Key/Value 缓存（KV cache）。上下文越长，KV 缓存越大，而且要装在显存里才快。

KV 缓存大小大概可以这样估：

```text
KV 字节/ token ≈ 层数 × KV 头数 × 头维度 × 2（K+V）× 2 字节（f16）
```

桌面端读取 GGUF 文件头里的 `block_count`、`attention.head_count_kv`、`attention.head_count`、`embedding_length` 等字段，就能算出这个值，进而估算指定上下文下 KV 缓存需要的显存，并比较你的可用显存够不够。

这就是为什么**大上下文可能装不下**：不是模型本身大，而是 KV 缓存随上下文线性增长，很容易顶爆显存。

## 跑分怎么测

「跑分」的目标是找到「速度达标、资源占用最小」的档位，流程是：

1. 读 GGUF 元数据，算出 KV 缓存需求，先判断目标上下文能不能装进显存。
2. 从用户选的硬件使用率开始，一档档往上调（GPU 层数 / CPU 线程）。
3. 每一档都实际跑一次 `llama-bench`，用固定的上下文深度测**生成速度**（token/秒）。
4. 当速度达到目标值，或资源用满，停止；哪一档最快达标，哪一档就是推荐配置。

:::info
速度在固定的 8K 上下文下实测，而不是在用户选的大上下文下测：`llama-bench` 必须真的跑过那么多 token 才能填满 KV 缓存，测 128K 上下文要几分钟甚至卡死。所以「上下文大小」单独用上面的内存公式算装不装得下，速度单独在小上下文下测——两者解耦，又快又准。
:::

## 为什么选 Vulkan 而不是 CUDA

CUDA 版要带一大套 cuDNN / CUDA 运行时（约 1.1 GB），而 Vulkan 版只要 ~95 MB，跨 NVIDIA / AMD / Intel 都能用。对目标用户（普通学生电脑、显存不大）来说，Vulkan 是体积和兼容性的最佳平衡。
