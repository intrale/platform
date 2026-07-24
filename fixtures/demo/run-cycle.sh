#!/usr/bin/env bash
# =============================================================================
# fixtures/demo/run-cycle.sh — wrapper del ciclo demo dev->build->QA->delivery
# Issue: intrale/platform#4700 (CA-D2). Runbook: docs/runbooks/demo-cycle.md
#
# Invoca el harness Node.js y propaga su código de salida. El harness es la
# fuente de verdad: verifica el target antes de cada fase mutante (CA-D2.2),
# corre delivery en dry-run sin auto-merge (CA-D2.3) y bootstrap pineado con
# `npm ci` (CA-D2.4).
#
# Uso:
#   bash fixtures/demo/run-cycle.sh                 # target controlado local (default)
#   KERNEL_TARGET_REMOTE=https://github.com/intrale/kernel \
#   KERNEL_TARGET_REF=agent/4699-fixtures \
#     bash fixtures/demo/run-cycle.sh               # target clonado (reuso #4706 -> ref=main)
#   KERNEL_DEMO_KEEP=1 bash fixtures/demo/run-cycle.sh   # conservar sandbox/evidencia
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "▶ Ejecutando ciclo demo del kernel (#4700)…"
code=0
node "${SCRIPT_DIR}/run-cycle.js" || code=$?

if [ "${code}" -eq 0 ]; then
  echo "✔ run-cycle.sh: ciclo completo (delivery dry-run, sin blast radius)."
else
  echo "✗ run-cycle.sh: ciclo abortado (exit ${code}). Ninguna fase mutó intrale/platform." >&2
fi
exit "${code}"
