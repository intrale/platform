#!/bin/bash

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