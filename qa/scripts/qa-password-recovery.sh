#!/usr/bin/env bash
# qa-password-recovery.sh — Graba evidencia en video de flujos de recuperación y cambio de contraseña
# Uso: bash qa/scripts/qa-password-recovery.sh
# Genera videos + screenshots en qa/evidence/1091/
set -euo pipefail

# Evitar conversión de paths MSYS2 (e.g. /data/local/tmp → C:/Program Files/Git/...)
export MSYS_NO_PATHCONV=1

ADB="/c/Users/Administrator/AppData/Local/Android/Sdk/platform-tools/adb.exe"
EVIDENCE_DIR="qa/evidence/1091"
APP_PKG="com.intrale.app.client"
APP_ACTIVITY="ar.com.intrale.MainActivity"
DEVICE_TMP="/data/local/tmp"
# Display ID del emulador (requerido para screenrecord headless)
DISPLAY_ID="4619827259835644672"

mkdir -p "$EVIDENCE_DIR"

# ── Helpers ───────────────────────────────────────────────────
tap() { "$ADB" shell input tap "$1" "$2"; sleep 1; }
type_text() { "$ADB" shell input text "$1"; sleep 0.5; }
swipe_up() { "$ADB" shell input swipe 540 1800 540 800 500; sleep 1; }
swipe_down() { "$ADB" shell input swipe 540 800 540 1800 500; sleep 1; }
press_back() { "$ADB" shell input keyevent 4; sleep 1; }
hide_keyboard() { "$ADB" shell input keyevent 111; sleep 0.5; }

screenshot() {
    local name="$1"
    "$ADB" shell "screencap -p $DEVICE_TMP/qa-shot.png"
    "$ADB" pull "$DEVICE_TMP/qa-shot.png" "$EVIDENCE_DIR/${name}.png" 2>/dev/null
    echo "  Screenshot: ${name}.png"
}

start_recording() {
    local name="$1"
    echo "  Iniciando grabación: $name"
    "$ADB" shell "screenrecord --display-id $DISPLAY_ID --size 720x1280 --bit-rate 2000000 --time-limit 120 $DEVICE_TMP/qa-${name}.mp4" &
    RECORD_PID=$!
    sleep 2
}

stop_recording() {
    local name="$1"
    echo "  Deteniendo grabación: $name"
    "$ADB" shell "kill -INT \$(pidof screenrecord)" 2>/dev/null || true
    sleep 3
    kill "$RECORD_PID" 2>/dev/null || true
    "$ADB" pull "$DEVICE_TMP/qa-${name}.mp4" "$EVIDENCE_DIR/${name}.mp4" 2>/dev/null || true
    "$ADB" shell "rm -f $DEVICE_TMP/qa-${name}.mp4" 2>/dev/null || true
    if [ -f "$EVIDENCE_DIR/${name}.mp4" ]; then
        local size
        size=$(du -h "$EVIDENCE_DIR/${name}.mp4" 2>/dev/null | cut -f1)
        echo "  Video guardado: ${name}.mp4 ($size)"
    else
        echo "  WARN: Video no generado para $name"
    fi
}

launch_app() {
    echo "  Lanzando app..."
    "$ADB" shell "am force-stop $APP_PKG" 2>/dev/null || true
    sleep 1
    "$ADB" shell "am start -n $APP_PKG/$APP_ACTIVITY" 2>/dev/null
    sleep 4
}

ui_dump() {
    "$ADB" shell "uiautomator dump $DEVICE_TMP/ui.xml" 2>/dev/null || true
    "$ADB" pull "$DEVICE_TMP/ui.xml" "$EVIDENCE_DIR/ui-dump.xml" 2>/dev/null || true
}

# Extraer centro de un bounds="[X1,Y1][X2,Y2]" y hacer tap
tap_bounds() {
    local bounds="$1"
    if [ -z "$bounds" ]; then return 1; fi
    local X1 Y1 X2 Y2
    X1=$(echo "$bounds" | grep -oP '\[\K\d+' | sed -n '1p')
    Y1=$(echo "$bounds" | grep -oP ',\K\d+' | sed -n '1p')
    X2=$(echo "$bounds" | grep -oP '\[\K\d+' | sed -n '2p')
    Y2=$(echo "$bounds" | grep -oP ',\K\d+' | sed -n '2p')
    local CX=$(( (X1 + X2) / 2 ))
    local CY=$(( (Y1 + Y2) / 2 ))
    echo "  Tap en ($CX, $CY)"
    tap "$CX" "$CY"
}

