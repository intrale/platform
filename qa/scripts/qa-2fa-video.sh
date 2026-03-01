#!/usr/bin/env bash
# qa-2fa-video.sh — Grabar evidencia en video del flujo 2FA
# Usa adb screenrecord + input para navegar la app
# Genera videos en qa/evidence/1092/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
EVIDENCE_DIR="${PROJECT_ROOT}/qa/evidence/1092"

# Paths Windows para adb pull (MSYS2 no debe convertir paths del dispositivo)
EVIDENCE_WIN="C:\\Workspaces\\Intrale\\platform\\qa\\evidence\\1092"
TMP_XML_WIN="C:\\Workspaces\\Intrale\\platform\\qa\\evidence\\1092\\.ui-dump-tmp.xml"
TMP_XML="${EVIDENCE_DIR}/.ui-dump-tmp.xml"

APP_PKG="com.intrale.app.client"
APP_MAIN_ACTIVITY="ar.com.intrale.MainActivity"
PYTHON="/c/Python314/python"

mkdir -p "$EVIDENCE_DIR"

echo "=== QA Video — 2FA Setup y Verificación ==="

# Verificar adb
if ! command -v adb &>/dev/null; then
    echo "ERROR: adb no encontrado"
    exit 1
fi

# Verificar Python
if [ ! -f "$PYTHON" ]; then
    echo "ERROR: Python no encontrado en $PYTHON"
    exit 1
fi

# Verificar emulador conectado
DEVICE=$(adb devices 2>/dev/null | grep -v "^$" | grep -v "^List" | grep "device$" | head -1 | awk '{print $1}')
if [ -z "$DEVICE" ]; then
    echo "ERROR: No hay dispositivo conectado"
    exit 1
fi
echo "  Dispositivo: $DEVICE"

RECORD_PID=""

# Función: esperar N segundos
wait_sec() {
    sleep "$1"
}

# Función: input texto
type_text() {
    adb -s "$DEVICE" shell input text "$1"
    wait_sec 0.5
}

# Función: swipe para scroll
scroll_down() {
    adb -s "$DEVICE" shell input swipe 540 1800 540 800 500
    wait_sec 1
}

# Función: obtener UI dump y buscar coordenadas usando Python
find_and_tap() {
    local search_text="$1"
    local max_attempts="${2:-3}"
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        # Dump UI hierarchy al dispositivo (sin conversión MSYS2)
        MSYS_NO_PATHCONV=1 adb -s "$DEVICE" shell "uiautomator dump /data/local/tmp/ui-dump.xml" 2>/dev/null || true
        wait_sec 1

        # Pull al PC usando path Windows
        MSYS_NO_PATHCONV=1 adb -s "$DEVICE" pull /data/local/tmp/ui-dump.xml "$TMP_XML_WIN" 2>/dev/null || true

        # Parsear con Python
        local coords
        coords=$("$PYTHON" - "$TMP_XML" "$search_text" 2>/dev/null <<'PYEOF'
import xml.etree.ElementTree as ET
import re, sys

try:
    xml_file = sys.argv[1]
    search = sys.argv[2].lower()
    tree = ET.parse(xml_file)
    root = tree.getroot()
    for node in root.iter('node'):
        text = (node.get('text') or '') + ' ' + (node.get('content-desc') or '')
        if search in text.lower():
            bounds = node.get('bounds', '')
            m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', bounds)
            if m:
                x1, y1, x2, y2 = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4))
                print(f"{(x1+x2)//2} {(y1+y2)//2}")
                break
except Exception:
    pass
PYEOF
        )

        if [ -n "$coords" ]; then
            local cx cy
            cx=$(echo "$coords" | awk '{print $1}')
            cy=$(echo "$coords" | awk '{print $2}')
            echo "  Tap: '$search_text' en ($cx, $cy)"
            adb -s "$DEVICE" shell input tap "$cx" "$cy"
            wait_sec 1
            rm -f "$TMP_XML" 2>/dev/null
            return 0
        fi

        attempt=$((attempt + 1))
        if [ $attempt -lt $max_attempts ]; then
            echo "  Texto '$search_text' no encontrado, scrolling... (intento $attempt/$max_attempts)"
            scroll_down
        fi
    done

    echo "  WARN: No se encontró '$search_text' después de $max_attempts intentos"
    rm -f "$TMP_XML" 2>/dev/null
    return 1
}

# Función: iniciar screenrecord
start_recording() {
    local video_name="$1"
    echo "  Grabando: $video_name"
    MSYS_NO_PATHCONV=1 adb -s "$DEVICE" shell "screenrecord --size 720x1280 --bit-rate 2000000 --time-limit 60 /data/local/tmp/${video_name}.mp4" &
    RECORD_PID=$!
    wait_sec 2
}

# Función: detener screenrecord y extraer video
stop_recording() {
    local video_name="$1"
    local video_local="${EVIDENCE_DIR}/${video_name}.mp4"
    local video_local_win="${EVIDENCE_WIN}\\${video_name}.mp4"

    MSYS_NO_PATHCONV=1 adb -s "$DEVICE" shell "pkill -INT screenrecord" 2>/dev/null || true
    wait_sec 3

    if [ -n "$RECORD_PID" ]; then
        kill "$RECORD_PID" 2>/dev/null || true
        wait "$RECORD_PID" 2>/dev/null || true
        RECORD_PID=""
    fi

    wait_sec 2

    if MSYS_NO_PATHCONV=1 adb -s "$DEVICE" shell "ls /data/local/tmp/${video_name}.mp4" &>/dev/null; then
        MSYS_NO_PATHCONV=1 adb -s "$DEVICE" pull "/data/local/tmp/${video_name}.mp4" "$video_local_win" 2>/dev/null && \
            MSYS_NO_PATHCONV=1 adb -s "$DEVICE" shell "rm /data/local/tmp/${video_name}.mp4" 2>/dev/null || true
        local size
        size=$(du -h "$video_local" 2>/dev/null | cut -f1) || size="?"
        echo "  Video guardado: $video_local ($size)"
    else
        echo "  WARN: Video no generado para $video_name"
    fi
}

