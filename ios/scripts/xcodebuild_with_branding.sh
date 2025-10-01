#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE_PATH="$PROJECT_ROOT/BrandingTemplate.xcconfig"
OUTPUT_PATH="$PROJECT_ROOT/Branding.xcconfig"

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
