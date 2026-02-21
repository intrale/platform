# =============================================================================
# dev-functions.sh — Funciones para desarrollo paralelo con worktrees
#
# Carga automatica desde ~/.bashrc
# Requiere: worktrunk (git-wt), git, claude
# =============================================================================

# --- Paths ---
export PATH="/c/Users/Administrator/AppData/Local/Microsoft/WinGet/Packages/max-sixty.worktrunk_Microsoft.Winget.Source_8wekyb3d8bbwe:$PATH"
export PATH="/c/Workspaces/gh-cli/bin:$PATH"
export JAVA_HOME="/c/Users/Administrator/.jdks/temurin-21.0.7"

# Directorio principal del repo
_INTRALE_MAIN="/c/Workspaces/Intrale/platform"

# =============================================================================
# dev <issue> [slug]
#
# Crea un worktree aislado para trabajar en un issue.
# Copia automaticamente la config de Claude Code (permisos, etc).
#
# Ejemplos:
#   dev 42 auth-2fa        → branch codex/42-auth-2fa
#   dev 43 catalogo        → branch codex/43-catalogo
#   dev 50                 → branch codex/50-feature
# =============================================================================
dev() {
    local issue="${1}"
    local slug="${2:-feature}"

    if [ -z "$issue" ]; then
        cat <<HELP
Uso: dev <issue-number> [slug]

Ejemplos:
  dev 42 auth-2fa      Crea worktree para issue #42
  dev 43 catalogo      Crea worktree para issue #43

Otros comandos:
  dev-list             Ver todos los worktrees activos
  dev-go <issue|slug>  Ir a un worktree existente
  dev-done             Mergear worktree actual a main y limpiar
  dev-clean            Eliminar worktree actual sin merge
  dev-clean-all        Eliminar TODOS los worktrees
HELP
        return 1
    fi

    local branch="codex/${issue}-${slug}"
    local wt_dir="${_INTRALE_MAIN}/../platform.codex-${issue}-${slug}"

    # Ir al worktree principal
    cd "$_INTRALE_MAIN" 2>/dev/null || {
        echo "Error: no se encuentra $_INTRALE_MAIN"
        return 1
    }

    # Actualizar main
    echo ">> Actualizando main..."
    git fetch origin main --quiet 2>/dev/null

    # Crear worktree via worktrunk
    echo ">> Creando worktree: $branch"
    git-wt switch --create "$branch"

    # El directorio actual ya cambio (shell integration de worktrunk)
    local current_dir="$(pwd)"

    # Copiar settings.local.json de Claude Code (permisos)
    if [ -f "$_INTRALE_MAIN/.claude/settings.local.json" ]; then
        mkdir -p "$current_dir/.claude" 2>/dev/null
        cp "$_INTRALE_MAIN/.claude/settings.local.json" "$current_dir/.claude/settings.local.json"
        echo ">> Copiado permisos de Claude Code"
    fi

    echo ""
    echo "============================================"
    echo "  Worktree listo: $branch"
    echo "  Dir: $current_dir"
    echo "============================================"
    echo ""
    echo "  claude                           → Iniciar agente"
    echo "  claude \"prompt - Closes #${issue}\" → Con instruccion"
    echo ""
}

# =============================================================================
# dev-list — Ver todos los worktrees activos
# =============================================================================
dev-list() {
    cd "$_INTRALE_MAIN" 2>/dev/null && git-wt list
}

# =============================================================================
# dev-go <issue|slug> — Ir a un worktree existente
#
# Ejemplos:
#   dev-go 42              → busca worktree con "42" en el branch
#   dev-go auth            → busca worktree con "auth" en el branch
# =============================================================================
dev-go() {
    local search="${1}"
    if [ -z "$search" ]; then
        echo "Uso: dev-go <issue-number|slug>"
        echo ""
        dev-list
        return 1
    fi

    cd "$_INTRALE_MAIN" 2>/dev/null

    # Intentar match exacto primero
    git-wt switch "codex/${search}" 2>/dev/null && return 0

    # Buscar parcial en branches con worktrees
    local match=$(git worktree list --porcelain 2>/dev/null \
        | grep "^branch refs/heads/" \
        | sed 's/branch refs\/heads\///' \
        | grep "$search" \
        | head -1)

    if [ -n "$match" ]; then
        git-wt switch "$match"
    else
        echo "No se encontro worktree con '$search'"
        echo ""
        dev-list
        return 1
    fi
}

# =============================================================================
# dev-done — Merge squash a main + cleanup del worktree
# =============================================================================
dev-done() {
    local current_branch=$(git branch --show-current 2>/dev/null)

    if [ "$current_branch" = "main" ]; then
        echo "Error: ya estas en main. Movete a un worktree primero (dev-go)."
        return 1
    fi

    echo ">> Mergeando $current_branch a main (squash + fast-forward)..."
    echo ""
    git-wt merge main
}

# =============================================================================
# dev-clean — Eliminar worktree actual sin mergear
# =============================================================================
dev-clean() {
    local current_branch=$(git branch --show-current 2>/dev/null)

    if [ "$current_branch" = "main" ]; then
        echo "Error: ya estas en main."
        return 1
    fi

    echo ">> Eliminando worktree: $current_branch"
    git-wt remove
}

# =============================================================================
# dev-clean-all — Limpiar TODOS los worktrees (excepto main)
# =============================================================================
dev-clean-all() {
    cd "$_INTRALE_MAIN" 2>/dev/null || return 1

    local worktrees=$(git worktree list 2>/dev/null | grep -v "\[main\]" | grep -v "^$")

    if [ -z "$worktrees" ]; then
        echo "No hay worktrees activos (aparte de main)."
        return 0
    fi

    echo ">> Worktrees que se eliminaran:"
    echo "$worktrees"
    echo ""
    read -p "Eliminar todos? (y/N) " confirm
    if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
        git worktree list --porcelain 2>/dev/null \
            | grep "^worktree " \
            | grep -v "$_INTRALE_MAIN" \
            | sed 's/worktree //' \
            | while read wt_path; do
                echo "  Eliminando: $wt_path"
                git worktree remove "$wt_path" --force 2>/dev/null
            done
        git worktree prune 2>/dev/null
        echo "Listo."
    else
        echo "Cancelado."
    fi
}

# =============================================================================
# dev-home — Volver al worktree principal (main)
# =============================================================================
dev-home() {
    cd "$_INTRALE_MAIN" 2>/dev/null && echo ">> En main: $(pwd)"
}

# Solo mostrar mensaje en sesiones interactivas (evita contaminar stdout de hooks)
[[ $- == *i* ]] && echo "[dev-functions] Cargado. Usa 'dev <issue> [slug]' para empezar."
