#!/bin/bash
# El Centinela -- Activity Logger Hook
# Se ejecuta como PostToolUse hook, registra actividad en activity-log.jsonl
# Compatible con Windows (Git Bash) — sin dependencia de jq

LOG_FILE="$(git rev-parse --show-toplevel 2>/dev/null)/.claude/activity-log.jsonl"
MAX_LINES=500

# Leer JSON del stdin (protocolo PostToolUse de Claude Code)
INPUT=$(cat)

# Extraer tool_name del JSON usando bash string manipulation
# El input tiene formato: {"session_id":"...","tool_name":"...","tool_input":{...},...}
tool_name=""
target=""

# Extraer tool_name
if [[ "$INPUT" == *'"tool_name"'* ]]; then
    # Extraer el valor despues de "tool_name":"
    temp="${INPUT#*\"tool_name\"}"
    temp="${temp#*:}"
    temp="${temp#*\"}"
    tool_name="${temp%%\"*}"
fi

# Si no se pudo extraer tool_name, salir silenciosamente
if [[ -z "$tool_name" ]]; then
    exit 0
fi

# Ignorar herramientas de solo lectura que generan mucho ruido
case "$tool_name" in
    TaskList|TaskGet|Read|Glob|Grep)
        exit 0
        ;;
esac

# Extraer target segun el tipo de herramienta
case "$tool_name" in
    Edit|Write|NotebookEdit)
        # Extraer file_path o notebook_path
        if [[ "$INPUT" == *'"file_path"'* ]]; then
            temp="${INPUT#*\"file_path\"}"
            temp="${temp#*:}"
            temp="${temp#*\"}"
            target="${temp%%\"*}"
        elif [[ "$INPUT" == *'"notebook_path"'* ]]; then
            temp="${INPUT#*\"notebook_path\"}"
            temp="${temp#*:}"
            temp="${temp#*\"}"
            target="${temp%%\"*}"
        fi
        ;;
    Bash)
        # Extraer command (primeros 80 chars)
        if [[ "$INPUT" == *'"command"'* ]]; then
            temp="${INPUT#*\"command\"}"
            temp="${temp#*:}"
            temp="${temp#*\"}"
            target="${temp%%\"*}"
            # Truncar a 80 caracteres
            if [[ ${#target} -gt 80 ]]; then
                target="${target:0:80}..."
            fi
        fi
        ;;
    Task)
        # Extraer description
        if [[ "$INPUT" == *'"description"'* ]]; then
            temp="${INPUT#*\"description\"}"
            temp="${temp#*:}"
            temp="${temp#*\"}"
            target="${temp%%\"*}"
        fi
        ;;
    TaskCreate|TaskUpdate)
        # Extraer subject o taskId
        if [[ "$INPUT" == *'"subject"'* ]]; then
            temp="${INPUT#*\"subject\"}"
            temp="${temp#*:}"
            temp="${temp#*\"}"
            target="${temp%%\"*}"
        elif [[ "$INPUT" == *'"taskId"'* ]]; then
            temp="${INPUT#*\"taskId\"}"
            temp="${temp#*:}"
            temp="${temp#*\"}"
            target="task #${temp%%\"*}"
        fi
        ;;
    WebFetch|WebSearch)
        if [[ "$INPUT" == *'"url"'* ]]; then
            temp="${INPUT#*\"url\"}"
            temp="${temp#*:}"
            temp="${temp#*\"}"
            target="${temp%%\"*}"
        elif [[ "$INPUT" == *'"query"'* ]]; then
            temp="${INPUT#*\"query\"}"
            temp="${temp#*:}"
            temp="${temp#*\"}"
            target="${temp%%\"*}"
        fi
        ;;
    *)
        target="--"
        ;;
esac

# Sanitizar target para JSON (escapar comillas y backslashes)
target="${target//\\/\\\\}"
target="${target//\"/\\\"}"

# Timestamp ISO 8601
timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%S")

# Escribir entrada JSONL
mkdir -p "$(dirname "$LOG_FILE")"
echo "{\"ts\":\"$timestamp\",\"tool\":\"$tool_name\",\"target\":\"$target\"}" >> "$LOG_FILE"

# Rotacion: si supera MAX_LINES, mantener las ultimas MAX_LINES/2
if [[ -f "$LOG_FILE" ]]; then
    line_count=$(wc -l < "$LOG_FILE" 2>/dev/null)
    if [[ "$line_count" -gt "$MAX_LINES" ]]; then
        keep=$((MAX_LINES / 2))
        tail -n "$keep" "$LOG_FILE" > "${LOG_FILE}.tmp" 2>/dev/null && mv "${LOG_FILE}.tmp" "$LOG_FILE"
    fi
fi

exit 0
