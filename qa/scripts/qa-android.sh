#!/usr/bin/env bash
# qa-android.sh — Build APK + emuladores configurables + Maestro Shards + video recording
# Uso: bash qa/scripts/qa-android.sh
# 100% autonomo: arranca N emuladores (default 1 para performance) en paralelo, compila, instala, corre tests Maestro con shards.
#
# Modo LIVIANO (default):
# - 1 shard (QA_SHARDS=1) = 1 emulador, 1536MB RAM, 2 cores, CPU affinity cores 4-7
# - Resultado: máquina sigue respondiendo normalmente
#
# Modo PARALELO (legacy, QA_SHARDS=3):
# - 3 shards = 3 emuladores, 2048MB RAM cada uno, sin affinity
# - Usa más recursos pero paraleliza tests 3x
#
# Env vars (todos opcionales, con defaults seguros):
# - QA_SHARDS=1 (default, modo liviano) | 3 (modo paralelo legacy)
# - QA_AVD_CORES=2 (default) — cores máximos por AVD
# - QA_AVD_MEMORY=1536 (default liviano) | 2048 (legacy)
# - QA_NO_AFFINITY=1 — desabilitar CPU affinity (debug)
# - QA_NARRATION=true (default) | false — narración TTS con OpenAI gpt-4o-mini-tts
#   Requiere OPENAI_API_KEY configurada. Sin key → narración omitida automáticamente.
#
# Optimizaciones:
# - CPU affinity: emulador limitado a cores 4-7, agentes en cores 0-3
# - Snapshot 'qa-ready': boot en ~40s vs ~130s cold boot
# - GPU auto (mejor modo para el host, swiftshader_indirect en headless)
# - Audio, camaras, GPS y sensores deshabilitados
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RECORDINGS_DIR="${PROJECT_ROOT}/qa/recordings"
MAESTRO_DIR="${PROJECT_ROOT}/.maestro/flows"
ANDROID_SDK="${HOME}/AppData/Local/Android/Sdk"
EMULATOR_BIN="${ANDROID_SDK}/emulator/emulator"

# ──────────────────────────────────────────────────────────────────────
# MODO LIVIANO vs PARALELO — configuración optimizada
# ──────────────────────────────────────────────────────────────────────
QA_SHARDS=${QA_SHARDS:-1}           # 1 (liviano) o 3 (legacy paralelo)
QA_AVD_CORES=${QA_AVD_CORES:-2}     # Cores máximos por AVD
QA_NO_AFFINITY=${QA_NO_AFFINITY:-0} # 0=usar affinity (default), 1=desabilitar
QA_NARRATION=${QA_NARRATION:-true}  # true=generar narracion TTS (requiere OPENAI_API_KEY), false=solo video mudo
QA_FLAVOR=${QA_FLAVOR:-client}      # client | business | delivery — flavor del APK a compilar e instalar

# Calcular memoria según modo
if [ "$QA_SHARDS" = "3" ]; then
    QA_AVD_MEMORY=${QA_AVD_MEMORY:-2048}  # Legacy: 2048MB si 3 shards
else
    QA_AVD_MEMORY=${QA_AVD_MEMORY:-1536}  # Default liviano: 1536MB
fi

# Mapear QA_FLAVOR → tarea Gradle, directorio APK y appId filter para flows Maestro
case "$QA_FLAVOR" in
  business)
    GRADLE_APK_TASK=":app:composeApp:assembleBusinessDebug"
    APK_OUTPUT_DIR="business"
    APP_ID_FILTER="com.intrale.app.business"
    ;;
  delivery)
    GRADLE_APK_TASK=":app:composeApp:assembleDeliveryDebug"
    APK_OUTPUT_DIR="delivery"
    APP_ID_FILTER="com.intrale.app.delivery"
    ;;
  *)  # client (default)
    GRADLE_APK_TASK=":app:composeApp:assembleClientDebug"
    APK_OUTPUT_DIR="client"
    APP_ID_FILTER="com.intrale.app.client"
    ;;
esac

# Configuración de múltiples AVDs y puertos (soporta 1 a 3 shards)
declare -A AVD_PORTS=(
  ["virtualAndroid"]="5554"
  ["virtualAndroid2"]="5556"
  ["virtualAndroid3"]="5558"
)
declare -a AVD_NAMES=()
for i in $(seq 1 "$QA_SHARDS"); do
  if [ "$i" = "1" ]; then
    AVD_NAMES+=("virtualAndroid")
  else
    AVD_NAMES+=("virtualAndroid$i")
  fi
done

