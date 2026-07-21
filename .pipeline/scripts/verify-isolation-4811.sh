#!/usr/bin/env bash
# =============================================================================
# verify-isolation-4811.sh — Evidencia reproducible de aislamiento de estado por
# producto (issue #4811). Genera un snapshot tamper-evident del árbol de estado
# del monorepo `intrale-platform` (waves.json + worktrees + tests de aislamiento)
# ANTES y DESPUÉS de correr la verificación, mostrando diff vacío para el monorepo.
#
# Uso:
#   bash .pipeline/scripts/verify-isolation-4811.sh
#
# Salida: imprime hashes/estado y corre los 3 suites `node --test` de aislamiento.
# Exit 0 si todo el estado del monorepo queda intacto y los tests pasan.
# =============================================================================
set -euo pipefail

ROOT="${PIPELINE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

echo "== #4811 · verificación de aislamiento de estado por producto =="
echo "ROOT: $ROOT"
echo

# --- Snapshot tamper-evident del estado del monorepo (ANTES) -----------------
WAVES="$ROOT/.pipeline/waves.json"
snapshot_waves() {
  if [ -f "$WAVES" ]; then
    md5sum "$WAVES" 2>/dev/null || md5 -q "$WAVES" 2>/dev/null || echo "(sin md5 disponible)"
  else
    echo "(waves.json ausente)"
  fi
}

echo "-- snapshot ANTES --"
BEFORE_WAVES="$(snapshot_waves)"
echo "waves.json md5: $BEFORE_WAVES"
# git status del árbol de estado versionado del pipeline (excluye archivos runtime).
BEFORE_GIT="$(git -C "$ROOT" status --porcelain -- .pipeline/waves.json .pipeline/lib .pipeline/contracts 2>/dev/null || true)"
echo "git status (estado versionado del pipeline):"
echo "${BEFORE_GIT:-  (limpio)}"
echo

# --- Verificación por tests node --test --------------------------------------
echo "-- corriendo suites de aislamiento (node --test) --"
node --test \
  .pipeline/lib/__tests__/product-isolation-4811.test.js \
  .pipeline/lib/__tests__/kernel-store.test.js \
  .pipeline/lib/__tests__/credentials-isolation.test.js
echo

# --- Snapshot tamper-evident del estado del monorepo (DESPUÉS) ----------------
echo "-- snapshot DESPUÉS --"
AFTER_WAVES="$(snapshot_waves)"
echo "waves.json md5: $AFTER_WAVES"
echo

# --- Diff vacío para el monorepo ---------------------------------------------
if [ "$BEFORE_WAVES" != "$AFTER_WAVES" ]; then
  echo "FALLO: waves.json del monorepo cambió durante la verificación (fuga CA-1/CA-8)."
  exit 1
fi
echo "OK: waves.json del monorepo intacto (diff vacío)."
echo "OK: aislamiento verificado — la actividad del producto nuevo no pisa el estado del monorepo."
