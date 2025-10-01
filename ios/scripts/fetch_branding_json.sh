#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_ROOT="$PROJECT_ROOT/build/branding"

BRAND_ID="${BRAND_ID-}"
BRANDING_ENDPOINT="${BRANDING_ENDPOINT-}"
PREVIEW_VERSION="${BRANDING_PREVIEW_VERSION-}"

log_warning() {
  echo "[Branding] WARNING: $1" >&2
}

log_info() {
  echo "[Branding] $1"
}

if [[ -z "$BRAND_ID" ]]; then
  log_warning "Variable BRAND_ID no definida; se omite la descarga del JSON."
  exit 0
fi

if [[ -z "$BRANDING_ENDPOINT" ]]; then
  log_warning "Variable BRANDING_ENDPOINT no definida; se omite la descarga del JSON."
  exit 0
fi

TARGET_DIR="$BUILD_ROOT/$BRAND_ID"
TARGET_FILE="$TARGET_DIR/branding.json"
mkdir -p "$TARGET_DIR"

URL="$BRANDING_ENDPOINT"
if [[ -n "$PREVIEW_VERSION" ]]; then
  if [[ "$URL" == *"?"* ]]; then
    URL="${URL}&previewVersion=${PREVIEW_VERSION}"
  else
    URL="${URL}?previewVersion=${PREVIEW_VERSION}"
  fi
fi

TMP_FILE="$(mktemp)"
CURL_STDERR="$(mktemp)"
cleanup() {
  rm -f "$TMP_FILE" "$CURL_STDERR"
}
trap cleanup EXIT

CURL_ARGS=(
  --fail-with-body
  --location
  --silent
  --show-error
  --connect-timeout 5
  --max-time 20
  --retry 2
  --retry-delay 2
  "$URL"
  --output "$TMP_FILE"
)

if ! curl "${CURL_ARGS[@]}" 2>"$CURL_STDERR"; then
  log_warning "No se pudo descargar el branding desde $URL: $(<"$CURL_STDERR")"
  exit 0
fi
rm -f "$CURL_STDERR"

if ! python3 - "$TMP_FILE" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
    payload = json.loads(path.read_text(encoding="utf-8"))
except Exception as exc:  # noqa: BLE001
    print(f"[Branding] ERROR: JSON inválido: {exc}", file=sys.stderr)
    sys.exit(1)

required_paths = (
    ("payload", "images", "logo"),
    ("copy", "appName"),
)
missing = []
for route in required_paths:
    cursor = payload
    for segment in route:
        if isinstance(cursor, dict) and segment in cursor:
            cursor = cursor[segment]
        else:
            missing.append(".".join(route))
            break

if missing:
    print(
        "[Branding] ERROR: Faltan claves obligatorias: " + ", ".join(missing),
        file=sys.stderr,
    )
    sys.exit(1)
PY
then
  log_warning "El JSON descargado no superó la validación mínima; se omite la actualización."
  exit 0
fi

mv "$TMP_FILE" "$TARGET_FILE"
trap - EXIT
cleanup

log_info "Branding cacheado en $TARGET_FILE"
