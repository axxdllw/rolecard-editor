#!/usr/bin/env bash
# 构建并部署到服务器：介绍页（site/）放在站点根目录，编辑器（dist/）放在 /app/
#
# 用法：DEPLOY_HOST=ubuntu@1.2.3.4 DEPLOY_PORT=22 bash scripts/deploy.sh
#   DEPLOY_ROOT 默认 /opt/rolecard/www（服务器上的目录结构见 deploy/）
#   SKIP_BUILD=1 跳过构建，直接上传现有 dist/
set -euo pipefail

: "${DEPLOY_HOST:?请设置 DEPLOY_HOST，例如 ubuntu@1.2.3.4}"
PORT="${DEPLOY_PORT:-22}"
ROOT="${DEPLOY_ROOT:-/opt/rolecard/www}"

cd "$(dirname "$0")/.."
[ "${SKIP_BUILD:-}" = 1 ] || npm run build

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -r site/. "$stage/"
mkdir "$stage/app"
cp -r dist/. "$stage/app/"

release="$(date +%Y%m%d-%H%M%S)"
tar -C "$stage" -czf - . | ssh -p "$PORT" "$DEPLOY_HOST" "set -e
  cd '$ROOT'
  mkdir -p releases
  dir=releases/$release
  mkdir \"\$dir\"
  tar -xzf - -C \"\$dir\"
  # 留着上一版的分包：已经打开旧页面的人懒加载时不会 404
  if [ -d current/app/assets ]; then cp -rn current/app/assets/. \"\$dir/app/assets/\"; fi
  ln -sfn \"\$dir\" current.tmp && mv -T current.tmp current
  # 只保留最近 5 个版本
  ls -1d releases/* | head -n -5 | xargs -r rm -rf
  echo \"已部署 \$dir\""
