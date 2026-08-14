// visual_review 全局插件（Host 端）
//
// 作用：
//  - visual_review 工具：分析图片。默认读取 $DSH_HOME/visual_review.config.json
//    （通常为 ~/.dsh/visual_review.config.json），若配置了 url/apiKey/model
//    （云端，OpenAI 兼容 chat/completions 多模态接口）则走云端；否则回退本机
//    Qwen3-VL-8B（server/visual_review_server.py 子进程）。
//  - visual_review_config 工具：查看/更新上述配置。
//  - /vr-image 路由：给客户端渲染提供图片字节。
//  - /api/session.prompt 拦截 + agent/pre-step：把图片块转成带附件 ID 的注解，
//    让模型（本身看不到图片）能定位附件并调用 visual_review。
//
// 路径全部可通过环境变量覆盖（见 README「环境变量」一节）：
//  VISUAL_REVIEW_SERVER     本机推理脚本（默认：插件自带 server/visual_review_server.py）
//  VISUAL_REVIEW_PYTHON     本机推理脚本的解释器（默认：python3）
//  VISUAL_REVIEW_WORKSPACE  工作区根目录（默认：sandbox workspaceRoot，再退回进程 cwd）
//  VISUAL_REVIEW_ATTACH_ROOT 附件对象存储根目录（默认：$HOME/.dsh/attachments/v1/objects）
//  DSH_HOME                 DSH 数据目录（默认：$HOME/.dsh，配置文件所在处）
import os from 'node:os'

const name = 'visual-review'

const inject = ['tools', 'webServer', 'apiProxy']

// 配置路径：$DSH_HOME/visual_review.config.json（与插件代码和工作目录隔离）
const DSH_HOME = process.env.DSH_HOME || os.homedir() + '/.dsh'
const CONFIG_PATH = DSH_HOME + '/visual_review.config.json'

// 本机推理脚本：优先环境变量，其次插件自带的 server/visual_review_server.py，
// 最后回退到「工作区根目录/visual_review_server.py」（旧约定的兼容路径）。
const PLUGIN_SERVER = (() => {
  try {
    return new URL('../server/visual_review_server.py', import.meta.url).pathname
  } catch (err) {
    return ''
  }
})()
const DEFAULT_SERVER = (process.env.VISUAL_REVIEW_SERVER && process.env.VISUAL_REVIEW_SERVER.trim() !== '')
  ? process.env.VISUAL_REVIEW_SERVER.trim()
  : (PLUGIN_SERVER !== '' ? PLUGIN_SERVER : '')
const PYTHON = (process.env.VISUAL_REVIEW_PYTHON && process.env.VISUAL_REVIEW_PYTHON.trim() !== '')
  ? process.env.VISUAL_REVIEW_PYTHON.trim()
  : 'python3'
const DEFAULT_ATTACH_ROOT = os.homedir() + '/.dsh/attachments/v1/objects'
const ATTACH_ROOT = (process.env.VISUAL_REVIEW_ATTACH_ROOT && process.env.VISUAL_REVIEW_ATTACH_ROOT.trim() !== '')
  ? process.env.VISUAL_REVIEW_ATTACH_ROOT.trim()
  : DEFAULT_ATTACH_ROOT
const READY_TIMEOUT_MS = 20 * 60 * 1000
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_BODY_BYTES = 64 * 1024 * 1024
const DEFAULT_PROMPT = '请详细描述这张图片的内容，包括其中的文字、物体、人物、场景和布局。'
const DEFAULT_MAX_TOKENS = 256

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function bytesToBase64(bytes) {
  const len = bytes.length
  let out = ''
  let i = 0
  while (i < len) {
    const b0 = bytes[i++]
    const b1 = i < len ? bytes[i++] : -1
    const b2 = i < len ? bytes[i++] : -1
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | (b1 < 0 ? 0 : b1 >> 4)]
    out += b1 < 0 ? '=' : B64[((b1 & 15) << 2) | (b2 < 0 ? 0 : b2 >> 6)]
    out += b2 < 0 ? '=' : B64[b2 & 63]
  }
  return out
}

function sniffMediaType(data) {
  if (data && data.length >= 4) {
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif'
    if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  }
  return 'image/png'
}

