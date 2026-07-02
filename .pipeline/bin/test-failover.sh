#!/usr/bin/env bash
# =============================================================================
# test-failover.sh — Failover multi-provider reproducible (#4404 D5 · CA-E · RS-4)
#
# QUÉ HACE
#   Para cada skill target (backend-dev, pipeline-dev, android-dev):
#     1. Enmascara de forma REVERSIBLE la credencial del provider primario a
#        nivel de env del proceso hijo (nunca toca ~/.claude/secrets/credentials.json).
#     2. Corre la sonda `failover-probe.js`, que usa el resolver real
#        (resolveSpawnWithFallback) para verificar que el primario caído hace
#        saltar al FALLBACK DECLARADO en agent-models.json.
#     3. Loguea, con formato idéntico byte-a-byte en los 3 casos:
#          [<skill>] Failover <primario> → <fallback>  <timestamp ISO-8601>
#     4. Restaura la credencial del primario.
#
# CONTROLES DE SEGURIDAD (RS-4 — bloqueantes en verificación)
#   RS-4.1  Masking reversible, NUNCA borrado: sólo se toca la env var del hijo;
#           el archivo canónico de secrets jamás se modifica.
#   RS-4.2  Restauración garantizada ante crash: `trap` instalado ANTES del
#           primer masking; SIGINT/SIGTERM restauran vía cleanup y salen.
#   RS-4.3  Cero leakage: `set +x` alrededor de toda manipulación de credencial;
#           nunca se imprime el valor (ni parcial, ni longitud, ni hash).
#   RS-4.4  Evidencia sin secretos: la salida sólo contiene nombres de provider
#           y timestamps.
#
# ENTORNO: corre bajo Git Bash (Windows). `set -uo pipefail`, quoting defensivo.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$SCRIPT_DIR/failover-probe.js"

# Skills target del issue (CA-E.3): cadena declarada anthropic → openai-codex → …
SKILLS=("backend-dev" "pipeline-dev" "android-dev")

# Snapshot de las credenciales enmascaradas para restauración byte-a-byte.
declare -A ORIG_ENV     # valor original de la env var
declare -A WAS_SET      # "1" si la var estaba exportada originalmente, "0" si no
_CLEANED=0

# ── RS-4.2/RS-4.3: restauración idempotente, sin trace de credenciales ───────
cleanup() {
    set +x
    [[ "$_CLEANED" == "1" ]] && return
    _CLEANED=1
    if [[ ${#ORIG_ENV[@]} -gt 0 ]]; then
        for k in "${!ORIG_ENV[@]}"; do
            if [[ "${WAS_SET[$k]:-0}" == "1" ]]; then
                export "$k=${ORIG_ENV[$k]}"
            else
                unset "$k"
            fi
        done
    fi
    echo "[failover] trap: credenciales restauradas"
}
on_interrupt() { cleanup; exit 143; }

# RS-4.2: los traps se instalan ANTES de cualquier masking.
trap cleanup EXIT
trap on_interrupt INT TERM

# Enmascara UNA env var de credencial de forma reversible (RS-4.1/RS-4.3).
mask_var() {
    set +x
    local v="$1"
    if [[ -n "${!v+x}" ]]; then
        WAS_SET["$v"]=1
        ORIG_ENV["$v"]="${!v}"
    else
        WAS_SET["$v"]=0
        ORIG_ENV["$v"]=""
    fi
    export "$v="   # masking reversible — env del hijo, no el archivo canónico
}

# Restaura UNA env var enmascarada (para el siguiente caso).
unmask_var() {
    set +x
    local v="$1"
    if [[ "${WAS_SET[$v]:-0}" == "1" ]]; then
        export "$v=${ORIG_ENV[$v]}"
    else
        unset "$v"
    fi
    unset "ORIG_ENV[$v]" 2>/dev/null || true
    unset "WAS_SET[$v]" 2>/dev/null || true
}

rc_all=0
echo "[failover] === Failover multi-provider reproducible (#4404 D5) ==="

for SKILL in "${SKILLS[@]}"; do
    # Env vars de credencial del primario (sólo nombres, nunca valores).
    CREDENVS="$(node "$PROBE" credenv "$SKILL" 2>/dev/null || true)"
    for v in $CREDENVS; do
        mask_var "$v"
    done

    # Hook de test (RS-4.2): simula un crash mientras la credencial está
    # enmascarada para probar que el trap restaura igual. Sólo activo bajo test.
    if [[ "${FAILOVER_TEST_CRASH_AFTER_MASK:-0}" == "1" ]]; then
        echo "[$SKILL] (test) simulando crash con credencial enmascarada…"
        kill -TERM $$
        sleep 5   # da tiempo a que la señal actúe; no debería alcanzarse
    fi

    if OUT="$(node "$PROBE" resolve "$SKILL" 2>/dev/null)"; then
        IFS='|' read -r PRIMARY FALLBACK SOURCE MASKED GATE <<< "$OUT"
        ts="$(date +%Y-%m-%dT%H:%M:%S)"
        echo "[$SKILL] Failover ${PRIMARY} → ${FALLBACK}  ${ts}"
        if [[ -n "${GATE:-}" && "$GATE" != "n/a" ]]; then
            echo "[$SKILL] data-residency gate (fallback ${FALLBACK}): ${GATE}"
        fi
    else
        echo "[$SKILL] ✗ failover NO verificado (no saltó al fallback declarado)"
        rc_all=1
    fi

    # Restaurar credencial del primario para el siguiente caso.
    for v in $CREDENVS; do
        unmask_var "$v"
    done
    echo "[$SKILL] ✔ primario restaurado"
done

if [[ "$rc_all" == "0" ]]; then
    echo "[failover] === OK: 3/3 casos saltaron al fallback declarado ==="
else
    echo "[failover] === FALLÓ: al menos un caso no verificó el failover ==="
fi
exit "$rc_all"
