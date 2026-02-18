#!/bin/bash
# Hook PostToolUse: detecta git push y lanza monitoreo CI en background

INPUT=$(cat)

# Solo actuar si fue una llamada al tool Bash
TOOL=$(echo "$INPUT" | grep -o '"tool_name":"[^"]*"' | cut -d'"' -f4)
if [ "$TOOL" != "Bash" ]; then
    exit 0
fi

# Verificar si el comando fue un git push
COMMAND=$(echo "$INPUT" | grep -o '"command":"[^"]*"' | head -1 | cut -d'"' -f4)
if ! echo "$COMMAND" | grep -q "git push"; then
    exit 0
fi

# Asegurarse de que no fue un push fallido (no hay "error" ni "rejected" en el output)
OUTPUT=$(echo "$INPUT" | grep -o '"stdout":"[^"]*"' | head -1)
ERROR=$(echo "$INPUT" | grep -o '"stderr":"[^"]*"' | head -1)
if echo "$ERROR" | grep -qiE 'error|rejected|denied|failed'; then
    exit 0
fi

# Obtener el SHA del commit pusheado
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/c/Workspaces/Intrale/platform}"
SHA=$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null)
if [ -z "$SHA" ]; then
    exit 0
fi

# Lanzar monitoreo CI en background (no bloquea el hook)
nohup bash "$PROJECT_DIR/.claude/hooks/ci-monitor.sh" "$SHA" "$PROJECT_DIR" > /tmp/ci-monitor-$$.log 2>&1 &

exit 0
