#!/usr/bin/env bash
# Levanta Docker (DynamoDB + Moto), espera la inicialización,
# extrae credenciales y arranca el backend Ktor.
# Uso: ./scripts/local-up.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env.local"

cd "$PROJECT_ROOT"

# ── 1. Docker ──────────────────────────────────────────────
echo "=== Levantando servicios Docker ==="
docker compose up -d

echo "Esperando a que aws-init termine..."
# aws-init es un container efímero — esperamos a que salga con código 0
TIMEOUT=120
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  STATUS=$(docker compose ps aws-init --format '{{.State}}' 2>/dev/null || echo "unknown")
  # El container puede reportar "exited" o desaparecer del listado
  if echo "$STATUS" | grep -qi "exited"; then
    break
  fi
  # Si ya no existe en la lista, también terminó
  if ! docker compose ps --status running 2>/dev/null | grep -q "aws-init"; then
    # Verificar que no esté "running" sino que ya salió
    if ! docker compose ps 2>/dev/null | grep "aws-init" | grep -qi "running"; then
      break
    fi
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  printf "."
done
echo ""

if [ $ELAPSED -ge $TIMEOUT ]; then
  echo "ERROR: aws-init no terminó en ${TIMEOUT}s"
  docker compose logs aws-init
  exit 1
fi

# Verificar que salió bien
EXIT_CODE=$(docker compose ps aws-init --format '{{.ExitCode}}' 2>/dev/null || echo "0")
if [ "$EXIT_CODE" != "0" ] && [ -n "$EXIT_CODE" ]; then
  echo "ERROR: aws-init falló (exit code: $EXIT_CODE)"
  docker compose logs aws-init
  exit 1
fi

echo "aws-init completado."

# ── 2. Extraer credenciales ────────────────────────────────
echo "Extrayendo USER_POOL_ID y CLIENT_ID..."

INIT_LOGS=$(docker compose logs aws-init 2>&1)

USER_POOL_ID=$(echo "$INIT_LOGS" | grep 'USER_POOL_ID=' | tail -1 | sed 's/.*USER_POOL_ID=//')
CLIENT_ID=$(echo "$INIT_LOGS" | grep 'CLIENT_ID=' | tail -1 | sed 's/.*CLIENT_ID=//')

# Limpiar posibles \r de Windows
USER_POOL_ID=$(echo "$USER_POOL_ID" | tr -d '\r' | xargs)
CLIENT_ID=$(echo "$CLIENT_ID" | tr -d '\r' | xargs)

if [ -z "$USER_POOL_ID" ] || [ -z "$CLIENT_ID" ]; then
  echo "ERROR: No se pudieron extraer credenciales de los logs"
  echo "Logs de aws-init:"
  echo "$INIT_LOGS"
  exit 1
fi

# ── 3. Guardar .env.local ─────────────────────────────────
cat > "$ENV_FILE" <<ENVEOF
# Generado automáticamente por local-up.sh — no commitear
LOCAL_MODE=true
REGION_VALUE=us-east-1
ACCESS_KEY_ID=local
SECRET_ACCESS_KEY=local
USER_POOL_ID=$USER_POOL_ID
CLIENT_ID=$CLIENT_ID
DYNAMODB_ENDPOINT=http://localhost:8000
COGNITO_ENDPOINT=http://localhost:5050
ENVEOF

echo "Credenciales guardadas en .env.local"
echo "  USER_POOL_ID=$USER_POOL_ID"
echo "  CLIENT_ID=$CLIENT_ID"

# ── 4. Arrancar backend ───────────────────────────────────
echo ""
echo "=== Arrancando backend Ktor ==="
echo "(Ctrl+C para detener)"
echo ""

# Exportar todas las variables
set -a
source "$ENV_FILE"
set +a

# JAVA_HOME — usar Temurin 21 si existe
if [ -d "/c/Users/Administrator/.jdks/temurin-21.0.7" ]; then
  export JAVA_HOME="/c/Users/Administrator/.jdks/temurin-21.0.7"
elif [ -n "${JAVA_HOME:-}" ]; then
  echo "Usando JAVA_HOME existente: $JAVA_HOME"
else
  echo "WARN: JAVA_HOME no configurado — Gradle usará el JDK del PATH"
fi

exec ./gradlew :users:run
