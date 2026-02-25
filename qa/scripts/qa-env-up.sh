#!/usr/bin/env bash
# Levanta el entorno QA: Docker (DynamoDB + Moto + seed) + backend Ktor.
# Uso: ./qa/scripts/qa-env-up.sh
# El backend queda corriendo en background — usar qa-env-down.sh para tirar todo.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env.qa"
PID_FILE="$PROJECT_ROOT/qa/.backend.pid"

cd "$PROJECT_ROOT"

echo "=== QA Environment — Levantando ==="

# ── 1. Verificar Docker ───────────────────────────────────
echo "[1/5] Verificando Docker..."
if ! command -v docker &>/dev/null; then
  echo "ERROR: 'docker' no encontrado en PATH"
  exit 1
fi

if ! docker info &>/dev/null; then
  echo "ERROR: Docker daemon no esta corriendo"
  exit 1
fi
echo "  Docker OK"

# ── 2. Docker Compose ─────────────────────────────────────
echo "[2/5] Levantando servicios Docker..."
if ! docker compose up -d; then
  echo "ERROR: docker compose up fallo"
  exit 1
fi

echo "  Esperando a que aws-init termine..."
TIMEOUT=120
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  if ! docker compose ps 2>/dev/null | grep "aws-init" | grep -qi "running"; then
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  printf "."
done
echo ""

if [ $ELAPSED -ge $TIMEOUT ]; then
  echo "ERROR: aws-init no termino en ${TIMEOUT}s"
  docker compose logs aws-init
  exit 1
fi
echo "  aws-init completado"

# ── 3. Extraer credenciales ────────────────────────────────
echo "[3/5] Extrayendo credenciales..."
sleep 2  # Esperar flush de logs del container
INIT_LOGS=$(docker compose logs --no-log-prefix aws-init 2>&1)

# Extraer USER_POOL_ID: formato "USER_POOL_ID=xxx" o "User Pool creado: xxx"
USER_POOL_ID=$(echo "$INIT_LOGS" | sed -n 's/.*USER_POOL_ID=\([^ ]*\).*/\1/p' | tail -1)
if [ -z "$USER_POOL_ID" ]; then
  USER_POOL_ID=$(echo "$INIT_LOGS" | sed -n 's/.*User Pool creado: \([^ ]*\).*/\1/p' | tail -1)
fi
if [ -z "$USER_POOL_ID" ]; then
  USER_POOL_ID=$(echo "$INIT_LOGS" | sed -n 's/.*User Pool ya existe: \([^ ]*\).*/\1/p' | tail -1)
fi

# Extraer CLIENT_ID: formato "CLIENT_ID=xxx" o "App Client creado: xxx"
CLIENT_ID=$(echo "$INIT_LOGS" | sed -n 's/.*CLIENT_ID=\([^ ]*\).*/\1/p' | tail -1)
if [ -z "$CLIENT_ID" ]; then
  CLIENT_ID=$(echo "$INIT_LOGS" | sed -n 's/.*App Client creado: \([^ ]*\).*/\1/p' | tail -1)
fi
if [ -z "$CLIENT_ID" ]; then
  CLIENT_ID=$(echo "$INIT_LOGS" | sed -n 's/.*App Client ya existe: \([^ ]*\).*/\1/p' | tail -1)
fi

USER_POOL_ID=$(echo "$USER_POOL_ID" | tr -d '\r\n' | xargs)
CLIENT_ID=$(echo "$CLIENT_ID" | tr -d '\r\n' | xargs)

if [ -z "$USER_POOL_ID" ] || [ -z "$CLIENT_ID" ]; then
  echo "ERROR: No se pudieron extraer credenciales de los logs"
  echo "$INIT_LOGS"
  exit 1
fi

# ── 4. Guardar .env.qa ────────────────────────────────────
cat > "$ENV_FILE" <<ENVEOF
# Generado por qa-env-up.sh — no commitear
LOCAL_MODE=true
REGION_VALUE=us-east-1
ACCESS_KEY_ID=local
SECRET_ACCESS_KEY=local
USER_POOL_ID=$USER_POOL_ID
CLIENT_ID=$CLIENT_ID
DYNAMODB_ENDPOINT=http://localhost:8000
COGNITO_ENDPOINT=http://localhost:5050
QA_BASE_URL=http://localhost:80
ENVEOF

echo "  Credenciales guardadas en .env.qa"
echo "  USER_POOL_ID=$USER_POOL_ID"
echo "  CLIENT_ID=$CLIENT_ID"

# ── 5. Arrancar backend en background ─────────────────────
echo "[4/5] Arrancando backend Ktor en background..."

set -a
source "$ENV_FILE"
set +a

if [ -d "/c/Users/Administrator/.jdks/temurin-21.0.7" ]; then
  export JAVA_HOME="/c/Users/Administrator/.jdks/temurin-21.0.7"
fi

# Matar backend previo si existe
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  kill "$OLD_PID" 2>/dev/null || true
  rm -f "$PID_FILE"
fi

./gradlew :users:run &
BACKEND_PID=$!
echo "$BACKEND_PID" > "$PID_FILE"
echo "  Backend PID: $BACKEND_PID"

# ── 6. Healthcheck loop ──────────────────────────────────
echo "[5/5] Esperando que el backend responda..."
HC_TIMEOUT=90
HC_ELAPSED=0
while [ $HC_ELAPSED -lt $HC_TIMEOUT ]; do
  STATUS=$(curl -so /dev/null -w '%{http_code}' -X POST http://localhost:80/intrale/signin -H 'Content-Type: application/json' -d '{}' 2>/dev/null)
  if [ "$STATUS" = "400" ]; then
    echo ""
    echo "  Backend respondiendo en http://localhost:80"
    break
  fi
  sleep 3
  HC_ELAPSED=$((HC_ELAPSED + 3))
  printf "."
done
echo ""

if [ $HC_ELAPSED -ge $HC_TIMEOUT ]; then
  echo "WARN: Backend no respondio al healthcheck en ${HC_TIMEOUT}s"
  echo "  Puede que necesite mas tiempo o que haya un error."
  echo "  Revisar logs con: ./gradlew :users:run"
fi

echo ""
echo "=== QA Environment listo ==="
echo "  Base URL: http://localhost:80"
echo "  Para correr tests: ./gradlew :qa:test"
echo "  Para tirar abajo: ./qa/scripts/qa-env-down.sh"
