<div align="right"><b>中文</b> | <a href="README.en.md">English</a></div>

# visual-review

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/visual-review.svg)](https://www.npmjs.com/package/visual-review)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web 界面打造的**双面插件**：让聊天界面直接**显示图片**，并让模型**解读图片**。

- **图片显示**：用户粘贴 / 上传的图片（PNG / JPEG / WebP / GIF）会直接渲染在对话气泡里。
- **视觉解读**：`visual_review` 工具调用视觉多模态模型，返回图片的中文文字描述（文字、物体、人物、场景、图表等）。
- **双引擎**：云端优先（任意 OpenAI 兼容的多模态 `chat/completions` API，零本地依赖）；未配置时自动回退本机 Qwen3-VL-8B（数据不出本机）。
- **无需更换模型**：插件在发送路径上把「图片块」转换成「带附件 ID 的文本注解」，任何本身看不到图片的文本模型都能配合工作。

---

## 目录

- [功能特性](#功能特性)
- [架构与工作原理](#架构与工作原理)
- [目录结构](#目录结构)
- [环境要求](#环境要求)
- [安装](#安装)
- [配置](#配置)
- [使用](#使用)
- [安全说明](#安全说明)
- [开发与测试](#开发与测试)
- [常见问题（FAQ）](#常见问题faq)
- [License](#license)

## 功能特性

| 能力 | 说明 |
| --- | --- |
| 聊天界面渲染图片 | 客户端插件注入 `conversation.chat.node` 渲染槽，把图片块渲染为 `<img>`（经 `/vr-image` 路由取字节） |
| 模型“看见”图片 | `/api/session.prompt` 拦截 + `agent/pre-step` 兜底：图片块 → 注解文本，附带附件 ID，提示模型调用工具 |
| 图片解读工具 | `visual_review`：传 `attachment_id`（会话图片）或 `image_path`（本地文件）即可分析 |
| 云端引擎 | OpenAI 兼容 `chat/completions`，图片以 `data:` URL 内联发送，支持 `content` / `reasoning_content` 返回 |
| 本机引擎 | 内置 JSON-lines worker，加载本地 Qwen3-VL-8B 推理，图片与结果均不出本机 |
| 配置工具 | `visual_review_config`：查看 / 更新云端 `url` / `api_key` / `model`，一键切换引擎 |

## 架构与工作原理

```
┌──────────────────────────── DSH Web 前端 ────────────────────────────┐
│  聊天界面（React）                                                    │
│    └─ visual-review 客户端插件（lib/client.js）                        │
│         注入 conversation.chat.node 渲染槽                             │
│         └─ 图片块 → <img src="/vr-image/sha256:xxx">                  │
└───────────────┬─────────────────────────────────────────┬────────────┘
                │ ① /api/session.prompt（图片块→注解）      │ ② /vr-image 取图片字节
┌───────────────▼─────────────────────────────────────────▼────────────┐
│                        DSH Host（插件 Host 端 lib/index.js）          │
│  • /api/session.prompt 拦截路由：把 image 块存为附件，替换为注解文本    │
│  • agent/pre-step 兜底（幂等）：模型侧消息里的 image 块 → 注解          │
│  • /vr-image 路由：仅回环地址可访问，从附件存储读取图片字节             │
│  • visual_review 工具：云端优先 → 本机回退                             │
│        ├─ 云端：node 内联脚本 → OpenAI 兼容 chat/completions           │
│        └─ 本机：spawn Python worker（server/visual_review_server.py）  │
└───────────────────────────────────────────────────────────────────────┘
```

三个关键机制：

1. **发送拦截（图片 → 注解）**。客户端发送 `session.prompt` 时，插件拦截请求，把内容中的 `image` 块交给附件服务保存，得到附件 ID（形如 `sha256:xxx`），再替换成一段文本注解：

   ```
   [用户上传了图片附件（image/png，640x360px）。你无法直接查看图片，
   请调用 visual_review 工具并传入 attachment_id="sha256:xxx" 获取图片的视觉解析。]
   ```

   `agent/pre-step` 钩子对模型侧消息做同样的转换，作为兜底且幂等。于是**文本模型也能“看见”图片**——它只需按注解调用工具。

2. **`/vr-image` 路由（字节 → 渲染）**。客户端渲染槽把注解里的附件 ID 提取出来，渲染为 `<img src="/vr-image/<id>">`；Host 端从附件存储读回图片字节返回。该路由**仅接受回环地址**（127.0.0.1 / ::1）的请求。

3. **`visual_review` 工具（图片 → 描述）**。模型拿到附件 ID 后调用工具：优先读取 `$DSH_HOME/visual_review.config.json` 走云端；未配置云端则启动/复用本机 Python worker，把图片以 base64 经 stdin 发送，worker 返回生成文本。

本机 worker 通信协议（JSON-lines，每行一个 JSON 对象）：

```
请求  → {"id":1, "kind":"describe", "image_b64":"...", "prompt":"...", "max_new_tokens":256}
响应  → {"id":1, "ok":true, "text":"图片中有一只橘猫……"}
就绪  → {"event":"ready"}   （模型在后台线程加载，describe 请求会等待该事件）
```

## 目录结构

```
visual-review/
├── lib/
│   ├── index.js                  # Host 端插件：工具、路由、发送拦截、worker 管理
│   └── client.js                 # 客户端插件：聊天界面图片渲染
├── server/
│   └── visual_review_server.py   # 本机推理 worker（Qwen3-VL-8B，JSON-lines 协议）
├── config/
│   └── visual_review.config.example.json  # 云端配置模板（含 API Key 占位符）
├── install/
│   ├── install.sh                # 一键安装到 DSH profile
│   └── cordis.patch.yml.example  # 手动安装时追加到 cordis.patch.yml 的片段
├── examples/
│   └── test_image.png            # 测试图片
├── assets/
│   ├── qr-official-account.jpg   # 公众号二维码
│   └── qr-group.png              # 交流群二维码
├── cordis.patch.yml              # dsh.bundle 安装补丁层（`dsh plugin add` 用）
├── package.json                  # 插件清单（exports host/client 双入口 + dsh.bundle manifest）
├── README.md / README.en.md      # 中文 / English 文档
├── LICENSE                       # MIT
└── .gitignore
```

## 环境要求

- **DSH**（DeepSeek Harness）Web profile（`~/.dsh/profiles/web`），Node.js ≥ 18（需要全局 `fetch`）。
- 视觉引擎**二选一**：
  - **云端模式**（推荐，最简单）：任意 OpenAI 兼容的多模态 `chat/completions` API（如 SiliconFlow、OpenAI、DeepSeek、本地 vLLM 等）。
  - **本机模式**：Python 3.10+，`torch`、`transformers`（≥ 4.57，支持 Qwen3-VL）、`Pillow`，以及本地模型文件 `Qwen3-VL-8B-Instruct`（可换为任意兼容的 Qwen3-VL 权重）。

## 安装

> **方式 A / B 无需依赖外部发布渠道**；插件已声明 `dsh.bundle` manifest（`cordis.patch.yml`），因此也支持官方 `dsh plugin add` 安装（**方式 C**，推荐，最简单）。

### 方式 C：官方 `dsh plugin add`（推荐）

npm 发布后：

```bash
dsh plugin --profile web add visual-review
```

npm 尚未发布或想装最新版时，可直接从 GitHub 安装：

```bash
dsh plugin --profile web add github:wang-bool/visual-review
```

安装后**重启 dsh web** 并刷新浏览器。

### 方式 A：一键脚本

```bash
git clone <本仓库> visual-review
cd visual-review
bash install/install.sh
```

脚本会把插件复制到 `$DSH_HOME/profiles/web/node_modules/visual-review/`，并在 `cordis.patch.yml` 中注册（幂等，重复执行安全）。可用 `DSH_HOME` / `DSH_PROFILE` 环境变量指定其它数据目录或 profile。

### 方式 B：手动安装

1. 将插件包放入 profile 的 `node_modules`：

   ```bash
   DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
   PROFILE_DIR="$DSH_HOME/profiles/web"
   mkdir -p "$PROFILE_DIR/node_modules/visual-review"
   cp -r package.json lib server "$PROFILE_DIR/node_modules/visual-review/"
   ```

2. 在 `$PROFILE_DIR/cordis.patch.yml` 末尾追加（参考 `install/cordis.patch.yml.example`）：

   ```yaml
   - insert:
       - id: visual-review
         name: 'visual-review'
   ```

3. **重启 DSH web 服务并刷新浏览器**。宿主日志出现以下输出即加载成功：

   ```
   visual_review: 全局插件已加载 (config=.../visual_review.config.json)
   visual_review: /vr-image 图片路由已注册
   visual_review: /api/session.prompt 拦截路由已注册
   ```

## 配置

### 云端引擎（推荐）

在 `$DSH_HOME/visual_review.config.json`（默认 `~/.dsh/visual_review.config.json`）写入：

```json
{
  "url": "https://api.siliconflow.cn/v1/chat/completions",
  "apiKey": "sk-xxxx",
  "model": "Qwen/Qwen3.5-35B-A3B"
}
```

也可以在会话中让模型调用 **`visual_review_config`** 工具填写 `url` / `api_key` / `model`（只传需要修改的字段；三项都留空表示清除云端配置、回退本机引擎）。

> 该文件包含明文 API Key，务必加入 `.gitignore` 并注意文件权限（本仓库的 `.gitignore` 已包含）。

### 本机引擎

未配置云端时自动回退。需要本地模型：

```bash
huggingface-cli download Qwen/Qwen3-VL-8B-Instruct
```

模型目录解析顺序：命令行参数 → 环境变量 `VISUAL_REVIEW_MODEL_DIR` → 默认 `~/.cache/huggingface/hub/models--Qwen--Qwen3-VL-8B-Instruct`。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_HOME` | `$HOME/.dsh` | DSH 数据目录，`visual_review.config.json` 存放处 |
| `VISUAL_REVIEW_SERVER` | 插件自带 `server/visual_review_server.py` | 本机推理脚本路径 |
| `VISUAL_REVIEW_PYTHON` | `python3` | 本机推理脚本的解释器 |
| `VISUAL_REVIEW_WORKSPACE` | sandbox 工作区根 → 进程 cwd | 工作区根目录（`.visual_review_tmp` 所在处） |
| `VISUAL_REVIEW_ATTACH_ROOT` | `$HOME/.dsh/attachments/v1/objects` | 附件对象存储根目录（`/vr-image` 兜底读取用） |
| `VISUAL_REVIEW_MODEL_DIR` | HF 缓存默认路径 | 本机 Qwen3-VL 模型目录（worker 内读取） |

## 使用

1. **直接体验**：在聊天框**粘贴**或**上传**一张图片 → 图片立即渲染在气泡里；模型侧自动出现附件注解，模型会自动调用 `visual_review` 并给出图片描述。
2. **分析本地文件**：让模型分析磁盘上的图片，例如“请用 `visual_review` 分析 `/path/to/photo.png`”，模型会以 `image_path` 参数调用工具。
3. **定制提问**：给模型指令时说明诉求，如“读出这张图片里的所有文字”“描述这个图表的趋势”。工具支持 `prompt` 参数，由模型按需传递。
4. **切换引擎**：调用 `visual_review_config` 修改云端配置即可；把三项都置空则回到本机引擎。

## 安全说明

- `/vr-image` 与 `/api/session.prompt` 路由**只接受回环地址**（127.0.0.1 / ::1）的请求，其他来源一律 403。
- 云端 API Key 以**明文**存储在 `$DSH_HOME/visual_review.config.json`，请勿提交到仓库、注意权限控制。
- 本机模式：图片仅在本机处理，不产生任何外部网络请求。

## 开发与测试

### 单独测试本机 worker（不经过 DSH）

```bash
# 方式一：环境变量指定模型目录
VISUAL_REVIEW_MODEL_DIR=/path/to/Qwen3-VL-8B-Instruct python3 -u server/visual_review_server.py

# 方式二：命令行参数指定模型目录
python3 -u server/visual_review_server.py /path/to/Qwen3-VL-8B-Instruct
```

另开一个终端发送请求（图片先 base64 编码）：

```bash
B64=$(base64 -w0 examples/test_image.png)
printf '{"id":1,"kind":"describe","image_b64":"%s","prompt":"请描述这张图片","max_new_tokens":256}\n' "$B64" | \
  VISUAL_REVIEW_MODEL_DIR=/path/to/model python3 -u server/visual_review_server.py
```

预期依次收到 `{"event":"ready"}` 与 `{"id":1,"ok":true,"text":"..."}`。`kind:"decode_image"` 可用于把 base64 文件还原为二进制文件（无需模型）。

### 协议速查

| 方向 | 消息 |
| --- | --- |
| Host → worker | `{"id":<n>,"kind":"describe","image_b64":"...","prompt":"...","max_new_tokens":<int>}` |
| Host → worker | `{"id":<n>,"kind":"decode_image","b64_path":"...","out_path":"..."}` |
| worker → Host | `{"id":<n>,"ok":true,"text":"..."}` 或 `{"id":<n>,"ok":false,"error":"..."}` |
| worker → Host | `{"event":"ready"}`（模型就绪）/ `{"event":"load-failed","error":"..."}` |

## 常见问题（FAQ）

**Q：模型加载很慢 / 报“模型加载超时（20 分钟）”。**
本机模式首次要加载 Qwen3-VL-8B 权重，视磁盘与显存可能需数分钟。可先确认 `VISUAL_REVIEW_MODEL_DIR` 指向正确，或用云端模式。

**Q：报“找不到附件 ID”。**
附件引用只在本会话内有效：请直接重新上传图片，或改用 `image_path` 传入本地文件路径。

**Q：云端调用失败，提示 url 似乎缺少 `/chat/completions`。**
`url` 必须是完整的 OpenAI 兼容端点，如 `https://xxx/v1/chat/completions`。

**Q：图片在界面上显示为“（图片加载失败）”。**
`/vr-image` 仅允许回环请求；若通过远程访问 DSH Web，图片渲染可能被拒绝。另外开发模式下修改客户端插件需要重建前端 bundle 并刷新。

**Q：粘贴图片后模型说看不到图片。**
确认宿主日志中有 `/api/session.prompt 拦截路由已注册`。若该行缺失（webServer/apiProxy 不可用），发送拦截被跳过，此时依赖 `agent/pre-step` 兜底；仍不行请重新上传图片。

## License

[MIT](LICENSE) © visual-review authors

---

## 联系我们

欢迎关注公众号、加入交流群，获取最新动态、使用反馈与开源讨论：

<div align="center">

| 公众号 · 关注获取最新动态 | 交流群 · 入群交流反馈 |
| :---: | :---: |
| <img src="assets/qr-official-account.jpg" width="240" alt="公众号二维码" /> | <img src="assets/qr-group.png" width="220" alt="交流群二维码" /> |

> 💡 群二维码有时效（7 天），过期后请关注公众号获取最新入群方式。

</div>
