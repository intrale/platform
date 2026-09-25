#!/usr/bin/env bash
# Copyright (c) 2026 Leonel Larreta
# SPDX-License-Identifier: LicenseRef-Proprietary

set -euo pipefail

########################################
# 📦 Android SDK
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

# ⚠️ Evitar SIGPIPE (exit 141) al aceptar licencias
set +o pipefail
yes | sdkmanager --licenses >/dev/null 2>&1 || true
yes | sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0" >/dev/null 2>&1 || true
set -o pipefail

echo "✅ Android SDK instalado correctamente."

########################################
# 🔐 Validación de GITHUB_TOKEN
########################################
echo "🔐 Validando GITHUB_TOKEN..."
if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "⚠️  GITHUB_TOKEN no está definido."
else
  GH_ACCEPT="Accept: application/vnd.github+json"
  GH_VER="X-GitHub-Api-Version: 2022-11-28"
  GH_URL="https://api.github.com/user"

  curl_code() { curl -s -o /dev/null -w "%{http_code}" -H "$GH_ACCEPT" -H "$GH_VER" -H "Authorization: $1" "$GH_URL"; }
  show_login() {
    local body; body="$(curl -s -H "$GH_ACCEPT" -H "$GH_VER" -H "Authorization: $1" "$GH_URL")"
    echo "$body" | sed -n 's/.*"login"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/   👤 Autenticado como: \1/p' | head -n1
    local hdrs; hdrs="$(curl -sI -H "$GH_ACCEPT" -H "$GH_VER" -H "Authorization: $1" "$GH_URL" | tr -d '\r')"
    local scopes; scopes="$(echo "$hdrs" | grep -i '^x-oauth-scopes:' | sed 's/^x-oauth-scopes:[[:space:]]*//I')"
    [ -n "$scopes" ] && echo "   🔎 Scopes (PAT clásico): $scopes" || echo "   🔎 Scopes no visibles (fine-grained/App)."
  }

  if [ "$(curl_code "token $GITHUB_TOKEN")" = "200" ]; then
    echo "✅ GITHUB_TOKEN válido (Authorization: token ...)."; show_login "token $GITHUB_TOKEN"
  elif [ "$(curl_code "Bearer $GITHUB_TOKEN")" = "200" ]; then
    echo "✅ GITHUB_TOKEN válido (Authorization: Bearer ...)."; show_login "Bearer $GITHUB_TOKEN"
  else
    echo "❌ GITHUB_TOKEN inválido o sin permisos suficientes."
  fi
fi

########################################
# 🌿 Preparar workspace Git para Codex
########################################
echo "🌿 Preparando workspace Git para Codex…"

# Config
REPO_URL="https://github.com/intrale/platform.git"
WORKDIR="/workspace/platform"
BASE_BRANCH="${BASE_BRANCH:-main}"       # default main
export CODEX_PR_BASE="${BASE_BRANCH}"       # hint para agentes que lo lean

# Evitar prompts
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/true

mkdir -p "$WORKDIR"
[ -d "$WORKDIR/.git" ] || git -C "$WORKDIR" init

# Remote con token SOLO para fetch
git -C "$WORKDIR" remote remove origin >/dev/null 2>&1 || true
git -C "$WORKDIR" remote add origin "https://oauth2:${GITHUB_TOKEN:-x}@github.com/intrale/platform.git"

echo "🔎 Intentando fetch de la base '${BASE_BRANCH}' (shallow)…"
CHOSEN_BASE="$BASE_BRANCH"
if ! git -C "$WORKDIR" fetch --no-tags --depth=1 origin "$BASE_BRANCH"; then
  echo "⚠️  No existe '${BASE_BRANCH}' en remoto. Probando 'main'…"
  git -C "$WORKDIR" fetch --no-tags --depth=1 origin main
  CHOSEN_BASE="main"
fi

# Rama de trabajo desde la base elegida
git -C "$WORKDIR" switch --force-create work FETCH_HEAD

# Limpiar credenciales del remote
git -C "$WORKDIR" remote remove origin || true

echo "✅ Rama base elegida: ${CHOSEN_BASE}"
echo "✅ Rama de trabajo actual: $(git -C "$WORKDIR" branch --show-current)"
echo "✅ HEAD: $(git -C "$WORKDIR" rev-parse HEAD)"
git -C "$WORKDIR" status --porcelain=v1

echo "🏁 Workspace listo para trabajar desde '${CHOSEN_BASE}' ➜ 'work'."
