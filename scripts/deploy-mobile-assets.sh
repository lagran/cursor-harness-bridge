#!/usr/bin/env bash
# Deploy the Harness mobile UI assets (sidebar overlay CSS/JS, home-screen
# icons, web manifest) to a caller-selected reverse proxy.
#
# Two levels:
#   --container (default)  patch the selected running Nginx container only:
#                          copy assets, add location blocks, reload nginx.
#                          Fast, but a container restart re-renders
#                          /etc/nginx/nginx.conf from the host template and
#                          drops the patch.
#   --host                 also patch the selected host proxy project
#                          (deploy/nginx/nginx.conf + deploy/docker-compose.yml)
#                          so the deployment survives container recreation.
#                          Requires HARNESS_PROXY_PROJECT.
#
# Idempotent: re-running only refreshes copied files and bumps nothing.
# Usage:
#   HARNESS_NGINX_CONTAINER=my-nginx \
#     bash scripts/deploy-mobile-assets.sh [--host] [asset-version]
set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${HARNESS_NGINX_CONTAINER:-}"
HOST_REPO="${HARNESS_PROXY_PROJECT:-}"
COMPOSE_SERVICE="${HARNESS_COMPOSE_SERVICE:-nginx}"
RECREATE="${HARNESS_RECREATE:-0}"
ASSET_VERSION="${HARNESS_ASSET_VERSION:-}"
BACKUP_DIR="${HARNESS_BACKUP_DIR:-${BRIDGE_DIR}/.deploy-backups}"
PATCH_HOST=0
PATCH_CONTAINER=1

for arg in "$@"; do
  case "$arg" in
    --host) PATCH_HOST=1 ;;
    --container) ;;
    --host-only) PATCH_HOST=1; PATCH_CONTAINER=0 ;;
    *) ASSET_VERSION="$arg" ;;
  esac
done

need() { [[ -e "$1" ]] || { echo "missing: $1" >&2; exit 1; }; }

need "${BRIDGE_DIR}/deploy/harness-mobile-nav.js"
need "${BRIDGE_DIR}/deploy/harness-manifest.webmanifest"
need "${BRIDGE_DIR}/deploy/harness-icons"
need "${BRIDGE_DIR}/deploy/nginx-mobile-assets.locations.conf"

if [[ -z "${ASSET_VERSION}" ]]; then
  ASSET_VERSION="$(
    {
      sha256sum \
        "${BRIDGE_DIR}/deploy/harness-mobile.css" \
        "${BRIDGE_DIR}/deploy/harness-image-upload.js" \
        "${BRIDGE_DIR}/deploy/harness-mobile-nav.js" \
        "${BRIDGE_DIR}/deploy/harness-manifest.webmanifest"
      find "${BRIDGE_DIR}/deploy/harness-icons" -maxdepth 1 -type f \
        -exec sha256sum {} + | sort
    } | sha256sum | cut -c1-12
  )"
fi

if [[ "${PATCH_CONTAINER}" -eq 1 && -z "${CONTAINER}" ]]; then
  echo "Set HARNESS_NGINX_CONTAINER or use --host-only." >&2
  exit 2
fi
if [[ "${PATCH_HOST}" -eq 1 && -z "${HOST_REPO}" ]]; then
  echo "Set HARNESS_PROXY_PROJECT to the host proxy checkout." >&2
  exit 2
fi

SUB_FILTER_LINE="      sub_filter '</head>' '<link rel=\"apple-touch-icon\" sizes=\"180x180\" href=\"/harness-icons/apple-touch-icon.png?v=${ASSET_VERSION}\"><meta name=\"apple-mobile-web-app-capable\" content=\"yes\"><meta name=\"mobile-web-app-capable\" content=\"yes\"><meta name=\"apple-mobile-web-app-title\" content=\"Harness\"><meta name=\"apple-mobile-web-app-status-bar-style\" content=\"default\"><link rel=\"stylesheet\" href=\"/harness-mobile.css?v=${ASSET_VERSION}\"><script defer src=\"/harness-image-upload.js?v=${ASSET_VERSION}\"></script><script defer src=\"/harness-mobile-nav.js?v=${ASSET_VERSION}\"></script></head>';"

patch_conf() {
  # $1 = nginx.conf path (host file or container path via docker exec sh)
  local conf="$1"
  local tmp
  tmp="$(mktemp)"

  # 1) Insert location blocks once, right after the image-upload location.
  if ! grep -q 'harness-mobile-nav.js' "$conf"; then
    awk '
      { print }
      /location = \/harness-image-upload\.js/ { inblock = 1 }
      inblock && /^    }/ && !done {
        while ((getline line < "'"${BRIDGE_DIR}/deploy/nginx-mobile-assets.locations.conf"'") > 0) print line
        done = 1
        inblock = 0
      }
    ' "$conf" > "$tmp"
    cat "$tmp" > "$conf"
  fi

  # 2) Replace the sub_filter line with the full mobile injection.
  awk -v repl="$SUB_FILTER_LINE" '
    /sub_filter .<\/head>./ && !done { print repl; done = 1; next }
    { print }
  ' "$conf" > "$tmp"
  cat "$tmp" > "$conf"
  rm -f "$tmp"
}

