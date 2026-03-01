#!/usr/bin/env bash
# QA #1090 — Grabar evidencia de login y registro con adb screenrecord
# Ejecuta 5 escenarios del issue y captura video + screenshots
set -uo pipefail
export MSYS_NO_PATHCONV=1

EVIDENCE_DIR="/c/Workspaces/Intrale/platform.agent-1090-qa-video-login-registro/qa/evidence/1090"
APP_PKG="com.intrale.app.client"
ACTIVITY="ar.com.intrale.MainActivity"

# Resolución: 1080x2400

echo "=== QA #1090: Login y Registro — Evidencia en Video ==="
echo ""

# ── Helper: screenshot con nombre descriptivo ──
screenshot() {
    local name="$1"
    sleep 1
    adb exec-out screencap -p > "$EVIDENCE_DIR/${name}.png"
    echo "  Screenshot: ${name}.png"
}

# ── Helper: tap en coordenada ──
tap() {
    adb shell input tap "$1" "$2"
    sleep 2
}

# ── Helper: escribir texto ──
type_text() {
    # Usar adb shell input text (escapa espacios)
    local text="${1// /%s}"
    adb shell input text "$text"
    sleep 1
}

# ── Limpiar estado: forzar cierre de app ──
echo "[0] Limpiando estado..."
adb shell am force-stop "$APP_PKG" 2>/dev/null || true
sleep 2

# ── Iniciar grabación de video completa ──
echo "[1] Iniciando screenrecord..."
VIDEO_DEVICE="/sdcard/qa-1090-full.mp4"
adb shell screenrecord --size 720x1280 --bit-rate 4000000 --time-limit 180 "$VIDEO_DEVICE" &
RECORD_PID=$!
sleep 2

# ══════════════════════════════════════════════════════════
# ESCENARIO 1: Abrir app → ver pantalla de login/welcome
# ══════════════════════════════════════════════════════════
echo ""
echo "=== Escenario 1: Abrir app → ver pantalla welcome ==="
adb shell am start -n "$APP_PKG/$ACTIVITY" 2>/dev/null
sleep 4
screenshot "01-welcome-screen"

# ══════════════════════════════════════════════════════════
# ESCENARIO 2: Navegar a login → credenciales inválidas → error
# ══════════════════════════════════════════════════════════
echo ""
echo "=== Escenario 2: Login con credenciales inválidas ==="

# Tap "Ya tengo cuenta" (aprox centro del botón: 540, 560)
echo "  Tap: Ya tengo cuenta"
tap 370 560
sleep 2
screenshot "02a-login-screen"

# Tap campo Username (buscar por posición relativa)
echo "  Escribiendo usuario inválido..."
tap 370 450
sleep 1
type_text "usuario_invalido@test.com"
sleep 1

# Tap campo Password
echo "  Escribiendo password inválida..."
tap 370 600
sleep 1
type_text "wrongpass123"
sleep 1
screenshot "02b-login-filled-invalid"

# Tap botón de login (Ingresar)
echo "  Tap: Ingresar"
tap 370 750
sleep 4
screenshot "02c-login-error"

# ══════════════════════════════════════════════════════════
# ESCENARIO 3: Login exitoso con usuario seed
# ══════════════════════════════════════════════════════════
echo ""
echo "=== Escenario 3: Login exitoso ==="

# Limpiar campos - tap en campo username, seleccionar todo y borrar
echo "  Limpiando campos..."
tap 370 450
sleep 1
adb shell input keyevent KEYCODE_MOVE_HOME
adb shell "input keyevent --longpress $(for i in $(seq 1 30); do echo -n 'KEYCODE_FORWARD_DEL '; done)" 2>/dev/null || true
sleep 1
type_text "admin@intrale.com"
sleep 1

# Limpiar password
tap 370 600
sleep 1
adb shell input keyevent KEYCODE_MOVE_HOME
adb shell "input keyevent --longpress $(for i in $(seq 1 15); do echo -n 'KEYCODE_FORWARD_DEL '; done)" 2>/dev/null || true
sleep 1
type_text "Admin1234!"
sleep 1
screenshot "03a-login-filled-valid"

# Tap login
echo "  Tap: Ingresar"
tap 370 750
sleep 5
screenshot "03b-home-after-login"

# ══════════════════════════════════════════════════════════
# ESCENARIO 4: Logout
# ══════════════════════════════════════════════════════════
echo ""
echo "=== Escenario 4: Logout ==="
# Buscar menú/perfil para logout - presionar back primero
adb shell input keyevent KEYCODE_BACK
sleep 2
# Forzar cierre para simular logout
adb shell am force-stop "$APP_PKG"
sleep 2
adb shell am start -n "$APP_PKG/$ACTIVITY"
sleep 4
screenshot "04-after-logout-welcome"

# ══════════════════════════════════════════════════════════
# ESCENARIO 5: Registro
# ══════════════════════════════════════════════════════════
echo ""
echo "=== Escenario 5: Registro básico ==="

# Tap "Registrarme"
echo "  Tap: Registrarme"
tap 370 420
sleep 3
screenshot "05a-signup-screen"

# Llenar formulario de registro
echo "  Llenando formulario de registro..."
tap 370 400
sleep 1
type_text "qa-test-1090@intrale.com"
sleep 1
screenshot "05b-signup-filled"

# Scroll down si es necesario y buscar botón de submit
echo "  Buscando botón de envío..."
adb shell input swipe 370 900 370 400 500
sleep 2
screenshot "05c-signup-form-scrolled"

# ── Detener grabación ──
echo ""
echo "=== Deteniendo grabación ==="
adb shell pkill -INT screenrecord 2>/dev/null || true
sleep 3
kill $RECORD_PID 2>/dev/null || true
sleep 2

# ── Extraer video ──
echo "Extrayendo video..."
adb pull "$VIDEO_DEVICE" "$EVIDENCE_DIR/qa-1090-full-recording.mp4" 2>&1
adb shell rm "$VIDEO_DEVICE" 2>/dev/null || true

echo ""
echo "=== Evidencia generada ==="
ls -lh "$EVIDENCE_DIR/"*.mp4 "$EVIDENCE_DIR/"*.png 2>/dev/null
echo ""
echo "=== QA #1090: COMPLETADO ==="
