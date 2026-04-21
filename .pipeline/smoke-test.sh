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

# Evidencia a stderr desde el vamos, independiente de tee/LOG_FILE.
# Si el smoke test falla antes del primer log() (tee roto, CWD raro),
# restart.js captura esto via spawnSync result.stderr.
echo "[smoke-test] inicio pid=$$ pipeline_dir=${PIPELINE_DIR}" >&2

log() {
  local msg="$1"
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "[$ts] $msg" | tee -a "$LOG_FILE"
  echo "[smoke-test] $msg" >&2
}

fail() {
  log "FAIL: $1"
  exit "${2:-1}"
}

# --- 1) Procesos críticos ---
# Descubrimos los PIDs al vuelo vía pid-discovery (wmic/ps + netstat).
# NO leemos archivos .pid: eran la causa raíz del deadlock de restart —
# si el archivo existía con un PID muerto (watchdog respawneó, o el scan
# wmic del singleton tomaba 30s), el smoke detectaba procesos inexistentes
# y disparaba auto-rollback sobre un pipeline que SÍ estaba vivo.
log "=== SMOKE TEST ==="
log "1) Verificando procesos críticos..."

CRITICAL=("pulpo" "dashboard" "svc-telegram")
MAX_WAIT_SECONDS=60

# Node helper: descubre el PID de un componente y devuelve "OK <pid>" si está
# vivo, o un error. Usa pid-discovery.js (fuente de verdad = SO).
# require('./pid-discovery') se resuelve desde cwd para evitar problemas con
# paths Unix-style (/c/...) que Node en Windows no acepta.
check_component_ready() {
  local name="$1"
  ( cd "${PIPELINE_DIR}" && node -e "
    const { findPidByComponent, pidAlive, invalidateCache } = require('./pid-discovery');
    invalidateCache();
    const f = findPidByComponent('${name}');
    if (!f) { console.log('ausente'); process.exit(1); }
    if (!pidAlive(f.pid)) { console.log('muerto(' + f.pid + ')'); process.exit(1); }
    console.log('OK ' + f.pid);
  " 2>/dev/null )
}

waited=0
all_ok=0
pending=""
while [ "$waited" -lt "$MAX_WAIT_SECONDS" ]; do
  pending=""
  declare -a ok_states=()
  for name in "${CRITICAL[@]}"; do
    if state=$(check_component_ready "$name"); then
      ok_states+=("  ${name}: ${state}")
    else
      pending="${pending} ${name}:${state:-error}"
    fi
  done
  if [ -z "$pending" ]; then
    all_ok=1
    for line in "${ok_states[@]}"; do log "$line"; done
    break
  fi
  sleep 2
  waited=$((waited + 2))
done
if [ "$all_ok" != 1 ]; then
  fail "procesos críticos no ready tras ${MAX_WAIT_SECONDS}s:${pending}" 1
fi

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

# --- 4) JAVA_HOME resoluble desde el normalizer ---
# Incidente 2026-04-21: pulpo heredó JAVA_HOME apuntando a JBR de IntelliJ viejo
# y gradlew aborta antes de arrancar. El lib/java-home-normalizer corrige el
# env del pulpo; acá validamos que, corriendo desde el mismo entorno que el
# pulpo hereda, seguimos pudiendo resolver un Temurin 21 válido.
log "4) Verificando JAVA_HOME resoluble (lib/java-home-normalizer)..."
jh_probe=$(cd "${PIPELINE_DIR}" && node -e "
  const { normalizeJavaHome, isValidJavaHome } = require('./lib/java-home-normalizer');
  const r = normalizeJavaHome();
  if (!isValidJavaHome(r.current)) {
    console.log('NO-TEMURIN');
    process.exit(1);
  }
  console.log(r.current);
" 2>&1)
if [ $? -ne 0 ] || [ -z "$jh_probe" ] || [ "$jh_probe" = "NO-TEMURIN" ]; then
  log "  WARN no se pudo resolver Temurin 21 vía normalizer: ${jh_probe}"
  # No falla el smoke (puede tener un JAVA_HOME válido externo), solo advierte.
else
  log "  OK JAVA_HOME resoluble: ${jh_probe}"
fi

log "=== SMOKE TEST OK ==="
exit 0