backup_file() {
  local source="$1"
  install -d -m 0700 "${BACKUP_DIR}"
  cp "${source}" "${BACKUP_DIR}/$(basename "${source}").$(date +%Y%m%d-%H%M%S)"
}

if [[ "${PATCH_CONTAINER}" -eq 1 ]]; then
  echo "== copying assets into ${CONTAINER} =="
  docker exec "${CONTAINER}" sh -c 'mkdir -p /etc/nginx/harness-icons'
  docker cp "${BRIDGE_DIR}/deploy/harness-mobile-nav.js" "${CONTAINER}:/etc/nginx/harness-mobile-nav.js"
  docker cp "${BRIDGE_DIR}/deploy/harness-manifest.webmanifest" "${CONTAINER}:/etc/nginx/harness-manifest.webmanifest"
  docker cp "${BRIDGE_DIR}/deploy/harness-icons/." "${CONTAINER}:/etc/nginx/harness-icons/"

  # docker cp preserves restrictive source modes; Nginx workers need read access.
  docker exec "${CONTAINER}" sh -c \
    'chmod 644 /etc/nginx/harness-mobile-nav.js /etc/nginx/harness-manifest.webmanifest /etc/nginx/harness-icons/*'

  echo "== patching rendered nginx.conf inside the container =="
  docker exec "${CONTAINER}" cat /etc/nginx/nginx.conf >"/tmp/harness-nginx.conf.$$"
  patch_conf "/tmp/harness-nginx.conf.$$"
  docker cp "/tmp/harness-nginx.conf.$$" "${CONTAINER}:/etc/nginx/nginx.conf"
  rm -f "/tmp/harness-nginx.conf.$$"
  docker exec "${CONTAINER}" nginx -t
  docker exec "${CONTAINER}" nginx -s reload
  echo "== container is live =="
fi

if [[ "$PATCH_HOST" -eq 1 ]]; then
  HOST_CONF="${HARNESS_NGINX_TEMPLATE:-${HOST_REPO}/deploy/nginx/nginx.conf}"
  HOST_COMPOSE="${HARNESS_COMPOSE_FILE:-${HOST_REPO}/deploy/docker-compose.yml}"
  need "$HOST_CONF"
  need "$HOST_COMPOSE"

  echo "== patching host template ${HOST_CONF} =="
  backup_file "$HOST_CONF"
  patch_conf "$HOST_CONF"

  echo "== adding volume mounts to ${HOST_COMPOSE} =="
  chmod 0755 "${BRIDGE_DIR}/deploy/harness-icons"
  chmod 0644 \
    "${BRIDGE_DIR}/deploy/harness-mobile-nav.js" \
    "${BRIDGE_DIR}/deploy/harness-manifest.webmanifest" \
    "${BRIDGE_DIR}/deploy/harness-icons/"*
  if ! grep -q 'harness-mobile-nav.js' "$HOST_COMPOSE"; then
    backup_file "$HOST_COMPOSE"
    awk -v b="${BRIDGE_DIR}" '
      { print }
      /deploy\/harness-image-upload\.js:\/etc\/nginx\/harness-image-upload\.js/ && !done {
        print "      # Harness 移动端导航增强：选中会话自动收起侧边栏 + 遮罩点击关闭"
        print "      - \"" b "/deploy/harness-mobile-nav.js:/etc/nginx/harness-mobile-nav.js:ro\""
        print "      # Harness 主屏图标与 PWA 清单"
        print "      - \"" b "/deploy/harness-manifest.webmanifest:/etc/nginx/harness-manifest.webmanifest:ro\""
        print "      - \"" b "/deploy/harness-icons:/etc/nginx/harness-icons:ro\""
        done = 1
      }
    ' "$HOST_COMPOSE" > "${HOST_COMPOSE}.new"
    mv "${HOST_COMPOSE}.new" "$HOST_COMPOSE"
  fi

  echo "== host files patched; recreate when convenient =="
  if [[ "${RECREATE}" == "1" ]]; then
    docker compose -f "${HOST_COMPOSE}" up -d "${COMPOSE_SERVICE}"
  else
    echo "    docker compose -f ${HOST_COMPOSE} up -d ${COMPOSE_SERVICE}"
  fi
fi

echo
echo "asset version: ${ASSET_VERSION}"
echo "verify your deployment's /harness-icons/icon-192.png endpoint"
