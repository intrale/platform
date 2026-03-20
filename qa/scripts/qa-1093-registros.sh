#!/usr/bin/env bash
# qa-1093-registros.sh — Graba video de los formularios de registro especializados
# Usa adb shell screenrecord + uiautomator para navegación
set -uo pipefail

DEVICE="emulator-5554"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVIDENCE_DIR="$PROJECT_ROOT/qa/evidence/1093"
RECORDINGS_DIR="$PROJECT_ROOT/qa/recordings"
APP_ID="com.intrale.app.client"

mkdir -p "$EVIDENCE_DIR" "$RECORDINGS_DIR"

echo "=== QA #1093: Registros Especializados con Video ==="

# ── Helper functions ──────────────────────────────────────────

dismiss_dialogs() {
    for i in 1 2 3; do
        local dump
        dump=$(adb -s "$DEVICE" exec-out uiautomator dump /dev/tty 2>/dev/null)
        if echo "$dump" | grep -q "isn't responding\|aerr_close"; then
            echo "    [!] Descartando diálogo ANR..."
            adb -s "$DEVICE" shell input tap 540 1201
            sleep 3
        else
            break
        fi
    done
}

get_dump() {
    adb -s "$DEVICE" exec-out uiautomator dump /dev/tty 2>/dev/null
}

wait_for_text() {
    local text="$1"
    local timeout="${2:-30}"
    local elapsed=0
    echo "    Esperando: '$text'..."
    while [ $elapsed -lt $timeout ]; do
        dismiss_dialogs
        if get_dump | grep -q "$text"; then
            echo "    ✓ '$text' encontrado"
            return 0
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done
    echo "    ⚠ Timeout: '$text'"
    return 1
}

tap_text() {
    local text="$1"
    echo "    Tap: '$text'"
    local dump
    dump=$(get_dump)
    # Extraer bounds del nodo con el texto
    local bounds
    bounds=$(echo "$dump" | grep -oP "text=\"[^\"]*${text}[^\"]*\"[^>]*bounds=\"\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]\"" | head -1 | grep -oP 'bounds="\[\K[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+' | head -1)
    if [ -n "$bounds" ]; then
        local x1 y1 x2 y2
        x1=$(echo "$bounds" | cut -d',' -f1)
        y1=$(echo "$bounds" | cut -d',' -f2 | cut -d']' -f1)
        x2=$(echo "$bounds" | cut -d'[' -f2 | cut -d',' -f1)
        y2=$(echo "$bounds" | cut -d',' -f3)
        local cx=$(( (x1 + x2) / 2 ))
        local cy=$(( (y1 + y2) / 2 ))
        adb -s "$DEVICE" shell input tap "$cx" "$cy"
        sleep 2
        return 0
    fi
    echo "    ⚠ No se encontró '$text'"
    return 1
}

take_screenshot() {
    local name="$1"
    echo "    📸 $name"
    adb -s "$DEVICE" exec-out screencap -p > "$EVIDENCE_DIR/${name}.png" 2>/dev/null
}

# ── 1. Iniciar screenrecord ──────────────────────────────────
echo ""
echo "[1/7] Iniciando grabación de video..."
VIDEO_DEVICE="/sdcard/qa-1093.mp4"
adb -s "$DEVICE" shell "rm -f $VIDEO_DEVICE" 2>/dev/null
adb -s "$DEVICE" shell "screenrecord --size 720x1280 --bit-rate 2000000 --time-limit 180 $VIDEO_DEVICE" \
    > "$RECORDINGS_DIR/screenrecord-1093.log" 2>&1 &
RECORD_PID=$!
sleep 2
echo "  ✓ Screenrecord iniciado"

cleanup() {
    echo ""
    echo "[CLEANUP] Deteniendo screenrecord..."
    adb -s "$DEVICE" shell "pkill -INT screenrecord" 2>/dev/null || true
    sleep 4
    if adb -s "$DEVICE" shell "test -s $VIDEO_DEVICE" 2>/dev/null; then
        adb -s "$DEVICE" exec-out "cat $VIDEO_DEVICE" > "$EVIDENCE_DIR/qa-1093-registros.mp4" 2>/dev/null
        if [ -s "$EVIDENCE_DIR/qa-1093-registros.mp4" ]; then
            echo "  ✓ Video: $EVIDENCE_DIR/qa-1093-registros.mp4 ($(du -h "$EVIDENCE_DIR/qa-1093-registros.mp4" | cut -f1))"
        fi
        adb -s "$DEVICE" shell "rm $VIDEO_DEVICE" 2>/dev/null || true
    fi
    kill $RECORD_PID 2>/dev/null || true
}
trap cleanup EXIT

# ── 2. Lanzar app ────────────────────────────────────────────
echo ""
echo "[2/7] Lanzando app..."
adb -s "$DEVICE" shell "am start -n $APP_ID/ar.com.intrale.MainActivity" 2>&1
sleep 5
dismiss_dialogs

# ── 3. Saltar onboarding ────────────────────────────────────
echo ""
echo "[3/7] Saltando onboarding..."
if wait_for_text "Saltar" 20; then
    take_screenshot "01-onboarding"
    tap_text "Saltar"
    sleep 3
fi

# ── 4. Home → Selección de perfil ────────────────────────────
echo ""
echo "[4/7] Navegando a selección de perfil..."
if wait_for_text "Registrarme" 15; then
    take_screenshot "02-home"
    tap_text "Registrarme"
    sleep 3
