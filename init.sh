#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Instalando Android SDK...
echo "📦 Instalando Android SDK..."

ANDROID_SDK_ROOT="/workspace/android-sdk"
mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools"

cd "$ANDROID_SDK_ROOT/cmdline-tools"
curl -o commandlinetools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip -q commandlinetools.zip
rm commandlinetools.zip
mv cmdline-tools latest

export ANDROID_HOME="$ANDROID_SDK_ROOT"
export ANDROID_SDK_ROOT="$ANDROID_SDK_ROOT"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

yes | sdkmanager --licenses
yes | sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"

echo "✅ Android SDK instalado correctamente."

#echo "🎨 Sincronizando íconos oficiales..."
#SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
#cd "$SCRIPT_DIR"
#./gradlew :app:composeApp:syncBrandingIcons

# =========================
# 🔐 Validación de GITHUB_TOKEN (mínimo intrusivo)
# =========================
echo "🔐 Validando GITHUB_TOKEN..."

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "⚠️  GITHUB_TOKEN no está definido en el entorno."
  echo "   Exportalo antes de usar el agente:  export GITHUB_TOKEN=xxxxx"
else
  GH_ACCEPT_HEADER="Accept: application/vnd.github+json"
  GH_API_VERSION="X-GitHub-Api-Version: 2022-11-28"
  GH_ENDPOINT="https://api.github.com/user"

  gh_http_code() {
    local auth_header="$1"
    curl -s -o /dev/null -w "%{http_code}" \
      -H "$GH_ACCEPT_HEADER" \
      -H "$GH_API_VERSION" \
      -H "Authorization: $auth_header" \
      "$GH_ENDPOINT"
  }

  gh_echo_login() {
    local auth_header="$1"
    # No dependemos de jq
    local body
    body="$(curl -s -H "$GH_ACCEPT_HEADER" -H "$GH_API_VERSION" -H "Authorization: $auth_header" "$GH_ENDPOINT")"
    # Extrae "login":"usuario"
    local login
    login="$(printf '%s' "$body" | sed -n 's/.*"login"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
    if [ -n "$login" ]; then
      echo "   👤 Autenticado como: $login"
    fi
  }

  gh_echo_scopes() {
    local auth_header="$1"
    # Encabezados (solo muestran X-OAuth-Scopes para PAT clásico)
    local headers
    headers="$(curl -s -I -H "$GH_ACCEPT_HEADER" -H "$GH_API_VERSION" -H "Authorization: $auth_header" "$GH_ENDPOINT")"
    local scopes
    scopes="$(printf '%s' "$headers" | tr -d '\r' | grep -i '^x-oauth-scopes:' | sed 's/^x-oauth-scopes:[[:space:]]*//I')"
    if [ -n "$scopes" ]; then
      echo "   🔎 Scopes (PAT clásico): $scopes"
    else
      echo "   🔎 Scopes no visibles (posible PAT Fine-Grained o GitHub App)."
    fi
  }

  # 1) Probar como PAT clásico
  CODE_TOKEN="$(gh_http_code "token $GITHUB_TOKEN")"

  if [ "$CODE_TOKEN" = "200" ]; then
    echo "✅ GITHUB_TOKEN válido (Authorization: token ...)."
    gh_echo_login "token $GITHUB_TOKEN"
    gh_echo_scopes "token $GITHUB_TOKEN"
  else
    # 2) Probar como Bearer (PAT fine-grained o token de App)
    CODE_BEARER="$(gh_http_code "Bearer $GITHUB_TOKEN")"
    if [ "$CODE_BEARER" = "200" ]; then
      echo "✅ GITHUB_TOKEN válido (Authorization: Bearer ...)."
      gh_echo_login "Bearer $GITHUB_TOKEN"
      gh_echo_scopes "Bearer $GITHUB_TOKEN"
    else
      echo "❌ GITHUB_TOKEN inválido o sin permisos suficientes."
      echo "   HTTP (token):  $CODE_TOKEN"
      echo "   HTTP (bearer): $CODE_BEARER"
      echo "   Verifica caducidad, tipo de token y permisos (repo/project/workflow)."
    fi
  fi
fi

# --- Preflight Codex (seguro e idempotente) ---
pushd "$SCRIPT_DIR" >/dev/null

: "${CODEX_AGENTS_PATH:="$PWD/agents.md"}"
export CODEX_AGENTS_PATH

echo "[INIT] Limpiando caché de Codex..."
rm -rf ~/.codex/cache 2>/dev/null || true
rm -rf /tmp/codex* 2>/dev/null || true

if [ -n "${CODEX_VERSION:-}" ]; then
  echo "[INIT] Usando Codex versión fijada: $CODEX_VERSION"
  # (Place holder: lógica de selección/descarga si aplica a su entorno)
fi

if [ "${CODEX_PREFLIGHT_SKIP:-false}" != "true" ]; then
  (
    set -euo pipefail

    echo "[INIT] PWD=$(pwd)"
    echo "[INIT] GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"
    if [ -f "$CODEX_AGENTS_PATH" ]; then
      echo "[INIT] agents.md PATH=$CODEX_AGENTS_PATH"
      echo "[INIT] agents.md SHA1=$(sha1sum "$CODEX_AGENTS_PATH" | cut -d' ' -f1)"
      # Show first 1 line to see version marker (safe, no secrets)
      head -n 1 "$CODEX_AGENTS_PATH"
    else
      echo "[ERROR] agents.md no encontrado en $CODEX_AGENTS_PATH"
      exit 1
    fi

    if command -v codex >/dev/null 2>&1; then
      echo "[INIT] codex --debug --dry-run --print-config (primeros 200 lines)"
      codex --debug --dry-run --print-config | sed -n '1,200p' || true
    else
      echo "[ERROR] 'codex' no está en PATH"
      exit 1
    fi

    echo "[INIT] Ejecutando sentinel diag-echo-task"
    if codex run diag-echo-task --debug 2>&1 | tee /tmp/codex_diag.log; then
      if ! grep -qE 'DIAG_OK from agents.md|DIAG_TASK_OK' /tmp/codex_diag.log; then
        echo "[ERROR] Sentinel ejecutado pero no se detectó salida esperada (¿no cargó agents.md?)"
        exit 1
      fi
      echo "[INIT] Sentinel OK"
    else
      echo "[ERROR] No se pudo ejecutar diag-echo-task (posible no-carga de agents.md)"
      exit 1
    fi
  )
  preflight_status=$?
  popd >/dev/null
  if [ "$preflight_status" -ne 0 ]; then
    exit "$preflight_status"
  fi
else
  echo "[INIT] CODEX_PREFLIGHT_SKIP=true → Saltando preflight"
  popd >/dev/null
fi

# --- Fin preflight ---
