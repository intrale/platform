#!/usr/bin/env bash
# qa-issue-from-branch.sh — Extrae el número de issue del branch actual.
#
# Soporta: agent/<N>-* | feature/<N>-* | bugfix/<N>-*
#
# Salida:
#   stdout: número de issue (sin prefijo)
# Exit codes:
#   0: issue encontrado
#   1: no se pudo determinar

set -e

BRANCH=$(git branch --show-current 2>/dev/null || echo "")

if [ -z "$BRANCH" ]; then
  echo "ERROR: no hay branch activo" >&2
  exit 1
fi

# Formato: <prefix>/<numero>-<slug>
ISSUE_NUM=$(echo "$BRANCH" | grep -oE '^(agent|feature|bugfix|fix)/[0-9]+-' | grep -oE '[0-9]+')

if [ -z "$ISSUE_NUM" ]; then
  echo "ERROR: branch '$BRANCH' no contiene un numero de issue (formato esperado: agent/<N>-* | feature/<N>-* | bugfix/<N>-* | fix/<N>-*)" >&2
  exit 1
fi

echo "$ISSUE_NUM"
exit 0
