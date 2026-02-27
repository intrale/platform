#!/usr/bin/env bash
# qa-android.sh — Build APK + emulador auto + Maestro E2E + video recording
# Uso: bash qa/scripts/qa-android.sh
# 100% autonomo: arranca emulador, compila, instala, graba video, corre tests, limpia.
#
# Optimizaciones de rendimiento:
# - Reutiliza emulador ya corriendo (detecta por AVD name, 0s boot)
# - Snapshot 'qa-ready': boot en ~5s vs ~90s cold boot
# - GPU host (hardware real, no swiftshader)
# - Memoria limitada a 2048MB
# - Audio, camaras, GPS y sensores deshabilitados
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RECORDINGS_DIR="${PROJECT_ROOT}/qa/recordings"
MAESTRO_DIR="${PROJECT_ROOT}/.maestro/flows"
ANDROID_SDK="${HOME}/AppData/Local/Android/Sdk"
EMULATOR_BIN="${ANDROID_SDK}/emulator/emulator"
AVD_NAME="virtualAndroid"
STARTED_EMULATOR=false

# JAVA_HOME obligatorio para Gradle y Maestro (forzar siempre Temurin 21)
export JAVA_HOME="/c/Users/Administrator/.jdks/temurin-21.0.7"

# Maestro necesita estar en PATH
export PATH="${HOME}/.maestro/bin:${ANDROID_SDK}/platform-tools:${PATH}"

echo "=== QA Android — Maestro E2E con Video ==="
echo "  JAVA_HOME=$JAVA_HOME"

# ── 1. Verificar adb ────────────────────────────────────────
echo ""
echo "[1/9] Verificando adb..."
if ! command -v adb &>/dev/null; then
    echo "ERROR: adb no encontrado. Instalar Android SDK Platform-Tools."
    exit 1
fi
echo "  adb OK"

# ── 2. Verificar/arrancar emulador ──────────────────────────
echo ""
echo "[2/9] Verificando dispositivo/emulador..."

# Iniciar adb server
adb start-server 2>/dev/null || true

# Nombre del snapshot para boot rapido (3-8s vs 60-120s cold boot)
QA_SNAPSHOT="qa-ready"

# ── 2a. Detectar si el AVD especifico ya esta corriendo ─────
RUNNING_EMULATOR=""
for serial in $(adb devices 2>/dev/null | grep "emulator-" | awk '{print $1}'); do
    avd_name=$(adb -s "$serial" emu avd name 2>/dev/null | tr -d '\r' | head -1)
    if [ "$avd_name" = "$AVD_NAME" ]; then
        RUNNING_EMULATOR="$serial"
        break
    fi
done

# Tambien detectar dispositivos fisicos
PHYSICAL_DEVICE=""
if [ -z "$RUNNING_EMULATOR" ]; then
    PHYSICAL_DEVICE=$(adb devices 2>/dev/null | grep -v "emulator-" | grep 'device$' | awk '{print $1}' | head -1)
fi

if [ -n "$RUNNING_EMULATOR" ]; then
    echo "  Emulador '$AVD_NAME' ya corriendo en $RUNNING_EMULATOR — reutilizando (0s boot)"
elif [ -n "$PHYSICAL_DEVICE" ]; then
    echo "  Dispositivo fisico detectado: $PHYSICAL_DEVICE — usando directamente"
