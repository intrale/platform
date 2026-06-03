#!/usr/bin/env bash
# =============================================================================
# manage-providers.sh — CLI operacional del kill-switch por provider (#3811)
#
# Apaga/enciende providers de IA por terminal, sin tocar archivos JSON a mano
# ni pasar por Telegram/LLM. Fuente de verdad: lib/provider-disabled.js (mismo
# módulo que usa el dashboard).
#
# USO:
#   ./manage-providers.sh disable <provider> [--ttl 20m]
#   ./manage-providers.sh enable  <provider>
#   ./manage-providers.sh list
#   ./manage-providers.sh clear-all
#
# Providers válidos: anthropic, openai-codex, gemini-google, cerebras, nvidia-nim
#
# TTL: acepta sufijos s|m|h|d (ej. 20m, 2h, 90s). Default 20m. `--ttl never`
#      = apagado permanente (hasta `enable` o `clear-all`).
#
# Ejemplos:
#   ./manage-providers.sh disable anthropic              # apaga 20min
#   ./manage-providers.sh disable anthropic --ttl 2h     # apaga 2 horas
#   ./manage-providers.sh disable cerebras --ttl never   # apaga permanente
#   ./manage-providers.sh enable anthropic               # re-habilita
#   ./manage-providers.sh list                           # estado + TTL restante
#   ./manage-providers.sh clear-all                      # re-habilita todo
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIPELINE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
MODULE="${PIPELINE_DIR}/lib/provider-disabled.js"

if [[ ! -f "${MODULE}" ]]; then
    echo "ERROR: no encuentro lib/provider-disabled.js en ${PIPELINE_DIR}" >&2
    exit 1
fi

usage() {
    sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

# Convierte una duración con sufijo (20m, 2h, 90s, 1d) a milisegundos.
# Imprime "null" para "never". Sale con error si el formato es inválido.
parse_ttl_ms() {
    local raw="$1"
    if [[ "${raw}" == "never" ]]; then
        echo "null"
        return 0
    fi
    if [[ ! "${raw}" =~ ^([0-9]+)([smhd])$ ]]; then
        echo "ERROR: --ttl inválido: '${raw}'. Formato: <número><s|m|h|d> o 'never'." >&2
        exit 2
    fi
    local num="${BASH_REMATCH[1]}"
    local unit="${BASH_REMATCH[2]}"
    local mult
    case "${unit}" in
        s) mult=1000 ;;
        m) mult=60000 ;;
        h) mult=3600000 ;;
        d) mult=86400000 ;;
    esac
    echo "$(( num * mult ))"
}

# Invoca el módulo Node con una función y argumentos. Toda la lógica de
# validación de provider / persistencia / TTL vive en el módulo.
run_node() {
    PIPELINE_DIR_OVERRIDE="${PIPELINE_DIR}" node "$@"
}

cmd="${1:-}"; shift || true

case "${cmd}" in
    disable)
        provider="${1:-}"; shift || true
        ttl_arg="20m"
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --ttl) ttl_arg="${2:-}"; shift 2 ;;
                *) echo "ERROR: argumento desconocido: $1" >&2; exit 2 ;;
            esac
        done
        if [[ -z "${provider}" ]]; then echo "ERROR: falta <provider>." >&2; usage 2; fi
        ttl_ms="$(parse_ttl_ms "${ttl_arg}")"
        run_node -e '
            const m = require(process.env.PIPELINE_DIR_OVERRIDE + "/lib/provider-disabled");
            const [, provider, ttlRaw] = process.argv;
            const ttlMs = ttlRaw === "null" ? null : Number(ttlRaw);
            const r = m.setProviderDisabled(provider, { ttlMs, source: "cli" });
            if (!r.ok) { console.error("ERROR: " + r.error); process.exit(1); }
            const ttlTxt = r.ttl_ms == null ? "permanente" : (r.ttl_ms / 60000) + "min";
            console.log("APAGADO: " + provider + " (ttl=" + ttlTxt + ")");
        ' "${provider}" "${ttl_ms}"
        ;;
    enable)
        provider="${1:-}"
        if [[ -z "${provider}" ]]; then echo "ERROR: falta <provider>." >&2; usage 2; fi
        run_node -e '
            const m = require(process.env.PIPELINE_DIR_OVERRIDE + "/lib/provider-disabled");
            const provider = process.argv[1];
            if (!m.isValidProvider(provider)) {
                console.error("ERROR: provider inválido: " + provider + ". Válidos: " + m.VALID_PROVIDERS.join(", "));
                process.exit(1);
            }
            const changed = m.clearProviderDisabled(provider, { source: "cli" });
            console.log(changed ? ("ENCENDIDO: " + provider) : (provider + " ya estaba encendido."));
        ' "${provider}"
        ;;
    list)
        run_node -e '
            const m = require(process.env.PIPELINE_DIR_OVERRIDE + "/lib/provider-disabled");
            const { disabled } = m.listDisabledProviders();
            if (disabled.length === 0) { console.log("Todos los providers ENCENDIDOS."); process.exit(0); }
            console.log("Providers APAGADOS:");
            for (const e of disabled) {
                const ttl = e.ttl_remaining_ms == null
                    ? "permanente"
                    : Math.ceil(e.ttl_remaining_ms / 60000) + "min restantes";
                console.log("  - " + e.name + " (" + ttl + ", desde " + e.disabled_at + ")");
            }
        '
        ;;
    clear-all)
        run_node -e '
            const m = require(process.env.PIPELINE_DIR_OVERRIDE + "/lib/provider-disabled");
            const changed = m.clearAll({ source: "cli" });
            console.log(changed ? "Todos los providers re-habilitados." : "No había providers apagados.");
        '
        ;;
    -h|--help|help|"")
        usage 0
        ;;
    *)
        echo "ERROR: comando desconocido: ${cmd}" >&2
        usage 2
        ;;
esac
