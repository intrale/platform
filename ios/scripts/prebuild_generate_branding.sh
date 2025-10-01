#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE_PATH="$PROJECT_ROOT/BrandingTemplate.xcconfig"
OUTPUT_PATH="$PROJECT_ROOT/Branding.xcconfig"
PYTHON_SCRIPT="$SCRIPT_DIR/generate_branding_xcconfig.py"
FETCH_SCRIPT="$SCRIPT_DIR/fetch_branding_json.sh"
APP_ICON_SCRIPT="$SCRIPT_DIR/generate_app_icon.swift"
APP_ICONSET_DIR="$PROJECT_ROOT/GeneratedAssets/AppIcon.appiconset"

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

if [[ -x "$FETCH_SCRIPT" ]]; then
  if ! "$FETCH_SCRIPT"; then
    echo "[Branding] WARNING: No se pudo actualizar el cache de branding" >&2
  fi
else
  echo "[Branding] WARNING: Script de fetch no disponible en $FETCH_SCRIPT" >&2
fi

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

if command -v swift >/dev/null 2>&1; then
  if [[ ! -x "$APP_ICON_SCRIPT" ]]; then
    echo "[Branding] WARNING: Script de AppIcon no disponible en $APP_ICON_SCRIPT" >&2
  else
    ICON_ARGS=("--brand-id" "$BRAND_ID" "--output" "$APP_ICONSET_DIR")
    BRANDING_JSON_PATH="$PROJECT_ROOT/build/branding/$BRAND_ID/branding.json"
    if [[ -f "$BRANDING_JSON_PATH" ]]; then
      ICON_ARGS+=("--branding-json" "$BRANDING_JSON_PATH")
    fi
    if [[ -n "${DISPLAY_NAME-}" ]]; then
      ICON_ARGS+=("--display-name" "$DISPLAY_NAME")
    elif [[ -n "${BRAND_NAME-}" ]]; then
      ICON_ARGS+=("--display-name" "$BRAND_NAME")
    fi
    if [[ -n "${BRAND_NAME-}" ]]; then
      ICON_ARGS+=("--brand-name" "$BRAND_NAME")
    fi
    "$APP_ICON_SCRIPT" "${ICON_ARGS[@]}"
  fi
else
  echo "[Branding] WARNING: Swift no está disponible; se omite la generación de AppIcon" >&2
fi

echo "[Branding] Archivo generado en $OUTPUT_PATH"
