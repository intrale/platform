#!/usr/bin/env bash
# Uso: users-test.sh
# Corre :users:test con setup de JAVA_HOME y resume el resultado.
# Cuando el issue toca el modulo :users (autenticacion, perfiles, 2FA).

set -uo pipefail

export JAVA_HOME="${JAVA_HOME:-/c/Users/Administrator/.jdks/temurin-21.0.7}"

cd "$(dirname "$0")/../.."

OUT="$(./gradlew :users:test --no-daemon 2>&1)"
RC=$?

echo "$OUT" | tail -50
echo
echo "----"
PASSED=$(echo "$OUT" | grep -oE '[0-9]+ tests? completed' | head -1 || echo "")
FAILED=$(echo "$OUT" | grep -oE '[0-9]+ failed' | head -1 || echo "0 failed")
echo "Resultado: ${PASSED:-?} | ${FAILED}"
echo "Exit: $RC"
exit $RC
