#!/usr/bin/env bash
#
# visual-review 一键安装脚本
# 将本插件安装到 DSH 的 web profile，并注册到 cordis.patch.yml。
#
# 用法:
#   bash install/install.sh
# 可选环境变量:
#   DSH_HOME      DSH 数据目录（默认 $HOME/.dsh）
#   DSH_PROFILE   目标 profile 名（默认 web）
#
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DSH_PROFILE="${DSH_PROFILE:-web}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROFILE_DIR="$DSH_HOME/profiles/$DSH_PROFILE"
PLUGIN_DIR="$PROFILE_DIR/node_modules/visual-review"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
PLUGIN_ID="visual-review"

echo "==> 目标 profile: $PROFILE_DIR"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "错误: profile 目录不存在: $PROFILE_DIR"
  echo "请确认已用 dsh 初始化过 web profile（$DSH_PROFILE），或通过 DSH_PROFILE 指定其它 profile。"
  exit 1
fi

# 1) 复制插件包（package.json + cordis.patch.yml + lib/ + server/）
mkdir -p "$PLUGIN_DIR"
echo "==> 复制插件到 $PLUGIN_DIR"
cp "$SRC_DIR/package.json" "$PLUGIN_DIR/package.json"
cp "$SRC_DIR/cordis.patch.yml" "$PLUGIN_DIR/cordis.patch.yml"
cp -r "$SRC_DIR/lib" "$PLUGIN_DIR/lib"
cp -r "$SRC_DIR/server" "$PLUGIN_DIR/server"

# 2) 注册到 cordis.patch.yml（幂等：已存在则跳过）
if [ ! -f "$PATCH_FILE" ]; then
  echo "==> 创建 $PATCH_FILE"
  cat > "$PATCH_FILE" <<EOF
# dsh profile 用户补丁层。将 visual-review 插件插入启动列表。
- insert:
    - id: $PLUGIN_ID
      name: '$PLUGIN_ID'
EOF
elif ! grep -q "$PLUGIN_ID" "$PATCH_FILE"; then
  echo "==> 追加插件条目到 $PATCH_FILE"
  {
    printf '\n# visual-review 图片显示与视觉解读插件\n'
    printf -- '- insert:\n'
    printf '    - id: %s\n' "$PLUGIN_ID"
    printf "      name: '%s'\n" "$PLUGIN_ID"
  } >> "$PATCH_FILE"
else
  echo "==> $PATCH_FILE 已包含 $PLUGIN_ID，跳过注册"
fi

echo
echo "✔ 安装完成。接下来："
echo "  1. 配置视觉引擎（二选一）："
echo "     - 云端: 写入 $DSH_HOME/visual_review.config.json（参考 config/visual_review.config.example.json），"
echo "       或在会话中让模型调用 visual_review_config 工具填写 url/api_key/model。"
echo "     - 本机: 下载 Qwen3-VL-8B-Instruct 并设置 VISUAL_REVIEW_MODEL_DIR（详见 README）。"
echo "  2. 重启 DSH web 服务，并刷新浏览器页面。"
echo "  3. 验证：宿主日志应出现「visual_review: 全局插件已加载」；"
echo "     粘贴/上传一张图片，聊天界面应直接渲染图片，模型会自动调用 visual_review 解读。"