# Track de emuladores iniciados por este script
declare -a STARTED_EMULATORS=()
QA_SNAPSHOT="qa-ready"

# QA_TEST_CASES_FILE: ruta opcional a JSON con test cases del issue
# Formato: [{"id":"TC-01","title":"..."},{"id":"TC-02","title":"..."},...]
# Si está definido, se ejecuta cada flow individualmente con tracking de timestamps.
# Si no está definido, se usa el modo libre original.
QA_TEST_CASES_FILE="${QA_TEST_CASES_FILE:-}"

# Helper: convierte segundos a formato HH:MM:SS
seconds_to_hms() {
    local s=$1
    printf "%02d:%02d:%02d" $((s/3600)) $(((s%3600)/60)) $((s%60))
}

# JAVA_HOME obligatorio para Gradle y Maestro (forzar siempre Temurin 21)
export JAVA_HOME="/c/Users/Administrator/.jdks/temurin-21.0.7"

# Maestro necesita estar en PATH
export PATH="${HOME}/.maestro/bin:${ANDROID_SDK}/platform-tools:${PATH}"

echo "=== QA Android — Maestro E2E con Video ==="
echo "  Modo: $([ "$QA_SHARDS" = "1" ] && echo "LIVIANO (1 shard)" || echo "PARALELO ($QA_SHARDS shards)")"
echo "  Flavor: ${QA_FLAVOR} (appId: ${APP_ID_FILTER})"
echo "  Configuración: ${QA_AVD_CORES} cores, ${QA_AVD_MEMORY}MB RAM por AVD"
if [ "$QA_NO_AFFINITY" = "0" ]; then
    echo "  CPU affinity: ON (cores 4-7 para emulador, 0-3 para agentes)"
else
    echo "  CPU affinity: OFF (debug mode)"
fi
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
    echo "    Arrancando $avd_name en puerto $port (${QA_AVD_CORES} cores, ${QA_AVD_MEMORY}MB RAM)..."

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

    # Arrancar emulador normalmente (sin wrapper de cmd.exe que falla en MSYS2)
    # Aplicaremos CPU affinity post-boot con PowerShell
    "$EMULATOR_BIN" -avd "$avd_name" \
        -port "$port" \
        -no-audio \
        -no-boot-anim \
        -no-window \
        -gpu auto \
        -cores $QA_AVD_CORES \
        -memory $QA_AVD_MEMORY \
        $SNAPSHOT_FLAGS \
        2>/dev/null &

    local emulator_pid=$!
    STARTED_EMULATORS+=("$emulator_pid")
    echo "    PID $emulator_pid (puerto $port) — affinity se aplicará post-boot"
}

# ── 2b. Arrancar múltiples AVDs en paralelo ──────────────────
echo ""
echo "[2/9] Arrancando $QA_SHARDS AVD(s) en paralelo..."
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
# 180s para cold boot (~130s real) o snapshot fallido; cada iteración duerme 2s
BOOT_TIMEOUT=180
for avd_name in "${AVD_NAMES[@]}"; do
    serial="emulator-${AVD_PORTS[$avd_name]}"
    echo "  Esperando boot de $avd_name ($serial)..."

    BOOT_ELAPSED=0
    while [ $BOOT_ELAPSED -lt $BOOT_TIMEOUT ]; do
        # Verificar que el dispositivo esté conectado
        if ! adb devices 2>/dev/null | grep -q "$serial"; then
            printf "."
            sleep 2
            BOOT_ELAPSED=$((BOOT_ELAPSED + 2))
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
        sleep 2
        BOOT_ELAPSED=$((BOOT_ELAPSED + 2))
    done

    if [ $BOOT_ELAPSED -ge $BOOT_TIMEOUT ]; then
        echo ""
        echo "ERROR: $avd_name no arrancó en ${BOOT_TIMEOUT}s"
        exit 1
    fi
done

echo "  ✓ Todos los AVDs listos"

# ── 2.6. Blindaje 4: Health check del emulador post-boot ──────────
# Verificar que cada emulador responde a input táctil, no está en ANR,
# y tiene RAM libre suficiente. Si falla, reintentar desde snapshot limpio.
echo ""
echo "[2.6/9] Health check post-boot (Blindaje 4)..."
QA_HEALTH_MAX_RETRIES=2

