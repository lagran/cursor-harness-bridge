#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root (for example: sudo -E $0)." >&2
  exit 1
fi

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "${BRIDGE_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${BRIDGE_DIR}/.env"
  set +a
fi

WORKSPACE_DIR="${CURSOR_WORKSPACE:-${1:-}}"
if [[ -z "${WORKSPACE_DIR}" ]]; then
  echo "Set CURSOR_WORKSPACE in .env or pass the workspace path as argument 1." >&2
  exit 2
fi
WORKSPACE_DIR="$(realpath "${WORKSPACE_DIR}")"
[[ -d "${WORKSPACE_DIR}" ]] || {
  echo "Workspace is not a directory: ${WORKSPACE_DIR}" >&2
  exit 2
}

HARNESS_DOMAIN="${HARNESS_DOMAIN:-localhost}"
HARNESS_PORT="${HARNESS_PORT:-3080}"
HARNESS_RUN_USER="${HARNESS_RUN_USER:-${SUDO_USER:-$(id -un)}}"
HARNESS_RUN_GROUP="${HARNESS_RUN_GROUP:-$(id -gn "${HARNESS_RUN_USER}")}"
ENV_FILE="${HARNESS_ENV_FILE:-${BRIDGE_DIR}/.env}"
DSH_BIN="${BRIDGE_DIR}/node_modules/.bin/dsh"
NODE_BIN="$(command -v node)"
SERVICE_PATH="$(dirname "${NODE_BIN}"):/usr/local/bin:/usr/bin:/bin"

[[ "${HARNESS_DOMAIN}" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || {
  echo "HARNESS_DOMAIN must be a bare host or host:port." >&2
  exit 2
}
[[ "${HARNESS_PORT}" =~ ^[0-9]+$ ]] && ((HARNESS_PORT > 0 && HARNESS_PORT < 65536)) || {
  echo "HARNESS_PORT must be between 1 and 65535." >&2
  exit 2
}
[[ -x "${DSH_BIN}" ]] || {
  echo "Harness CLI is missing. Run npm install first." >&2
  exit 1
}

escape_sed() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

template="${BRIDGE_DIR}/deploy/cursor-harness.service.in"
temp_dir="$(mktemp -d)"
rendered="${temp_dir}/cursor-harness.service"
trap 'rm -rf "${temp_dir}"' EXIT

sed \
  -e "s|@RUN_USER@|$(escape_sed "${HARNESS_RUN_USER}")|g" \
  -e "s|@RUN_GROUP@|$(escape_sed "${HARNESS_RUN_GROUP}")|g" \
  -e "s|@WORKSPACE_DIR@|$(escape_sed "${WORKSPACE_DIR}")|g" \
  -e "s|@ENV_FILE@|$(escape_sed "${ENV_FILE}")|g" \
  -e "s|@SERVICE_PATH@|$(escape_sed "${SERVICE_PATH}")|g" \
  -e "s|@DSH_BIN@|$(escape_sed "${DSH_BIN}")|g" \
  -e "s|@HARNESS_PORT@|$(escape_sed "${HARNESS_PORT}")|g" \
  -e "s|@HARNESS_DOMAIN@|$(escape_sed "${HARNESS_DOMAIN}")|g" \
  "${template}" >"${rendered}"

systemd-analyze verify "${rendered}"
install -m 0644 "${rendered}" /etc/systemd/system/cursor-harness.service
install -m 0644 \
  "${BRIDGE_DIR}/deploy/cursor-harness-refresh.service" \
  /etc/systemd/system/cursor-harness-refresh.service
install -m 0644 \
  "${BRIDGE_DIR}/deploy/cursor-harness-refresh.timer" \
  /etc/systemd/system/cursor-harness-refresh.timer

systemctl daemon-reload
systemctl enable --now cursor-harness.service
systemctl enable --now cursor-harness-refresh.timer

echo "Installed cursor-harness.service"
echo "  workspace: ${WORKSPACE_DIR}"
echo "  endpoint:  http://127.0.0.1:${HARNESS_PORT}"
echo "  host:      ${HARNESS_DOMAIN}"
