#!/usr/bin/env bash
# qa-android.sh — Build APK + múltiples emuladores en paralelo + Maestro Shards + video recording
# Uso: bash qa/scripts/qa-android.sh
# 100% autonomo: arranca 3 emuladores en paralelo, compila, instala, corre tests Maestro con shards.
#
# Optimizaciones de rendimiento:
# - Múltiples AVDs en paralelo: virtualAndroid (5554), virtualAndroid2 (5556), virtualAndroid3 (5558)
# - Reutiliza emuladores ya corriendo (detecta por AVD name, 0s boot)
# - Snapshot 'qa-ready': boot en ~40s vs ~130s cold boot
# - Maestro --shards 3: distribuye flows automáticamente entre 3 emuladores
# - GPU auto (mejor modo para el host, swiftshader_indirect en headless)
# - Memoria limitada a 2048MB por AVD
# - Audio, camaras, GPS y sensores deshabilitados
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RECORDINGS_DIR="${PROJECT_ROOT}/qa/recordings"
MAESTRO_DIR="${PROJECT_ROOT}/.maestro/flows"
ANDROID_SDK="${HOME}/AppData/Local/Android/Sdk"
EMULATOR_BIN="${ANDROID_SDK}/emulator/emulator"

# Configuración de múltiples AVDs y puertos
declare -A AVD_PORTS=(
  ["virtualAndroid"]="5554"
  ["virtualAndroid2"]="5556"
  ["virtualAndroid3"]="5558"
)
declare -a AVD_NAMES=("virtualAndroid" "virtualAndroid2" "virtualAndroid3")

# Track de emuladores iniciados por este script
declare -a STARTED_EMULATORS=()
QA_SNAPSHOT="qa-ready"

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

# ── 2a. Función para arrancar un AVD específico ─────────────────
start_avd() {
    local avd_name=$1
    local port=$2

    AVD_DIR="${HOME}/.android/avd/${avd_name}.avd"

    # Detectar si el AVD ya está corriendo
    for serial in $(adb devices 2>/dev/null | grep "emulator-" | awk '{print $1}'); do
        avd_running=$(adb -s "$serial" emu avd name 2>/dev/null | tr -d '\r' | head -1)
        if [ "$avd_running" = "$avd_name" ]; then
            echo "    $avd_name ya corriendo en $serial — reutilizando (0s boot)"
            return 0
        fi
    done

    # Si no está corriendo, arrancarlo
    echo "    Arrancando $avd_name en puerto $port..."

    if [ ! -f "$EMULATOR_BIN" ]; then
        echo "ERROR: Emulador no encontrado en: $EMULATOR_BIN"
        exit 1
    fi

    # Determinar modo de boot: snapshot (rápido) o cold boot
    if [ -d "${AVD_DIR}/snapshots/${QA_SNAPSHOT}" ]; then
        SNAPSHOT_FLAGS="-snapshot ${QA_SNAPSHOT}"
    else
        SNAPSHOT_FLAGS=""
    fi

    # Arrancar emulador en puerto específico
    "$EMULATOR_BIN" -avd "$avd_name" \
        -port "$port" \
        -no-audio \
        -no-boot-anim \
        -no-window \
        -gpu auto \
        -memory 2048 \
        $SNAPSHOT_FLAGS \
        2>/dev/null &

    local emulator_pid=$!
    STARTED_EMULATORS+=("$emulator_pid")
    echo "    PID $emulator_pid (puerto $port)"
}

# ── 2b. Arrancar múltiples AVDs en paralelo ──────────────────
echo ""
echo "[2/9] Arrancando 3 AVDs en paralelo..."
adb start-server 2>/dev/null || true

for avd_name in "${AVD_NAMES[@]}"; do
    port=${AVD_PORTS[$avd_name]}
    start_avd "$avd_name" "$port" &
done

# Esperar a que todos los AVDs arranquen
echo "  Esperando que todos los AVDs se inicien..."
wait
echo "  ✓ Todos los AVDs iniciados"

