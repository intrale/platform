#!/usr/bin/env bash
# smoke-test.sh — Ciclo completo de validación QA
# Ejecuta: prerequisitos → backend up → healthcheck → emulador → APK → Maestro → evidencia
#
# Uso:
#   bash qa/scripts/smoke-test.sh [--issue N] [--no-video] [--skip-backend] [--remote]
#
# Opciones:
#   --issue N       Número de issue para nombrar la evidencia (ej: --issue 1781)
#   --no-video      Saltar grabación de video (más rápido, para pruebas de configuración)
#   --skip-backend  Asumir que el backend ya está corriendo (no levanta Docker/Ktor)
#   --skip-emulator Asumir que el emulador ya está corriendo
#   --remote        Modo remoto: backend en Lambda AWS, APK de qa/artifacts/ (sin Docker ni Gradle)
#
# Env vars opcionales:
#   QA_BASE_URL  — URL base del backend (default: http://localhost:80)
#   JAVA_HOME    — Path al JDK 21 (se detecta automáticamente si no está seteado)
#
# Salida:
#   0 — Ciclo completo exitoso
#   1 — Algún paso falló (ver log para detalles)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RECORDINGS_DIR="${PROJECT_ROOT}/qa/recordings"
EVIDENCE_DIR="${PROJECT_ROOT}/qa/evidence"

# ── Parseo de argumentos (sin eval, sin expansión dinámica) ──────────────────
ISSUE_NUMBER="0"
NO_VIDEO="false"
SKIP_BACKEND="false"
SKIP_EMULATOR="false"
REMOTE_MODE="false"

while [ $# -gt 0 ]; do
    case "$1" in
        --issue)
            shift
            # Validar que sea numérico
            if [ -z "${1:-}" ] || ! echo "$1" | grep -qE '^[0-9]+$'; then
                echo "ERROR: --issue requiere un número válido (ej: --issue 1781)"
                exit 1
            fi
            ISSUE_NUMBER="$1"
            ;;
        --no-video)
            NO_VIDEO="true"
            ;;
        --skip-backend)
            SKIP_BACKEND="true"
            ;;
        --skip-emulator)
            SKIP_EMULATOR="true"
            ;;
        --remote)
            REMOTE_MODE="true"
            SKIP_BACKEND="true"  # No levantar backend local
            ;;
        --help|-h)
            head -22 "$0" | grep '^#' | sed 's/^# //'
            exit 0
            ;;
        *)
            echo "ERROR: argumento desconocido: $1"
            echo "  Uso: bash qa/scripts/smoke-test.sh [--issue N] [--no-video] [--skip-backend]"
            exit 1
            ;;
    esac
    shift
done

# ── Inicialización ────────────────────────────────────────────────────────────
TIMESTAMP="$(date '+%Y-%m-%d_%H-%M-%S')"
EVIDENCE_RUN_DIR="${EVIDENCE_DIR}/${TIMESTAMP}-issue${ISSUE_NUMBER}"
LOG_FILE="${EVIDENCE_RUN_DIR}/smoke-test.log"

mkdir -p "$EVIDENCE_RUN_DIR"
mkdir -p "$RECORDINGS_DIR"

# Función de logging dual (consola + archivo)
log() {
    echo "$*" | tee -a "$LOG_FILE"
}

# Función para medir tiempo
STEP_START=0
step_start() {
    STEP_START=$(date +%s)
    log ""
    log "[$1] $2"
}

step_end() {
    local elapsed=$(( $(date +%s) - STEP_START ))
    log "  ✓ Completado en ${elapsed}s"
    echo "$elapsed" >> "${EVIDENCE_RUN_DIR}/timings.txt"
}

TOTAL_START=$(date +%s)

if [ "$REMOTE_MODE" = "true" ]; then
    log "=== Smoke Test QA — Modo REMOTO (Lambda AWS) ==="
else
    log "=== Smoke Test QA — Ambiente Local ==="
fi
log "  Timestamp : $TIMESTAMP"
log "  Issue     : #${ISSUE_NUMBER}"
log "  Sin video : $NO_VIDEO"
log "  Modo      : $([ "$REMOTE_MODE" = "true" ] && echo "REMOTO (Lambda AWS)" || echo "LOCAL")"
log "  Backend   : $([ "$REMOTE_MODE" = "true" ] && echo "Lambda AWS (remoto)" || ([ "$SKIP_BACKEND" = "true" ] && echo "ya corriendo (--skip-backend)" || echo "levantar automáticamente"))"
log ""