for avd_name in "${AVD_NAMES[@]}"; do
    port=${AVD_PORTS[$avd_name]}
    serial="emulator-${port}"
    HEALTH_OK=false

    for attempt in $(seq 1 $((QA_HEALTH_MAX_RETRIES + 1))); do
        echo "  $avd_name ($serial): health check intento $attempt..."
        HEALTH_FAIL=""

        # Test 1: sys.boot_completed sigue siendo 1
        BOOT_OK=$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
        if [ "$BOOT_OK" != "1" ]; then
            HEALTH_FAIL="boot_completed=$BOOT_OK"
        fi

        # Test 2: input tap responde (no ANR)
        if [ -z "$HEALTH_FAIL" ]; then
            if ! adb -s "$serial" shell "input tap 360 640" 2>/dev/null; then
                HEALTH_FAIL="input_tap_failed"
            fi
        fi

        # Test 3: RAM libre > 100MB (MemAvailable en kB)
        if [ -z "$HEALTH_FAIL" ]; then
            MEM_AVAIL_KB=$(adb -s "$serial" shell "cat /proc/meminfo" 2>/dev/null | grep MemAvailable | awk '{print $2}' | tr -d '\r')
            MEM_AVAIL_MB=$(( ${MEM_AVAIL_KB:-0} / 1024 ))
            if [ "$MEM_AVAIL_MB" -lt 100 ]; then
                HEALTH_FAIL="low_ram:${MEM_AVAIL_MB}MB"
            fi
        fi

        # Test 4: mini screenrecord de 2s (verifica ADB + video pipeline)
        if [ -z "$HEALTH_FAIL" ]; then
            if ! adb -s "$serial" shell "screenrecord --time-limit 2 /sdcard/qa-health-test.mp4" 2>/dev/null; then
                HEALTH_FAIL="screenrecord_failed"
            else
                adb -s "$serial" shell "rm -f /sdcard/qa-health-test.mp4" 2>/dev/null || true
            fi
        fi

        if [ -z "$HEALTH_FAIL" ]; then
            HEALTH_OK=true
            echo "  ✓ $avd_name: health check OK (RAM: ${MEM_AVAIL_MB}MB libre)"
            break
        else
            echo "  ✗ $avd_name: health check FAIL ($HEALTH_FAIL)"

            if [ "$attempt" -le "$QA_HEALTH_MAX_RETRIES" ]; then
                echo "  Reintentando: matando emulador y relanzando desde snapshot limpio..."
                # Matar el emulador
                adb -s "$serial" emu kill 2>/dev/null || true
                sleep 3

                # Relanzar desde snapshot limpio
                start_avd "$avd_name" "$port"
                sleep 2

                # Esperar boot de nuevo
                REBOOT_ELAPSED=0
                while [ $REBOOT_ELAPSED -lt 120 ]; do
                    REBOOT_STATUS=$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
                    if [ "$REBOOT_STATUS" = "1" ]; then
                        echo "  $avd_name re-arrancado en ${REBOOT_ELAPSED}s"
                        break
                    fi
                    sleep 2
                    REBOOT_ELAPSED=$((REBOOT_ELAPSED + 2))
                done
            fi
        fi
    done

    if [ "$HEALTH_OK" != "true" ]; then
        echo "ERROR: $avd_name falló health check después de $((QA_HEALTH_MAX_RETRIES + 1)) intentos"
        echo "  Último fallo: $HEALTH_FAIL"
        echo "  Esto es un fallo de INFRAESTRUCTURA, no de QA del código."
        exit 1
    fi
done

echo "  ✓ Todos los AVDs pasaron health check"

# ── 2.7. Aplicar CPU affinity post-boot si está habilitado ─────
if [ "$QA_NO_AFFINITY" = "0" ]; then
    echo ""
    echo "[2.7/9] Aplicando CPU affinity (cores 4-7)..."
    powershell.exe -Command "
      \$procs = Get-Process -Name 'emulator' -ErrorAction SilentlyContinue
      if (\$procs) {
        \$procs | ForEach-Object {
          \$_.ProcessorAffinity = [System.IntPtr]::new(0xF0)
          \$_.PriorityClass = 'BelowNormal'
          Write-Host ('[✓] PID {0}: Affinity=0xF0 (cores 4-7), Priority=BelowNormal' -f \$_.Id)
        }
      } else {
        Write-Host '[!] No emulator processes found'
      }
    " 2>&1 || true
fi

# ── 3. Verificar Maestro ────────────────────────────────────
echo ""
echo "[3/9] Verificando Maestro instalado..."
if ! command -v maestro &>/dev/null; then
    echo "ERROR: Maestro no instalado."
    echo "  Instalar: curl -Ls 'https://get.maestro.mobile.dev' | bash"
    exit 1