# ── 2c. Esperar boot de todos los emuladores ────────────────
echo ""
echo "[2.5/9] Esperando boot de todos los AVDs..."
BOOT_TIMEOUT=120
for avd_name in "${AVD_NAMES[@]}"; do
    serial="emulator-${AVD_PORTS[$avd_name]}"
    echo "  Esperando boot de $avd_name ($serial)..."

    BOOT_ELAPSED=0
    while [ $BOOT_ELAPSED -lt $BOOT_TIMEOUT ]; do
        # Verificar que el dispositivo esté conectado
        if ! adb devices 2>/dev/null | grep -q "$serial"; then
            printf "."
            BOOT_ELAPSED=$((BOOT_ELAPSED + 1))
            continue
        fi

        # Verificar sys.boot_completed
        BOOT_STATUS=$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
        if [ "$BOOT_STATUS" = "1" ]; then
            echo ""
            echo "  ✓ $avd_name arrancado en ${BOOT_ELAPSED}s"
            break
        fi
        printf "."
        BOOT_ELAPSED=$((BOOT_ELAPSED + 1))
    done

    if [ $BOOT_ELAPSED -ge $BOOT_TIMEOUT ]; then
        echo ""
        echo "ERROR: $avd_name no arrancó en ${BOOT_TIMEOUT}s"
        exit 1
    fi
done

echo "  ✓ Todos los AVDs listos"

# ── 3. Verificar Maestro ────────────────────────────────────
echo ""
echo "[3/9] Verificando Maestro..."
if ! command -v maestro &>/dev/null; then
    echo "ERROR: Maestro no instalado."
    echo "  Instalar: curl -Ls 'https://get.maestro.mobile.dev' | bash"
    exit 1
fi
MAESTRO_VER=$(maestro --version 2>/dev/null || echo 'desconocida')
echo "  Maestro $MAESTRO_VER (con soporte --shards)"

# ── 4. Build APK ────────────────────────────────────────────
echo ""
echo "[4/9] Compilando APK client debug..."
cd "$PROJECT_ROOT"
./gradlew :app:composeApp:assembleClientDebug --no-daemon 2>&1 | tail -5

# ── 5. Instalar APK en todos los AVDs ─────────────────────
APK_PATH=$(find "${PROJECT_ROOT}/app/composeApp/build/outputs/apk/client/debug" -name "*.apk" -type f 2>/dev/null | head -1)
if [ -z "$APK_PATH" ]; then
    echo "ERROR: No se encontro APK en build/outputs/apk/client/debug/"
    exit 1
fi

echo ""
echo "[5/9] Instalando APK en 3 AVDs en paralelo: $(basename "$APK_PATH")"

# Instalar en paralelo en cada AVD
for avd_name in "${AVD_NAMES[@]}"; do
    port=${AVD_PORTS[$avd_name]}
    serial="emulator-${port}"
    adb -s "$serial" install -r "$APK_PATH" >/dev/null 2>&1 &
done

wait
echo "  ✓ APK instalado en todos los AVDs"

# ── 6. Crear directorio de recordings ───────────────────────
mkdir -p "$RECORDINGS_DIR"

# ── 7. Ejecutar Maestro con --shards 3 (distribución paralela) ────
echo ""
echo "[6/9] Ejecutando tests Maestro con --shards 3 (distribución paralela)..."