find_bounds_by_text() {
    local pattern="$1"
    grep -oP "text=\"${pattern}\"[^>]*bounds=\"\[\d+,\d+\]\[\d+,\d+\]\"" "$EVIDENCE_DIR/ui-dump.xml" 2>/dev/null \
        | grep -oP 'bounds="\[\d+,\d+\]\[\d+,\d+\]"' | head -1 || true
}

find_bounds_by_id() {
    local pattern="$1"
    grep -oP "resource-id=\"[^\"]*${pattern}[^\"]*\"[^>]*bounds=\"\[\d+,\d+\]\[\d+,\d+\]\"" "$EVIDENCE_DIR/ui-dump.xml" 2>/dev/null \
        | grep -oP 'bounds="\[\d+,\d+\]\[\d+,\d+\]"' | head -1 || true
}

echo "================================================================"
echo "  QA: Recuperación y Cambio de Contraseña — Issue #1091"
echo "================================================================"
echo ""

# ═══════════════════════════════════════════════════════════════
# ESCENARIO 1: Navegar a "Olvidé mi contraseña" desde login
# ═══════════════════════════════════════════════════════════════
echo "[1/4] Navegando a 'Olvidé mi contraseña' desde login..."
launch_app
start_recording "01-navigate-to-recovery"

screenshot "01a-welcome"

# Tap "Ya tengo cuenta"
echo "  Buscando 'Ya tengo cuenta'..."
ui_dump
BOUNDS=$(find_bounds_by_text "Ya tengo cuenta")
if [ -n "$BOUNDS" ]; then
    tap_bounds "$BOUNDS"
else
    echo "  Usando posición estimada"
    tap 540 510
fi
sleep 2
screenshot "01b-login-screen"

# Scroll down para ver los enlaces
swipe_up
sleep 1
screenshot "01c-login-scrolled"

# Tap "Recuperar contraseña"
ui_dump
BOUNDS=$(find_bounds_by_text "Recuperar contrase[^\"]*")
echo "  Bounds de 'Recuperar contraseña': $BOUNDS"
if [ -n "$BOUNDS" ]; then
    tap_bounds "$BOUNDS"
else
    echo "  WARN: No se encontró, intentando posición estimada"
    tap 540 1700
fi
sleep 2
screenshot "01d-password-recovery-screen"

stop_recording "01-navigate-to-recovery"
echo "[1/4] COMPLETADO"
echo ""

# ═══════════════════════════════════════════════════════════════
# ESCENARIO 2: Ingresar email → enviar código
# ═══════════════════════════════════════════════════════════════
echo "[2/4] Ingresando email y enviando código de recuperación..."
start_recording "02-submit-recovery"

screenshot "02a-recovery-empty"

# Tap en el campo de email
ui_dump
BOUNDS=$(find_bounds_by_id "field_Correo")
if [ -n "$BOUNDS" ]; then
    echo "  Campo email encontrado"
    tap_bounds "$BOUNDS"
else
    echo "  Campo email no encontrado, usando posición estimada"
    tap 540 650
fi
sleep 1

type_text "test@intrale.com"
sleep 1
hide_keyboard
screenshot "02b-recovery-email-filled"

# Tap en botón enviar
ui_dump
BOUNDS=$(find_bounds_by_id "btn_primary")
if [ -n "$BOUNDS" ]; then
    echo "  Botón enviar encontrado"
    tap_bounds "$BOUNDS"
else
    echo "  Botón no encontrado, usando posición estimada"
    tap 540 900
fi
sleep 3
screenshot "02c-recovery-submitted"

stop_recording "02-submit-recovery"
echo "[2/4] COMPLETADO"
echo ""