# ── JAVA_HOME ────────────────────────────────────────────────────────────────
# Detectar Java 21 sin usar eval
for candidate in \
    "/c/Users/Administrator/.jdks/temurin-21.0.7" \
    "/c/Program Files/Eclipse Adoptium/jdk-21.0.7+7" \
    "${JAVA_HOME:-}"; do
    if [ -n "$candidate" ] && [ -x "${candidate}/bin/java" ]; then
        ver=$("${candidate}/bin/java" -version 2>&1 | head -1 | sed 's/.*version "\([0-9]*\).*/\1/')
        if [ "$ver" = "21" ]; then
            export JAVA_HOME="$candidate"
            break
        fi
    fi
done

if [ -z "${JAVA_HOME:-}" ]; then
    log "WARN: JAVA_HOME no detectado — Gradle puede fallar"
fi
log "  JAVA_HOME : ${JAVA_HOME:-<no seteado>}"

# ── PASO 1: Verificar prerequisitos ──────────────────────────────────────────
step_start "1/7" "Verificando prerequisitos..."
if ! bash "${PROJECT_ROOT}/scripts/validate-env.sh" >> "$LOG_FILE" 2>&1; then
    log "  ✗ Prerequisitos faltantes (ver log: $LOG_FILE)"
    exit 1
fi
step_end

# ── PASO 2: Levantar backend ──────────────────────────────────────────────────
if [ "$REMOTE_MODE" = "true" ]; then
    step_start "2/7" "Levantando backend REMOTO (Lambda AWS)..."
    REMOTE_ARGS=""
    [ -n "${ISSUE_NUMBER}" ] && [ "$ISSUE_NUMBER" != "0" ] && REMOTE_ARGS="$REMOTE_ARGS"
    if ! bash "${SCRIPT_DIR}/qa-env-up-remote.sh" >> "$LOG_FILE" 2>&1; then
        log "  ✗ Backend remoto no pudo levantarse"
        log "  Ver logs: $LOG_FILE"
        exit 1
    fi
    # Leer el APK path del estado remoto
    if [ -f "$PROJECT_ROOT/qa/.qa-remote-state" ]; then
        REMOTE_APK_PATH=$(grep '^APK_PATH=' "$PROJECT_ROOT/qa/.qa-remote-state" | cut -d= -f2-)
    fi
    QA_BASE_URL="https://mgnr0htbvd.execute-api.us-east-2.amazonaws.com/dev"
    step_end
elif [ "$SKIP_BACKEND" = "false" ]; then
    step_start "2/7" "Levantando backend (Docker + Ktor)..."
    if ! bash "${SCRIPT_DIR}/qa-env-up.sh" >> "$LOG_FILE" 2>&1; then
        log "  ✗ Backend no pudo levantarse"
        log "  Ver logs: $LOG_FILE"
        exit 1
    fi
    step_end
else
    log ""
    log "[2/7] Saltando backend (--skip-backend)"
fi

# ── PASO 3: Health-check del backend ─────────────────────────────────────────
step_start "3/7" "Verificando endpoints del backend..."
HC_LOG="${EVIDENCE_RUN_DIR}/healthcheck.log"
if [ "$REMOTE_MODE" = "true" ]; then
    # Health-check al endpoint remoto
    HC_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
        -X POST "$QA_BASE_URL/intrale/signin" \
        -H "Content-Type: application/json" \
        -d '{}' 2>/dev/null)
    echo "Health-check remoto: HTTP $HC_STATUS" > "$HC_LOG"
    if [ "$HC_STATUS" = "400" ] || [ "$HC_STATUS" = "401" ]; then
        log "  ✓ Lambda respondiendo correctamente (HTTP $HC_STATUS)"
    else
        log "  WARN: Health-check retorno HTTP $HC_STATUS (esperado 400 o 401)"
        log "  Continuando igualmente..."
    fi
else
    if ! bash "${SCRIPT_DIR}/backend-healthcheck.sh" 2>&1 | tee "$HC_LOG" >> "$LOG_FILE"; then
        log "  ✗ Health-check falló"
        log "  Detalle: $HC_LOG"
        log "  WARN: continuando a pesar del fallo de health-check..."
    fi
