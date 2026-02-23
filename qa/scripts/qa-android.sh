#!/usr/bin/env bash
# qa-android.sh — Build APK client + instalar + correr tests Maestro
# Uso: bash qa/scripts/qa-android.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RECORDINGS_DIR="${PROJECT_ROOT}/qa/recordings"
MAESTRO_DIR="${PROJECT_ROOT}/.maestro/flows"

echo "=== QA Android — Maestro E2E ==="

# 1. Verificar adb
if ! command -v adb &>/dev/null; then
    echo "ERROR: adb no encontrado. Instalar Android SDK Platform-Tools."
    exit 1
fi

# 2. Verificar dispositivo/emulador conectado
DEVICE_COUNT=$(adb devices | grep -c 'device$' || true)
if [ "$DEVICE_COUNT" -eq 0 ]; then
    echo "ERROR: No hay dispositivo/emulador conectado."
    echo "  - Iniciar un emulador: emulator -avd <nombre>"
    echo "  - O conectar un dispositivo via USB/WiFi"
    exit 1
fi
echo "Dispositivos conectados: $DEVICE_COUNT"

# 3. Verificar Maestro
if ! command -v maestro &>/dev/null; then
    echo "ERROR: Maestro no instalado."
    echo "  Instalar: curl -Ls 'https://get.maestro.mobile.dev' | bash"
    exit 1
fi
echo "Maestro version: $(maestro --version 2>/dev/null || echo 'desconocida')"

# 4. Build APK
echo ""
echo "=== Compilando APK client debug ==="
export JAVA_HOME="${JAVA_HOME:-/c/Users/Administrator/.jdks/temurin-21.0.7}"
cd "$PROJECT_ROOT"
./gradlew :app:composeApp:assembleClientDebug --no-daemon

# 5. Buscar APK
APK_PATH=$(find "${PROJECT_ROOT}/app/composeApp/build/outputs/apk/client/debug" -name "*.apk" -type f 2>/dev/null | head -1)
if [ -z "$APK_PATH" ]; then
    echo "ERROR: No se encontro APK en build/outputs/apk/client/debug/"
    exit 1
fi
echo "APK encontrado: $APK_PATH"

# 6. Instalar APK
echo ""
echo "=== Instalando APK ==="
adb install -r "$APK_PATH"

# 7. Crear directorio de recordings
mkdir -p "$RECORDINGS_DIR"

# 8. Ejecutar tests Maestro
echo ""
echo "=== Ejecutando tests Maestro ==="
maestro test "$MAESTRO_DIR" \
    --format junit \
    --output "$RECORDINGS_DIR/maestro-results.xml" \
    2>&1 | tee "$RECORDINGS_DIR/maestro-output.log"

MAESTRO_EXIT=$?

# 9. Reporte
echo ""
echo "=== Resultado ==="
if [ $MAESTRO_EXIT -eq 0 ]; then
    echo "TODOS los flujos Maestro pasaron"
else
    echo "ALGUNOS flujos Maestro fallaron (exit code: $MAESTRO_EXIT)"
fi

echo ""
echo "Resultados JUnit: $RECORDINGS_DIR/maestro-results.xml"
echo "Log completo: $RECORDINGS_DIR/maestro-output.log"

exit $MAESTRO_EXIT