# Función: hacer login
do_login() {
    echo ""
    echo "[Login] Iniciando sesión..."

    # Forzar stop y relanzar app
    adb -s "$DEVICE" shell am force-stop "$APP_PKG" 2>/dev/null || true
    wait_sec 2
    adb -s "$DEVICE" shell am start -n "$APP_PKG/$APP_MAIN_ACTIVITY" 2>/dev/null
    wait_sec 5

    # Tap "Ya tengo cuenta"
    find_and_tap "Ya tengo cuenta" 2 || true
    wait_sec 2

    # Ingresar usuario — buscar por label del campo
    find_and_tap "Correo" 2 || find_and_tap "mail" 2 || true
    wait_sec 1
    type_text "admin@intrale.com"
    wait_sec 1

    # Ingresar contraseña
    find_and_tap "Contrase" 2 || true
    wait_sec 1
    type_text "Admin1234!"
    wait_sec 1

    # Tap en botón de login
    find_and_tap "Ingresar" 2 || find_and_tap "Iniciar" 2 || true
    wait_sec 8

    echo "[Login] Login completado"
}

# Función: navegar a perfil
go_to_profile() {
    echo ""
    echo "[Navegación] Yendo a Perfil..."
    find_and_tap "Perfil" 3 || true
    wait_sec 3
    echo "[Navegación] En perfil"
}

# ====================================================================
# ESCENARIO 1: Navegar a configuración 2FA desde perfil
# ====================================================================
echo ""
echo "=== Escenario 1: Navegar a configuración 2FA ==="

do_login
go_to_profile

start_recording "2fa-setup-navigation"

echo "[2FA Setup] Buscando sección de seguridad..."
scroll_down
wait_sec 1

find_and_tap "Configurar" 3 || find_and_tap "autenticaci" 3 || find_and_tap "2FA" 2 || true
wait_sec 5

adb -s "$DEVICE" exec-out screencap -p > "${EVIDENCE_DIR}/2fa-setup-screen.png" && echo "  Screenshot: 2fa-setup-screen.png" || true

wait_sec 3
stop_recording "2fa-setup-navigation"

# ====================================================================
# ESCENARIO 2: Ver pantalla de setup (QR / secret key)
# ====================================================================
echo ""
echo "=== Escenario 2: Pantalla de setup 2FA (detalles) ==="

start_recording "2fa-setup-details"
wait_sec 5

adb -s "$DEVICE" exec-out screencap -p > "${EVIDENCE_DIR}/2fa-setup-details.png" && echo "  Screenshot: 2fa-setup-details.png" || true

find_and_tap "Copiar clave" 1 || true
wait_sec 2
find_and_tap "Copiar enlace" 1 || true
wait_sec 2

adb -s "$DEVICE" shell input keyevent KEYCODE_BACK 2>/dev/null
wait_sec 3

stop_recording "2fa-setup-details"

# ====================================================================
# ESCENARIO 3: Pantalla de verificación de código
# ====================================================================
echo ""
echo "=== Escenario 3: Pantalla de verificación 2FA ==="

start_recording "2fa-verify-screen"
scroll_down
wait_sec 1

find_and_tap "Verificar autenticaci" 3 || find_and_tap "Verificar" 3 || true
wait_sec 5

adb -s "$DEVICE" exec-out screencap -p > "${EVIDENCE_DIR}/2fa-verify-screen.png" && echo "  Screenshot: 2fa-verify-screen.png" || true

wait_sec 3
stop_recording "2fa-verify-screen"

# ====================================================================
# ESCENARIO 4: Validación de código incorrecto
# ====================================================================
echo ""
echo "=== Escenario 4: Validación de código incorrecto ==="

start_recording "2fa-invalid-code"

find_and_tap "digo" 2 || true
wait_sec 1
type_text "123"
wait_sec 1

find_and_tap "Verificar c" 2 || true
wait_sec 3

adb -s "$DEVICE" exec-out screencap -p > "${EVIDENCE_DIR}/2fa-invalid-short-code.png" && echo "  Screenshot: 2fa-invalid-short-code.png" || true

find_and_tap "digo" 1 || true
adb -s "$DEVICE" shell input keyevent --longpress KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL 2>/dev/null
wait_sec 1
type_text "000000"
wait_sec 1

find_and_tap "Verificar c" 2 || true
wait_sec 5

adb -s "$DEVICE" exec-out screencap -p > "${EVIDENCE_DIR}/2fa-invalid-wrong-code.png" && echo "  Screenshot: 2fa-invalid-wrong-code.png" || true

wait_sec 2
stop_recording "2fa-invalid-code"

# ====================================================================
# RESUMEN
# ====================================================================
echo ""
echo "=== Resumen de evidencia ==="
echo "Directorio: $EVIDENCE_DIR"
ls -lh "$EVIDENCE_DIR" 2>/dev/null || true

rm -f "$TMP_XML" 2>/dev/null || true

echo ""
echo "=== QA Video 2FA: COMPLETADO ==="
