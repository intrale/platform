#!/usr/bin/env bash
# Copyright (c) 2026 Leonel Larreta
# SPDX-License-Identifier: LicenseRef-Proprietary

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
  "generated"
  "ios"
  "wasm"
  "desktop"
  "tools"
)

# Patrones legacy prohibidos (alineados con verifyNoLegacyStrings de Gradle)
PATTERNS=(
  "\\bR\\.string\\."
  "\\bRes\\.string\\b"
  "\\bstringResource\\s*\\("
  "\\bgetString\\s*\\("
  "\\bResources\\.getString\\s*\\("
  "\\bLocalContext\\.current\\.getString\\s*\\("
)

# Archivos y rutas excluidas de la verificacion
EXCLUDED_FILE_PREFIXES=(
  "app/composeApp/src/commonMain/kotlin/ui/rs/"
)

EXCLUDED_FILES=(
  "build.gradle.kts"
)

found=0

exclude_expr=()
for ex in "${EXCLUDES[@]}"; do
  exclude_expr+=( -not -path "*/$ex/*" )
done

# Excluir directorios de test
exclude_expr+=( -not -path "*/test/*" )
exclude_expr+=( -not -path "*/tests/*" )
exclude_expr+=( -not -path "*/androidTest/*" )
exclude_expr+=( -not -path "*/desktopTest/*" )
exclude_expr+=( -not -path "*/iosX64Test/*" )
exclude_expr+=( -not -path "*/wasmJsTest/*" )

for dir in "${INCLUDE_DIRS[@]}"; do
  for pat in "${PATTERNS[@]}"; do
    matches=$(find "$dir" -type f -name '*.kt' "${exclude_expr[@]}" -print0 \
      | xargs -0 grep -nE "$pat" 2>/dev/null || true)

    if [[ -n "$matches" ]]; then
      # Filtrar archivos excluidos
      filtered=""
      while IFS= read -r line; do
        rel_path="${line#"$ROOT_DIR"/}"
        skip=false
        for prefix in "${EXCLUDED_FILE_PREFIXES[@]}"; do
          if [[ "$rel_path" == "$prefix"* ]]; then
            skip=true
            break
          fi
        done
        for excluded in "${EXCLUDED_FILES[@]}"; do
          base=$(basename "${line%%:*}")
          if [[ "$base" == "$excluded" ]]; then
            skip=true
            break
          fi
        done
        if [[ "$skip" == false ]]; then
          filtered+="$line"$'\n'
        fi
      done <<< "$matches"

      if [[ -n "${filtered%$'\n'}" ]]; then
        echo "❌ Encontrado patrón prohibido: /$pat/"
        echo "$filtered"
        found=1
      fi
    fi
  done
done

if [[ "$found" -ne 0 ]]; then
  cat <<EOF

🚫 Se detectó uso de String Resources legacy.
Solución: migrar a IntraleStrings (Txt + MessageKey).

Sugerencias:
- stringResource(R.string.foo_title)  →  Txt(MessageKey.Foo_Title)
- context.getString(R.string.bar, x)  →  Txt(MessageKey.Bar, mapOf("x" to x))
- Res.string.foo                      →  Txt(MessageKey.Foo)
EOF
  exit 1
fi

echo "✅ Sin uso de String Resources legacy."
