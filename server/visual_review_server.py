#!/usr/bin/env python3
"""visual_review worker: JSON-lines server over stdin/stdout for Qwen3-VL-8B.

Protocol (one JSON object per line, utf-8):
  Host -> worker:  {"id": <n>, "kind": "describe", "image_b64": "...", "prompt": "...", "max_new_tokens": <int>}
                   {"id": <n>, "kind": "decode_image", "b64_path": "...", "out_path": "..."}
  Worker -> host:  {"id": <n>, "ok": true,  "text": "<generated text>"}
                   {"id": <n>, "ok": false, "error": "<message>"}
  Startup notice:  {"event": "ready"}

The model loads in a background thread; describe requests wait for it, decode
requests are served immediately. The worker exits when stdin closes (EOF).

Model directory resolution (first match wins):
  1. CLI argument:  python visual_review_server.py <model_dir>
  2. Env var:       VISUAL_REVIEW_MODEL_DIR
  3. Default:       ~/.cache/huggingface/hub/models--Qwen--Qwen3-VL-8B-Instruct
                    (i.e. `huggingface-cli download Qwen/Qwen3-VL-8B-Instruct`)
"""
import base64
import io
import json
import os
import sys
import threading
import time

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("OMP_NUM_THREADS", "16")

DEFAULT_MODEL_DIR = os.path.expanduser(
    "~/.cache/huggingface/hub/models--Qwen--Qwen3-VL-8B-Instruct"
)
MODEL_DIR = os.environ.get("VISUAL_REVIEW_MODEL_DIR") or DEFAULT_MODEL_DIR
if len(sys.argv) > 1 and sys.argv[1]:
    MODEL_DIR = sys.argv[1]
MIN_PIXELS = 256 * 28 * 28
MAX_PIXELS = 1024 * 28 * 28
DEFAULT_MAX_NEW_TOKENS = 256
MODEL_LOAD_TIMEOUT_S = 1800


def log(msg):
    print(f"[visual_review] {msg}", file=sys.stderr, flush=True)


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_model():
    # transformers >= 5.x prints docstring-check "[ERROR] ..." lines to stdout
    # during import/load; route them to stderr so the JSON-lines protocol stays clean.
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        import torch
        from transformers import AutoProcessor, Qwen3VLForConditionalGeneration
    finally:
        sys.stdout = real_stdout

    use_cuda = torch.cuda.is_available()
    device = "cuda" if use_cuda else "cpu"
    dtype = torch.bfloat16 if use_cuda else torch.float32
    log(f"loading processor ... (device={device}, dtype={dtype})")
    processor = AutoProcessor.from_pretrained(MODEL_DIR)
    log("loading model ...")
    sys.stdout = sys.stderr
    try:
        model = Qwen3VLForConditionalGeneration.from_pretrained(
            MODEL_DIR,
            dtype=dtype,
            device_map=None,
            low_cpu_mem_usage=True,
        )
    finally:
        sys.stdout = real_stdout
    model.to(device)
    model.eval()
    try:
        torch.set_num_threads(int(os.environ.get("OMP_NUM_THREADS", "16")))
    except Exception:
        pass
    log("model ready")
    return processor, model, device


def generate(processor, model, device, image, prompt, max_new_tokens):
    import torch

    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image"},
                {"type": "text", "text": prompt},
            ],
        }
    ]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = processor(
        text=[text],
        images=[image],
        return_tensors="pt",
        min_pixels=MIN_PIXELS,
        max_pixels=MAX_PIXELS,
    )
    if device != "cpu":
        inputs = {k: v.to(device) for k, v in inputs.items()}
    with torch.no_grad():
        out = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            repetition_penalty=1.05,
        )
    generated = out[0][inputs["input_ids"].shape[1]:]
    return processor.decode(generated, skip_special_tokens=True).strip()


def decode_image(image_b64):
    from PIL import Image
    raw = base64.b64decode(image_b64)
    img = Image.open(io.BytesIO(raw))
    img.load()
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    return img


def handle_decode(req):
    """Decode a base64 text file into a binary file. No model needed."""
    try:
        b64_path = req.get("b64_path", "")
        out_path = req.get("out_path", "")
        if not b64_path or not out_path:
            return {"id": req.get("id"), "ok": False, "error": "missing b64_path/out_path"}
        with open(b64_path, "r", encoding="ascii") as f:
            b64 = f.read()
        data = base64.b64decode(b64)
        with open(out_path, "wb") as f:
            f.write(data)
        log(f"decode id={req.get('id')} wrote {len(data)} bytes -> {out_path}")
        return {"id": req.get("id"), "ok": True, "text": ""}
    except Exception as exc:
        return {"id": req.get("id"), "ok": False, "error": str(exc)}


def handle_describe(processor, model, device, req):
    try:
        req_id = req.get("id")
        image_b64 = req.get("image_b64", "")
        prompt = req.get("prompt") or "请详细描述这张图片的内容。"
        max_new_tokens = int(req.get("max_new_tokens") or DEFAULT_MAX_NEW_TOKENS)
        if max_new_tokens < 1:
            max_new_tokens = DEFAULT_MAX_NEW_TOKENS
        if not image_b64:
            raise ValueError("missing image_b64")
        log(f"request id={req_id} prompt={prompt[:60]!r} max_new_tokens={max_new_tokens}")
        t0 = time.time()
        image = decode_image(image_b64)
        text = generate(processor, model, device, image, prompt, max_new_tokens)
        log(f"request id={req_id} done in {time.time() - t0:.1f}s")
        return {"id": req_id, "ok": True, "text": text}
    except Exception as exc:
        return {"id": req.get("id"), "ok": False, "error": str(exc)}


def main():
    log(f"started pid={os.getpid()} model_dir={MODEL_DIR}")
    model_ready = threading.Event()
    state = {}

    def load():
        try:
            state["tuple"] = load_model()
            model_ready.set()
            emit({"event": "ready"})
        except Exception as exc:
            log(f"model load FAILED: {exc!r}")
            emit({"event": "load-failed", "error": str(exc)})

    threading.Thread(target=load, daemon=True).start()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            emit({"id": None, "ok": False, "error": "invalid JSON line"})
            continue
        kind = req.get("kind") or "describe"
        if kind == "decode_image":
            emit(handle_decode(req))
            continue
        if not model_ready.wait(timeout=MODEL_LOAD_TIMEOUT_S):
            emit({"id": req.get("id"), "ok": False, "error": "model load timed out"})
            continue
        emit(handle_describe(state["tuple"][0], state["tuple"][1], state["tuple"][2], req))
    log("stdin closed, exiting")


if __name__ == "__main__":
    main()
