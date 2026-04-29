#!/usr/bin/env bash
# =============================================================================
# check-gitignore-logs.sh — verifica que .pipeline/logs/ este en .gitignore.
#
# Issue #2405 CA-3 / CA-5: el sanitizer del log stream garantiza que los
# secretos no lleguen a disco, pero si alguien remueve `.pipeline/logs/` de
# `.gitignore`, toda la estrategia se rompe porque los logs terminan en el
# repo publico. Este script corre en CI y falla si la entrada ya no esta.
#
# Usage: bash scripts/check-gitignore-logs.sh
# Exit codes:
#   0 → .gitignore contiene .pipeline/logs/ (OK)
#   1 → falta la entrada (FAIL)
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GITIGNORE="${REPO_ROOT}/.gitignore"

if [[ ! -f "$GITIGNORE" ]]; then
  echo "FAIL: .gitignore no existe en ${REPO_ROOT}" >&2
  exit 1
fi

# Matchear entrada exacta (con o sin barra final, con o sin prefijo ./).
if grep -qE '^\.?/?\.pipeline/logs/?$' "$GITIGNORE"; then
  echo "OK: .pipeline/logs/ presente en .gitignore"
  exit 0
fi

echo "FAIL: .pipeline/logs/ no esta en .gitignore" >&2
echo "" >&2
echo "Issue #2405 CA-3 requiere que .pipeline/logs/ este ignorado por git" >&2
echo "para evitar commits accidentales de logs que puedan contener secretos" >&2
echo "(aunque el sanitizer los redacta, no confiamos en una sola capa)." >&2
echo "" >&2
echo "Agregar la linea:" >&2
echo "  .pipeline/logs/" >&2
echo "a .gitignore y commitear." >&2
exit 1