# Función para cleanup en caso de error
cleanup() {
    # Detener screenrecord en todos los emuladores
    for avd_name in "${AVD_NAMES[@]}"; do
        port=${AVD_PORTS[$avd_name]}
        serial="emulator-${port}"
        adb -s "$serial" shell "pkill -INT screenrecord" 2>/dev/null || true
    done

    # Matar solo los emuladores que nosotros arrancamos
    if [ ${#STARTED_EMULATORS[@]} -gt 0 ]; then
        echo "  Deteniendo emuladores iniciados por este script..."
        for pid in "${STARTED_EMULATORS[@]}"; do
            kill -9 "$pid" 2>/dev/null || true
        done
        # Esperar un poco para limpieza
        sleep 2
    fi
}
trap cleanup EXIT

# Iniciar screenrecord en cada emulador en paralelo antes de ejecutar Maestro
echo "  Iniciando grabación de video en 3 emuladores en paralelo..."
for avd_name in "${AVD_NAMES[@]}"; do
    port=${AVD_PORTS[$avd_name]}
    serial="emulator-${port}"
    VIDEO_DEVICE="/sdcard/maestro-shard-${port}.mp4"

    # Iniciar screenrecord en background en cada emulador
    adb -s "$serial" shell "screenrecord --size 720x1280 --bit-rate 2000000 $VIDEO_DEVICE" \
        > "$RECORDINGS_DIR/screenrecord-${port}.log" 2>&1 &
done

# Ejecutar Maestro con --shards 3 (distribuye flows automáticamente)
echo "  Distribuiendo flows entre 3 shards (emuladores)..."
MAESTRO_EXIT=0

if maestro test "$MAESTRO_DIR" \
    --shards 3 \
    --format junit \
    --output "$RECORDINGS_DIR/maestro-results.xml" \
    2>&1 | tee "$RECORDINGS_DIR/maestro-output.log"; then
    echo "  ✓ Todos los flows pasaron"
else
    echo "  ✗ Algunos flows fallaron (ver logs)"
    MAESTRO_EXIT=1
fi

# Detener grabación en todos los emuladores
echo ""
echo "[6.5/9] Deteniendo grabación de video..."
for avd_name in "${AVD_NAMES[@]}"; do
    port=${AVD_PORTS[$avd_name]}
    serial="emulator-${port}"
    adb -s "$serial" shell "pkill -INT screenrecord" 2>/dev/null || true
done

# Esperar a que se complete la escritura de videos
sleep 2

# Extraer videos de todos los emuladores
echo "[7/9] Extrayendo videos de los 3 emuladores..."
for avd_name in "${AVD_NAMES[@]}"; do
    port=${AVD_PORTS[$avd_name]}
    serial="emulator-${port}"
    VIDEO_DEVICE="/sdcard/maestro-shard-${port}.mp4"
    VIDEO_LOCAL="${RECORDINGS_DIR}/maestro-shard-${port}.mp4"

    if adb -s "$serial" shell "ls $VIDEO_DEVICE" &>/dev/null; then
        adb -s "$serial" pull "$VIDEO_DEVICE" "$VIDEO_LOCAL" 2>/dev/null
        adb -s "$serial" shell "rm $VIDEO_DEVICE" 2>/dev/null || true
        echo "  ✓ Video shard $port: $VIDEO_LOCAL"
    else
        echo "  ⚠ Video no generado para shard $port"
    fi
done

# ── 8. Reporte final ────────────────────────────────────────
echo ""
echo "[8/9] Reporte JUnit XML:"
if [ -f "$RECORDINGS_DIR/maestro-results.xml" ]; then
    echo "  ✓ $RECORDINGS_DIR/maestro-results.xml"
    # Contar resultados desde el XML (si está disponible grep)
    TOTAL_TESTS=$(grep -o 'tests="[0-9]*"' "$RECORDINGS_DIR/maestro-results.xml" | head -1 | cut -d'"' -f2)
    FAILURES=$(grep -o 'failures="[0-9]*"' "$RECORDINGS_DIR/maestro-results.xml" | head -1 | cut -d'"' -f2)
    if [ -n "$TOTAL_TESTS" ]; then
        PASSED=$((TOTAL_TESTS - FAILURES))
        echo "  Resultado: $PASSED/$TOTAL_TESTS flows pasaron"
    fi
else
    echo "  ⚠ No se generó maestro-results.xml"
fi

echo ""
echo "[9/9] Archivos generados:"
echo "  Logs:"
ls -lh "$RECORDINGS_DIR"/*.log 2>/dev/null | awk '{print "    " $9}' || echo "    (ninguno)"
echo "  Videos (shards paralelos):"
ls -lh "$RECORDINGS_DIR"/maestro-shard-*.mp4 2>/dev/null | awk '{print "    " $9}' || echo "    (ninguno)"
echo "  JUnit XML:"
ls -lh "$RECORDINGS_DIR"/maestro-results.xml 2>/dev/null | awk '{print "    " $9}' || echo "    (ninguno)"

echo ""
if [ $MAESTRO_EXIT -eq 0 ]; then
    echo "=== QA Android PARALELO: APROBADO (3 AVDs en paralelo) ==="
else
    echo "=== QA Android PARALELO: RECHAZADO (ver logs para detalles) ==="
fi

exit $MAESTRO_EXIT
