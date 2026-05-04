#!/usr/bin/env bash
# Uso: backend-verify.sh
# Ejecuta el ciclo de verificacion del Paso 7 del agente /backend-dev:
# tests de :backend, tests de :users (si existen tests cambiados o el issue
# toca el modulo) y build completo de :backend. Resume cada gate.

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

TOTAL+=1; run_gate "backend-tests" ":backend:test"  || FAILED+=1
TOTAL+=1; run_gate "users-tests"   ":users:test"    || FAILED+=1
TOTAL+=1; run_gate "backend-build" ":backend:build" || FAILED+=1

echo
echo "----"
if (( FAILED == 0 )); then
  echo "Resultado: ${TOTAL}/${TOTAL} gates OK"
  exit 0
else
  echo "Resultado: ${FAILED}/${TOTAL} gates FALLARON"
  exit 1
fi
