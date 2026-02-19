#!/usr/bin/env bash
# Detiene el backend (si hay) y baja los servicios Docker.
# Uso: ./scripts/local-down.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# ── 1. Matar procesos Gradle del backend ──────────────────
echo "=== Deteniendo backend ==="
# Buscar el proceso Gradle del :users:run
GRADLE_PIDS=$(ps aux 2>/dev/null | grep '[g]radlew.*:users:run' | awk '{print $2}' || true)
if [ -n "$GRADLE_PIDS" ]; then
  echo "Deteniendo Gradle (PIDs: $GRADLE_PIDS)..."
  echo "$GRADLE_PIDS" | xargs kill 2>/dev/null || true
  sleep 2
else
  echo "No se encontró backend corriendo."
fi

# También intentar matar el daemon de Gradle que corre el backend
BACKEND_PIDS=$(ps aux 2>/dev/null | grep '[G]radleDaemon.*users' | awk '{print $2}' || true)
if [ -n "$BACKEND_PIDS" ]; then
  echo "Deteniendo Gradle daemon (PIDs: $BACKEND_PIDS)..."
  echo "$BACKEND_PIDS" | xargs kill 2>/dev/null || true
fi

# ── 2. Bajar Docker ───────────────────────────────────────
echo ""
echo "=== Deteniendo servicios Docker ==="
docker compose down

# ── 3. Limpiar .env.local ─────────────────────────────────
if [ -f ".env.local" ]; then
  rm -f .env.local
  echo ".env.local eliminado"
fi

echo ""
echo "=== Entorno local detenido ==="
