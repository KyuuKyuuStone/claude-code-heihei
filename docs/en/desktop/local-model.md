---
title: Local models
nav_title: Local models
description: Run GGUF models directly on your own machine. No network, no API key.
order: 4
---

# Local models

Claude Code Heihei can run GGUF models directly on your own computer — no internet connection, no API key, and the model and your conversations stay local. It ships with the [llama.cpp](https://github.com/ggml-org/llama.cpp) runtime built in.

Great for things like homework, notes, small tasks that don't need a giant model, or when you just want to work fully offline without paying for API usage.

## Open the local model page

Click **Settings** at the bottom of the sidebar, then pick the **Local models** tab. You'll see three sections:

- **Hardware** — CPU cores, memory, and GPU (with VRAM when detected). The app recommends a config tier from this.
- **Configurations** — one configuration = a GGUF model file + a config tier + detail parameters. You can keep many and hit **Apply** to enable one.
- **Run state** — whether the engine is running, which port it uses, and recent logs.

## Step 1: Get a GGUF model

Click **Download models** at the top of the page to open the download hub, which links to Hugging Face, ModelScope, Ollama, and LM Studio. Pick a quantized GGUF build of a model — filenames usually look like `*Q4_K_M.gguf`.

The file can live anywhere; just remember the path.

## Step 2: Create a configuration

1. Click **New configuration**.
2. **Name** — something you'll recognize, like "7B for coding".
3. **Model file** — click **Choose model** and select the `.gguf` file you downloaded.
4. **Config tier** — pick one for your hardware:
   - **Low** — lowest resource use, CPU-first.
   - **Medium** — GPU + CPU hybrid, balanced.
   - **High** — GPU-first, speed-first.
   - **Super** — big-VRAM oriented, suits larger models.
   - **Emperor** — max configuration, squeeze the hardware.
5. Want finer control? Expand **Detail parameters** to tune context window, CPU threads, GPU layers, batch size, KV cache type, Flash Attention, sampling, and more.
6. Click **Save**.

## Step 3: Benchmark and let the app choose

If you're not sure about parameters, click **Benchmark** and let the app measure instead:

1. Pick a model file.
2. Set a **target generation speed** (tokens/sec) — how fast you want it.
3. Set a **context length** — how much conversation the model can remember.
4. Set a **hardware usage** — GPU / CPU share, leaving headroom for the system.
5. Click **Start benchmark**.

The app raises resource usage step by step until it hits your target speed, then reports a **recommended configuration**. The report also tells you roughly how much VRAM the KV cache needs at that context and whether it fits.

Click **Apply recommended configuration** to save it as a configuration.

## Step 4: Start

Back on the configurations list, select the one you want and click **Start**. The bundled llama.cpp engine boots (first load takes tens of seconds), the state flips to **Running**, and a port shows next to it.

Then switch to the local model in the model picker at the bottom-left of the input box and chat offline.

:::tip
Prefer **Benchmark** over hand-tuning. It's measured against your actual hardware, so it's far more accurate than guessing.
:::

## Troubleshooting

**The model takes a long time to load or hangs.** Check the engine log under **Run state**. Loading a big model for the first time takes tens of seconds — that's normal. If it says out of memory, shrink the context, drop the tier, or use a smaller quantization (e.g. `Q4_K_S` instead of `Q4_K_M`).

**It's slow.** Small models on CPU are slow by nature. For speed you want a bigger GPU, a smaller model, or a higher tier. Benchmark shows you the fastest combination for your hardware.

**The context doesn't fit.** Bigger context needs more VRAM for the KV cache. Benchmark tells you roughly how much; if it doesn't fit, pick a smaller context or switch to a Q4 build.

**It keeps talking but never acts.** That's a weak tool-calling model, not a config problem. Try a bigger, stronger model.

Once a model is connected, you can also check out the cloud connection methods in [Connect a model service](../start/models.md).
