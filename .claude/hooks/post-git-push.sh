#!/bin/bash
# Hook PostToolUse[Bash]: detecta git push y lanza monitoreo CI en background
# Matcher: Bash — solo se ejecuta despues de comandos Bash

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/c/Workspaces/Intrale/platform}"

# Parsear JSON con node para extraer command y verificar errores
SHOULD_MONITOR=$(cat | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
    try {
        const data = JSON.parse(input);
        const command = (data.tool_input && data.tool_input.command) || "";
        if (!command.includes("git push")) process.exit(1);

        // Verificar que no hubo error en stderr
        const stderr = (data.tool_result && data.tool_result.stderr) || "";
        if (/error|rejected|denied|failed/i.test(stderr)) process.exit(1);

        // OK para monitorear
        process.exit(0);
    } catch(e) {
        process.exit(1);
    }
});
' 2>/dev/null)

if [ $? -ne 0 ]; then
    exit 0
fi

# Obtener el SHA del commit pusheado
SHA=$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null)
if [ -z "$SHA" ]; then
    exit 0
fi

# Lanzar monitoreo CI en background (no bloquea el hook)
nohup bash "$PROJECT_DIR/.claude/hooks/ci-monitor.sh" "$SHA" "$PROJECT_DIR" > /dev/null 2>&1 &

exit 0
