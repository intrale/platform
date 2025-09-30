#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE_PATH="$PROJECT_ROOT/BrandingTemplate.xcconfig"
OUTPUT_PATH="$PROJECT_ROOT/Branding.xcconfig"
PYTHON_SCRIPT="$SCRIPT_DIR/generate_branding_xcconfig.py"

REQUIRED_VARS=(
  BRAND_ID
)
OPTIONAL_VARS=(
  BUNDLE_ID_SUFFIX
  BRAND_NAME
  DEEPLINK_HOST
  BRANDING_ENDPOINT
  BRANDING_PREVIEW_VERSION
  PRODUCT_BUNDLE_IDENTIFIER
  DISPLAY_NAME
)

for var_name in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var_name-}" ]]; then
    echo "[Branding] Variable obligatoria faltante: $var_name" >&2
    exit 1
  fi
done

if [[ ! -f "$TEMPLATE_PATH" ]]; then
  echo "[Branding] No se encontró la plantilla en $TEMPLATE_PATH" >&2
  exit 1
fi

if [[ ! -x "$PYTHON_SCRIPT" ]]; then
  echo "[Branding] No se puede ejecutar $PYTHON_SCRIPT" >&2
  exit 1
fi

ARGS=("--template" "$TEMPLATE_PATH" "--output" "$OUTPUT_PATH")

append_if_set() {
  local key="$1"
  local value="${!key-}"
  if [[ -n "$value" ]]; then
    ARGS+=("--set" "$key=$value")
  fi
}

for key in "${REQUIRED_VARS[@]}"; do
  append_if_set "$key"
done
for key in "${OPTIONAL_VARS[@]}"; do
  append_if_set "$key"
done

"$PYTHON_SCRIPT" "${ARGS[@]}"

echo "[Branding] Archivo generado en $OUTPUT_PATH"