else
    echo "  No hay dispositivo conectado. Arrancando emulador '$AVD_NAME'..."

    if [ ! -f "$EMULATOR_BIN" ]; then
        echo "ERROR: Emulador no encontrado en: $EMULATOR_BIN"
        exit 1
    fi

    # ── 2b. Determinar modo de boot: snapshot (rapido) o cold boot ──
    # Verificar si el snapshot qa-ready existe en el directorio del AVD
    AVD_DIR="${HOME}/.android/avd/${AVD_NAME}.avd"
    if [ -d "${AVD_DIR}/snapshots/${QA_SNAPSHOT}" ]; then
        SNAPSHOT_FLAGS="-snapshot ${QA_SNAPSHOT} -no-snapshot-save"
        BOOT_TIMEOUT=30
        echo "  Modo: snapshot '${QA_SNAPSHOT}' (boot rapido ~5s)"
    else
        SNAPSHOT_FLAGS=""
        BOOT_TIMEOUT=120
        echo "  Modo: cold boot (~60s). Se creara snapshot al finalizar."
    fi

    # Arrancar emulador headless con GPU hardware y memoria limitada
    # -gpu host: usa GPU real del host (10-50x mas rapido que swiftshader)
    # -memory 2048: limita RAM a 2GB (evita acaparar memoria del host)
    # -no-audio: elimina ~15% CPU continuo del subsistema de audio
    # -no-boot-anim: salta animacion de boot (~5-10s menos)
    # -no-window: headless, sin renderizado de ventana
    "$EMULATOR_BIN" -avd "$AVD_NAME" \
        -no-audio \
        -no-boot-anim \
        -no-window \
        -gpu host \
        -memory 2048 \
        $SNAPSHOT_FLAGS \
        2>/dev/null &
    EMULATOR_PID=$!
    STARTED_EMULATOR=true
    echo "  Emulador PID: $EMULATOR_PID (timeout: ${BOOT_TIMEOUT}s)"

    # Esperar a que adb vea el dispositivo
    echo "  Esperando dispositivo adb..."
    adb wait-for-device

    # Esperar boot completo
    echo "  Esperando boot del emulador..."
    BOOT_ELAPSED=0
    while [ $BOOT_ELAPSED -lt $BOOT_TIMEOUT ]; do
        BOOT_STATUS=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
        if [ "$BOOT_STATUS" = "1" ]; then
            echo ""
            echo "  Emulador arrancado en ${BOOT_ELAPSED}s"
            break
        fi
        sleep 2
        BOOT_ELAPSED=$((BOOT_ELAPSED + 2))
        printf "."
    done
    echo ""

    if [ $BOOT_ELAPSED -ge $BOOT_TIMEOUT ]; then
        echo "ERROR: Emulador no arranco en ${BOOT_TIMEOUT}s"
        kill "$EMULATOR_PID" 2>/dev/null || true
        exit 1
    fi

    # Esperar a que package manager este listo
    echo "  Esperando package manager..."
    PM_TIMEOUT=60
    PM_ELAPSED=0
    while [ $PM_ELAPSED -lt $PM_TIMEOUT ]; do
        if adb shell pm list packages 2>/dev/null | head -1 | grep -q "package:"; then
            echo "  Package manager listo"
            break
        fi
        sleep 3
        PM_ELAPSED=$((PM_ELAPSED + 3))
    done

    # Esperar extras (launcher, servicios)
    sleep 3

    # ── 2c. Guardar snapshot si fue cold boot (para proximas corridas) ──
    if [ -z "$SNAPSHOT_FLAGS" ]; then
        echo "  Guardando snapshot '${QA_SNAPSHOT}' para reutilizacion futura..."
        if adb emu avd snapshot save "$QA_SNAPSHOT" 2>/dev/null; then
            echo "  Snapshot guardado. Proximas corridas iniciaran en ~5s."
        else
            echo "  WARN: No se pudo guardar snapshot (corridas futuras usaran cold boot)"
        fi
    fi
fi

# ── 3. Verificar Maestro ────────────────────────────────────
echo ""
echo "[3/9] Verificando Maestro..."
if ! command -v maestro &>/dev/null; then
    echo "ERROR: Maestro no instalado."
    echo "  Instalar: curl -Ls 'https://get.maestro.mobile.dev' | bash"
    exit 1
fi
MAESTRO_VER=$(maestro --version 2>/dev/null || echo 'desconocida')
echo "  Maestro $MAESTRO_VER"

# ── 4. Build APK ────────────────────────────────────────────
echo ""
echo "[4/9] Compilando APK client debug..."
cd "$PROJECT_ROOT"
./gradlew :app:composeApp:assembleClientDebug --no-daemon 2>&1 | tail -5

# ── 5. Buscar e instalar APK ────────────────────────────────
APK_PATH=$(find "${PROJECT_ROOT}/app/composeApp/build/outputs/apk/client/debug" -name "*.apk" -type f 2>/dev/null | head -1)
if [ -z "$APK_PATH" ]; then
    echo "ERROR: No se encontro APK en build/outputs/apk/client/debug/"
    exit 1
fi

echo ""
echo "[5/9] Instalando APK: $(basename "$APK_PATH")"
adb install -r "$APK_PATH" 2>&1 | tail -3

