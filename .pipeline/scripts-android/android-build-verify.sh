#!/usr/bin/env bash
# Uso: android-build-verify.sh
# Ejecuta el ciclo completo de verificacion del Paso 7 del SKILL del agente
# /android-dev: build + tests + verifyNoLegacyStrings + validateComposeResources
# + scanNonAsciiFallbacks. Resume cada gate y exit no-cero si alguno falla.

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

run_gate "build"                ":app:composeApp:build"                  || FAILED+=1
run_gate "tests"                ":app:composeApp:testDebugUnitTest"      || FAILED+=1
run_gate "no-legacy-strings"    "verifyNoLegacyStrings"                  || FAILED+=1
run_gate "validate-resources"   ":app:composeApp:validateComposeResources" || FAILED+=1
run_gate "ascii-fallbacks"      ":app:composeApp:scanNonAsciiFallbacks"  || FAILED+=1

echo
echo "----"
if (( FAILED == 0 )); then
  echo "Resultado: 5/5 gates OK"
  exit 0
else
  echo "Resultado: ${FAILED}/5 gates FALLARON"
  exit 1
fi