fi
MAESTRO_VER=$(maestro --version 2>/dev/null || echo 'desconocida')
echo "  Maestro $MAESTRO_VER (con soporte --shards)"

# ── 4. Build APK ────────────────────────────────────────────
echo ""
echo "[4/9] Compilando APK ${QA_FLAVOR} debug..."
cd "$PROJECT_ROOT"
./gradlew "$GRADLE_APK_TASK" --no-daemon 2>&1 | tail -5

# ── 5. Instalar APK en todos los AVDs ─────────────────────
APK_PATH=$(find "${PROJECT_ROOT}/app/composeApp/build/outputs/apk/${APK_OUTPUT_DIR}/debug" -name "*.apk" -type f 2>/dev/null | head -1)
if [ -z "$APK_PATH" ]; then
    echo "ERROR: No se encontro APK en build/outputs/apk/${APK_OUTPUT_DIR}/debug/"
    exit 1
fi

echo ""
echo "[5/9] Instalando APK en $QA_SHARDS AVD(s) en paralelo: $(basename "$APK_PATH")"

# Instalar en paralelo en cada AVD
for avd_name in "${AVD_NAMES[@]}"; do
    port=${AVD_PORTS[$avd_name]}
    serial="emulator-${port}"
    adb -s "$serial" install -r "$APK_PATH" >/dev/null 2>&1 &
done

wait
echo "  ✓ APK instalado en todos los AVDs"

# ── 6. Crear directorio de recordings + cleanup de espacio ──
mkdir -p "$RECORDINGS_DIR"

# Blindaje 3: Cleanup automatico de videos ya procesados para evitar disco lleno
echo ""
echo "[6/9] Limpiando videos anteriores para liberar espacio..."
DISK_FREE_MB=$(df -m "$RECORDINGS_DIR" 2>/dev/null | awk 'NR==2{print $4}' || echo "0")
echo "  Espacio libre: ${DISK_FREE_MB}MB"
if [ "${DISK_FREE_MB:-0}" -lt 500 ] || [ "${QA_FORCE_CLEANUP:-0}" = "1" ]; then
    echo "  Espacio insuficiente (<500MB) — limpiando videos anteriores..."
    CLEANED=0
    # Borrar videos de sesiones anteriores (no los de esta sesion)
    for old_vid in "$RECORDINGS_DIR"/maestro-shard-*.mp4; do
        [ -f "$old_vid" ] || continue
        rm -f "$old_vid"
        CLEANED=$((CLEANED+1))
    done
    # Borrar logs de screenrecord anteriores
    for old_log in "$RECORDINGS_DIR"/screenrecord-*.log; do
        [ -f "$old_log" ] || continue
        rm -f "$old_log"
    done
    # Borrar segmentos de grabaciones segmentadas anteriores
    for old_seg in "$RECORDINGS_DIR"/screenrecord-seg-*.mp4; do
        [ -f "$old_seg" ] || continue
        rm -f "$old_seg"
    done
    echo "  Limpiados $CLEANED videos anteriores"
    DISK_FREE_AFTER=$(df -m "$RECORDINGS_DIR" 2>/dev/null | awk 'NR==2{print $4}' || echo "?")
    echo "  Espacio libre ahora: ${DISK_FREE_AFTER}MB"
else
    echo "  Espacio suficiente (${DISK_FREE_MB}MB >= 500MB) — sin limpieza necesaria"
fi

