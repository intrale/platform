#!/usr/bin/env bash
# Levanta Docker (DynamoDB + Moto), espera la inicialización,
# extrae credenciales y arranca el backend Ktor.
# Uso: ./scripts/local-up.sh
set -uo pipefail

# En Windows: si algo falla, no cerrar la ventana sin avisar
pause_on_exit() {
  local code=$?
  if [ $code -ne 0 ]; then
    echo ""
    echo "ERROR: el script falló con código $code"
  fi
  echo ""
  read -r -p "Presiona Enter para cerrar..."
  exit $code
}
trap pause_on_exit EXIT

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env.local"

cd "$PROJECT_ROOT"

# ── 1. Verificar Docker ───────────────────────────────────
echo "=== Verificando Docker ==="
if ! command -v docker &>/dev/null; then
  echo "ERROR: 'docker' no encontrado en PATH"
  echo "Instala Docker Desktop: https://www.docker.com/products/docker-desktop/"
  exit 1
fi

if ! docker info &>/dev/null; then
  echo "ERROR: Docker daemon no está corriendo"
  echo "Abrí Docker Desktop y esperá a que arranque."
  exit 1
fi

# ── 2. Docker Compose ─────────────────────────────────────
echo "=== Levantando servicios Docker ==="
if ! docker compose up -d; then
  echo "ERROR: docker compose up falló"
  exit 1
fi

echo "Esperando a que aws-init termine..."
TIMEOUT=120
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  # Verificar si el container ya no está running
  if ! docker compose ps 2>/dev/null | grep "aws-init" | grep -qi "running"; then
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  printf "."
done
echo ""

if [ $ELAPSED -ge $TIMEOUT ]; then
  echo "ERROR: aws-init no terminó en ${TIMEOUT}s"
  echo "Logs:"
  docker compose logs aws-init
  exit 1
fi

echo "aws-init completado."
echo ""

# ── 3. Extraer credenciales ────────────────────────────────
echo "Extrayendo USER_POOL_ID y CLIENT_ID..."

INIT_LOGS=$(docker compose logs aws-init 2>&1)

USER_POOL_ID=$(echo "$INIT_LOGS" | grep 'USER_POOL_ID=' | tail -1 | sed 's/.*USER_POOL_ID=//')
CLIENT_ID=$(echo "$INIT_LOGS" | grep 'CLIENT_ID=' | tail -1 | sed 's/.*CLIENT_ID=//')

# Limpiar \r de Windows y espacios
USER_POOL_ID=$(echo "$USER_POOL_ID" | tr -d '\r\n' | xargs)
CLIENT_ID=$(echo "$CLIENT_ID" | tr -d '\r\n' | xargs)

if [ -z "$USER_POOL_ID" ] || [ -z "$CLIENT_ID" ]; then
  echo "ERROR: No se pudieron extraer credenciales de los logs."
  echo ""
  echo "Logs de aws-init:"
  echo "$INIT_LOGS"
  exit 1
fi

# ── 4. Guardar .env.local ─────────────────────────────────
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

# ── 5. Arrancar backend ───────────────────────────────────
echo ""
echo "=== Arrancando backend Ktor ==="
echo "(Ctrl+C para detener)"
echo ""

# Exportar variables
set -a
source "$ENV_FILE"
set +a

# JAVA_HOME — detección dinámica en orden de preferencia
detect_java_home() {
  # 1. Buscar Temurin 21 en ubicaciones estándar (varias versiones patch)
  for candidate in \
    /c/Users/Administrator/.jdks/temurin-21* \
    /c/Program\ Files/Eclipse\ Adoptium/jdk-21* \
    /usr/lib/jvm/temurin-21* \
    /usr/lib/jvm/java-21*; do
    if [ -x "$candidate/bin/java" ]; then
      echo "$candidate"
      return
    fi
  done

  # 2. Usar JAVA_HOME ya seteado si es Java 21
  if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
    local ver
    ver=$("$JAVA_HOME/bin/java" -version 2>&1 | head -1 | sed 's/.*version "\([0-9]*\).*/\1/')
    if [ "$ver" = "21" ]; then
      echo "$JAVA_HOME"
      return
    fi
  fi

  # 3. Usar java del PATH si es Java 21
  if command -v java &>/dev/null; then
    local ver
    ver=$(java -version 2>&1 | head -1 | sed 's/.*version "\([0-9]*\).*/\1/')
    if [ "$ver" = "21" ]; then
      # Devolver directorio del JDK (dos niveles sobre el binario)
      local java_bin
      java_bin=$(command -v java)
      echo "$(cd "$(dirname "$java_bin")/.." && pwd)"
      return
    fi
  fi
}

DETECTED_JAVA_HOME="$(detect_java_home)"
if [ -n "$DETECTED_JAVA_HOME" ]; then
  export JAVA_HOME="$DETECTED_JAVA_HOME"
  echo "Usando JAVA_HOME: $JAVA_HOME"
elif [ -n "${JAVA_HOME:-}" ]; then
  echo "WARN: JAVA_HOME configurado pero no es Java 21 — Gradle puede fallar: $JAVA_HOME"
else
  echo "WARN: Java 21 no encontrado — Gradle usará el JDK del PATH (puede fallar)"
fi

# No usar exec — mantener el script vivo para el trap
./gradlew :users:run
