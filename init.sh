#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

########################################
# 📦 Android SDK (igual que venías usando)
########################################
echo "📦 Instalando Android SDK..."

ANDROID_SDK_ROOT="/workspace/android-sdk"
mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools"

cd "$ANDROID_SDK_ROOT/cmdline-tools"
if [ ! -d "latest" ]; then
  curl -sSfL -o commandlinetools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  unzip -q commandlinetools.zip
  rm -f commandlinetools.zip
  mv cmdline-tools latest
fi

export ANDROID_HOME="$ANDROID_SDK_ROOT"
export ANDROID_SDK_ROOT="$ANDROID_SDK_ROOT"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

yes | sdkmanager --licenses >/dev/null
yes | sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0" >/dev/null

echo "✅ Android SDK instalado correctamente."

########################################
# 🔐 Validación de GITHUB_TOKEN (corrige bug de sintaxis)
########################################
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
    local body
    body="$(curl -s -H "$GH_ACCEPT_HEADER" -H "$GH_API_VERSION" -H "Authorization: $auth_header" "$GH_ENDPOINT")"
    local login
    login="$(printf '%s' "$body" | sed -n 's/.*"login"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
    if [ -n "$login" ]; then
      echo "   👤 Autenticado como: $login"
    fi
  }

  gh_echo_scopes() {
    local auth_header="$1"
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

  CODE_TOKEN="$(gh_http_code "token $GITHUB_TOKEN")"
  if [ "$CODE_TOKEN" = "200" ]; then
    echo "✅ GITHUB_TOKEN válido (Authorization: token ...)."
    gh_echo_login "token $GITHUB_TOKEN"
    gh_echo_scopes "token $GITHUB_TOKEN"
  elif [ "$(gh_http_code "Bearer $GITHUB_TOKEN")" = "200" ]; then
    echo "✅ GITHUB_TOKEN válido (Authorization: Bearer ...)."
    gh_echo_login "Bearer $GITHUB_TOKEN"
    gh_echo_scopes "Bearer $GITHUB_TOKEN"
  else
    echo "❌ GITHUB_TOKEN inválido o sin permisos suficientes."
    echo "   HTTP (token):  $CODE_TOKEN"
    echo "   HTTP (bearer): $(gh_http_code "Bearer $GITHUB_TOKEN")"
    echo "   Verifica caducidad, tipo de token y permisos (repo/project/workflow)."
  fi
fi

########################################
# 🌿 Base SIEMPRE desde develop (fallback a main)
########################################
echo "🌿 Preparando workspace Git para Codex…"

# Configurables
REPO_URL="https://github.com/intrale/platform.git"
WORKDIR="/workspace/platform"
BASE_BRANCH="${BASE_BRANCH:-develop}"      # default: develop
export CODEX_PR_BASE="${BASE_BRANCH}"      # hint para herramientas que lo soporten

# Evitar prompts interactivos
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/true

mkdir -p "$WORKDIR"
if [ ! -d "$WORKDIR/.git" ]; then
  git -C "$WORKDIR" init
fi

# Remote limpio con token solo para fetch
if git -C "$WORKDIR" remote get-url origin >/dev/null 2>&1; then
  git -C "$WORKDIR" remote remove origin || true
fi
git -C "$WORKDIR" remote add origin "https://oauth2:${GITHUB_TOKEN:-x}@github.com/intrale/platform.git"

echo "🔎 Intentando fetch de la base '${BASE_BRANCH}' (shallow)…"
CHOSEN_BASE="$BASE_BRANCH"
if ! git -C "$WORKDIR" fetch --no-tags --depth=1 origin "${BASE_BRANCH}"; then
  echo "⚠️  No existe '${BASE_BRANCH}' en remoto. Probando 'main'…"
  git -C "$WORKDIR" fetch --no-tags --depth=1 origin main
  CHOSEN_BASE="main"
fi

# Forzar rama de trabajo 'work' desde la base elegida
git -C "$WORKDIR" switch --force-create work FETCH_HEAD

# Quitar el remote para no filtrar el token en logs posteriores
git -C "$WORKDIR" remote remove origin || true

echo "✅ Rama base elegida: ${CHOSEN_BASE}"
echo "✅ Rama de trabajo actual: $(git -C "$WORKDIR" branch --show-current)"
echo "✅ HEAD: $(git -C "$WORKDIR" rev-parse HEAD)"
git -C "$WORKDIR" status --porcelain=v1

echo "🏁 Workspace listo para trabajar desde '${CHOSEN_BASE}' ➜ 'work'."
