#!/usr/bin/env bash
# Lanza la app apuntando al backend local.
# Uso:
#   ./scripts/local-app.sh              → Desktop (JVM)
#   ./scripts/local-app.sh desktop      → Desktop (JVM)
#   ./scripts/local-app.sh android      → Android (emulador)
#   ./scripts/local-app.sh wasm         → Web (Wasm)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

TARGET="${1:-desktop}"

# JAVA_HOME
if [ -d "/c/Users/Administrator/.jdks/temurin-21.0.7" ]; then
  export JAVA_HOME="/c/Users/Administrator/.jdks/temurin-21.0.7"
fi

case "$TARGET" in
  desktop|jvm)
    echo "=== Lanzando app Desktop (JVM) → http://localhost:8080/ ==="
    exec ./gradlew :app:composeApp:run -PLOCAL_BASE_URL=http://localhost:8080/
    ;;

  android)
    echo "=== Instalando app Android → http://10.0.2.2:8080/ ==="
    echo "(Requiere emulador corriendo)"
    exec ./gradlew :app:composeApp:installClientDebug -PLOCAL_BASE_URL=http://10.0.2.2:8080/
    ;;

  wasm|web)
    echo "=== Lanzando app Web (Wasm) → http://localhost:8080/ ==="
    exec ./gradlew :app:composeApp:wasmJsBrowserDevelopmentRun -PLOCAL_BASE_URL=http://localhost:8080/
    ;;

  *)
    echo "Uso: $0 [desktop|android|wasm]"
    echo ""
    echo "  desktop  App Desktop JVM (default)"
    echo "  android  Instala APK en emulador Android"
    echo "  wasm     App Web en navegador"
    exit 1
    ;;
esac
