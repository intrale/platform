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

# --- Resolución del directorio de RUNTIME del pipeline ---
# El estado vivo del pipeline (last-restart.json, ready markers, colas) vive en
# el checkout CANÓNICO desde el que corre la infra, no en cada copia del código.
# En producción el smoke test corre desde ese checkout y PIPELINE_DIR ya es
# correcto. Cuando corre desde un worktree de agente (self-check de pipeline-dev)
# el worktree sólo tiene el CÓDIGO: el estado runtime no existe ahí. Resolvemos
# el .pipeline canónico para chequear el pipeline realmente vivo, sin alterar el
# path de producción (fast-path sin git cuando el marker local existe).
resolve_runtime_dir() {
  # 1) Override explícito (operación manual / tests).
  if [ -n "${PIPELINE_RUNTIME_DIR:-}" ]; then
    echo "${PIPELINE_RUNTIME_DIR}"
    return 0
  fi
  # 2) Producción / checkout canónico: el marker de runtime está presente. Sin git.
  if [ -f "${PIPELINE_DIR}/last-restart.json" ]; then
    echo "${PIPELINE_DIR}"
    return 0
  fi
  # 3) Worktree de agente: resolver el .pipeline del checkout principal vía git.
  local common_dir main_root
  common_dir="$(cd "${PIPELINE_DIR}" && git rev-parse --git-common-dir 2>/dev/null)" || common_dir=""
  if [ -n "$common_dir" ]; then
    case "$common_dir" in
      /*|[A-Za-z]:*) : ;;                          # ya absoluto
      *) common_dir="${PIPELINE_DIR}/${common_dir}" ;;
    esac
    main_root="$(cd "$(dirname "$common_dir")" 2>/dev/null && pwd)" || main_root=""
    if [ -n "$main_root" ] && [ -d "${main_root}/.pipeline" ]; then
      echo "${main_root}/.pipeline"
      return 0
    fi
  fi
  # 4) Fallback: el propio directorio (comportamiento previo).
  echo "${PIPELINE_DIR}"
}

RUNTIME_DIR="$(resolve_runtime_dir)"

# Evidencia a stderr desde el vamos, independiente de tee/LOG_FILE.
# Si el smoke test falla antes del primer log() (tee roto, CWD raro),
# restart.js captura esto via spawnSync result.stderr.
echo "[smoke-test] inicio pid=$$ pipeline_dir=${PIPELINE_DIR} runtime_dir=${RUNTIME_DIR}" >&2

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

# last-restart.json debe existir y ser reciente (< 5 min).
# Se resuelve contra el runtime CANÓNICO (ver resolve_runtime_dir): desde un
# worktree de agente el estado vivo no está en la copia local del código.
LAST_RESTART="${RUNTIME_DIR}/last-restart.json"
if [ ! -f "$LAST_RESTART" ]; then
  fail "last-restart.json ausente (runtime_dir=${RUNTIME_DIR})" 3
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

# Archivos de commander/trabajando huérfanos (>10 min) — runtime canónico.
ORPHAN_DIR="${RUNTIME_DIR}/servicios/commander/trabajando"
if [ -d "$ORPHAN_DIR" ]; then
  orphan_count=$(find "$ORPHAN_DIR" -name "*.json" -type f 2>/dev/null | wc -l | tr -d '[:space:]')
  if [ "${orphan_count:-0}" -gt 0 ]; then
    log "  WARN ${orphan_count} mensajes en commander/trabajando/ (esperado 0 post-restart)"
  fi
fi

log "=== SMOKE TEST OK ==="
exit 0
