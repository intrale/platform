#!/usr/bin/env bash
# Uso: web-bundle-size.sh
# Reporta el tamanio del bundle Wasm generado (composeApp.js + .wasm).
# Util para validar performance budgets (Addy Osmani / Alex Russell).

set -uo pipefail

export JAVA_HOME="${JAVA_HOME:-/c/Users/Administrator/.jdks/temurin-21.0.7}"

cd "$(dirname "$0")/../.."

DIST="app/composeApp/build/dist/wasmJs/developmentExecutable"

if [[ ! -d "$DIST" ]]; then
  echo "Bundle no encontrado en $DIST"
  echo "Ejecuta primero: .pipeline/scripts-web/web-build.sh"
  exit 1
fi

echo "=== Bundle Wasm — $DIST ==="
echo
ls -lh "$DIST" | awk 'NR>1 {printf "  %-50s %s\n", $NF, $5}'
echo
TOTAL=$(du -sb "$DIST" 2>/dev/null | awk '{print $1}')
TOTAL_KB=$((TOTAL / 1024))
TOTAL_MB=$((TOTAL_KB / 1024))
echo "----"
echo "Total: ${TOTAL_KB} KB (${TOTAL_MB} MB)"
echo
echo "Performance budget orientativo (development build):"
echo "  - Wasm + JS combinado < 5 MB: aceptable en dev"
echo "  - Production build con shrinking deberia bajar significativamente"
