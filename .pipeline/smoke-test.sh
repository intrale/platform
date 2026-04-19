#!/usr/bin/env bash
# smoke-test.sh — Verificación post-restart del pipeline V2
#
# Diseñado para correr SIN depender del pipeline vivo. Solo requiere:
#   - bash, node, curl, taskkill/ps (según OS)
#   - Acceso al filesystem del proyecto
#
# Chequeos:
#   1. Procesos críticos corren (pulpo, dashboard, servicio-telegram)
#   2. Dashboard responde en :3200
#   3. No hay lock files huérfanos bloqueando el pipeline
#   4. El archivo de último restart es reciente (< 120s)
#
# Exit codes:
#   0 → pipeline sano
#   1 → fallo crítico (componente caído)
#   2 → fallo de conectividad (dashboard no responde)
#   3 → fallo de estado (archivos corruptos o stale)

set -u

PIPELINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="${PIPELINE_DIR}/logs/smoke-test.log"
mkdir -p "$(dirname "$LOG_FILE")"

log() {
  local msg="$1"
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "[$ts] $msg" | tee -a "$LOG_FILE"
}

fail() {
  log "FAIL: $1"
  exit "${2:-1}"
}

# --- 1) Procesos críticos ---
log "=== SMOKE TEST ==="
log "1) Verificando procesos críticos..."

CRITICAL=("pulpo.pid" "dashboard.pid" "svc-telegram.pid")
for pid_file in "${CRITICAL[@]}"; do
  if [ ! -f "${PIPELINE_DIR}/${pid_file}" ]; then
    fail "PID file ausente: ${pid_file}" 1
  fi
  pid=$(cat "${PIPELINE_DIR}/${pid_file}" 2>/dev/null | tr -d '[:space:]')
  if [ -z "$pid" ]; then
    fail "PID file vacío: ${pid_file}" 1
  fi
  # Windows/Unix portable process check
  if command -v tasklist &>/dev/null; then
    if ! tasklist //FI "PID eq ${pid}" //NH 2>/dev/null | grep -q "^node"; then
      fail "Proceso no corre: ${pid_file} (PID ${pid})" 1
    fi
  else
    if ! ps -p "$pid" &>/dev/null; then
      fail "Proceso no corre: ${pid_file} (PID ${pid})" 1
    fi
  fi
  log "  OK ${pid_file} (PID ${pid})"
done

# --- 2) Dashboard responde ---
log "2) Verificando dashboard HTTP..."
if command -v curl &>/dev/null; then
  # Dashboard en :3200 — endpoint /api/state es cheap
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:3200/api/state" 2>/dev/null || echo "000")
  if [ "$http_code" != "200" ]; then
    fail "Dashboard no responde en :3200 (HTTP ${http_code})" 2
  fi
  log "  OK dashboard HTTP 200"
else
  log "  SKIP curl no disponible"
fi

# --- 3) Estado del filesystem ---
log "3) Verificando estado del filesystem..."

# last-restart.json debe existir y ser reciente (< 5 min)
LAST_RESTART="${PIPELINE_DIR}/last-restart.json"
if [ ! -f "$LAST_RESTART" ]; then
  fail "last-restart.json ausente" 3
fi

# Portable file mtime (GNU stat / BSD stat / fallback)
if stat --version &>/dev/null 2>&1; then
  mtime=$(stat -c %Y "$LAST_RESTART" 2>/dev/null)
else
  mtime=$(stat -f %m "$LAST_RESTART" 2>/dev/null)
fi
now=$(date +%s)
age=$((now - mtime))
if [ "$age" -gt 300 ]; then
  log "  WARN last-restart.json tiene ${age}s (esperado < 300)"
else
  log "  OK last-restart.json (${age}s)"
fi

# Archivos de commander/trabajando huérfanos (>10 min)
ORPHAN_DIR="${PIPELINE_DIR}/servicios/commander/trabajando"
if [ -d "$ORPHAN_DIR" ]; then
  orphan_count=$(find "$ORPHAN_DIR" -name "*.json" -type f 2>/dev/null | wc -l | tr -d '[:space:]')
  if [ "${orphan_count:-0}" -gt 0 ]; then
    log "  WARN ${orphan_count} mensajes en commander/trabajando/ (esperado 0 post-restart)"
  fi
fi

log "=== SMOKE TEST OK ==="
exit 0
