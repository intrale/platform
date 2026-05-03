#!/usr/bin/env bash
# Uso: android-install-apk.sh <flavor>   # flavor: client | business | delivery
# Construye e instala el APK debug del flavor en el emulador/device conectado.

set -euo pipefail

FLAVOR="${1:-}"
case "$FLAVOR" in
  client|business|delivery) ;;
  *) echo "Uso: $0 <client|business|delivery>" >&2; exit 2 ;;
esac

export JAVA_HOME="${JAVA_HOME:-/c/Users/Administrator/.jdks/temurin-21.0.7}"

cd "$(dirname "$0")/../.."

# Capitaliza primera letra para gradle task: client -> Client
GRADLE_FLAVOR="$(echo "${FLAVOR:0:1}" | tr '[:lower:]' '[:upper:]')${FLAVOR:1}"

echo "=== assemble${GRADLE_FLAVOR}Debug ==="
./gradlew ":app:composeApp:assemble${GRADLE_FLAVOR}Debug" --no-daemon 2>&1 | tail -10

APK="$(find app/composeApp/build/outputs/apk/${FLAVOR}/debug -name '*.apk' | head -1)"
if [[ -z "$APK" ]]; then
  echo "[FAIL] No se encontro APK en app/composeApp/build/outputs/apk/${FLAVOR}/debug" >&2
  exit 1
fi

echo "=== adb install $APK ==="
adb install -r "$APK"