# ── 6.5. Filtrar flows Maestro por flavor ───────────────────────
# Solo ejecuta flows cuyo appId coincide con el flavor compilado,
# evitando fallos por apps no instaladas en el emulador.
echo ""
echo "[6.5/9] Filtrando flows para flavor '${QA_FLAVOR}' (appId: ${APP_ID_FILTER})..."
FILTERED_FLOWS_DIR="${RECORDINGS_DIR}/flows-${QA_FLAVOR}"
mkdir -p "$FILTERED_FLOWS_DIR"
FLOWS_COPIED=0
for _flow_file in "${MAESTRO_DIR}"/*.yaml; do
    [ -f "$_flow_file" ] || continue
    if grep -q "^appId: ${APP_ID_FILTER}" "$_flow_file" 2>/dev/null; then
        cp "$_flow_file" "$FILTERED_FLOWS_DIR/"
        FLOWS_COPIED=$((FLOWS_COPIED+1))
    fi
done
if [ "$FLOWS_COPIED" -gt 0 ]; then
    echo "  ✓ ${FLOWS_COPIED} flows filtrados para ${QA_FLAVOR}"
    MAESTRO_DIR="$FILTERED_FLOWS_DIR"
else
    echo "  ⚠ Sin flows con appId '${APP_ID_FILTER}' — ejecutando todos los flows disponibles"
fi

# ── 7. Ejecutar Maestro con shards (distribución paralela si QA_SHARDS > 1) ────
echo ""
echo "[6/9] Ejecutando tests Maestro con --shards $QA_SHARDS..."

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

# Blindaje 1: Screenrecord segmentado — graba en segmentos de 3 minutos para evitar el
# limite de screenrecord (180s). Un loop en el device genera segmentos consecutivos que
# luego se concatenan con ffmpeg en un solo video continuo.
SCREENRECORD_SEGMENT_SECS=170  # Ligeramente menor a 180s para evitar corte abrupto
echo "  Iniciando grabación de video SEGMENTADA en $QA_SHARDS emulador(es)..."
echo "  (segmentos de ${SCREENRECORD_SEGMENT_SECS}s, concatenación con ffmpeg al final)"
SERIAL_MAIN="emulator-${AVD_PORTS[${AVD_NAMES[0]}]}"
for avd_name in "${AVD_NAMES[@]}"; do
    port=${AVD_PORTS[$avd_name]}
    serial="emulator-${port}"

    # Limpiar segmentos anteriores en el device
    adb -s "$serial" shell "rm -f /sdcard/qa-seg-${port}-*.mp4" 2>/dev/null || true

    # Loop de grabación segmentada en el device (corre hasta que se mate con pkill)
    # Cada segmento se nombra qa-seg-{port}-{N}.mp4 (N = 0, 1, 2, ...)
    adb -s "$serial" shell "
        N=0
        while true; do
            screenrecord --size 720x1280 --bit-rate 2000000 --time-limit ${SCREENRECORD_SEGMENT_SECS} /sdcard/qa-seg-${port}-\${N}.mp4
            N=\$((N+1))
        done
    " > "$RECORDINGS_DIR/screenrecord-${port}.log" 2>&1 &
done

MAESTRO_EXIT=0

# ── Modo guión: ejecutar flows uno a uno con tracking de timestamps ──────────
if [ -n "$QA_TEST_CASES_FILE" ] && [ -f "$QA_TEST_CASES_FILE" ]; then
    echo "  Modo guión activado: ejecutando flows por test case..."

    # En modo guión se fuerza 1 shard para ejecución secuencial y timestamps precisos
    if [ "$QA_SHARDS" -gt 1 ]; then
        echo "  Nota: QA_SHARDS reducido a 1 en modo guión (ejecución secuencial requerida)"
    fi

    # Obtener lista de flows ordenados alfabéticamente
    FLOW_FILES=()
    while IFS= read -r f; do
        [ -f "$f" ] && FLOW_FILES+=("$f")
    done < <(find "$MAESTRO_DIR" -name "*.yaml" | sort)
    FLOW_COUNT=${#FLOW_FILES[@]}

    # Leer cantidad de test cases del JSON (requiere node)
    TC_COUNT=0
    if command -v node &>/dev/null; then
        TC_COUNT=$(node -e "
          try {
            const fs = require('fs');
            const t = JSON.parse(fs.readFileSync('$QA_TEST_CASES_FILE','utf8'));
            console.log(t.length);
          } catch(e) { console.log(0); }
        " 2>/dev/null || echo "0")
    fi

    echo "  Test cases del issue: $TC_COUNT | Flows disponibles: $FLOW_COUNT"

    # Timestamp de inicio de grabación (referencia para calcular offsets)
    RECORDING_START=$(date +%s)
    TC_RESULTS_JSON="["
    FIRST_TC=1

    for i in $(seq 0 $((FLOW_COUNT - 1))); do
        FLOW_FILE="${FLOW_FILES[$i]}"
        FLOW_NAME=$(basename "$FLOW_FILE" .yaml)

        # Obtener id y título del test case correspondiente (o generar uno genérico)
        TC_ID=$(printf "TC-%02d" $((i+1)))
        TC_TITLE="$FLOW_NAME"
        if command -v node &>/dev/null && [ "$TC_COUNT" -gt 0 ]; then
            READ_TC=$(node -e "
              try {
                const fs = require('fs');
                const t = JSON.parse(fs.readFileSync('$QA_TEST_CASES_FILE','utf8'));
                const tc = t[$i];
                if (tc) {
                  console.log((tc.id||'TC-$(printf "%02d" $((i+1)))') + '\t' + (tc.title||'$FLOW_NAME'));
                } else {
                  console.log('TC-$(printf "%02d" $((i+1)))\t$FLOW_NAME');
                }
              } catch(e) { console.log('TC-$(printf "%02d" $((i+1)))\t$FLOW_NAME'); }
            " 2>/dev/null || echo "${TC_ID}	${FLOW_NAME}")
            TC_ID=$(echo "$READ_TC" | cut -f1)
            TC_TITLE=$(echo "$READ_TC" | cut -f2-)
        fi

        # Timestamp inicio del test case
        NOW=$(date +%s)
        TC_START_SEC=$(( NOW - RECORDING_START ))
        TS_START=$(seconds_to_hms "$TC_START_SEC")

        echo ""
        echo "  [$TC_ID] $TC_TITLE"
        echo "    Flow: $FLOW_NAME | Inicio: $TS_START"

        # Ejecutar el flow individualmente
        TC_EXIT=0
        maestro test "$FLOW_FILE" \
            --format junit \
            --output "$RECORDINGS_DIR/maestro-tc-${i}.xml" \
            2>&1 | tee "$RECORDINGS_DIR/maestro-tc-${i}.log" || TC_EXIT=$?

        # Pausa visual entre test cases (~1s para separación en el video)
        sleep 1

        # Timestamp fin del test case
        NOW=$(date +%s)
        TC_END_SEC=$(( NOW - RECORDING_START ))
        TS_END=$(seconds_to_hms "$TC_END_SEC")

        TC_RESULT=$([ $TC_EXIT -eq 0 ] && echo "PASS" || echo "FAIL")
        [ $TC_EXIT -ne 0 ] && MAESTRO_EXIT=1

        echo "    → $TC_RESULT ($TS_START → $TS_END)"

        # Acumular resultado en JSON (escapar caracteres problemáticos del título)
        TC_TITLE_SAFE=$(echo "$TC_TITLE" | sed 's/"/\\"/g' | tr -d '\n\r')
        TC_ID_SAFE=$(echo "$TC_ID" | sed 's/"/\\"/g')
        if [ "$FIRST_TC" = "1" ]; then
            FIRST_TC=0
        else
            TC_RESULTS_JSON="${TC_RESULTS_JSON},"
        fi
        TC_RESULTS_JSON="${TC_RESULTS_JSON}
    {\"id\":\"${TC_ID_SAFE}\",\"title\":\"${TC_TITLE_SAFE}\",\"timestamp_start\":\"${TS_START}\",\"timestamp_end\":\"${TS_END}\",\"result\":\"${TC_RESULT}\"}"
    done

    TC_RESULTS_JSON="${TC_RESULTS_JSON}
  ]"

    # Calcular veredicto global
    QA_VERDICT=$([ $MAESTRO_EXIT -eq 0 ] && echo "APROBADO" || echo "RECHAZADO")

    # Generar qa-steps-report.json
    cat > "$RECORDINGS_DIR/qa-steps-report.json" << STEPS_EOF
{
  "test_cases": ${TC_RESULTS_JSON},
  "verdict": "${QA_VERDICT}"
}
STEPS_EOF
    echo ""
    echo "  qa-steps-report.json generado con $FLOW_COUNT test cases → $QA_VERDICT"

    # Usar el último XML como maestro-results.xml de referencia
    LAST_IDX=$((FLOW_COUNT - 1))
    cp "$RECORDINGS_DIR/maestro-tc-${LAST_IDX}.xml" "$RECORDINGS_DIR/maestro-results.xml" 2>/dev/null || true

    if [ $MAESTRO_EXIT -eq 0 ]; then
        echo "  ✓ Todos los test cases pasaron"
    else
        echo "  ✗ Algunos test cases fallaron (ver logs)"
    fi

# ── Modo libre: comportamiento original con shards ───────────────────────────
else
    if [ "$QA_SHARDS" -gt 1 ]; then
        echo "  Distribuiendo flows entre $QA_SHARDS shards (emuladores en paralelo)..."
    else
        echo "  Ejecutando flows en modo secuencial (1 emulador)..."
    fi

    if maestro test "$MAESTRO_DIR" \
        --shards "$QA_SHARDS" \
        --format junit \
        --output "$RECORDINGS_DIR/maestro-results.xml" \
        2>&1 | tee "$RECORDINGS_DIR/maestro-output.log"; then
        echo "  ✓ Todos los flows pasaron"
    else
        echo "  ✗ Algunos flows fallaron (ver logs)"
        MAESTRO_EXIT=1
    fi
fi

# Detener grabación segmentada en todos los emuladores
echo ""
echo "[6.5/9] Deteniendo grabación de video segmentada..."
for avd_name in "${AVD_NAMES[@]}"; do
    port=${AVD_PORTS[$avd_name]}
    serial="emulator-${port}"
    # pkill -INT envía SIGINT al screenrecord activo, y el loop while termina
    # porque el shell background se mata con el proceso padre
    adb -s "$serial" shell "pkill -INT screenrecord" 2>/dev/null || true
done

# Esperar a que se complete la escritura del ultimo segmento
sleep 3

# Blindaje 1: Extraer segmentos y concatenar con ffmpeg
echo "[7/9] Extrayendo y concatenando segmentos de video de $QA_SHARDS emulador(es)..."
for avd_name in "${AVD_NAMES[@]}"; do
    port=${AVD_PORTS[$avd_name]}
    serial="emulator-${port}"
    VIDEO_LOCAL="${RECORDINGS_DIR}/maestro-shard-${port}.mp4"
    SEG_DIR="${RECORDINGS_DIR}/segments-${port}"
    mkdir -p "$SEG_DIR"

    # Listar segmentos disponibles en el device
    SEGMENTS=$(adb -s "$serial" shell "ls /sdcard/qa-seg-${port}-*.mp4 2>/dev/null" 2>/dev/null | tr -d '\r' | sort -V)

    if [ -z "$SEGMENTS" ]; then
        echo "  ⚠ Sin segmentos de video para shard $port"
        continue
    fi

    SEG_COUNT=0
    CONCAT_LIST="${SEG_DIR}/concat-list.txt"
    > "$CONCAT_LIST"

    for seg in $SEGMENTS; do
        seg_name=$(basename "$seg")
        local_seg="${SEG_DIR}/${seg_name}"
        # Extraer segmento (exec-out cat para evitar MSYS2 path mangling)
        adb -s "$serial" exec-out "cat $seg" > "$local_seg" 2>/dev/null
        if [ -s "$local_seg" ]; then
            echo "file '${local_seg}'" >> "$CONCAT_LIST"
            SEG_COUNT=$((SEG_COUNT+1))
        else
            rm -f "$local_seg"
        fi
    done

    echo "  Shard $port: $SEG_COUNT segmento(s) extraidos"

    if [ "$SEG_COUNT" -eq 0 ]; then
        echo "  ⚠ Ningun segmento valido para shard $port"
    elif [ "$SEG_COUNT" -eq 1 ]; then
        # Solo un segmento — copiar directamente sin ffmpeg
        SINGLE_SEG=$(head -1 "$CONCAT_LIST" | sed "s/^file '//;s/'$//")
        cp "$SINGLE_SEG" "$VIDEO_LOCAL"
        echo "  ✓ Video shard $port (1 segmento): $(du -h "$VIDEO_LOCAL" | cut -f1)"
    else
        # Multiples segmentos — concatenar con ffmpeg
        echo "  Concatenando $SEG_COUNT segmentos con ffmpeg..."
        if ffmpeg -y -f concat -safe 0 -i "$CONCAT_LIST" -c copy "$VIDEO_LOCAL" 2>"${SEG_DIR}/ffmpeg.log"; then
            echo "  ✓ Video shard $port ($SEG_COUNT segmentos → 1 video): $(du -h "$VIDEO_LOCAL" | cut -f1)"
        else
            echo "  ⚠ ffmpeg concat falló para shard $port — usando ultimo segmento como fallback"
            LAST_SEG=$(tail -1 "$CONCAT_LIST" | sed "s/^file '//;s/'$//")
            cp "$LAST_SEG" "$VIDEO_LOCAL" 2>/dev/null || true
        fi
    fi

    # Limpiar segmentos del device
    adb -s "$serial" shell "rm -f /sdcard/qa-seg-${port}-*.mp4" 2>/dev/null || true
    # Limpiar segmentos locales (el video concatenado ya queda en VIDEO_LOCAL)
    rm -rf "$SEG_DIR"
done

# ── 7.5. Generar narracion de audio TTS para videos ─────────
echo ""
echo "[7.5/9] Generando narracion de audio TTS (OpenAI gpt-4o-mini-tts)..."
NARRATION_ENABLED=false
if [ "$QA_NARRATION" = "false" ]; then
    echo "  Narracion desactivada (QA_NARRATION=false)"
elif ! command -v node &>/dev/null; then
    echo "  Saltando narracion: node no disponible"
else
    NARRATION_ENABLED=true
    for avd_name in "${AVD_NAMES[@]}"; do
        port=${AVD_PORTS[$avd_name]}
        VIDEO_LOCAL="${RECORDINGS_DIR}/maestro-shard-${port}.mp4"
        if [ -f "$VIDEO_LOCAL" ]; then
            echo "  Procesando shard $port..."
            QA_NARRATION="$QA_NARRATION" node "$SCRIPT_DIR/qa-narration.js" \
                --video "$VIDEO_LOCAL" \
                --flows-dir "$MAESTRO_DIR" \
                --output "${RECORDINGS_DIR}/maestro-shard-${port}-narrated.mp4" \
                2>&1 | tail -8 || echo "  Narracion fallida para shard $port (continuando sin audio)"
        fi
    done
fi

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
echo "  Videos mudos:"
ls -lh "$RECORDINGS_DIR"/maestro-shard-[0-9]*.mp4 2>/dev/null | grep -v "\-narrated\." | awk '{print "    " $9}' || echo "    (ninguno)"
echo "  Videos narrados (TTS):"
ls -lh "$RECORDINGS_DIR"/maestro-shard-*-narrated.mp4 2>/dev/null | awk '{print "    " $9}' || echo "    (ninguno)"
echo "  JUnit XML:"
ls -lh "$RECORDINGS_DIR"/maestro-results.xml 2>/dev/null | awk '{print "    " $9}' || echo "    (ninguno)"

# Generar qa-report.json con flag de narración
NARRATED_COUNT=$(ls "$RECORDINGS_DIR"/maestro-shard-*-narrated.mp4 2>/dev/null | wc -l)
QA_REPORT_PATH="${RECORDINGS_DIR}/qa-report.json"
cat > "$QA_REPORT_PATH" <<REPORT_EOF
{
  "verdict": "$([ $MAESTRO_EXIT -eq 0 ] && echo "APROBADO" || echo "RECHAZADO")",
  "passed": ${PASSED:-0},
  "total": ${TOTAL_TESTS:-0},
  "shards": $QA_SHARDS,
  "narration": $([ "$NARRATED_COUNT" -gt 0 ] && echo "true" || echo "false"),
  "narration_model": "gpt-4o-mini-tts",
  "narration_voice": "ash",
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
REPORT_EOF
echo "  QA Report: $QA_REPORT_PATH (narration: $([ "$NARRATED_COUNT" -gt 0 ] && echo "true" || echo "false"))"

echo ""
if [ $MAESTRO_EXIT -eq 0 ]; then
    if [ "$QA_SHARDS" -gt 1 ]; then
        echo "=== QA Android: APROBADO ($QA_SHARDS AVDs en paralelo) ==="
    else
        echo "=== QA Android (modo liviano): APROBADO (1 AVD, $QA_AVD_MEMORY MB RAM, $QA_AVD_CORES cores) ==="
    fi
else
    echo "=== QA Android: RECHAZADO (ver logs para detalles) ==="
fi

# ── 10. Compartir videos con stakeholders (best-effort, no bloquea resultado QA) ──
if command -v node &>/dev/null && [ -f "$SCRIPT_DIR/qa-video-share.js" ]; then
    # Preferir videos narrados (-narrated.mp4) si existen, fallback a video mudo
    VIDEOS_LIST=""
    for vf in "$RECORDINGS_DIR"/maestro-shard-*.mp4; do
        [ -f "$vf" ] || continue
        # Saltar si es un archivo -narrated (se agrega via su video base)
        case "$vf" in *-narrated.mp4) continue;; esac
        narrated="${vf%.mp4}-narrated.mp4"
        if [ -f "$narrated" ]; then
            VIDEOS_LIST="${VIDEOS_LIST:+$VIDEOS_LIST,}$narrated"
        else
            VIDEOS_LIST="${VIDEOS_LIST:+$VIDEOS_LIST,}$vf"
        fi
    done
    if [ -n "$VIDEOS_LIST" ]; then
        VERDICT=$([ $MAESTRO_EXIT -eq 0 ] && echo "APROBADO" || echo "RECHAZADO")
        echo ""
        echo "[10] Enviando videos a stakeholders via Telegram..."
        node "$SCRIPT_DIR/qa-video-share.js" \
            --issue "${ISSUE_NUMBER:-0}" \
            --title "${ISSUE_TITLE:-}" \
            --sprint "${SPRINT_ID:-}" \
            --videos "$VIDEOS_LIST" \
            --verdict "$VERDICT" \
            --passed "${PASSED:-0}" \
            --total "${TOTAL_TESTS:-0}" \
            2>&1 | tail -5 &
    fi
fi

exit $MAESTRO_EXIT
