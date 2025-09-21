#!/usr/bin/env bash
set -euo pipefail

# 📦 Instalando Android SDK...
echo "📦 Instalando Android SDK..."

# ===== Config preservando tus valores por defecto =====
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/workspace/android-sdk}"
ANDROID_HOME="$ANDROID_SDK_ROOT"
ANDROID_API="${ANDROID_API:-34}"
BUILD_TOOLS="${BUILD_TOOLS:-34.0.0}"
MARKER="$ANDROID_SDK_ROOT/.installed-${ANDROID_API}-${BUILD_TOOLS}"
CMDLINE_DIR="$ANDROID_SDK_ROOT/cmdline-tools/latest"
CMDLINE_ZIP_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"

# ===== Helper de retries =====
retry() {
  local tries=${2:-5} wait=${3:-3} n=1
  until eval "$1"; do
    if (( n >= tries )); then return 1; fi
    echo ">> Reintento $n/$tries en ${wait}s..."
    sleep "$wait"; ((n++))
  done
}

# ===== Fast-path para pruebas de token =====
if [[ "${SKIP_ANDROID_SDK:-0}" == "1" ]]; then
  echo ">> SKIP_ANDROID_SDK=1 → salto instalación de Android SDK."
  exit 0
fi

# ===== Preparar layout =====
mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools" "$ANDROID_SDK_ROOT/platform-tools"

# ===== Descargar cmdline-tools solo si falta =====
if [[ ! -x "$CMDLINE_DIR/bin/sdkmanager" ]]; then
  tmpzip="$ANDROID_SDK_ROOT/cmdline-tools/commandlinetools.zip"
  echo ">> Descargando commandline-tools..."
  retry "curl -fsSL -o \"$tmpzip\" \"$CMDLINE_ZIP_URL\"" 5 5

  echo ">> Descomprimiendo commandline-tools..."
  rm -rf "$CMDLINE_DIR" "$ANDROID_SDK_ROOT/cmdline-tools/tmp"
  mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools/tmp"
  unzip -q "$tmpzip" -d "$ANDROID_SDK_ROOT/cmdline-tools/tmp"
  rm -f "$tmpzip"

  # La zip trae 'cmdline-tools/'; renombramos a 'latest' de forma idempotente
  mv "$ANDROID_SDK_ROOT/cmdline-tools/tmp/cmdline-tools" "$CMDLINE_DIR"
  rm -rf "$ANDROID_SDK_ROOT/cmdline-tools/tmp"
fi

# ===== Export igual que tenías =====
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export ANDROID_SDK_ROOT="$ANDROID_SDK_ROOT"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# ===== Aceptar licencias sin prompts =====
echo ">> Aceptando licencias..."
yes | sdkmanager --sdk_root="$ANDROID_SDK_ROOT" --licenses >/dev/null || true

# ===== Paquetes requeridos (tus mismos defaults) =====
need=()
[[ -d "$ANDROID_SDK_ROOT/platform-tools" ]] || need+=("platform-tools")
[[ -d "$ANDROID_SDK_ROOT/platforms/android-${ANDROID_API}" ]] || need+=("platforms;android-${ANDROID_API}")
[[ -d "$ANDROID_SDK_ROOT/build-tools/${BUILD_TOOLS}" ]] || need+=("build-tools;${BUILD_TOOLS}")

if (( ${#need[@]} )); then
  echo ">> Instalando paquetes: ${need[*]}"
  # sdkmanager puede fallar por red → reintentar
  retry "sdkmanager --sdk_root=\"$ANDROID_SDK_ROOT\" ${need[*]@Q}" 3 10
else
  echo ">> Paquetes requeridos ya presentes."
fi

touch "$MARKER"
echo "✅ Android SDK instalado correctamente."

# ======= (Mantengo tu bloque original comentado) =======
#echo "🎨 Sincronizando íconos oficiales..."
#SCRIPT_DIR=\"\$(cd \"\$(dirname \"\$0\")\" && pwd)\"
#cd \"\$SCRIPT_DIR\"
#./gradlew :app:composeApp:syncBrandingIcons
