#!/usr/bin/env bash
# rollback.sh — Rollback de emergencia del pipeline V2
#
# Diseño: bash puro, ejecutable aunque el pipeline esté muerto o corrupto.
# Requisitos mínimos: bash, git, node.
# NO depende de ningún script .js del pipeline.
#
# Flujo:
#   1. Mata todo proceso del pipeline (wmic/ps)
#   2. git fetch origin pipeline-stable
#   3. git reset --hard pipeline-stable (solo .pipeline/* y roles/*)
#   4. Relanza el pipeline con node restart.js
#
# Uso:
#   bash .pipeline/rollback.sh             → rollback a pipeline-stable
#   bash .pipeline/rollback.sh <sha|tag>   → rollback a commit específico

set -u

PIPELINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${PIPELINE_DIR}/.." && pwd)"
TARGET="${1:-pipeline-stable}"
LOG_FILE="${PIPELINE_DIR}/logs/rollback.log"
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

log "=== ROLLBACK a ${TARGET} ==="

# --- 1) Matar pipeline ---
# taskkill //T es tree-kill: si matamos al restart.js padre se lleva
# puesto a este bash y el rollback muere mid-ejecución. El parent ideal
# nos pasa su PID en PARENT_RESTART_PID; si no lo hace (restart.js
# pre-#2361) caemos a $PPID (el bash siempre tiene el node padre ahí).
PARENT_RESTART_PID="${PARENT_RESTART_PID:-${PPID:-0}}"
MY_PID=$$
# Escribo también a stderr para dejar evidencia aunque tee falle
echo "[rollback] parent=${PARENT_RESTART_PID} self=${MY_PID}" >&2
log "1) Matando procesos del pipeline (skip parent=${PARENT_RESTART_PID}, self=${MY_PID})..."

# Descubrimos los PIDs del pipeline vía pid-discovery.js (OS como fuente
# de verdad, shell:true + cmd.exe para que el filtro de wmic sobreviva).
# Fallback: wmic directo (bash históricamente preserva el quoting, pero
# algunos shells lo cortan — por eso preferimos delegar a node).
PIDS_RAW=""
if command -v node &>/dev/null && [ -f "${PIPELINE_DIR}/pid-discovery.js" ]; then
  PIDS_RAW="$(node -e "
    const d = require('${PIPELINE_DIR}/pid-discovery.js');
    for (const p of d.scanNodeProcesses()) {
      if (p.commandLine && p.commandLine.includes('.pipeline')) console.log(p.pid);
    }
  " 2>/dev/null || true)"
fi

if [ -n "$PIDS_RAW" ]; then
  printf '%s\n' "$PIDS_RAW" | while read -r pid; do
    if [ -z "$pid" ]; then continue; fi
    if [ "$pid" = "$PARENT_RESTART_PID" ]; then
      log "  Skip PID $pid (parent restart.js)"
      continue
    fi
    if [ "$pid" = "$MY_PID" ]; then continue; fi
    taskkill //PID "$pid" //F //T 2>/dev/null && log "  Killed PID $pid"
  done || true
elif command -v pgrep &>/dev/null; then
  pgrep -f '\.pipeline' 2>/dev/null | while read -r pid; do
    if [ -z "$pid" ]; then continue; fi
    if [ "$pid" = "$PARENT_RESTART_PID" ] || [ "$pid" = "$MY_PID" ]; then continue; fi
    kill -9 "$pid" 2>/dev/null && log "  Killed PID $pid"
  done || true
else
  log "  WARN: sin node ni pgrep — no puedo matar procesos del pipeline"
fi

# Limpiar PIDs
for pid_file in "${PIPELINE_DIR}"/*.pid; do
  [ -f "$pid_file" ] && rm -f "$pid_file"
done

sleep 2

# --- 2) Verificar target existe ---
log "2) Verificando target ${TARGET}..."
cd "$ROOT" || fail "No se pudo entrar a $ROOT" 2

if ! git rev-parse --verify "$TARGET" &>/dev/null; then
  log "  Target local no existe, haciendo fetch..."
  git fetch origin "refs/tags/${TARGET}:refs/tags/${TARGET}" 2>/dev/null \
    || git fetch origin "${TARGET}" 2>/dev/null \
    || fail "No se pudo fetch ${TARGET}" 2
fi

TARGET_SHA="$(git rev-parse "${TARGET}")"
log "  Target SHA: ${TARGET_SHA}"

# --- 3) Reset quirúrgico: solo .pipeline/ (incluye .pipeline/roles/) ---
log "3) Revirtiendo .pipeline/ al target..."
git checkout "${TARGET}" -- .pipeline/ 2>/dev/null \
  || fail "git checkout falló" 3

# --- 4) Relanzar ---
log "4) Relanzando pipeline..."
cd "$ROOT" || fail "No se pudo entrar a $ROOT" 4
node "${PIPELINE_DIR}/restart.js" --no-smoke-test 2>&1 | tee -a "$LOG_FILE"
restart_rc=${PIPESTATUS[0]}

if [ "$restart_rc" -ne 0 ]; then
  fail "restart.js retornó ${restart_rc}" 4
fi

log "=== ROLLBACK COMPLETADO ==="
log "Pipeline restaurado a ${TARGET} (${TARGET_SHA:0:8})"
exit 0
