#!/usr/bin/env bash
# qa-find-apk.sh — Busca el APK del flavor client en orden de prioridad.
#
# Salida:
#   stdout: path absoluto al APK (si encontrado)
#   stderr: razón del fallo (si no se encuentra)
# Exit codes:
#   0: APK encontrado, path en stdout
#   1: APK no encontrado en ninguna ubicación

set -e

CANDIDATES=(
  "qa/artifacts/composeApp-client-debug.apk"
  "app/composeApp/build/outputs/apk/client/debug/composeApp-client-debug.apk"
)

# Glob de fallback (build local con sufijos)
shopt -s nullglob 2>/dev/null || true
FALLBACK_GLOB=(app/composeApp/build/outputs/apk/client/debug/*.apk)

for path in "${CANDIDATES[@]}"; do
  if [ -f "$path" ]; then
    echo "$(cd "$(dirname "$path")" && pwd)/$(basename "$path")"
    exit 0
  fi
done

for path in "${FALLBACK_GLOB[@]}"; do
  if [ -f "$path" ]; then
    echo "$(cd "$(dirname "$path")" && pwd)/$(basename "$path")"
    exit 0
  fi
done

echo "ERROR: APK no encontrado en qa/artifacts/ ni en app/composeApp/build/outputs/apk/client/debug/" >&2
exit 1
