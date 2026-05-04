#!/usr/bin/env bash
# Uso: web-verify.sh
# Ejecuta el ciclo de verificacion del Paso 6 del agente /web-dev:
# build Wasm, verifyNoLegacyStrings, validateComposeResources y
# scanNonAsciiFallbacks. Resume cada gate.

set -uo pipefail

export JAVA_HOME="${JAVA_HOME:-/c/Users/Administrator/.jdks/temurin-21.0.7}"

cd "$(dirname "$0")/../.."

run_gate() {
  local label="$1"
  local task="$2"
  echo "=== ${label} ==="
  if ./gradlew "$task" --no-daemon 2>&1 | tail -30; then
    echo "[OK] ${label}"
    return 0
  else
    echo "[FAIL] ${label}"
    return 1
  fi
}

declare -i FAILED=0
declare -i TOTAL=0

TOTAL+=1; run_gate "wasm-webpack"           ":app:composeApp:wasmJsBrowserDevelopmentWebpack" || FAILED+=1
TOTAL+=1; run_gate "verify-no-legacy-strs"  "verifyNoLegacyStrings"                           || FAILED+=1
TOTAL+=1; run_gate "validate-resources"     ":app:composeApp:validateComposeResources"        || FAILED+=1
TOTAL+=1; run_gate "scan-ascii-fallbacks"   ":app:composeApp:scanNonAsciiFallbacks"           || FAILED+=1

echo
echo "----"
if (( FAILED == 0 )); then
  echo "Resultado: ${TOTAL}/${TOTAL} gates OK"
  exit 0
else
  echo "Resultado: ${FAILED}/${TOTAL} gates FALLARON"
  exit 1
fi