function apply(ctx) {
  const state = {
    worker: null,
    attachmentRefs: new Map()
  }

  const sandboxPolicy = ctx.get('sandboxPolicy')
  const PROCESS_WORKSPACE = (process.env.VISUAL_REVIEW_WORKSPACE && process.env.VISUAL_REVIEW_WORKSPACE.trim() !== '')
    ? process.env.VISUAL_REVIEW_WORKSPACE.trim()
    : ((sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot !== '')
      ? sandboxPolicy.workspaceRoot
      : process.cwd())
  const TMP_DIR = PROCESS_WORKSPACE + '/.visual_review_tmp'

  // 工作区按会话 cwd 解析：本机推理脚本跟随每个会话自己的工作区
  function sessionWorkspace(agent) {
    try {
      const session = agent && agent.session
      const cwd = session && session.header && typeof session.header.cwd === 'string' && session.header.cwd !== '' ? session.header.cwd : undefined
      if (cwd) return cwd
    } catch (err) {}
    return PROCESS_WORKSPACE
  }

  // 日志：同时写控制台和 .visual_review_tmp/status.log，便于排查启动问题
  function log(msg) {
    console.log(msg)
    try {
      const fsSvc = ctx.get('fs')
      if (fsSvc) {
        fsSvc.resolve(TMP_DIR + '/status.log').then(async (t) => {
          let prev = ''
          try { prev = await fsSvc.readText(t) } catch (err) { prev = '' }
          await fsSvc.writeText(t, prev + msg + '\n')
        }).catch(() => {})
      }
    } catch (err) {}
  }

  // ── 本机 worker（Qwen3-VL） ──────────────────────────────────────────────
  function handleWorkerLine(worker, line) {
    let obj
    try { obj = JSON.parse(line) } catch (err) { return }
    if (obj && obj.event === 'ready') {
      worker.ready = true
      const waiters = worker.readyWaiters
      worker.readyWaiters = []
      for (const w of waiters) w.resolve()
      console.log('visual_review: worker ready')
      return
    }
    if (obj && typeof obj.id === 'number') {
      const entry = worker.pending.get(obj.id)
      if (entry) {
        worker.pending.delete(obj.id)
        if (obj.ok) entry.resolve(String(obj.text || ''))
        else entry.reject(new Error(obj.error || 'visual_review: 推理失败'))
      }
    }
  }

  function handleWorkerExit(worker, outcome) {
    if (state.worker === worker) state.worker = null
    const detail = outcome && outcome.exitCode !== undefined
      ? 'code=' + outcome.exitCode + ' signal=' + outcome.signal
      : String((outcome && outcome.error) || outcome)
    const err = new Error('visual_review: 推理进程退出 (' + detail + ')')
    for (const [, entry] of worker.pending) entry.reject(err)
    worker.pending.clear()
    for (const w of worker.readyWaiters) w.reject(err)
    worker.readyWaiters = []
    console.log('visual_review: worker exited (' + detail + ')')
  }

  function spawnWorker(script) {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) throw new Error('visual_review: subprocess 服务不可用')
    const proc = subprocess.spawn({
      argv: [PYTHON, '-u', script],
      cwd: PROCESS_WORKSPACE,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 1 << 16, spill: { maxBytes: 1 << 20 } } },
      graceMs: 30000,
      env: { PYTHONUNBUFFERED: '1', TOKENIZERS_PARALLELISM: 'false', OMP_NUM_THREADS: '16' }
    })
    const worker = { proc, pending: new Map(), nextId: 1, ready: false, readyWaiters: [], buffer: '' }
    state.worker = worker
    if (proc.stdout) {
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk) => {
        worker.buffer += chunk
        let nl
        while ((nl = worker.buffer.indexOf('\n')) !== -1) {
          const line = worker.buffer.slice(0, nl).trim()
          worker.buffer = worker.buffer.slice(nl + 1)
          if (line !== '') handleWorkerLine(worker, line)
        }
      })
      proc.stdout.on('error', () => {})
    }
    proc.done.then(
      (outcome) => handleWorkerExit(worker, outcome),
      (error) => handleWorkerExit(worker, { error })
    )
    console.log('visual_review: worker spawned pid=' + proc.pid)
    return worker
  }

  function ensureWorker(script) {
    if (state.worker) return state.worker
    return spawnWorker(script)
  }

  function waitReady(worker) {
    if (worker.ready) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, value) => { if (settled) return; settled = true; fn(value) }
      const timerId = setTimeout(() => finish(reject, new Error('visual_review: 模型加载超时（20 分钟），请稍后重试')), READY_TIMEOUT_MS)
      worker.readyWaiters.push({
        resolve: () => { clearTimeout(timerId); finish(resolve) },
        reject: (err) => { clearTimeout(timerId); finish(reject, err) }
      })
    })
  }

  function sendWorkerRequest(worker, payload) {
    const id = worker.nextId++
    return new Promise((resolve, reject) => {
      worker.pending.set(id, { resolve, reject })
      try {
        worker.proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n')
      } catch (err) {
        worker.pending.delete(id)
        reject(new Error('visual_review: 无法写入推理进程: ' + (err && err.message ? err.message : String(err))))
      }
    })
  }

  async function localAnalyze(bytes, prompt, maxTokens, signal, script) {
    const worker = ensureWorker(script)
    await waitReady(worker)
    if (signal && signal.aborted) throw new Error('visual_review: 已中止')
    return sendWorkerRequest(worker, { kind: 'describe', image_b64: bytesToBase64(bytes), prompt, max_new_tokens: maxTokens })
  }

  function abortable(promise, signal) {
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(new Error('visual_review: 已中止'))
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error('visual_review: 已中止'))
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
        (error) => { signal.removeEventListener('abort', onAbort); reject(error) }
      )
    })
  }

  // ── 图片字节解析（附件 / 本地路径） ─────────────────────────────────────
  function findRefInSession(agent, attachmentId) {
    const session = agent && agent.session
    const events = session && Array.isArray(session.events) ? session.events : null
    if (!events) return undefined
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (!ev || ev.type !== 'user/message') continue
      const content = ev.data && Array.isArray(ev.data.content) ? ev.data.content : null
      if (!content) continue
      for (let j = 0; j < content.length; j++) {
        const block = content[j]
        if (block && block.type === 'image' && block.attachment && String(block.attachment.attachmentId) === attachmentId) {
          return block.attachment
        }
      }
    }
    return undefined
  }

  async function resolveAttachment(attachmentId, agent, signal) {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new Error('visual_review: attachments 服务不可用')
    let ref = state.attachmentRefs.get(attachmentId)
    if (ref === undefined) {
      ref = findRefInSession(agent, attachmentId)
      if (ref !== undefined) state.attachmentRefs.set(attachmentId, ref)
    }
    if (ref === undefined) {
      throw new Error('visual_review: 找不到附件 ID ' + attachmentId + '。请改用 image_path 传入图片路径，或让用户重新上传图片。')
    }
    const stored = await attachments.readImage(ref, signal)
    return { bytes: stored.data, source: 'attachment:' + attachmentId }
  }

  async function resolvePath(imagePath, signal) {
    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('visual_review: fs 服务不可用')
    const target = await fs.resolve(imagePath)
    const info = await fs.stat(target, signal)
    if (info === undefined) throw new Error('visual_review: 文件不存在: ' + imagePath)
    const data = await fs.readBytes(target, signal, MAX_IMAGE_BYTES)
    return { bytes: data, source: imagePath }
  }

  // ── 云端配置（visual_review.config.json） ────────────────────────────────
  async function readConfig(path) {
    const fs = ctx.get('fs')
    if (fs === undefined) return { value: null }
    try {
      const target = await fs.resolve(path)
      const info = await fs.stat(target)
      if (info === undefined) return { value: null }
      const text = await fs.readText(target)
      const parsed = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { value: null }
      return { value: parsed }
    } catch (err) {
      return { value: null }
    }
  }

  function isCloudConfigured(cfg) {
    return !!cfg && typeof cfg.url === 'string' && cfg.url.trim() !== '' &&
      typeof cfg.apiKey === 'string' && cfg.apiKey.trim() !== '' &&
      typeof cfg.model === 'string' && cfg.model.trim() !== ''
  }

  // ── 云端调用（node 内联脚本，OpenAI 兼容 chat/completions） ───────────────
  const helper = `(async () => {
  const fs = require("fs");
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const raw = Buffer.from(input.imageB64, "base64");
  const mime = sniffMime(raw);
  const body = {
    model: input.model,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: input.prompt || "请详细描述这张图片的内容，包括其中所有的文字、图形元素和整体用途。" },
        { type: "image_url", image_url: { url: "data:" + mime + ";base64," + input.imageB64 } }
      ]
    }],
    max_tokens: input.maxTokens || 1024
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150000);
  let res;
  try {
    res = await fetch(input.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + input.apiKey },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    process.stderr.write("网络错误: " + (err && err.message ? err.message : String(err)));
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    let hint = "";
    if (input.url.indexOf("/chat/completions") === -1) hint = "（url 似乎缺少 /v1/chat/completions 端点，请检查配置）";
    process.stderr.write("HTTP " + res.status + ": " + text.slice(0, 2000) + hint);
    process.exit(1);
  }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
  let answer = text;
  if (parsed && Array.isArray(parsed.choices) && parsed.choices[0]) {
    const c = parsed.choices[0].message;
    if (c) {
      if (typeof c.content === "string" && c.content.trim() !== "") answer = c.content;
      else if (typeof c.reasoning_content === "string" && c.reasoning_content.trim() !== "") answer = c.reasoning_content;
      else if (c.content !== undefined && c.content !== null) answer = JSON.stringify(c.content);
    }
  } else if (parsed && typeof parsed.content === "string") {
    answer = parsed.content;
  }
  process.stdout.write(answer);
  function sniffMime(buf) {
    if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf.length > 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
    if (buf.length > 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
    return "image/png";
  }
})();`

  async function cloudAnalyze(bytes, prompt, maxTokens, cfg, signal) {
    const shell = ctx.get('shell')
    if (shell === undefined) throw new Error('visual_review: shell 服务不可用')
    const payload = JSON.stringify({
      url: cfg.url.trim(),
      apiKey: cfg.apiKey.trim(),
      model: cfg.model.trim(),
      prompt: prompt,
      maxTokens: maxTokens,
      imageB64: bytesToBase64(bytes)
    })
    let spec
    try {
      spec = shell.resolve({
        command: "node -e '" + helper + "'",
        stdin: payload,
        timeoutMs: 180000,
        stdoutMaxBytes: 2000000,
        signal: signal
      })
    } catch (err) {
      throw new Error('visual_review: 构造云端命令失败: ' + (err && err.message ? err.message : String(err)))
    }
    let result
    try {
      result = await shell.run(spec)
    } catch (err) {
      throw new Error('visual_review: 云端调用失败: ' + (err && err.message ? err.message : String(err)))
    }
    const stderr = (result.stderr && result.stderr.text) ? result.stderr.text : ''
    if (result.exitCode !== 0) {
      throw new Error('visual_review: 云端调用失败(exit ' + result.exitCode + '): ' + (stderr || '无错误输出').slice(0, 3000))
    }
    const stdout = (result.stdout && result.stdout.text) ? result.stdout.text : ''
    if (stdout.trim() === '') {
      throw new Error('visual_review: 云端返回为空' + (stderr !== '' ? '（stderr: ' + stderr.slice(0, 500) + '）' : ''))
    }
    return stdout
  }

  // ── 注解格式（与客户端渲染约定一致） ────────────────────────────────────
  function annotationFor(ref, name) {
    const id = String(ref.attachmentId)
    const label = typeof name === 'string' && name !== '' ? '（' + name + '）' : ''
    const dims = typeof ref.width === 'number' && typeof ref.height === 'number' ? ref.width + 'x' + ref.height + 'px' : ''
    return '[用户上传了图片附件' + label + '，附件 ID=' + id + '（' + ref.mediaType + '，' + dims + '）。你无法直接查看图片，请调用 visual_review 工具并传入 attachment_id="' + id + '" 获取图片的视觉解析。]'
  }

  async function saveImageFromBase64(part) {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new Error('visual_review: attachments 服务不可用')
    const b64 = String(part.data || '').replace(/^data:[^,]*,/, '')
    if (b64 === '') throw new Error('visual_review: 图片数据为空')
    const bytes = Buffer.from(b64, 'base64')
    if (bytes.length === 0) throw new Error('visual_review: 图片数据为空')
    return attachments.saveImage({
      data: bytes,
      mediaType: part.mediaType,
      ...typeof part.name === 'string' ? { name: part.name } : {}
    })
  }

  async function transformPromptContent(content) {
    const result = []
    for (const part of content) {
      if (part && part.type === 'image') {
        const ref = await saveImageFromBase64(part)
        state.attachmentRefs.set(String(ref.attachmentId), ref)
        result.push({ type: 'text', text: annotationFor(ref, part.name) })
      } else {
        result.push(part)
      }
    }
    return result
  }

  // ── /vr-image 路由（供客户端渲染图片） ───────────────────────────────────
  function isLoopback(address) {
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  }

  function registerImageRoute() {
    const webServer = ctx.get('webServer')
    if (webServer === undefined) return null
    const handler = async (req, res) => {
      const remote = req.socket && req.socket.remoteAddress
      if (!isLoopback(remote)) { res.writeHead(403); res.end('forbidden'); return }
      const rawUrl = req.url || ''
      const q = rawUrl.indexOf('?')
      const path = (q === -1 ? rawUrl : rawUrl.slice(0, q))
      let id = path.slice('/vr-image/'.length)
      try { id = decodeURIComponent(id) } catch (err) {}
      if (id === '' || id === path || !id.startsWith('sha256:')) { res.writeHead(404); res.end(); return }
      const attachments = ctx.get('attachments')
      if (attachments !== undefined) {
        const ref = state.attachmentRefs.get(id)
        if (ref !== undefined) {
          try {
            const stored = await attachments.readImage(ref)
            res.writeHead(200, { 'content-type': stored.ref.mediaType, 'content-length': stored.data.byteLength, 'cache-control': 'private, max-age=86400' })
            res.end(stored.data)
            return
          } catch (err) {}
        }
      }
      const hex = id.slice(7)
      if (/^[a-f0-9]{64}$/.test(hex)) {
        const fs = ctx.get('fs')
        try {
          const target = await fs.resolve(ATTACH_ROOT + '/' + hex.slice(0, 2) + '/' + hex)
          const info = await fs.stat(target)
          if (info !== undefined) {
            const data = await fs.readBytes(target, undefined, MAX_IMAGE_BYTES)
            res.writeHead(200, { 'content-type': sniffMediaType(data), 'content-length': data.byteLength, 'cache-control': 'private, max-age=86400' })
            res.end(data)
            return
          }
        } catch (err) {}
      }
      res.writeHead(404); res.end()
    }
    try {
      const dispose = webServer.register({ kind: 'prefix', path: '/vr-image', handler })
      log('visual_review: /vr-image 图片路由已注册')
      return dispose
    } catch (err) {
      log('visual_review: /vr-image 路由注册失败: ' + (err && err.message ? err.message : String(err)))
      return null
    }
  }

  // ── /api/session.prompt 拦截（图片块 → 注解，让模型能"看见"附件） ───────
  function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      const onData = (chunk) => {
        size += chunk.length
        if (size > maxBytes) { cleanup(); reject(new Error('request body too large')); req.destroy(); return }
        chunks.push(chunk)
      }
      const onEnd = () => {
        cleanup()
        const total = new Uint8Array(size)
        let off = 0
        for (const c of chunks) { total.set(c, off); off += c.length }
        resolve(new TextDecoder('utf-8').decode(total))
      }
      const onError = (err) => { cleanup(); reject(err) }
      const cleanup = () => {
        req.removeListener('data', onData)
        req.removeListener('end', onEnd)
        req.removeListener('error', onError)
      }
      req.on('data', onData)
      req.on('end', onEnd)
      req.on('error', onError)
    })
  }

  function writeJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  function registerPromptRoute() {
    const webServer = ctx.get('webServer')
    const apiProxy = ctx.get('apiProxy')
    if (webServer === undefined || apiProxy === undefined) {
      log('visual_review: webServer/apiProxy 服务不可用，跳过发送拦截（粘贴图片会被模型准入拒绝）')
      return null
    }
    const sessions = apiProxy.sessions
    if (!sessions || typeof sessions.prompt !== 'function') {
      log('visual_review: apiProxy.sessions.prompt 不可用，跳过发送拦截')
      return null
    }
    const handler = async (req, res) => {
      const remote = req.socket && req.socket.remoteAddress
      if (!isLoopback(remote)) { res.writeHead(403); res.end('forbidden'); return }
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return }
      const ct = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
      if (ct !== 'application/json') { res.writeHead(415); res.end('content type must be application/json'); return }
      let raw
      try { raw = await readBody(req, MAX_BODY_BYTES) } catch (err) { res.writeHead(413); res.end('request body too large'); return }
      let envelope
      try { envelope = JSON.parse(raw) } catch (err) { envelope = null }
      if (!envelope || typeof envelope !== 'object' || envelope.method !== 'session.prompt' || !envelope.payload || typeof envelope.payload !== 'object') {
        writeJson(res, 200, {
          type: 'server-response',
          rpcId: envelope && typeof envelope.rpcId === 'string' ? envelope.rpcId : 'invalid-request',
          result: { ok: false, error: { code: 'bad-request', message: 'invalid client-request message', details: { issues: [] } } }
        })
        return
      }
      const writeOutcome = (result) => writeJson(res, 200, { type: 'server-response', rpcId: envelope.rpcId, result })
      try {
        const hasImage = Array.isArray(envelope.payload.content) && envelope.payload.content.some((p) => p && p.type === 'image')
        const payload = hasImage
          ? { ...envelope.payload, content: await transformPromptContent(envelope.payload.content) }
          : envelope.payload
        const outcome = await sessions.prompt({ rpcId: envelope.rpcId, payload })
        writeOutcome(outcome && outcome.result ? outcome.result : { ok: false, error: { code: 'internal', message: 'visual_review: prompt 无返回结果', details: {} } })
      } catch (error) {
        let result
        if (error && typeof error === 'object' && error.name === 'AttachmentError') {
          result = { ok: false, error: { code: 'attachment-error', message: String(error.message || error), details: { reason: String(error.code || 'INVALID_IMAGE') } } }
        } else {
          result = { ok: false, error: { code: 'internal', message: 'visual_review: ' + String((error && error.message) || error), details: {} } }
        }
        writeOutcome(result)
      }
    }
    try {
      const dispose = webServer.register({ kind: 'exact', path: '/api/session.prompt', handler })
      log('visual_review: /api/session.prompt 拦截路由已注册')
      return dispose
    } catch (err) {
      log('visual_review: /api/session.prompt 路由注册失败: ' + (err && err.message ? err.message : String(err)))
      return null
    }
  }

  // ── pre-step：模型侧消息里的图片块 → 注解（兜底，幂等） ─────────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
    try {
      let changed = false
      const messages = []
      for (const message of decision.messages) {
        const content = message && Array.isArray(message.content) ? message.content : null
        if (!content || !content.some((b) => b && b.type === 'image')) { messages.push(message); continue }
        changed = true
        const newContent = content.map((block) => {
          if (!block || block.type !== 'image') return block
          const ref = block.attachment
          if (!ref || !ref.attachmentId) return { type: 'text', text: '[用户上传了图片，但附件引用不可用]' }
          const id = String(ref.attachmentId)
          state.attachmentRefs.set(id, ref)
          return { type: 'text', text: annotationFor(ref, ref.name) }
        })
        messages.push({ ...message, content: newContent })
      }
      return changed ? { ...decision, messages } : decision
    } catch (err) {
      console.error('visual_review: pre-step 处理失败: ' + (err && err.message ? err.message : String(err)))
      return decision
    }
  })

  // ── 工具：visual_review（云端优先，未配置回退本机） ─────────────────────
  const tool = {
    name: 'visual_review',
    description: '分析图片：调用视觉多模态模型并返回中文文字描述。默认读取 $DSH_HOME/visual_review.config.json（通常为 ~/.dsh/visual_review.config.json）——若配置了 url/apiKey/model（云端，OpenAI 兼容 chat/completions 接口）则走云端模型；否则回退本机 Qwen3-VL-8B。可用 visual_review_config 工具查看/修改配置。当用户粘贴/上传了图片（会话中会出现带附件 ID 的提示）或需要读取图片中的文字、图表、场景时使用。attachment_id 与 image_path 二者提供其一：用户上传的图片用 attachment_id；本地文件用 image_path。',
    parameters: {
      type: 'object',
      properties: {
        attachment_id: { type: 'string', description: '用户上传/粘贴图片的附件 ID（来自会话中图片提示，形如 sha256:xxx）。' },
        image_path: { type: 'string', description: '图片文件的绝对路径（PNG/JPEG/WebP/GIF）。' },
        prompt: { type: 'string', description: '希望视觉模型回答的问题，例如“读出图中所有文字”或“描述图表内容”。缺省为详细描述图片内容。' },
        max_new_tokens: { type: 'integer', description: '输出最大 token 数，默认 256。' }
      }
    },
    output: {
      schema: {},
      render: (args, value) => [{ type: 'text', text: value && typeof value.text === 'string' ? value.text : JSON.stringify(value) }]
    },
    isConcurrencySafe: () => true,
    timeoutMs: 1500000,
    async execute(args, exec) {
      const attachmentId = typeof args.attachment_id === 'string' ? args.attachment_id.trim() : ''
      const imagePath = typeof args.image_path === 'string' ? args.image_path.trim() : ''
      if (attachmentId === '' && imagePath === '') throw new Error('visual_review 需要 attachment_id 或 image_path 参数')
      const prompt = typeof args.prompt === 'string' && args.prompt.trim() !== '' ? args.prompt.trim() : DEFAULT_PROMPT
      const maxTokens = Number.isInteger(args.max_new_tokens) && args.max_new_tokens > 0 ? args.max_new_tokens : DEFAULT_MAX_TOKENS
      const signal = exec && exec.signal ? exec.signal : undefined
      const agent = exec && exec.agent ? exec.agent : undefined
      let bytes, source
      if (attachmentId !== '') {
        const resolved = await resolveAttachment(attachmentId, agent, signal)
        bytes = resolved.bytes
        source = resolved.source
      } else {
        const resolved = await resolvePath(imagePath, signal)
        bytes = resolved.bytes
        source = resolved.source
      }
      const ws = sessionWorkspace(agent)
      const script = (DEFAULT_SERVER !== '' && DEFAULT_SERVER !== (ws + '/visual_review_server.py'))
        ? DEFAULT_SERVER
        : (ws + '/visual_review_server.py')
      const cfg = await readConfig(CONFIG_PATH)
      if (isCloudConfigured(cfg.value)) {
        const text = await cloudAnalyze(bytes, prompt, maxTokens, cfg.value, signal)
        return { text, source: 'cloud:' + cfg.value.model.trim() }
      }
      const text = await abortable(localAnalyze(bytes, prompt, maxTokens, signal, script), signal)
      return { text, source }
    }
  }

  // ── 工具：visual_review_config（查看/更新云端配置） ─────────────────────
  const configTool = {
    name: 'visual_review_config',
    description: '查看或更新 visual_review 的云端视觉模型配置（写入 $DSH_HOME/visual_review.config.json：url 为 OpenAI 兼容 chat/completions 完整地址，api_key 为密钥，model 为支持图片的模型名）。只传需要修改的字段，其余保持不变；三项都留空表示不配置云端、继续使用本机模型。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'OpenAI 兼容的 chat/completions 完整地址。' },
        api_key: { type: 'string', description: 'API Key（明文写入配置文件）。' },
        model: { type: 'string', description: '支持图片的模型名，如 gpt-4o-mini / qwen-vl-plus。' }
      }
    },
    output: {
      schema: {},
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    async execute(args, exec) {
      const fs = ctx.get('fs')
      if (fs === undefined) throw new Error('visual_review_config: fs 服务不可用')
      const existing = (await readConfig(CONFIG_PATH)).value
      const base = (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) ? existing : {}
      const next = {
        url: (typeof args.url === 'string' && args.url.trim() !== '') ? args.url.trim() : (typeof base.url === 'string' ? base.url : ''),
        apiKey: (typeof args.api_key === 'string' && args.api_key.trim() !== '') ? args.api_key.trim() : (typeof base.apiKey === 'string' ? base.apiKey : ''),
        model: (typeof args.model === 'string' && args.model.trim() !== '') ? args.model.trim() : (typeof base.model === 'string' ? base.model : '')
      }
      const target = await fs.resolve(CONFIG_PATH)
      await fs.writeText(target, JSON.stringify(next, null, 2) + '\n')
      return { ok: true, configPath: CONFIG_PATH, url: next.url, model: next.model, apiKeySet: next.apiKey !== '' }
    }
  }

  ctx.tools.register(tool)
  ctx.tools.register(configTool)

  // ── 路由与 worker 的生命周期清理 ────────────────────────────────────────
  ctx.effect(() => {
    let disposeImageRoute = null
    let disposePromptRoute = null
    disposeImageRoute = registerImageRoute()
    disposePromptRoute = registerPromptRoute()
    return () => {
      if (disposeImageRoute && typeof disposeImageRoute === 'function') { try { disposeImageRoute() } catch (err) {} }
      if (disposePromptRoute && typeof disposePromptRoute === 'function') { try { disposePromptRoute() } catch (err) {} }
      if (state.worker) { try { state.worker.proc.terminate() } catch (err) {} state.worker = null }
    }
  })

  log('visual_review: 全局插件已加载 (config=' + CONFIG_PATH + ')')
}

export { name, inject, apply }
