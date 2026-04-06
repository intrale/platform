#!/usr/bin/env bash
# Tira abajo el entorno QA remoto: desactiva Priority Window + limpia estado.
# Uso: ./qa/scripts/qa-env-down-remote.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PIPELINE_DIR="$PROJECT_ROOT/.pipeline"
STATE_FILE="$PROJECT_ROOT/qa/.qa-remote-state"

cd "$PROJECT_ROOT"

echo "=== QA Environment REMOTO — Tirando abajo ==="

# ── 1. Desactivar QA Priority Window ────────────────────
echo "[1/2] Desactivando QA Priority Window..."
PW_FILE="$PIPELINE_DIR/priority-windows.json"
if [ -f "$PW_FILE" ]; then
  node -e "
    const fs = require('fs');
    const f = '$PW_FILE';
    let pw = {};
    try { pw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) {}
    if (pw.qa) {
      pw.qa.active = false;
      pw.qa.deactivatedAt = Date.now();
      pw.qa.reason = 'qa-env-down-remote';
    }
    pw.updatedAt = Date.now();
    fs.writeFileSync(f, JSON.stringify(pw, null, 2));
    console.log('  QA Priority Window DESACTIVADA');
  " 2>/dev/null || echo "  WARN: No se pudo desactivar Priority Window"
else
  echo "  No habia Priority Window activa"
fi

# ── 2. Limpiar estado ──────────────────────────────────
echo "[2/2] Limpiando estado..."
if [ -f "$STATE_FILE" ]; then
  echo "  Estado previo:"
  cat "$STATE_FILE" | sed 's/^/    /'
  rm -f "$STATE_FILE"
  echo "  Archivo de estado eliminado"
else
  echo "  No habia archivo de estado"
fi

echo ""
echo "=== QA Environment REMOTO detenido ==="
echo "  Pipeline puede reanudar lanzamiento de agentes"
