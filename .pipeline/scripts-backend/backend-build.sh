#!/usr/bin/env bash
# Uso: backend-build.sh
# Corre :backend:build con setup de JAVA_HOME y resume el resultado.
# Reemplaza la invocacion repetitiva del SKILL del agente /backend-dev (Paso 7).

set -uo pipefail

export JAVA_HOME="${JAVA_HOME:-/c/Users/Administrator/.jdks/temurin-21.0.7}"

cd "$(dirname "$0")/../.."

OUT="$(./gradlew :backend:build --no-daemon 2>&1)"
RC=$?

echo "$OUT" | tail -50
echo
echo "----"
if (( RC == 0 )); then
  echo "Resultado: build OK"
else
  echo "Resultado: build FALLO"
fi
echo "Exit: $RC"
exit $RC
