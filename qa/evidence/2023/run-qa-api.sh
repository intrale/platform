#!/usr/bin/env bash
# QA-API manual runner para issue #2023
# Verifica que los endpoints backend responden correctamente

set -u

REMOTE_URL="${QA_BASE_URL:-https://mgnr0htbvd.execute-api.us-east-2.amazonaws.com/dev}"
ISSUE="${QA_ISSUE:-2023}"
EVIDENCE="qa/evidence/${ISSUE}"
mkdir -p "$EVIDENCE"

RAW="$EVIDENCE/raw-responses.txt"
JSON="$EVIDENCE/qa-api-report.json"
SUMMARY="$EVIDENCE/qa-api-summary.txt"

> "$RAW"
TOTAL=0
PASS=0
FAIL=0
RESULTS_JSON="[]"

run_test() {
  local id="$1"
  local title="$2"
  local method="$3"
  local endpoint="$4"
  local body="$5"
  local expected_min="$6"
  local expected_max="$7"

  TOTAL=$((TOTAL+1))

  local start_ms=$(date +%s%3N 2>/dev/null || echo 0)
  local tmpfile=$(mktemp)
  local status
  status=$(curl -s -o "$tmpfile" -w '%{http_code}' \
    -X "$method" "$REMOTE_URL$endpoint" \
    -H 'Content-Type: application/json' \
    --data "$body" 2>/dev/null)
  local end_ms=$(date +%s%3N 2>/dev/null || echo 0)
  local elapsed=$((end_ms - start_ms))

  local response_body
  response_body=$(cat "$tmpfile")
  rm -f "$tmpfile"

  local verdict="FAIL"
  if [ "$status" -ge "$expected_min" ] 2>/dev/null && [ "$status" -le "$expected_max" ] 2>/dev/null; then
    verdict="PASS"
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
  fi

  {
    echo "===== $id: $method $endpoint ====="
    echo "TITLE: $title"
    echo "REQUEST BODY: $body"
    echo "EXPECTED: ${expected_min}..${expected_max}"
    echo "ACTUAL STATUS: $status"
    echo "TIME_MS: $elapsed"
    echo "RESPONSE: $response_body"
    echo "VERDICT: $verdict"
    echo ""
  } >> "$RAW"

  echo "[$verdict] $id $method $endpoint -> $status (${elapsed}ms)"

  # Build JSON entry (simple escape of response body)
  local resp_escaped
  resp_escaped=$(printf '%s' "$response_body" | python -c 'import sys,json;print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""')

  ENTRY=$(cat <<EOF
{
  "id": "$id",
  "title": "$title",
  "method": "$method",
  "endpoint": "$endpoint",
  "expected_status_range": [$expected_min, $expected_max],
  "actual_status": $status,
  "time_ms": $elapsed,
  "response_body": $resp_escaped,
  "verdict": "$verdict"
}
EOF
)
  echo "$ENTRY" >> "$EVIDENCE/.tc-entries.tmp"
}

# --- Auth ---
run_test "TC-AUTH-01" "Signin endpoint existe y valida body" \
  "POST" "/qa-automation/signin" '{}' 400 400

run_test "TC-AUTH-02" "Signup endpoint existe y valida body" \
  "POST" "/qa-automation/signup" '{}' 400 400

run_test "TC-AUTH-03" "Recovery (forgot password) endpoint existe" \
  "POST" "/qa-automation/recovery" '{}' 400 400

run_test "TC-AUTH-04" "Signin con credenciales invalidas responde error" \
  "POST" "/qa-automation/signin" \
  '{"email":"inexistente@test.com","password":"WrongPass123!"}' 400 401

# --- Productos ---
run_test "TC-PROD-01" "Products endpoint existe (requiere auth)" \
  "POST" "/qa-automation/products" '{}' 400 401

# --- Pedidos ---
run_test "TC-ORDER-01" "Orders endpoint existe (requiere auth)" \
  "POST" "/qa-automation/orders" '{}' 400 401

run_test "TC-ORDER-02" "Order-detail endpoint existe (requiere auth)" \
  "POST" "/qa-automation/order-detail" '{}' 400 401

# --- Delivery ---
run_test "TC-DELIVERY-01" "Delivery orders endpoint existe" \
  "POST" "/qa-automation/delivery-orders" '{}' 400 401

# --- Perfil ---
run_test "TC-PROFILE-01" "Profile endpoint existe (requiere auth)" \
  "POST" "/qa-automation/profile" '{}' 400 401

# Armar JSON final
python <<PYEOF > "$JSON"
import json, os, datetime
entries = []
path = "$EVIDENCE/.tc-entries.tmp"
if os.path.exists(path):
    raw = open(path).read()
    for blk in raw.split("\n{"):
        s = blk.strip()
        if not s:
            continue
        if not s.startswith("{"):
            s = "{" + s
        try:
            entries.append(json.loads(s))
        except Exception:
            pass
report = {
  "issue": "$ISSUE",
  "mode": "qa-api",
  "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
  "base_url": "$REMOTE_URL",
  "results": entries,
  "summary": {
    "total": $TOTAL,
    "passed": $PASS,
    "failed": $FAIL
  }
}
print(json.dumps(report, indent=2))
PYEOF

rm -f "$EVIDENCE/.tc-entries.tmp"

{
  echo "QA-API verificacion - Issue #$ISSUE"
  echo "====================================="
  echo "Fecha: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Pipeline: desarrollo"
  echo "Modo: qa-api"
  echo "Backend: $REMOTE_URL"
  echo ""
  echo "Resultados: $PASS/$TOTAL PASS, $FAIL FAIL"
  echo ""
  echo "Endpoints verificados (existencia y reachability):"
  echo "- Auth: signin, signup, recovery (forgot password)"
  echo "  Nota: NO hay endpoint /refresh dedicado. El refreshToken se entrega"
  echo "        como parte de la respuesta de signin. Documentado por Guru."
  echo "- Productos: /products (requiere auth JWT)"
  echo "- Pedidos: /orders, /order-detail (requiere auth JWT)"
  echo "- Delivery: /delivery-orders (requiere auth JWT)"
  echo "- Perfil: /profile (requiere auth JWT)"
  echo ""
  echo "Interpretacion de status codes:"
  echo "- 400 = endpoint existe, Lambda valida body y rechaza (OK)"
  echo "- 401 = endpoint existe, API Gateway/Lambda valida auth y rechaza (OK)"
  echo "- 403 (Missing Authentication Token) = ruta NO existe en API Gateway (FAIL)"
  echo "- 404 = recurso no encontrado (FAIL si es lista de rutas)"
  echo ""
  echo "Detalle completo en: $RAW"
  echo "Reporte JSON: $JSON"
} > "$SUMMARY"

cat "$SUMMARY"

if [ "$FAIL" -eq 0 ]; then
  exit 0
else
  exit 1
fi
