#!/usr/bin/env bash
# qa-apply-verdict-label.sh — Aplica label qa:passed | qa:failed | qa:skipped al issue.
#
# Uso:
#   qa-apply-verdict-label.sh <verdict> [issue-number]
#
# Si se omite issue-number, lo extrae con qa-issue-from-branch.sh.
#
# Verdicts soportados: passed | failed | skipped
#
# Exit codes:
#   0: label aplicado (o issue no determinable, en cuyo caso emite warning)
#   1: verdict invalido
#   2: gh no disponible

set -e

VERDICT="${1:-}"
ISSUE_NUM="${2:-}"

case "$VERDICT" in
  passed|failed|skipped) ;;
  *)
    echo "ERROR: verdict invalido '$VERDICT' (usar: passed | failed | skipped)" >&2
    exit 1
    ;;
esac

# gh CLI path (Windows)
export PATH="/c/Workspaces/gh-cli/bin:$PATH"
if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh CLI no disponible en PATH" >&2
  exit 2
fi

# Resolver issue
if [ -z "$ISSUE_NUM" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  ISSUE_NUM=$(bash "$SCRIPT_DIR/qa-issue-from-branch.sh" 2>/dev/null) || ISSUE_NUM=""
fi

if [ -z "$ISSUE_NUM" ]; then
  echo "WARN: no se pudo determinar issue, omitiendo label" >&2
  exit 0
fi

LABEL="qa:$VERDICT"
gh issue edit "$ISSUE_NUM" --repo intrale/platform --add-label "$LABEL" >/dev/null 2>&1 \
  && echo "Label $LABEL aplicado a issue #$ISSUE_NUM" \
  || echo "WARN: no se pudo aplicar $LABEL a issue #$ISSUE_NUM" >&2

exit 0
