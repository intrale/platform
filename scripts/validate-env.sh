#!/usr/bin/env bash
# Verifica que el entorno local tenga todos los prerequisitos para levantar el ambiente.
# Uso: ./scripts/validate-env.sh
# Salida: 0 si todo está OK, 1 si hay algún prerequisito faltante o inválido.
set -uo pipefail

ERRORS=0
WARNINGS=0

pass() { echo "  [OK]  $1"; }
fail() { echo "  [ERR] $1"; ERRORS=$((ERRORS + 1)); }
warn() { echo "  [WARN] $1"; WARNINGS=$((WARNINGS + 1)); }
section() { echo ""; echo "=== $1 ==="; }

# ── 1. Java 21 ────────────────────────────────────────────
section "Java"

# Detectar java en PATH o JAVA_HOME
JAVA_BIN=""
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
  JAVA_BIN="$JAVA_HOME/bin/java"
elif command -v java &>/dev/null; then
  JAVA_BIN="$(command -v java)"
fi

if [ -z "$JAVA_BIN" ]; then
  fail "Java no encontrado (ni en PATH ni en JAVA_HOME)"
  echo "       Instala Temurin 21: https://adoptium.net/"
else
  JAVA_VERSION=$("$JAVA_BIN" -version 2>&1 | head -1 | sed 's/.*version "\([^"]*\)".*/\1/')
  JAVA_MAJOR=$(echo "$JAVA_VERSION" | sed 's/^\([0-9]*\).*/\1/')
  if [ "$JAVA_MAJOR" = "21" ]; then
    pass "Java $JAVA_VERSION encontrado en $JAVA_BIN"
  else
    fail "Se requiere Java 21, encontrado: $JAVA_VERSION (en $JAVA_BIN)"
    echo "       Instala Temurin 21: https://adoptium.net/"
    echo "       O setea JAVA_HOME apuntando a un JDK 21"
  fi
fi

# ── 2. Docker daemon ──────────────────────────────────────
section "Docker"

if ! command -v docker &>/dev/null; then
  fail "'docker' no encontrado en PATH"
  echo "       Instala Docker Desktop: https://www.docker.com/products/docker-desktop/"
else
  DOCKER_VERSION=$(docker --version 2>/dev/null | sed 's/Docker version //')
  if docker info &>/dev/null; then
    pass "Docker $DOCKER_VERSION — daemon activo"
  else
    fail "Docker está instalado ($DOCKER_VERSION) pero el daemon no está corriendo"
    echo "       Abrí Docker Desktop y esperá a que arranque."
  fi
fi

# ── 3. ADB ────────────────────────────────────────────────
section "Android (ADB)"

if ! command -v adb &>/dev/null; then
  warn "adb no encontrado en PATH (requerido solo para pruebas Android)"
  echo "       Instala Android SDK Platform-Tools o Android Studio."
  echo "       Agrega \$ANDROID_HOME/platform-tools al PATH."
else
  ADB_VERSION=$(adb version 2>/dev/null | head -1)
  pass "$ADB_VERSION"

  # Verificar que adb server está activo
  if ! adb devices &>/dev/null; then
    warn "adb encontrado pero el servidor no responde — intentá 'adb start-server'"
  fi
fi

# ── 4. Emulador AVD ───────────────────────────────────────
section "Android AVD (emulador)"

EMULATOR_BIN=""
if command -v emulator &>/dev/null; then
  EMULATOR_BIN="$(command -v emulator)"
elif [ -n "${ANDROID_HOME:-}" ] && [ -x "$ANDROID_HOME/emulator/emulator" ]; then
  EMULATOR_BIN="$ANDROID_HOME/emulator/emulator"
fi

if [ -z "$EMULATOR_BIN" ]; then
  warn "emulator no encontrado (requerido solo para pruebas Android)"
  echo "       Instala Android SDK Emulator desde Android Studio > SDK Manager."
else
  AVD_LIST=$("$EMULATOR_BIN" -list-avds 2>/dev/null || true)
  if [ -z "$AVD_LIST" ]; then
    warn "No se encontraron AVDs configurados"
    echo "       Creá un AVD desde Android Studio > Device Manager."
    echo "       Recomendado: Pixel 6, API 34 (Android 14), nombre 'virtualAndroid'"
  else
    AVD_COUNT=$(echo "$AVD_LIST" | grep -c . || true)
    pass "$AVD_COUNT AVD(s) encontrado(s):"
    echo "$AVD_LIST" | while read -r avd; do echo "         • $avd"; done

    # Avisar si no existe el AVD canónico del proyecto
    if ! echo "$AVD_LIST" | grep -q "virtualAndroid"; then
      warn "AVD 'virtualAndroid' no encontrado (nombre canónico del proyecto)"
      echo "       El script qa-android.sh y local-app.sh buscan este AVD por defecto."
    fi
  fi
fi

# ── Resumen ───────────────────────────────────────────────
echo ""
echo "======================================="
if [ $ERRORS -gt 0 ]; then
  echo "RESULTADO: $ERRORS error(es) crítico(s), $WARNINGS advertencia(s)"
  echo "Corregí los errores antes de levantar el ambiente local."
  echo "Consultá docs/entorno-local.md para guía de troubleshooting."
  exit 1
elif [ $WARNINGS -gt 0 ]; then
  echo "RESULTADO: OK con $WARNINGS advertencia(s)"
  echo "El ambiente puede levantarse, pero algunas funciones Android no estarán disponibles."
  exit 0
else
  echo "RESULTADO: Todo OK — el ambiente está listo"
  exit 0
fi
