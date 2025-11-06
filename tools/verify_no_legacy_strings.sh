#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

INCLUDE_DIRS=(
  "$ROOT_DIR"
)

EXCLUDES=(
  ".git"
  "build"
  ".gradle"
  "node_modules"
  "ios/"
  "wasm/"
  "desktop/"
)

PATTERNS=(
  "R\\.string\\."
  "stringResource\\("
  "\\bgetString\\("
  "Resources\\.getString\\("
  "LocalContext\\.current\\.getString\\("
)

found=0

exclude_expr=()
for ex in "${EXCLUDES[@]}"; do
  exclude_expr+=( -not -path "*/$ex/*" )
done

KT_PATTERNS=(
  "*.kt"
  "*.kts"
  "*.java"
)

file_filters=()
for ext in "${KT_PATTERNS[@]}"; do
  file_filters+=(-name "$ext" -o)
done
file_filters+=(-false)

for dir in "${INCLUDE_DIRS[@]}"; do
  for pat in "${PATTERNS[@]}"; do
    matches=$(find "$dir" -type f \
      \( "${file_filters[@]}" \) \
      "${exclude_expr[@]}" -print0 |
      xargs -0 grep -nE "$pat" || true)
    if [[ -n "$matches" ]]; then
      echo "❌ Encontrado patrón prohibido: /$pat/"
      echo "$matches"
      echo
      found=1
    fi
  done
done

if [[ "$found" -ne 0 ]]; then
  cat <<EOF2
🚫 Se detectó uso de String Resources legacy.
Solución: migrar a Txt(MessageKey, params).

Sugerencias:
- stringResource(R.string.foo_title)  →  Txt(MessageKey.Foo_Title)
- context.getString(R.string.bar, x)  →  Txt(MessageKey.Bar, mapOf("x" to x))
EOF2
  exit 1
fi

echo "✅ Sin uso de String Resources legacy."
