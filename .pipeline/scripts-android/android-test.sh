#!/usr/bin/env bash
# Uso: android-test.sh
# Corre los tests unitarios de :app:composeApp:testDebugUnitTest y resume.
# Reemplaza la invocacion repetitiva en SKILL.md (Pasos 4.2 y 6).

set -uo pipefail

export JAVA_HOME="${JAVA_HOME:-/c/Users/Administrator/.jdks/temurin-21.0.7}"

cd "$(dirname "$0")/../.."

OUT="$(./gradlew :app:composeApp:testDebugUnitTest --no-daemon 2>&1)"
RC=$?

echo "$OUT" | tail -50
echo
echo "----"
PASSED=$(echo "$OUT" | grep -oE '[0-9]+ tests? completed' | head -1 || echo "")
FAILED=$(echo "$OUT" | grep -oE '[0-9]+ failed' | head -1 || echo "0 failed")
echo "Resultado: ${PASSED:-?} | ${FAILED}"
echo "Exit: $RC"
exit $RC
