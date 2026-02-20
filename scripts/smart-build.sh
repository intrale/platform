#!/bin/bash
# smart-build.sh — Build inteligente: compila solo módulos afectados
#
# Uso:
#   ./scripts/smart-build.sh              # Detecta cambios vs main
#   ./scripts/smart-build.sh --base dev   # Detecta cambios vs otra rama
#   ./scripts/smart-build.sh --all        # Forzar build completo
#
# Dependencias entre módulos:
#   :users depende de :backend (cambio en backend → recompila users también)
#   :app:composeApp es independiente del backend
#   :tools:forbidden-strings-processor es independiente

set -euo pipefail

BASE_BRANCH="main"
FORCE_ALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      BASE_BRANCH="$2"
      shift 2
      ;;
    --all)
      FORCE_ALL=true
      shift
      ;;
    *)
      echo "Uso: $0 [--base <rama>] [--all]"
      exit 1
      ;;
  esac
done

# ── Colores ───────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}>> Smart Build — detectando módulos afectados${NC}"

# ── Build completo si se pide ─────────────────────────────────────
if $FORCE_ALL; then
  echo -e "${YELLOW}>> Modo --all: compilando todo${NC}"
  ./gradlew check
  exit $?
fi

# ── Detectar archivos cambiados ──────────────────────────────────
if git rev-parse --verify "$BASE_BRANCH" > /dev/null 2>&1; then
  changed=$(git diff --name-only "$BASE_BRANCH"...HEAD 2>/dev/null || git diff --name-only HEAD)
elif git rev-parse --verify "origin/$BASE_BRANCH" > /dev/null 2>&1; then
  changed=$(git diff --name-only "origin/$BASE_BRANCH"...HEAD 2>/dev/null || git diff --name-only HEAD)
else
  echo -e "${YELLOW}>> No se encontró rama base '$BASE_BRANCH', usando cambios uncommitted${NC}"
  changed=$(git diff --name-only HEAD)
fi

if [[ -z "$changed" ]]; then
  echo -e "${GREEN}>> Sin cambios detectados. Nada que compilar.${NC}"
  exit 0
fi

echo -e "${CYAN}>> Archivos cambiados:${NC}"
echo "$changed" | head -20
total=$(echo "$changed" | wc -l)
if [[ $total -gt 20 ]]; then
  echo "   ... y $((total - 20)) archivos más"
fi
echo ""

# ── Detectar módulos afectados ───────────────────────────────────
tasks=""
backend=false
app=false
users=false
tools=false
shared=false

while IFS= read -r file; do
  case "$file" in
    backend/*)                    backend=true ;;
    app/*)                        app=true ;;
    users/*)                      users=true ;;
    tools/*)                      tools=true ;;
    build.gradle.kts|settings.gradle.kts|gradle.properties)
                                  shared=true ;;
    gradle/*|buildSrc/*)          shared=true ;;
  esac
done <<< "$changed"

# Cambio en archivos compartidos → compilar todo
if $shared; then
  echo -e "${YELLOW}>> Cambio en archivos compartidos (gradle/buildSrc) — compilando todo${NC}"
  ./gradlew check
  exit $?
fi

# Armar lista de tasks
if $backend; then
  tasks="$tasks :backend:check"
  echo -e "  ${GREEN}+ backend${NC}"
fi

# users depende de backend (transitividad)
if $users || $backend; then
  tasks="$tasks :users:check"
  if $users; then
    echo -e "  ${GREEN}+ users${NC}"
  else
    echo -e "  ${GREEN}+ users${NC} (transitivo: depende de backend)"
  fi
fi

if $app; then
  tasks="$tasks :app:composeApp:check"
  echo -e "  ${GREEN}+ app:composeApp${NC}"
fi

if $tools; then
  tasks="$tasks :tools:forbidden-strings-processor:check"
  echo -e "  ${GREEN}+ tools:forbidden-strings-processor${NC}"
fi

if [[ -z "$tasks" ]]; then
  echo -e "${GREEN}>> Los cambios no afectan módulos compilables (docs, scripts, etc.)${NC}"
  exit 0
fi

echo ""
echo -e "${CYAN}>> Ejecutando: ./gradlew$tasks${NC}"
echo ""

./gradlew $tasks