# ═══════════════════════════════════════════════════════════════
# ESCENARIO 3: Navegar a confirmación con código (desde login)
# ═══════════════════════════════════════════════════════════════
echo "[3/4] Navegando a pantalla de confirmación con código..."
launch_app
start_recording "03-confirm-recovery"

# Ir al login
ui_dump
BOUNDS=$(find_bounds_by_text "Ya tengo cuenta")
if [ -n "$BOUNDS" ]; then
    tap_bounds "$BOUNDS"
else
    tap 540 510
fi
sleep 2
screenshot "03a-login-screen"

# Scroll y buscar "Ya tengo un código de recuperación"
swipe_up
sleep 1

ui_dump
BOUNDS=$(find_bounds_by_text "Ya tengo un c[^\"]*")
if [ -n "$BOUNDS" ]; then
    echo "  Enlace 'Ya tengo un código' encontrado"
    tap_bounds "$BOUNDS"
else
    echo "  WARN: Enlace no encontrado, usando posición estimada"
    tap 540 1800
fi
sleep 2
screenshot "03b-confirm-recovery-screen"

# Llenar formulario de confirmación
ui_dump

# Tap campo email
BOUNDS=$(find_bounds_by_id "field_Correo")
if [ -n "$BOUNDS" ]; then tap_bounds "$BOUNDS"; else tap 540 550; fi
type_text "test@intrale.com"
hide_keyboard

# Tap campo código
BOUNDS=$(find_bounds_by_id "field_C")
if [ -n "$BOUNDS" ]; then tap_bounds "$BOUNDS"; else tap 540 700; fi
type_text "123456"
hide_keyboard

screenshot "03c-confirm-fields-filled"

# Scroll para ver campos de contraseña
swipe_up
sleep 1

screenshot "03d-confirm-password-fields"

stop_recording "03-confirm-recovery"
echo "[3/4] COMPLETADO"
echo ""

# ═══════════════════════════════════════════════════════════════
# ESCENARIO 4: Validaciones del formulario (passwords no coinciden)
# ═══════════════════════════════════════════════════════════════
echo "[4/4] Probando validaciones del formulario..."
start_recording "04-validation"

# Actualizar UI dump
ui_dump

# Intentar enviar con campos de password vacíos
BOUNDS=$(find_bounds_by_id "btn_primary")
if [ -n "$BOUNDS" ]; then tap_bounds "$BOUNDS"; else tap 540 1200; fi
sleep 2
screenshot "04a-validation-empty-passwords"

# Scroll up para ver los campos
swipe_down
sleep 1

# Llenar password con valor
ui_dump
BOUNDS=$(find_bounds_by_id "field_Contrase")
if [ -n "$BOUNDS" ]; then
    tap_bounds "$BOUNDS"
else
    swipe_up
    tap 540 800
fi
type_text "NewPass123!"
hide_keyboard

# Llenar campo confirmar contraseña con valor diferente
ui_dump
BOUNDS=$(find_bounds_by_id "field_Confirmar")
if [ -n "$BOUNDS" ]; then
    tap_bounds "$BOUNDS"
else
    tap 540 950
fi
type_text "DifferentPassword!"
hide_keyboard

screenshot "04b-passwords-mismatch"

# Scroll down y tap enviar
swipe_up
sleep 1
ui_dump
BOUNDS=$(find_bounds_by_id "btn_primary")
if [ -n "$BOUNDS" ]; then tap_bounds "$BOUNDS"; else tap 540 1200; fi
sleep 2
screenshot "04c-validation-error"

stop_recording "04-validation"
echo "[4/4] COMPLETADO"
echo ""

# ═══════════════════════════════════════════════════════════════
# REPORTE FINAL
# ═══════════════════════════════════════════════════════════════
echo "================================================================"
echo "  EVIDENCIA GENERADA"
echo "================================================================"
echo ""
echo "Videos:"
ls -lh "$EVIDENCE_DIR"/*.mp4 2>/dev/null || echo "  (ninguno)"
echo ""
echo "Screenshots:"
ls -lh "$EVIDENCE_DIR"/*.png 2>/dev/null || echo "  (ninguno)"
echo ""
echo "================================================================"
echo "  QA Password Recovery: COMPLETADO"
echo "================================================================"
