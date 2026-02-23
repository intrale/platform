#!/usr/bin/env bash
# Tira abajo el entorno QA: mata backend + docker compose down.
# Uso: ./qa/scripts/qa-env-down.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PID_FILE="$PROJECT_ROOT/qa/.backend.pid"
ENV_FILE="$PROJECT_ROOT/.env.qa"

cd "$PROJECT_ROOT"

echo "=== QA Environment — Tirando abajo ==="

# ── 1. Matar backend ─────────────────────────────────────
echo "[1/3] Deteniendo backend..."
if [ -f "$PID_FILE" ]; then
  BACKEND_PID=$(cat "$PID_FILE")
  if kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
    echo "  Backend (PID $BACKEND_PID) detenido"
  else
    echo "  Backend (PID $BACKEND_PID) ya no estaba corriendo"
  fi
  rm -f "$PID_FILE"
else
  echo "  No se encontro PID del backend"
  # Intentar matar por puerto
  if command -v lsof &>/dev/null; then
    PIDS=$(lsof -ti :80 2>/dev/null || true)
    if [ -n "$PIDS" ]; then
      echo "  Matando procesos en puerto 80: $PIDS"
      echo "$PIDS" | xargs kill 2>/dev/null || true
    fi
  fi
fi

# ── 2. Docker Compose down ───────────────────────────────
echo "[2/3] Deteniendo Docker..."
docker compose down 2>/dev/null || true
echo "  Docker detenido"

# ── 3. Limpiar archivos ─────────────────────────────────
echo "[3/3] Limpiando archivos temporales..."
rm -f "$ENV_FILE"
rm -f "$PID_FILE"
echo "  Archivos limpiados"

echo ""
echo "=== QA Environment detenido ==="
