/**
 * 精选 GGUF 模型清单——随应用打包的静态数据，不连服务器。
 *
 * 维护约定：只收录官方或高口碑组织发布的 GGUF 仓库，每条给 Hugging Face 和
 * ModelScope 两个直链；链接失效时用户可按名字去站点搜索。一年核对一两次即可。
 * 量化建议统一指向 Q4_K_M（速度/体积/质量甜点）。
 */

export type LocalModelCatalogEntry = {
  name: string
  /** 文件名里一般长这样的规模标签 */
  params: string
  /** Q4_K_M 量化的大致体积 */
  sizeGB: string
  capability: 'chat' | 'tools' | 'vision'
  note: string
  huggingFace: string
  modelScope: string
  /** 多模态模型需要同仓库里的 mmproj 投影文件才能看图 */
  needsMmproj?: boolean
}

export const LOCAL_MODEL_CATALOG: LocalModelCatalogEntry[] = [
  {
    name: 'Qwen3-4B-Instruct-2507',
    params: '4B',
    sizeGB: '约 2.4 GB',
    capability: 'tools',
    note: '本地首选：4B 里工具调用最稳，日常问答 + 轻量代码都行，8GB 内存可跑',
    huggingFace: 'https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507-GGUF',
    modelScope: 'https://modelscope.cn/models/Qwen/Qwen3-4B-Instruct-2507-GGUF',
  },
  {
    name: 'Qwen2.5-Coder-7B-Instruct',
    params: '7B',
    sizeGB: '约 4.7 GB',
    capability: 'tools',
    note: '代码专精：写代码、改代码任务选它，需要 16GB 内存较从容',
    huggingFace: 'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
    modelScope: 'https://modelscope.cn/models/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
  },
  {
    name: 'Qwen3-8B',
    params: '8B',
    sizeGB: '约 5.2 GB',
    capability: 'tools',
    note: '全能均衡：能力比 4B 明显强一档，纯 CPU 会慢，有可用独显时推荐',
    huggingFace: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF',
    modelScope: 'https://modelscope.cn/models/Qwen/Qwen3-8B-GGUF',
  },
  {
    name: 'gemma-3-4b-it',
    params: '4B',
    sizeGB: '约 2.9 GB',
    capability: 'vision',
    note: '能看图的聊天模型：日常问答 + 图片理解；需同仓库下载 mmproj 投影文件并在方案里配置',
    huggingFace: 'https://huggingface.co/google/gemma-3-4b-it-gguf',
    modelScope: 'https://modelscope.cn/models/google/gemma-3-4b-it-gguf',
    needsMmproj: true,
  },
  {
    name: 'DeepSeek-R1-Distill-Qwen-7B',
    params: '7B',
    sizeGB: '约 4.7 GB',
    capability: 'tools',
    note: '带推理链：数学/逻辑题先想后答，但输出带长思考、纯 CPU 下更慢',
    huggingFace: 'https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B-GGUF',
    modelScope: 'https://modelscope.cn/models/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B-GGUF',
  },
]

export const CAPABILITY_LABELS = {
  chat: '适合聊天 · 轻任务',
  tools: '能扛工具调用',
  vision: '能看图 · 聊天',
} as const
