#!/usr/bin/env bash
# backend-healthcheck.sh — Verifica que el backend remoto (Lambda AWS) responde correctamente
# Uso: bash qa/scripts/backend-healthcheck.sh [BASE_URL]
# Salida: 0 si todos los endpoints responden, 1 si alguno falla
#
# Env vars opcionales:
#   QA_BASE_URL — URL base del backend (default: Lambda AWS dev)
#   HC_TIMEOUT  — segundos máximos de espera por intento (default: 5)
set -euo pipefail

# ── Configuración ─────────────────────────────────────────────────────────────
# Aceptar URL como argumento posicional o env var, pero nunca inyectarla en shell
if [ -n "${1:-}" ]; then
    BASE_URL="${1}"
else
    BASE_URL="${QA_BASE_URL:-https://mgnr0htbvd.execute-api.us-east-2.amazonaws.com/dev}"
fi

# Validar que BASE_URL tenga formato aceptable (http/https + host)
if ! echo "$BASE_URL" | grep -qE '^https?://[a-zA-Z0-9._-]+(:[0-9]+)?(/.*)?$'; then
    echo "ERROR: BASE_URL inválida: '$BASE_URL'"
    echo "  Formato esperado: https://host/path"
    exit 1
fi

HC_TIMEOUT="${HC_TIMEOUT:-5}"

ERRORS=0
CHECKS=0

pass() { echo "  [OK]  $1"; }
fail() { echo "  [ERR] $1"; ERRORS=$((ERRORS + 1)); }
section() { echo ""; echo "=== $1 ==="; }

echo "=== Backend Health Check ==="
echo "  URL base: $BASE_URL"
echo ""

# ── Función de verificación de endpoint ──────────────────────────────────────
# check_endpoint <descripcion> <metodo> <path> <body> <codigo_esperado>
# No se interpolan variables del usuario en los argumentos de curl
check_endpoint() {
    local desc="$1"
    local method="$2"
    local path="$3"
    local body="$4"
    local expected_code="$5"

    CHECKS=$((CHECKS + 1))

    local url="${BASE_URL}${path}"
    local actual_code

    if [ "$method" = "POST" ]; then
        actual_code=$(curl \
            --silent \
            --output /dev/null \
            --write-out '%{http_code}' \
            --max-time "$HC_TIMEOUT" \
            --request POST \
            --header 'Content-Type: application/json' \
            --data-raw "$body" \
            -- "$url" 2>/dev/null || echo "000")
    else
        actual_code=$(curl \
            --silent \
            --output /dev/null \
            --write-out '%{http_code}' \
            --max-time "$HC_TIMEOUT" \
            --request GET \
            -- "$url" 2>/dev/null || echo "000")
    fi

    if [ "$actual_code" = "$expected_code" ]; then
        pass "$desc → HTTP $actual_code"
    else
        fail "$desc → esperado HTTP $expected_code, recibido HTTP $actual_code"
    fi
}

# ── 1. Conectividad básica ────────────────────────────────────────────────────
section "Conectividad"
check_endpoint \
    "Ruta raíz (routing básico)" \
    "GET" "/" "" "403"

# ── 2. Endpoint de autenticación (signin) ────────────────────────────────────
section "Auth — signin"
check_endpoint \
    "signin sin body → 400 (validación activa)" \
    "POST" "/intrale/signin" "{}" "400"

check_endpoint \
    "signin con email inválido → 401" \
    "POST" "/intrale/signin" \
    '{"email":"not-an-email","password":"test"}' \
    "401"

# ── 3. Endpoint de registro (signup) ─────────────────────────────────────────
section "Auth — signup"
check_endpoint \
    "signup sin body → 400" \
    "POST" "/intrale/signup" "{}" "400"

# ── 4. Endpoint de perfiles (requiere JWT) ────────────────────────────────────
section "Perfiles (SecuredFunction)"
check_endpoint \
    "profiles sin token → 401" \
    "POST" "/intrale/profiles" "{}" "401"

# ── 5. Endpoint de negocios ───────────────────────────────────────────────────
section "Negocios"
check_endpoint \
    "searchBusinesses sin body → 200" \
    "POST" "/intrale/searchBusinesses" "{}" "200"

# ── Resumen ───────────────────────────────────────────────────────────────────
echo ""
echo "======================================="
echo "Checks ejecutados : $CHECKS"
echo "Errores           : $ERRORS"
echo ""

if [ $ERRORS -eq 0 ]; then
    echo "RESULTADO: Backend OK — todos los endpoints responden correctamente"
    exit 0
else
    echo "RESULTADO: $ERRORS endpoint(s) no respondieron como se esperaba"
    echo "  Verificar:"
    echo "    1. El backend remoto (Lambda AWS) está activo"
    echo "    2. La URL en QA_BASE_URL es correcta"
    echo "    3. Verificar estado de API Gateway en AWS Console"
    exit 1
fi
