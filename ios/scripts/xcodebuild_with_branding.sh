#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE_PATH="$PROJECT_ROOT/BrandingTemplate.xcconfig"
OUTPUT_PATH="$PROJECT_ROOT/Branding.xcconfig"
APP_ICON_SCRIPT="$SCRIPT_DIR/generate_app_icon.swift"
APP_ICONSET_DIR="$PROJECT_ROOT/GeneratedAssets/AppIcon.appiconset"

BRANDING_KEYS=(
  BRAND_ID
  BUNDLE_ID_SUFFIX
  BRAND_NAME
  DEEPLINK_HOST
  BRANDING_ENDPOINT
  BRANDING_PREVIEW_VERSION
  PRODUCT_BUNDLE_IDENTIFIER
  DISPLAY_NAME
)

declare -A BRANDING_OVERRIDES=()

declare -a FORWARDED_ARGS=()

for arg in "$@"; do
  if [[ "$arg" == -* ]]; then
    FORWARDED_ARGS+=("$arg")
    continue
  fi

  if [[ "$arg" == *=* ]]; then
    key="${arg%%=*}"
    value="${arg#*=}"
    for known_key in "${BRANDING_KEYS[@]}"; do
      if [[ "$key" == "$known_key" ]]; then
        BRANDING_OVERRIDES["$key"]="$value"
        break
      fi
    done
    FORWARDED_ARGS+=("$arg")
  else
    FORWARDED_ARGS+=("$arg")
  fi
done

for key in "${!BRANDING_OVERRIDES[@]}"; do
  export "$key"="${BRANDING_OVERRIDES[$key]}"
done

PYTHON_SCRIPT="$SCRIPT_DIR/generate_branding_xcconfig.py"

if [[ ! -x "$PYTHON_SCRIPT" ]]; then
  echo "Error: no se puede ejecutar $PYTHON_SCRIPT" >&2
  exit 1
fi

"$PYTHON_SCRIPT" --template "$TEMPLATE_PATH" --output "$OUTPUT_PATH"

if command -v swift >/dev/null 2>&1; then
  if [[ ! -x "$APP_ICON_SCRIPT" ]]; then
    echo "[Branding] WARNING: Script de AppIcon no disponible en $APP_ICON_SCRIPT" >&2
  else
    EFFECTIVE_BRAND_ID="${BRANDING_OVERRIDES[BRAND_ID]:-${BRAND_ID-}}"
    if [[ -z "$EFFECTIVE_BRAND_ID" ]]; then
      echo "[Branding] WARNING: No se pudo determinar BRAND_ID para generar AppIcon" >&2
    else
      ICON_ARGS=("--brand-id" "$EFFECTIVE_BRAND_ID" "--output" "$APP_ICONSET_DIR")
      BRANDING_JSON_PATH="$PROJECT_ROOT/build/branding/$EFFECTIVE_BRAND_ID/branding.json"
      if [[ -f "$BRANDING_JSON_PATH" ]]; then
        ICON_ARGS+=("--branding-json" "$BRANDING_JSON_PATH")
      fi
      DISPLAY_VALUE="${BRANDING_OVERRIDES[DISPLAY_NAME]:-${DISPLAY_NAME-}}"
      if [[ -n "$DISPLAY_VALUE" ]]; then
        ICON_ARGS+=("--display-name" "$DISPLAY_VALUE")
      else
        BRAND_VALUE="${BRANDING_OVERRIDES[BRAND_NAME]:-${BRAND_NAME-}}"
        if [[ -n "$BRAND_VALUE" ]]; then
          ICON_ARGS+=("--display-name" "$BRAND_VALUE")
        fi
      fi
      BRAND_VALUE="${BRANDING_OVERRIDES[BRAND_NAME]:-${BRAND_NAME-}}"
      if [[ -n "$BRAND_VALUE" ]]; then
        ICON_ARGS+=("--brand-name" "$BRAND_VALUE")
      fi
      "$APP_ICON_SCRIPT" "${ICON_ARGS[@]}"
    fi
  fi
else
  echo "[Branding] WARNING: Swift no está disponible; se omite la generación de AppIcon" >&2
fi

has_xcconfig=false
for arg in "${FORWARDED_ARGS[@]}"; do
  if [[ "$arg" == "-xcconfig" ]]; then
    has_xcconfig=true
    break
  fi
done

if [[ "$has_xcconfig" == false ]]; then
  FORWARDED_ARGS+=("-xcconfig" "$OUTPUT_PATH")
fi

exec xcodebuild "${FORWARDED_ARGS[@]}"