# ── 6. Crear directorio de recordings ───────────────────────
mkdir -p "$RECORDINGS_DIR"

# ── 7. Iniciar screenrecord + ejecutar Maestro por flow ─────
echo ""
echo "[6/9] Ejecutando tests Maestro con video recording..."

# Función para cleanup en caso de error
cleanup() {
    # Detener screenrecord si está corriendo
    adb shell "pkill -INT screenrecord" 2>/dev/null || true
    sleep 1
    # Solo matar emulador si nosotros lo arrancamos (no si lo reutilizamos)
    if $STARTED_EMULATOR; then
        echo "  Deteniendo emulador (arrancado por este script)..."
        adb emu kill 2>/dev/null || true
        sleep 2
    else
        echo "  Emulador reutilizado — se mantiene corriendo para proximas corridas"
    fi
}
trap cleanup EXIT

MAESTRO_EXIT=0
TOTAL_FLOWS=0
PASSED_FLOWS=0

for flow_file in "$MAESTRO_DIR"/*.yaml; do
    [ -e "$flow_file" ] || continue
    FLOW_NAME=$(basename "$flow_file" .yaml)

    # Saltar config.yaml (no es un flow)
    if [ "$FLOW_NAME" = "config" ]; then
        continue
    fi

    TOTAL_FLOWS=$((TOTAL_FLOWS + 1))
    VIDEO_DEVICE="/sdcard/maestro-${FLOW_NAME}.mp4"
    VIDEO_LOCAL="${RECORDINGS_DIR}/maestro-${FLOW_NAME}-recording.mp4"

    echo ""
    echo "  --- Flow: $FLOW_NAME ---"

    # Iniciar screenrecord en background (max 180s, se detiene al terminar)
    adb shell "screenrecord --size 720x1280 --bit-rate 2000000 $VIDEO_DEVICE" &
    RECORD_PID=$!

    # Ejecutar flow individual
    if maestro test "$flow_file" 2>&1 | tee -a "$RECORDINGS_DIR/maestro-output.log"; then
        echo "  $FLOW_NAME: PASSED"
        PASSED_FLOWS=$((PASSED_FLOWS + 1))
    else
        echo "  $FLOW_NAME: FAILED"
        MAESTRO_EXIT=1
    fi

    # Detener screenrecord
    adb shell "pkill -INT screenrecord" 2>/dev/null || true
    sleep 2
    kill "$RECORD_PID" 2>/dev/null || true

    # Extraer video del emulador
    if adb shell "ls $VIDEO_DEVICE" &>/dev/null; then
        adb pull "$VIDEO_DEVICE" "$VIDEO_LOCAL" 2>/dev/null
        adb shell "rm $VIDEO_DEVICE" 2>/dev/null || true
        echo "  Video: $VIDEO_LOCAL ($(du -h "$VIDEO_LOCAL" 2>/dev/null | cut -f1))"
    else
        echo "  WARN: Video no generado para $FLOW_NAME"
    fi
done

# ── 8. Ejecutar Maestro completo para JUnit XML ─────────────
echo ""
echo "[7/9] Generando reporte JUnit consolidado..."
maestro test "$MAESTRO_DIR" \
    --format junit \
    --output "$RECORDINGS_DIR/maestro-results.xml" \
    2>&1 | tail -10 || true

# ── 9. Reporte ──────────────────────────────────────────────
echo ""
echo "[8/9] Resultado"
echo "  Flows: $PASSED_FLOWS/$TOTAL_FLOWS pasaron"

VIDEOS_COUNT=$(find "$RECORDINGS_DIR" -name "maestro-*-recording.mp4" -type f 2>/dev/null | wc -l)
echo "  Videos generados: $VIDEOS_COUNT"
echo ""

echo "[9/9] Archivos generados:"
ls -lh "$RECORDINGS_DIR"/maestro-* 2>/dev/null || echo "  (ninguno)"

echo ""
if [ $MAESTRO_EXIT -eq 0 ]; then
    echo "=== QA Android: APROBADO ($PASSED_FLOWS/$TOTAL_FLOWS flows) ==="
else
    echo "=== QA Android: RECHAZADO ($PASSED_FLOWS/$TOTAL_FLOWS flows) ==="
fi

exit $MAESTRO_EXIT
