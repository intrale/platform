#!/usr/bin/env bash
# Uso: web-dev-run.sh
# Levanta el target Wasm en modo development con webpack-dev-server.
# Reemplaza la invocacion repetitiva del Paso 6 del SKILL del agente /web-dev
# (probar localmente en el navegador).

set -uo pipefail

export JAVA_HOME="${JAVA_HOME:-/c/Users/Administrator/.jdks/temurin-21.0.7}"

cd "$(dirname "$0")/../.."

echo "Levantando dev server Wasm en http://localhost:8080 (Ctrl+C para detener)"
echo "----"
exec ./gradlew :app:composeApp:wasmJsBrowserDevelopmentRun --no-daemon
