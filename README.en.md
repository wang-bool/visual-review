<div align="right"><a href="README.md">中文</a> | <b>English</b></div>

# visual-review

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A **dual-sided plugin** for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web UI: render images **in the chat interface** and let the model **interpret them**.

- **Image rendering** — Images pasted or uploaded by the user (PNG / JPEG / WebP / GIF) show up directly inside the chat bubble.
- **Visual interpretation** — The `visual_review` tool calls a vision-language model and returns a Chinese description of the image (text, objects, people, scenes, charts, …).
- **Dual engines** — Cloud-first: any OpenAI-compatible multimodal `chat/completions` API, zero local dependencies; falls back to a local Qwen3-VL-8B worker when no cloud config is set (data never leaves the machine).
- **No model swap needed** — The plugin rewrites `image` blocks into text annotations carrying the attachment ID on the send path, so any text-only model can "see" images by calling the tool.

---

## Table of Contents

- [Features](#features)
- [Architecture & How It Works](#architecture--how-it-works)
- [Directory Layout](#directory-layout)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Security Notes](#security-notes)
- [Development & Testing](#development--testing)
- [FAQ](#faq)
- [License](#license)

## Features

| Capability | Description |
| --- | --- |
| Render images in chat | The client plugin injects a `conversation.chat.node` render slot and renders image blocks as `<img>` (bytes served by the `/vr-image` route) |
| Let the model "see" images | `/api/session.prompt` interception + `agent/pre-step` fallback: image blocks → annotation text with the attachment ID, instructing the model to call the tool |
| Image interpretation tool | `visual_review` accepts `attachment_id` (session image) or `image_path` (local file) |
| Cloud engine | OpenAI-compatible `chat/completions`; the image is inlined as a `data:` URL; handles `content` / `reasoning_content` replies |
| Local engine | Built-in JSON-lines worker running a local Qwen3-VL-8B; images and results stay on the machine |
| Config tool | `visual_review_config` reads / updates the cloud `url` / `api_key` / `model` and switches engines in one step |

## Architecture & How It Works

```
┌──────────────────────────── DSH Web frontend ──────────────────────────┐
│  Chat UI (React)                                                       │
│    └─ visual-review client plugin (lib/client.js)                      │
│         injects conversation.chat.node render slots                    │
│         └─ image block → <img src="/vr-image/sha256:xxx">              │
└───────────────┬─────────────────────────────────────────┬──────────────┘
                │ ① /api/session.prompt (image→annotation)│ ② /vr-image bytes
┌───────────────▼─────────────────────────────────────────▼──────────────┐
│                       DSH Host (plugin host side lib/index.js)         │
│  • /api/session.prompt intercept route: save image as attachment,      │
│    replace it with annotation text                                     │
│  • agent/pre-step fallback (idempotent): image blocks in model-side    │
│    messages → annotations                                              │
│  • /vr-image route: loopback-only, reads image bytes from attachment   │
│    storage                                                             │
│  • visual_review tool: cloud first → local fallback                    │
│        ├─ cloud: inline node script → OpenAI-compatible chat/completions│
│        └─ local: spawn Python worker (server/visual_review_server.py)  │
└────────────────────────────────────────────────────────────────────────┘
```

Three key mechanisms:

1. **Send interception (image → annotation).** When the client issues `session.prompt`, the plugin intercepts it, saves each `image` block through the attachments service to obtain an attachment ID (e.g. `sha256:xxx`), and replaces the block with an annotation like:

   ```
   [用户上传了图片附件（image/png，640x360px）。你无法直接查看图片，
   请调用 visual_review 工具并传入 attachment_id="sha256:xxx" 获取图片的视觉解析。]
   ```

   The `agent/pre-step` hook applies the same transformation to model-side messages as an idempotent fallback. This is how a **text-only model can "see" images** — it just follows the annotation and calls the tool.

2. **`/vr-image` route (bytes → rendering).** The client render slot extracts the attachment ID from the annotation and renders `<img src="/vr-image/<id>">`; the host reads the bytes back from attachment storage. The route **only accepts loopback** (127.0.0.1 / ::1) requests.

3. **`visual_review` tool (image → description).** With the attachment ID in hand, the model calls the tool. It reads `$DSH_HOME/visual_review.config.json` for cloud settings; otherwise it spawns/reuses the local Python worker and sends the image as base64 over stdin.

Local worker protocol (JSON-lines, one JSON object per line):

```
request → {"id":1, "kind":"describe", "image_b64":"...", "prompt":"...", "max_new_tokens":256}
reply   → {"id":1, "ok":true, "text":"图片中有一只橘猫……"}
ready   → {"event":"ready"}   (model loads in a background thread; describe waits for it)
```

## Directory Layout

```
visual-review/
├── lib/
│   ├── index.js                  # Host plugin: tools, routes, interception, worker mgmt
│   └── client.js                 # Client plugin: image rendering in the chat UI
├── server/
│   └── visual_review_server.py   # Local inference worker (Qwen3-VL-8B, JSON-lines)
├── config/
│   └── visual_review.config.example.json  # Cloud config template (API-key placeholder)
├── install/
│   ├── install.sh                # One-shot installer into a DSH profile
│   └── cordis.patch.yml.example  # Snippet to append to cordis.patch.yml manually
├── examples/
│   └── test_image.png            # Sample image for testing
├── assets/
│   ├── qr-official-account.jpg   # Official-account QR code
│   └── qr-group.png              # Community group QR code
├── package.json                  # Plugin manifest (host + client entries)
├── README.md / README.en.md      # 中文 / English docs
├── LICENSE                       # MIT
└── .gitignore
```

## Requirements

- **DSH** (DeepSeek Harness) Web profile (`~/.dsh/profiles/web`), Node.js ≥ 18 (global `fetch` required).
- Vision engine, **pick one**:
  - **Cloud mode** (recommended, simplest): any OpenAI-compatible multimodal `chat/completions` API (SiliconFlow, OpenAI, DeepSeek, local vLLM, …).
  - **Local mode**: Python 3.10+, `torch`, `transformers` (≥ 4.57 for Qwen3-VL), `Pillow`, and local weights of `Qwen3-VL-8B-Instruct` (any compatible Qwen3-VL checkpoint works).

## Installation

### Option A: one-shot script (recommended)

```bash
git clone <this repo> visual-review
cd visual-review
bash install/install.sh
```

The script copies the plugin into `$DSH_HOME/profiles/web/node_modules/visual-review/` and registers it in `cordis.patch.yml` (idempotent — safe to re-run). Override `DSH_HOME` / `DSH_PROFILE` for other data dirs or profiles.

### Option B: manual install

1. Put the package into the profile's `node_modules`:

   ```bash
   DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
   PROFILE_DIR="$DSH_HOME/profiles/web"
   mkdir -p "$PROFILE_DIR/node_modules/visual-review"
   cp -r package.json lib server "$PROFILE_DIR/node_modules/visual-review/"
   ```

2. Append to `$PROFILE_DIR/cordis.patch.yml` (see `install/cordis.patch.yml.example`):

   ```yaml
   - insert:
       - id: visual-review
         name: 'visual-review'
   ```

3. **Restart the DSH web service and refresh the browser.** The host log should show:

   ```
   visual_review: 全局插件已加载 (config=.../visual_review.config.json)
   visual_review: /vr-image 图片路由已注册
   visual_review: /api/session.prompt 拦截路由已注册
   ```

## Configuration

### Cloud engine (recommended)

Write `$DSH_HOME/visual_review.config.json` (default `~/.dsh/visual_review.config.json`):

```json
{
  "url": "https://api.siliconflow.cn/v1/chat/completions",
  "apiKey": "sk-xxxx",
  "model": "Qwen/Qwen3.5-35B-A3B"
}
```

Alternatively, ask the model to call the **`visual_review_config`** tool with `url` / `api_key` / `model` (only the fields you pass are changed; passing none clears the cloud config and falls back to the local engine).

> This file holds the API key in plain text — keep it out of git (the repo's `.gitignore` already covers it) and mind file permissions.

### Local engine

Falls back automatically when no cloud config exists. You need local weights:

```bash
huggingface-cli download Qwen/Qwen3-VL-8B-Instruct
```

Model dir resolution: CLI argument → env var `VISUAL_REVIEW_MODEL_DIR` → default `~/.cache/huggingface/hub/models--Qwen--Qwen3-VL-8B-Instruct`.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `DSH_HOME` | `$HOME/.dsh` | DSH data dir; where `visual_review.config.json` lives |
| `VISUAL_REVIEW_SERVER` | plugin's own `server/visual_review_server.py` | path to the local inference script |
| `VISUAL_REVIEW_PYTHON` | `python3` | interpreter for the local worker |
| `VISUAL_REVIEW_WORKSPACE` | sandbox workspace root → process cwd | workspace root (where `.visual_review_tmp` lives) |
| `VISUAL_REVIEW_ATTACH_ROOT` | `$HOME/.dsh/attachments/v1/objects` | attachment object-store root (used by `/vr-image` fallback) |
| `VISUAL_REVIEW_MODEL_DIR` | default HF cache path | local Qwen3-VL model dir (read by the worker) |

## Usage

1. **Try it directly**: paste or upload an image in the chat → it renders immediately in the bubble; the annotation appears on the model side and the model calls `visual_review` on its own.
2. **Analyze a local file**: ask the model, e.g. “please analyze `/path/to/photo.png` with `visual_review`” — the model passes it via `image_path`.
3. **Custom questions**: be specific, e.g. “read all the text in this image” or “describe the trend of this chart”. The tool accepts a `prompt` parameter the model forwards as needed.
4. **Switch engines**: update the cloud config via `visual_review_config`; clearing all three fields returns to the local engine.

## Security Notes

- The `/vr-image` and `/api/session.prompt` routes **only accept loopback** (127.0.0.1 / ::1); other sources get 403.
- The cloud API key is stored **in plain text** at `$DSH_HOME/visual_review.config.json` — never commit it; restrict file permissions.
- Local mode: images are processed on the machine only; no external network requests are made.

## Development & Testing

### Test the local worker standalone (without DSH)

```bash
# via env var
VISUAL_REVIEW_MODEL_DIR=/path/to/Qwen3-VL-8B-Instruct python3 -u server/visual_review_server.py

# via CLI argument
python3 -u server/visual_review_server.py /path/to/Qwen3-VL-8B-Instruct
```

From another terminal, send a request (base64-encode the image first):

```bash
B64=$(base64 -w0 examples/test_image.png)
printf '{"id":1,"kind":"describe","image_b64":"%s","prompt":"请描述这张图片","max_new_tokens":256}\n' "$B64" | \
  VISUAL_REVIEW_MODEL_DIR=/path/to/model python3 -u server/visual_review_server.py
```

Expect `{"event":"ready"}` followed by `{"id":1,"ok":true,"text":"..."}`. `kind:"decode_image"` decodes a base64 file back to binary without loading the model.

### Protocol cheatsheet

| Direction | Message |
| --- | --- |
| Host → worker | `{"id":<n>,"kind":"describe","image_b64":"...","prompt":"...","max_new_tokens":<int>}` |
| Host → worker | `{"id":<n>,"kind":"decode_image","b64_path":"...","out_path":"..."}` |
| worker → Host | `{"id":<n>,"ok":true,"text":"..."}` or `{"id":<n>,"ok":false,"error":"..."}` |
| worker → Host | `{"event":"ready"}` / `{"event":"load-failed","error":"..."}` |

## FAQ

**Q: The model loads slowly / “模型加载超时（20 分钟）”.**
Local mode must load the Qwen3-VL-8B weights on first use — can take minutes depending on disk/GPU. Check `VISUAL_REVIEW_MODEL_DIR` or switch to cloud mode.

**Q: “找不到附件 ID”.**
Attachment references are only valid within the current session: re-upload the image, or pass a local path via `image_path`.

**Q: Cloud call fails, hinting the url seems to miss `/chat/completions`.**
`url` must be a full OpenAI-compatible endpoint, e.g. `https://xxx/v1/chat/completions`.

**Q: The image shows “（图片加载失败）” in the chat.**
`/vr-image` only allows loopback requests; remote access to the DSH Web UI may be refused. Also, during development the client plugin requires rebuilding the frontend bundle and a refresh.

**Q: After pasting an image the model says it can't see it.**
Check the host log for `/api/session.prompt 拦截路由已注册`. If missing (webServer/apiProxy unavailable), interception is skipped and only the `agent/pre-step` fallback applies; if it still fails, re-upload the image.

## License

[MIT](LICENSE) © visual-review authors

---

## Contact

Welcome to follow the official account or join the community group for latest news, feedback, and open-source discussion:

<div align="center">

| Official account · Latest news | Community group · Chat & feedback |
| :---: | :---: |
| <img src="assets/qr-official-account.jpg" width="240" alt="Official account QR code" /> | <img src="assets/qr-group.png" width="220" alt="Community group QR code" /> |

> 💡 The group QR code expires after 7 days; follow the official account to get the latest invite link.

</div>
