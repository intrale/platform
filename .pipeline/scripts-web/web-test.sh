#!/usr/bin/env bash
# Uso: web-test.sh
# Corre los tests del :app:composeApp (commonTest aplica tambien a Wasm).
# Reemplaza la invocacion repetitiva del Paso 5 del SKILL del agente /web-dev.

set -uo pipefail

export JAVA_HOME="${JAVA_HOME:-/c/Users/Administrator/.jdks/temurin-21.0.7}"

cd "$(dirname "$0")/../.."

OUT="$(./gradlew :app:composeApp:allTests --no-daemon 2>&1)"
RC=$?

echo "$OUT" | tail -50
echo
echo "----"
if (( RC == 0 )); then
  echo "Resultado: tests OK"
else
  echo "Resultado: tests FALLARON"
fi
echo "Exit: $RC"
exit $RC
