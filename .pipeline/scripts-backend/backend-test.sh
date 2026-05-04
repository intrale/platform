#!/usr/bin/env bash
# Uso: backend-test.sh
# Corre :backend:test con setup de JAVA_HOME y resume el resultado.
# Reemplaza la invocacion repetitiva del SKILL del agente /backend-dev (Pasos 4.2 y 6).

set -uo pipefail

export JAVA_HOME="${JAVA_HOME:-/c/Users/Administrator/.jdks/temurin-21.0.7}"

cd "$(dirname "$0")/../.."

OUT="$(./gradlew :backend:test --no-daemon 2>&1)"
RC=$?

echo "$OUT" | tail -50
echo
echo "----"
PASSED=$(echo "$OUT" | grep -oE '[0-9]+ tests? completed' | head -1 || echo "")
FAILED=$(echo "$OUT" | grep -oE '[0-9]+ failed' | head -1 || echo "0 failed")
echo "Resultado: ${PASSED:-?} | ${FAILED}"
echo "Exit: $RC"
exit $RC