fi

# ── 5. Formulario Platform Admin ─────────────────────────────
echo ""
echo "[5/7] Formulario: Registro Platform Admin..."
if wait_for_text "Registro Platform Admin" 10; then
    take_screenshot "03-select-profile"
    tap_text "Registro Platform Admin"
    sleep 3
fi

if wait_for_text "Registrar administrador" 10; then
    take_screenshot "04-platform-admin-empty"

    # Tap en el campo de email (buscar por "Correo" o el campo de texto)
    local_dump=$(get_dump)
    email_bounds=$(echo "$local_dump" | grep -oP 'class="android.widget.EditText"[^>]*bounds="\[\K[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+' | head -1)
    if [ -n "$email_bounds" ]; then
        x1=$(echo "$email_bounds" | cut -d',' -f1)
        y1=$(echo "$email_bounds" | cut -d',' -f2 | cut -d']' -f1)
        x2=$(echo "$email_bounds" | cut -d'[' -f2 | cut -d',' -f1)
        y2=$(echo "$email_bounds" | cut -d',' -f3)
        cx=$(( (x1 + x2) / 2 ))
        cy=$(( (y1 + y2) / 2 ))
        adb -s "$DEVICE" shell input tap "$cx" "$cy"
        sleep 1
    else
        # Fallback: tap en la zona del campo email
        adb -s "$DEVICE" shell input tap 540 600
        sleep 1
    fi
    adb -s "$DEVICE" shell input text "admin-qa@intrale.com"
    sleep 1
    # Ocultar teclado
    adb -s "$DEVICE" shell input keyevent KEYCODE_ESCAPE
    sleep 1
    take_screenshot "05-platform-admin-filled"

    # Enviar formulario
    tap_text "Registrar administrador" || true
    sleep 3
    take_screenshot "06-platform-admin-submitted"
fi

# Volver atrás
echo "    ← Volviendo..."
adb -s "$DEVICE" shell input keyevent KEYCODE_BACK
sleep 2

# ── 6. Formulario Delivery ───────────────────────────────────
echo ""
echo "[6/7] Formulario: Registro Delivery..."
if wait_for_text "Registro Delivery" 10; then
    tap_text "Registro Delivery"
    sleep 3
fi

if wait_for_text "Registrar repartidor" 15; then
    take_screenshot "07-delivery-empty"

    # Buscar primer EditText (email)
    local_dump=$(get_dump)
    email_bounds=$(echo "$local_dump" | grep -oP 'class="android.widget.EditText"[^>]*bounds="\[\K[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+' | head -1)
    if [ -n "$email_bounds" ]; then
        x1=$(echo "$email_bounds" | cut -d',' -f1)
        y1=$(echo "$email_bounds" | cut -d',' -f2 | cut -d']' -f1)
        x2=$(echo "$email_bounds" | cut -d'[' -f2 | cut -d',' -f1)
        y2=$(echo "$email_bounds" | cut -d',' -f3)
        cx=$(( (x1 + x2) / 2 ))
        cy=$(( (y1 + y2) / 2 ))
        adb -s "$DEVICE" shell input tap "$cx" "$cy"
        sleep 1
    else
        adb -s "$DEVICE" shell input tap 540 500
        sleep 1
    fi
    adb -s "$DEVICE" shell input text "delivery-qa@intrale.com"
    sleep 1
    adb -s "$DEVICE" shell input keyevent KEYCODE_ESCAPE
    sleep 1
    take_screenshot "08-delivery-email-filled"

    # Buscar segundo EditText (negocio)
    local_dump=$(get_dump)
    biz_bounds=$(echo "$local_dump" | grep -oP 'class="android.widget.EditText"[^>]*bounds="\[\K[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+' | sed -n '2p')
    if [ -n "$biz_bounds" ]; then
        x1=$(echo "$biz_bounds" | cut -d',' -f1)
        y1=$(echo "$biz_bounds" | cut -d',' -f2 | cut -d']' -f1)
        x2=$(echo "$biz_bounds" | cut -d'[' -f2 | cut -d',' -f1)
        y2=$(echo "$biz_bounds" | cut -d',' -f3)
        cx=$(( (x1 + x2) / 2 ))
        cy=$(( (y1 + y2) / 2 ))
        adb -s "$DEVICE" shell input tap "$cx" "$cy"
        sleep 1
    fi
    adb -s "$DEVICE" shell input text "intrale"
    sleep 2
    adb -s "$DEVICE" shell input keyevent KEYCODE_ESCAPE
    sleep 1
    take_screenshot "09-delivery-business-filled"

    # Enviar
    tap_text "Registrar repartidor" || true
    sleep 3
    take_screenshot "10-delivery-submitted"
fi

# Volver atrás
adb -s "$DEVICE" shell input keyevent KEYCODE_BACK
sleep 2

# ── 7. Evidencia RegisterSaler ────────────────────────────────
echo ""
echo "[7/7] Documentando RegisterSaler..."
echo "  ℹ RegisterSaler (/registerSaler) no tiene navegación UI en el app client."
echo "  ℹ Solo es accesible para BusinessAdmin (no hay botón en SelectSignUpProfile)."
take_screenshot "11-profile-selector-final"

echo ""
echo "=== Evidencia generada ==="
ls -la "$EVIDENCE_DIR/" 2>/dev/null
echo ""
echo "=== QA #1093: COMPLETADO ==="
