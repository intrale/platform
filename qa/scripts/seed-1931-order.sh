#!/usr/bin/env bash
# seed-1931-order.sh
# Crea un pedido activo (status PENDING) en el ambiente QA remoto para que el
# flow Maestro `validate-1931-detalle-pedido-estimacion.yaml` pueda renderizar
# la `DeliveryEstimationCard` y demostrar visualmente los criterios del issue
# #1931 (estimacion inteligente de tiempo de entrega).
#
# Por que existe este script:
# El rebote de aprobacion (PO + UX, 2026-04-26) explica que la cuenta de cliente
# provisionada en QA no tenia pedidos activos al momento de la corrida, por lo
# tanto la card del feature nunca se rendero en pantalla y el video QA quedo
# sin evidencia visual de los criterios 1, 2, 3, 4, 5 y 7. Este script cierra
# ese gap creando un pedido contra la API real (sin tocar DynamoDB directo).
#
# Uso:
#   ./qa/scripts/seed-1931-order.sh \
#       [--email qa-cliente@intrale.com.ar] \
#       [--password QaCliente2026!] \
#       [--business intrale] \
#       [--items 2]
#
# Env vars (alternativa a flags):
#   QA_CLIENT_EMAIL    — cuenta cliente QA (default: qa-cliente@intrale.com.ar)
#   QA_CLIENT_PASSWORD — password de la cuenta QA (default: QaCliente2026!)
#   QA_BUSINESS        — business slug (default: intrale)
#   QA_BASE_URL        — endpoint API Gateway (default: dev en us-east-2)
#   QA_ITEMS_COUNT     — cantidad de items en el pedido (default: 2)
#
# Salida:
#   - Imprime el orderId y shortCode del pedido creado.
#   - exit 0 si OK; exit != 0 si fallo el login o la creacion.
#
# Requisitos:
#   - curl + jq disponibles en PATH.
#   - La cuenta QA debe existir en Cognito y tener password definitivo (no
#     NEW_PASSWORD_REQUIRED). Si no existe, este script falla con HTTP 400/401
#     y debe coordinarse con backend-dev para alta inicial.

set -euo pipefail

# ---------- Defaults / parametros ----------
EMAIL="${QA_CLIENT_EMAIL:-qa-cliente@intrale.com.ar}"
PASSWORD="${QA_CLIENT_PASSWORD:-QaCliente2026!}"
BUSINESS="${QA_BUSINESS:-intrale}"
BASE_URL="${QA_BASE_URL:-https://mgnr0htbvd.execute-api.us-east-2.amazonaws.com/dev}"
ITEMS_COUNT="${QA_ITEMS_COUNT:-2}"

while [ $# -gt 0 ]; do
  case "$1" in
    --email)    EMAIL="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --business) BUSINESS="$2"; shift 2 ;;
    --items)    ITEMS_COUNT="$2"; shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    -h|--help)
      sed -n '1,40p' "$0"
      exit 0
      ;;
    *) echo "WARN: argumento desconocido: $1"; shift ;;
  esac
done

# ---------- Validaciones de tooling ----------
for tool in curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: '$tool' no esta instalado o no esta en PATH" >&2
    exit 2
  fi
done

# ---------- 1. Login para obtener JWT ----------
echo "=== Seed pedido activo para issue #1931 ==="
echo "  Email   : $EMAIL"
echo "  Business: $BUSINESS"
echo "  Items   : $ITEMS_COUNT"
echo "  Endpoint: $BASE_URL"
echo ""

echo "[1/2] Login contra $BASE_URL/$BUSINESS/signin..."
LOGIN_BODY=$(jq -n --arg email "$EMAIL" --arg pwd "$PASSWORD" \
  '{email: $email, password: $pwd}')

LOGIN_RAW=$(curl --silent --show-error --max-time 20 \
  --request POST \
  --header "Content-Type: application/json" \
  --data "$LOGIN_BODY" \
  "$BASE_URL/$BUSINESS/signin" || true)

if [ -z "$LOGIN_RAW" ]; then
  echo "ERROR: respuesta vacia del endpoint de signin" >&2
  exit 3
fi

# Extraer JWT (idToken o accessToken segun configuracion del backend)
JWT=$(echo "$LOGIN_RAW" | jq -r '.idToken // .accessToken // .token // empty' 2>/dev/null || true)

if [ -z "$JWT" ] || [ "$JWT" = "null" ]; then
  echo "ERROR: no se pudo obtener JWT del login. Respuesta:" >&2
  echo "$LOGIN_RAW" | head -c 500 >&2
  echo "" >&2
  echo "" >&2
  echo "Verificar que la cuenta exista y tenga password definitivo (no NEW_PASSWORD_REQUIRED)." >&2
  exit 4
fi

echo "  Login OK (JWT len=${#JWT})"

# ---------- 2. Crear pedido ----------
echo "[2/2] Creando pedido activo en $BASE_URL/$BUSINESS/client/orders..."

# Generar payload con N items dummy (productos genericos del seed). Si el negocio
# requiere productos reales, ajustar productId/productName aca.
ITEMS_JSON=$(jq -n --argjson count "$ITEMS_COUNT" '
  [range(0; $count) | {
    productId: ("seed-prod-" + (. | tostring)),
    productName: ("Producto seed " + ((. + 1) | tostring)),
    quantity: 1,
    unitPrice: 100.0
  }]
')

ORDER_BODY=$(jq -n --argjson items "$ITEMS_JSON" '{
  items: $items,
  notes: "Seed automatico para QA visual de #1931"
}')

ORDER_RAW=$(curl --silent --show-error --max-time 20 \
  --request POST \
  --header "Content-Type: application/json" \
  --header "Authorization: Bearer $JWT" \
  --header "X-Http-Method: POST" \
  --data "$ORDER_BODY" \
  "$BASE_URL/$BUSINESS/client/orders" || true)

if [ -z "$ORDER_RAW" ]; then
  echo "ERROR: respuesta vacia al crear el pedido" >&2
  exit 5
fi

ORDER_ID=$(echo "$ORDER_RAW" | jq -r '.orderId // empty' 2>/dev/null || true)
SHORT_CODE=$(echo "$ORDER_RAW" | jq -r '.shortCode // empty' 2>/dev/null || true)

if [ -z "$ORDER_ID" ] || [ "$ORDER_ID" = "null" ]; then
  echo "ERROR: el backend no devolvio orderId. Respuesta:" >&2
  echo "$ORDER_RAW" | head -c 800 >&2
  echo "" >&2
  exit 6
fi

echo ""
echo "OK: pedido seed creado"
echo "  orderId  : $ORDER_ID"
echo "  shortCode: $SHORT_CODE"
echo "  business : $BUSINESS"
echo ""
echo "Ahora se puede correr Maestro:"
echo "  bash qa/scripts/qa-android.sh QA_FLAVOR=client"
echo "y los flows validate-1931-* deberian capturar la DeliveryEstimationCard."
