#!/usr/bin/env bash
# Uso: web-build.sh
# Corre :app:composeApp:wasmJsBrowserDevelopmentWebpack con setup de JAVA_HOME
# y resume el resultado. Reemplaza la invocacion repetitiva del Paso 6 del
# SKILL del agente /web-dev (build de target Wasm).

set -uo pipefail

export JAVA_HOME="${JAVA_HOME:-/c/Users/Administrator/.jdks/temurin-21.0.7}"

cd "$(dirname "$0")/../.."

OUT="$(./gradlew :app:composeApp:wasmJsBrowserDevelopmentWebpack --no-daemon 2>&1)"
RC=$?

echo "$OUT" | tail -50
echo
echo "----"
if (( RC == 0 )); then
  echo "Resultado: build Wasm OK"
else
  echo "Resultado: build Wasm FALLO"
fi
echo "Exit: $RC"
exit $RC