fi
step_end

# ── PASO 4: Verificar/arrancar emulador ──────────────────────────────────────
ANDROID_SDK="${HOME}/AppData/Local/Android/Sdk"
EMULATOR_BIN="${ANDROID_SDK}/emulator/emulator"
ADB_BIN="${ANDROID_SDK}/platform-tools/adb"
export PATH="${ANDROID_SDK}/platform-tools:${PATH}"

AVD_NAME="virtualAndroid"
AVD_PORT="5554"
AVD_SERIAL="emulator-${AVD_PORT}"
QA_SNAPSHOT="qa-ready"
EMULATOR_PID=""

if [ "$SKIP_EMULATOR" = "false" ]; then
    step_start "4/7" "Verificando emulador Android ($AVD_NAME)..."

    # Verificar si ya está corriendo
    EMULATOR_RUNNING="false"
    if command -v adb &>/dev/null; then
        adb start-server >> "$LOG_FILE" 2>&1 || true
        for serial in $(adb devices 2>/dev/null | grep "emulator-" | awk '{print $1}'); do
            running_avd=$(adb -s "$serial" emu avd name 2>/dev/null | tr -d '\r' | head -1)
            if [ "$running_avd" = "$AVD_NAME" ]; then
                log "  Emulador $AVD_NAME ya corriendo en $serial — reutilizando"
                EMULATOR_RUNNING="true"
                break
            fi
        done
    fi

    if [ "$EMULATOR_RUNNING" = "false" ]; then
        if [ ! -f "$EMULATOR_BIN" ]; then
            log "  ✗ Emulador no encontrado: $EMULATOR_BIN"
            log "  Instalar Android SDK Emulator desde Android Studio > SDK Manager"
            exit 1
        fi

        AVD_DIR="${HOME}/.android/avd/${AVD_NAME}.avd"
        if [ -d "${AVD_DIR}/snapshots/${QA_SNAPSHOT}" ]; then
            SNAPSHOT_FLAGS="-snapshot ${QA_SNAPSHOT}"
            log "  Snapshot $QA_SNAPSHOT encontrado — boot rápido (~40s)"
        else
            SNAPSHOT_FLAGS=""
            log "  Sin snapshot — cold boot (~130s)"
        fi

        "$EMULATOR_BIN" -avd "$AVD_NAME" \
            -port "$AVD_PORT" \
            -no-audio \
            -no-boot-anim \
            -no-window \
            -gpu auto \
            -cores 2 \
            -memory 1536 \
            $SNAPSHOT_FLAGS \
            >> "$LOG_FILE" 2>&1 &
        EMULATOR_PID=$!
        log "  Emulador PID: $EMULATOR_PID"

        # Esperar boot
        BOOT_TIMEOUT=180
        BOOT_ELAPSED=0
        while [ $BOOT_ELAPSED -lt $BOOT_TIMEOUT ]; do
            if adb devices 2>/dev/null | grep -q "$AVD_SERIAL"; then
                BOOT_STATUS=$(adb -s "$AVD_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
                if [ "$BOOT_STATUS" = "1" ]; then
                    log "  ✓ Emulador arrancado en ${BOOT_ELAPSED}s"
                    break
                fi
            fi
            sleep 2
            BOOT_ELAPSED=$((BOOT_ELAPSED + 2))
        done

        if [ $BOOT_ELAPSED -ge $BOOT_TIMEOUT ]; then
            log "  ✗ Emulador no arrancó en ${BOOT_TIMEOUT}s"
            exit 1
        fi
    fi
    step_end
else
    log ""
    log "[4/7] Saltando emulador (--skip-emulator)"
fi

# ── PASO 5: Build e instalación del APK ──────────────────────────────────────
cd "$PROJECT_ROOT"
BUILD_LOG="${EVIDENCE_RUN_DIR}/build.log"

if [ "$REMOTE_MODE" = "true" ]; then
    step_start "5/7" "Instalando APK pre-compilado (modo remoto)..."

    # Usar APK de qa-env-up-remote.sh o qa/artifacts/
    if [ -n "${REMOTE_APK_PATH:-}" ] && [ -f "${REMOTE_APK_PATH}" ]; then
        APK_PATH="$REMOTE_APK_PATH"
    elif [ -f "${PROJECT_ROOT}/qa/artifacts/composeApp-client-debug.apk" ]; then
        APK_PATH="${PROJECT_ROOT}/qa/artifacts/composeApp-client-debug.apk"
    else
        # Buscar en build/outputs como fallback
        APK_PATH=$(find "${PROJECT_ROOT}/app/composeApp/build/outputs/apk/client/debug" -name "*.apk" -type f 2>/dev/null | head -1)
    fi

    if [ -z "$APK_PATH" ] || [ ! -f "$APK_PATH" ]; then
        log "  ✗ APK no encontrado. La fase Build debe generarlo primero."
        log "  Buscado en: qa/artifacts/, build/outputs/, worktrees"
        exit 1
    fi
    log "  APK (pre-compilado): $(basename "$APK_PATH") — $(du -h "$APK_PATH" | cut -f1)"
    echo "APK pre-compilado: $APK_PATH" > "$BUILD_LOG"
else
    step_start "5/7" "Compilando e instalando APK client debug..."

    if ! ./gradlew :app:composeApp:assembleClientDebug --no-daemon >> "$BUILD_LOG" 2>&1; then
        log "  ✗ Build falló"
        log "  Ver logs: $BUILD_LOG"
        exit 1
    fi

    APK_PATH=$(find "${PROJECT_ROOT}/app/composeApp/build/outputs/apk/client/debug" -name "*.apk" -type f 2>/dev/null | head -1)
    if [ -z "$APK_PATH" ]; then
        log "  ✗ APK no encontrado en build/outputs/apk/client/debug/"
        exit 1
    fi
    log "  APK: $(basename "$APK_PATH")"
fi

if command -v adb &>/dev/null; then
    if ! adb -s "$AVD_SERIAL" install -r "$APK_PATH" >> "$LOG_FILE" 2>&1; then
        log "  ✗ Instalación del APK falló en $AVD_SERIAL"
        exit 1
    fi
    log "  ✓ APK instalado en $AVD_SERIAL"
fi
step_end

# ── PASO 6: Grabación y tests Maestro ────────────────────────────────────────
step_start "6/7" "Ejecutando tests Maestro$([ "$NO_VIDEO" = "true" ] && echo " (sin video)" || echo " con video")..."

MAESTRO_DIR="${PROJECT_ROOT}/.maestro/flows"
MAESTRO_LOG="${EVIDENCE_RUN_DIR}/maestro-output.log"
MAESTRO_XML="${EVIDENCE_RUN_DIR}/maestro-results.xml"
VIDEO_DEVICE="/sdcard/smoke-test.mp4"
VIDEO_LOCAL="${EVIDENCE_RUN_DIR}/smoke-test.mp4"

export PATH="${HOME}/.maestro/bin:${PATH}"

if ! command -v maestro &>/dev/null; then
    log "  WARN: Maestro no instalado — saltando tests E2E"
    log "  Instalar: curl -Ls 'https://get.maestro.mobile.dev' | bash"
else
    # Iniciar screenrecord antes de los tests
    if [ "$NO_VIDEO" = "false" ] && command -v adb &>/dev/null; then
        adb -s "$AVD_SERIAL" shell \
            "screenrecord --size 720x1280 --bit-rate 2000000 $VIDEO_DEVICE" \
            > "${EVIDENCE_RUN_DIR}/screenrecord.log" 2>&1 &
        log "  Grabación de video iniciada"
    fi

    MAESTRO_EXIT=0
    if maestro test "$MAESTRO_DIR" \
        --format junit \
        --output "$MAESTRO_XML" \
        >> "$MAESTRO_LOG" 2>&1; then
        log "  ✓ Todos los flows pasaron"
    else
        log "  ✗ Algunos flows fallaron"
        MAESTRO_EXIT=1
    fi

    # Detener screenrecord y extraer video
    if [ "$NO_VIDEO" = "false" ] && command -v adb &>/dev/null; then
        adb -s "$AVD_SERIAL" shell "pkill -INT screenrecord" >> "$LOG_FILE" 2>&1 || true
        sleep 2

        if adb -s "$AVD_SERIAL" shell "ls $VIDEO_DEVICE" >> "$LOG_FILE" 2>&1; then
            adb -s "$AVD_SERIAL" exec-out "cat $VIDEO_DEVICE" > "$VIDEO_LOCAL" 2>/dev/null
            if [ -s "$VIDEO_LOCAL" ]; then
                adb -s "$AVD_SERIAL" shell "rm $VIDEO_DEVICE" >> "$LOG_FILE" 2>/dev/null || true
                log "  ✓ Video guardado: $(du -h "$VIDEO_LOCAL" | cut -f1)"
            else
                rm -f "$VIDEO_LOCAL"
                log "  ⚠ Video no se pudo extraer"
            fi
        fi
    fi

    if [ $MAESTRO_EXIT -ne 0 ]; then
        step_end
        log ""
        log "=== SMOKE TEST: RECHAZADO ==="
        log "  Flows Maestro fallaron — ver: $MAESTRO_LOG"
        exit 1
    fi
fi
step_end

# ── PASO 7: Generar resumen de evidencia ─────────────────────────────────────
step_start "7/7" "Generando resumen de evidencia..."

TOTAL_ELAPSED=$(( $(date +%s) - TOTAL_START ))

{
    echo "# Smoke Test QA — Issue #${ISSUE_NUMBER}"
    echo ""
    echo "| Campo | Valor |"
    echo "|-------|-------|"
    echo "| Timestamp | $TIMESTAMP |"
    echo "| Issue | #${ISSUE_NUMBER} |"
    echo "| Duración total | ${TOTAL_ELAPSED}s |"
    echo "| Backend URL | ${QA_BASE_URL:-http://localhost:80} |"
    echo "| Emulador | $AVD_NAME ($AVD_SERIAL) |"
    echo "| APK | $(basename "${APK_PATH:-desconocido}") |"
    echo ""
    echo "## Archivos"
    echo ""
    echo "| Archivo | Descripción |"
    echo "|---------|-------------|"
    [ -f "$LOG_FILE" ]     && echo "| smoke-test.log | Log completo del ciclo |"
    [ -f "$HC_LOG" ]       && echo "| healthcheck.log | Resultado health-check backend |"
    [ -f "$BUILD_LOG" ]    && echo "| build.log | Log de compilación Gradle |"
    [ -f "$MAESTRO_LOG" ]  && echo "| maestro-output.log | Output de Maestro |"
    [ -f "$MAESTRO_XML" ]  && echo "| maestro-results.xml | Resultados JUnit XML |"
    [ -f "$VIDEO_LOCAL" ]  && echo "| smoke-test.mp4 | Video de evidencia E2E |"
    echo ""
    echo "## Resultado"
    echo ""
    echo "✅ APROBADO — ciclo completo completado en ${TOTAL_ELAPSED}s"
} > "${EVIDENCE_RUN_DIR}/summary.md"

# Copiar a latest/
LATEST_DIR="${EVIDENCE_DIR}/latest"
rm -rf "$LATEST_DIR"
cp -r "$EVIDENCE_RUN_DIR" "$LATEST_DIR"

step_end

# ── Resumen final ─────────────────────────────────────────────────────────────
echo ""
log "======================================="
log "=== SMOKE TEST: APROBADO ==="
log "======================================="
log ""
log "Duración total: ${TOTAL_ELAPSED}s"
log ""
log "Evidencia guardada en:"
log "  $EVIDENCE_RUN_DIR"
log ""
log "Pasos y tiempos:"
step_num=1
if [ -f "${EVIDENCE_RUN_DIR}/timings.txt" ]; then
    while IFS= read -r t; do
        log "  Paso $step_num: ${t}s"
        step_num=$((step_num + 1))
    done < "${EVIDENCE_RUN_DIR}/timings.txt"
fi

if [ "$TOTAL_ELAPSED" -gt 600 ]; then
    log ""
    log "  ⚠ Ciclo tomó más de 10 minutos (${TOTAL_ELAPSED}s)"
    log "  Revisar: snapshot qa-ready del emulador y tiempo de build"
else
    log ""
    log "  ✓ Ciclo completado dentro del objetivo de 10 minutos"
fi

# Cleanup remoto si aplica
if [ "$REMOTE_MODE" = "true" ]; then
    log ""
    log "Desactivando QA Priority Window..."
    bash "${SCRIPT_DIR}/qa-env-down-remote.sh" >> "$LOG_FILE" 2>&1 || true
fi

exit 0
