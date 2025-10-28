#!/usr/bin/env bash
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
  echo "❌ GITHUB_TOKEN no está definido"; exit 1
else
  GH_ACCEPT="Accept: application/vnd.github+json"
  GH_VER="X-GitHub-Api-Version: 2022-11-28"
  GH_URL="https://api.github.com/user"
  curl -fsS -H "$GH_ACCEPT" -H "$GH_VER" -H "Authorization: token $GITHUB_TOKEN" "$GH_URL" >/dev/null \
    || { echo "❌ GITHUB_TOKEN inválido o sin permisos"; exit 1; }
  echo "✅ GITHUB_TOKEN válido."
fi

########################################
# 🌿 Preparar workspace Git (SIEMPRE develop) + rama de trabajo
########################################
echo "🌿 Preparando workspace Git para Codex…"

REPO_URL="${REPO_URL:-https://github.com/intrale/platform.git}"
WORKDIR="${WORKDIR:-/workspace/platform}"
BASE_BRANCH="develop"                 # fijo, sin fallback
export CODEX_BASE_BRANCH="$BASE_BRANCH"
export CODEX_PR_BASE="$BASE_BRANCH"
export DEFAULT_BRANCH_HINT="$BASE_BRANCH"

# Evitar prompts
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/true

mkdir -p "$WORKDIR"
[ -d "$WORKDIR/.git" ] || git -C "$WORKDIR" init

# Config mínima de autor (por si Codex comitea)
git -C "$WORKDIR" config user.name  "${GIT_AUTHOR_NAME:-leitocodexbot}"
git -C "$WORKDIR" config user.email "${GIT_AUTHOR_EMAIL:-leitocodexbot@users.noreply.github.com}"

# Remote con token para fetch
git -C "$WORKDIR" remote remove origin >/dev/null 2>&1 || true
git -C "$WORKDIR" remote add origin "https://oauth2:${GITHUB_TOKEN}@github.com/intrale/platform.git"

echo "🔎 Fetch de '${BASE_BRANCH}' (shallow)…"
git -C "$WORKDIR" fetch --no-tags --depth=1 origin "$BASE_BRANCH" \
  || { echo "❌ No se pudo obtener 'origin/${BASE_BRANCH}'. Abortando."; exit 1; }

# Posicionar/actualizar develop: si existe local, reset; si no, crear tracking
if git -C "$WORKDIR" rev-parse --verify "$BASE_BRANCH" >/dev/null 2>&1; then
  git -C "$WORKDIR" switch "$BASE_BRANCH"
  git -C "$WORKDIR" fetch --no-tags origin "$BASE_BRANCH"
  git -C "$WORKDIR" reset --hard "origin/${BASE_BRANCH}"
else
  git -C "$WORKDIR" switch --track -c "$BASE_BRANCH" "origin/${BASE_BRANCH}"
fi

# Asegurar clean y fast-forward only
git -C "$WORKDIR" pull --ff-only origin "$BASE_BRANCH"

########################################
# 🌱 Crear la rama de trabajo directamente desde develop
########################################
# Reglas: si hay variables de issue/slug conocidas, se usan; si no, se genera.
_slugify () {
  printf "%s" "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g; s/-{2,}/-/g'
}

CAND_SLUG="${ISSUE_SLUG:-${CODEX_ISSUE_SLUG:-${TITLE_SLUG:-''}}}"
CAND_ID="${ISSUE_ID:-${ISSUE_NUMBER:-${CODEX_ISSUE_ID:-${CODEX_TASK_ID:-''}}}}"

if [ -n "$CAND_SLUG" ]; then
  SLUG="$(_slugify "$CAND_SLUG")"
elif [ -n "$CAND_ID" ]; then
  SLUG="task-$(_slugify "$CAND_ID")"
else
  SLUG="task-$(date +%Y%m%d-%H%M%S)"
fi

# Permití override explícito si alguien pasa CODEX_BRANCH_NAME
BRANCH_NAME="${CODEX_BRANCH_NAME:-codex/${SLUG}}"

# Crear y movernos a la rama de trabajo directamente desde develop
git -C "$WORKDIR" switch -c "$BRANCH_NAME" "$BASE_BRANCH"

# (Opcional) proteger contra merges involuntarios: preferimos rebase por defecto
git -C "$WORKDIR" config pull.rebase true

# Quitar el remote con credenciales (evitar fugas de token en logs posteriores)
git -C "$WORKDIR" remote remove origin || true

# Export para que Codex/flows tengan todo a mano
export CODEX_WORK_BRANCH="$BRANCH_NAME"

echo "✅ Rama base: $(git -C "$WORKDIR" branch --show-current) (derivada de '${BASE_BRANCH}')"
echo "✅ HEAD develop: $(git -C "$WORKDIR" rev-parse --short ${BASE_BRANCH})"
echo "✅ HEAD work:    $(git -C "$WORKDIR" rev-parse --short HEAD)"
git -C "$WORKDIR" status --porcelain=v1 || true

cat <<EOF

🏁 Listo.
- Base de trabajo fija: '${BASE_BRANCH}' (sin fallback).
- Repo actualizado (--ff-only) y **rama de trabajo creada**: '${BRANCH_NAME}'.
- PRs deben apuntar a: '${CODEX_PR_BASE}'.

Variables útiles exportadas:
  CODEX_BASE_BRANCH=${CODEX_BASE_BRANCH}
  CODEX_PR_BASE=${CODEX_PR_BASE}
  CODEX_WORK_BRANCH=${CODEX_WORK_BRANCH}
  DEFAULT_BRANCH_HINT=${DEFAULT_BRANCH_HINT}

👉 A partir de aquí, que Codex comience a commitear en '${BRANCH_NAME}'
   y abra los PRs **contra '${CODEX_PR_BASE}'**.

EOF
