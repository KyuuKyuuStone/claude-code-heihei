---
title: How local models work
nav_title: Local models
description: How the desktop app runs GGUF with the bundled llama.cpp, detects the GPU, and estimates KV cache VRAM.
order: 6
---

# How local models work

This page explains the design: the desktop app doesn't run the model in the web page. It starts a local llama.cpp server and talks to it over a loopback HTTP port. Read this to understand what **Benchmark** actually computes and why a large context may not fit.

## Process model

Instead of packing GGUF inference into the React renderer, the desktop app ships binary builds and starts them separately:

```text
Electron main
└── llama-server (bundled llama.cpp, separate child process)
    ├── loads the given .gguf model
    ├── listens on a free loopback port
    └── exposes /health and an OpenAI-compatible /v1 chat interface
```

- **Electron main** finds a free port, spawns `llama-server`, and polls `/health` until the model is ready.
- **llama-server** does the actual inference and stays resident once the model is loaded.
- Once ready, the desktop app registers `http://127.0.0.1:<port>` as an `anthropic`-format Provider, so chat and tool calls reuse the same protocol as cloud models.

Two `llama-server` builds ship:

- `llama-server/` — pure CPU.
- `llama-server-vulkan/` — uses Vulkan for the GPU, works across NVIDIA / AMD / Intel, and is much smaller than CUDA (about 95 MB vs 1.1 GB) — better suited to modest student machines.

## GPU and memory detection

Before startup, the desktop app calls `llama-server --list-devices` to enumerate available Vulkan devices, parsing the GPU name and VRAM (e.g. `Vulkan0: NVIDIA GeForce RTX 3050 (6216 MiB)`); CPU cores and total RAM come from the OS. These drive the recommended tier — more RAM or VRAM means a higher tier.

## KV cache and context

During inference, every token keeps a Key/Value cache in the attention layers. The longer the context, the bigger the KV cache, and it must live in VRAM to be fast.

The KV cache size is roughly:

```text
KV bytes/token ≈ layers × kv_heads × head_dim × 2 (K+V) × 2 bytes (f16)
```

The desktop app reads `block_count`, `attention.head_count_kv`, `attention.head_count`, and `embedding_length` from the GGUF header to compute this, then estimates the VRAM needed at a given context and compares it to your available VRAM.

That's why a **large context may not fit**: it's not the model size, it's the KV cache growing roughly linearly with context, which easily exceeds VRAM.

## How Benchmark works

Benchmark finds the tier that hits your target speed with the least resource use:

1. Read GGUF metadata, compute KV cache requirements, and first check whether the target context fits in VRAM.
2. Start from the user's chosen hardware usage and raise it step by step (GPU layers / CPU threads).
3. At each step, actually run `llama-bench` once, measuring generation speed (tokens/sec) at a fixed context depth.
4. Stop when speed reaches the target or resources max out; the tier that first reaches the target is the recommendation.

:::info
Speed is measured at a fixed 8K context, not at the user's chosen large context: `llama-bench` has to actually run that many tokens to fill the KV cache, so testing 128K can take minutes or hang. So "context size" is handled separately with the memory formula (does it fit), and speed is measured independently at a small context — the two are decoupled, which is both fast and accurate.
:::

## Why Vulkan over CUDA

The CUDA build drags in a large CUDA / cuDNN runtime (about 1.1 GB), while the Vulkan build is only ~95 MB and works across NVIDIA / AMD / Intel. For the target audience (modest student machines, small VRAM), Vulkan is the best balance of size and compatibility.
