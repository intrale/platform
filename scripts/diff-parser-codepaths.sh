#!/usr/bin/env bash
# =============================================================================
# diff-parser-codepaths.sh — Comparador de paridad entre legacy y generalized
# parser de errores in-flight (#3576 CA-9, refinación R3 guru ratificada por PO).
#
# Lee el log textual del pulpo (`.pipeline/logs/pulpo-YYYY-MM-DD.log` o un
# archivo pasado como argumento) y compara los discriminadores 🛡️ (legacy)
# vs 🆕 (generalized) emitidos por el wire del CA-3.
#
# Output esperado para avanzar entre olas: "0 mismatches" (mismo error_class
# para el mismo skill+provider en ambos paths durante la ventana). Cualquier
# valor > 0 requiere investigación manual antes de avanzar.
#
# USO
# ---
#   ./scripts/diff-parser-codepaths.sh                          # log de hoy
#   ./scripts/diff-parser-codepaths.sh path/to/pulpo.log       # archivo específico
#   ./scripts/diff-parser-codepaths.sh path/to/pulpo.log -v    # muestra cada par
#
# Salida (stdout): tabla resumen + conteo final.
# Exit code:  0 si paridad OK (0 mismatches), 1 si hay mismatches.
# =============================================================================
set -euo pipefail

LOG_FILE="${1:-.pipeline/logs/pulpo-$(date -u +%Y-%m-%d).log}"
VERBOSE="${2:-}"

if [[ ! -f "$LOG_FILE" ]]; then
    echo "ERROR: no encontré el log en $LOG_FILE" >&2
    echo "Pasalo como primer argumento o asegurate que el pulpo escribió el día." >&2
    exit 2
fi

# Las líneas tienen shape:
#   ... [lanzamiento] 🛡️ codepath=legacy skill=guru provider=anthropic error_class=quota_exhausted matched=true
#   ... [lanzamiento] 🆕 codepath=generalized skill=guru provider=anthropic error_class=quota_exhausted flag_set=true decision=flag_set
#
# Extraemos (codepath, skill, provider, error_class) para cada línea y los
# emparejamos por (skill, provider) en orden de aparición. Asume que para el
# mismo spawn el legacy y el generalized se loggean en el mismo bloque
# (mismo skill+provider, líneas adyacentes durante el rollout dual).

LEGACY_LINES=$(grep -E 'codepath=legacy' "$LOG_FILE" || true)
GENERALIZED_LINES=$(grep -E 'codepath=generalized' "$LOG_FILE" || true)

# count_lines — cuenta líneas no vacías. `echo "$VAR" | grep -c '^'` cuenta
# 1 cuando VAR está vacío (echo emite un newline), por eso usamos printf y
# guard explícito.
count_lines() {
    if [[ -z "${1:-}" ]]; then echo 0; else printf '%s\n' "$1" | grep -c '^'; fi
}

LEGACY_COUNT=$(count_lines "$LEGACY_LINES")
GENERALIZED_COUNT=$(count_lines "$GENERALIZED_LINES")

# Detectamos pares (skill, provider) con su error_class en cada codepath.
# Si un par aparece solo en un codepath durante la ventana de rollout, es
# un mismatch silencioso — lo logueamos para que el operador investigue.
extract_tuple() {
    # Output: skill|provider|error_class
    # Usamos awk en vez de sed para que los emojis multi-byte del prefijo
    # (🛡️ / 🆕) no confundan al motor de regex POSIX en mintty/Git Bash.
    awk 'BEGIN { FS="[ ]+" } {
        skill=""; provider=""; ec=""
        for (i = 1; i <= NF; i++) {
            if ($i ~ /^skill=/)        { skill    = substr($i, 7) }
            else if ($i ~ /^provider=/) { provider = substr($i, 10) }
            else if ($i ~ /^error_class=/) { ec   = substr($i, 13) }
        }
        if (skill != "" && provider != "" && ec != "") {
            print skill "|" provider "|" ec
        }
    }'
}

LEGACY_TUPLES=$(echo "$LEGACY_LINES" | extract_tuple | sort)
GENERALIZED_TUPLES=$(echo "$GENERALIZED_LINES" | extract_tuple | sort)

# Mismatch = tuple presente en uno pero no en el otro.
ONLY_LEGACY=$(comm -23 <(echo "$LEGACY_TUPLES") <(echo "$GENERALIZED_TUPLES"))
ONLY_GENERALIZED=$(comm -13 <(echo "$LEGACY_TUPLES") <(echo "$GENERALIZED_TUPLES"))

ONLY_LEGACY_COUNT=$(count_lines "$ONLY_LEGACY")
ONLY_GENERALIZED_COUNT=$(count_lines "$ONLY_GENERALIZED")
MISMATCH_COUNT=$((ONLY_LEGACY_COUNT + ONLY_GENERALIZED_COUNT))

echo "=============================================================="
echo "diff-parser-codepaths.sh — paridad #3576"
echo "Log: $LOG_FILE"
echo "=============================================================="
echo "Líneas codepath=legacy:      $LEGACY_COUNT"
echo "Líneas codepath=generalized: $GENERALIZED_COUNT"
echo "--------------------------------------------------------------"
echo "Tuplas solo en legacy:      $ONLY_LEGACY_COUNT"
echo "Tuplas solo en generalized: $ONLY_GENERALIZED_COUNT"
echo "Mismatches totales:         $MISMATCH_COUNT"
echo "=============================================================="

if [[ -n "$VERBOSE" && "$VERBOSE" == "-v" ]]; then
    if [[ "$ONLY_LEGACY_COUNT" -gt 0 ]]; then
        echo "Tuplas SOLO en legacy:"
        echo "$ONLY_LEGACY"
    fi
    if [[ "$ONLY_GENERALIZED_COUNT" -gt 0 ]]; then
        echo "Tuplas SOLO en generalized:"
        echo "$ONLY_GENERALIZED"
    fi
fi

if [[ "$MISMATCH_COUNT" -eq 0 ]]; then
    echo "PARIDAD OK — 0 mismatches. Avanzar a la siguiente ola es seguro."
    exit 0
else
    echo "PARIDAD FALLIDA — $MISMATCH_COUNT mismatches. Investigar antes de avanzar."
    echo "Sugerencia: re-ejecutar con flag -v para ver los pares concretos."
    exit 1
fi
