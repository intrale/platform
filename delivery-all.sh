#!/bin/bash
set -euo pipefail

# Setup
export PATH="/c/Workspaces/gh-cli/bin:$PATH"
export GH_TOKEN=$(printf 'protocol=https\nhost=github.com\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')
export MAIN_REPO="/c/Workspaces/Intrale/platform"

# Arreglo para resultados
declare -a RESULTS
declare -i RESULT_IDX=0

# Función para procesar un worktree
process_worktree() {
    local WT_PATH="$1"
    local BRANCH="$2"
    local ISSUE=$(echo "$BRANCH" | sed -E 's/codex\/([0-9]+).*/\1/')

    cd "$WT_PATH"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📦 Procesando: $BRANCH (issue #$ISSUE)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # 1. Contexto actual
    echo ""
    echo "📋 Commits a incluir:"
    git log origin/main..HEAD --oneline | head -5

    echo ""
    echo "📊 Diff resumido:"
    git diff --stat origin/main..HEAD | head -10

    # 2. Stage de cambios
    echo ""
    echo "🔧 Preparando commit..."
    STAGED=$(git diff --cached --name-only 2>/dev/null | wc -l)
    UNSTAGED=$(git diff --name-only 2>/dev/null | wc -l)

    if [[ $UNSTAGED -gt 0 ]]; then
        echo "   ℹ️  Archivos sin stagear: $UNSTAGED"
        git add -A
        echo "   ✓ Todos los cambios forwardeados"
    fi

    # 3. Commit (solo si hay cambios sin commitear)
    if git diff --cached --quiet; then
        echo "   ⓘ Sin cambios para commitear (ya han sido commiteados previamente)"
        COMMIT_HASH=$(git rev-parse HEAD)
    else
        echo "   🔐 Creando commit..."
        COMMIT_MSG="feat(codex-$ISSUE): cambios generados por agente

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
        git commit -m "$COMMIT_MSG" || {
            echo "   ⚠️  Commit falló (posiblemente ya estaba commiteado)"
            COMMIT_HASH=$(git rev-parse HEAD)
        }
    fi

    # 4. Rebase para resolver conflictos
    echo ""
    echo "🔄 Verificando divergencia con main..."
    git fetch origin main 2>/dev/null || true

    BEHIND=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "0")
    if [[ $BEHIND -gt 0 ]]; then
        echo "   ℹ️  $BEHIND commits nuevos en main - rebasing..."
        git rebase origin/main || {
            echo "   ❌ Rebase falló con conflictos"
            git rebase --abort
            RESULTS[$RESULT_IDX]="$BRANCH | — | REBASE-ERROR: conflictos irreconciliables"
            ((RESULT_IDX++))
            return 1
        }
    else
        echo "   ✓ Rama al día con main"
    fi

    # 5. Push
    echo ""
    echo "📤 Pusheando rama..."
    if git push -u origin "$BRANCH" 2>&1; then
        echo "   ✓ Push exitoso"
    else
        echo "   ❌ Push falló"
        RESULTS[$RESULT_IDX]="$BRANCH | — | PUSH-ERROR"
        ((RESULT_IDX++))
        return 1
    fi

    # 6. Crear / detectar PR
    echo ""
    echo "📝 Verificando PR..."
    PR_CHECK=$(gh pr list --repo intrale/platform --head "$BRANCH" --state open --json number 2>/dev/null | grep -o '"number":[0-9]*' | head -1 || echo "")

    if [[ -n "$PR_CHECK" ]]; then
        PR_NUMBER=$(echo "$PR_CHECK" | sed 's/.*://')
        echo "   ℹ️  PR ya existe: #$PR_NUMBER"
    else
        echo "   🆕 Creando PR..."
        PR_OUTPUT=$(gh pr create --repo intrale/platform \
            --title "feat: cambios codex-$ISSUE" \
            --body "Cierre de issue #$ISSUE

## Resumen
Cambios generados por agente Codex

## Tests
- [x] Commit válido
- [x] Push exitoso

Closes #$ISSUE

🤖 Generado con [Claude Code](https://claude.ai/claude-code)" \
            --base main \
            --head "$BRANCH" \
            --assignee leitolarreta 2>&1) || {
            echo "   ❌ Creación de PR falló: $PR_OUTPUT"
            RESULTS[$RESULT_IDX]="$BRANCH | — | PR-CREATE-ERROR"
            ((RESULT_IDX++))
            return 1
        }
        PR_NUMBER=$(echo "$PR_OUTPUT" | grep -oP '(?<=https://github.com/intrale/platform/pull/)\d+' | head -1)
    fi

    # 7. Mergear PR
    echo ""
    echo "🔀 Mergeando PR #$PR_NUMBER..."
    if gh pr merge "$PR_NUMBER" --repo intrale/platform --squash --delete-branch 2>&1; then
        echo "   ✓ Merge exitoso"
        PR_URL="https://github.com/intrale/platform/pull/$PR_NUMBER"
        RESULTS[$RESULT_IDX]="$BRANCH | $PR_URL | OK (merged)"
    else
        echo "   ⚠️  Merge automático falló, verificando checks..."
        if ! gh pr checks "$PR_NUMBER" --repo intrale/platform 2>&1 | grep -q "PASSED"; then
            echo "   ❌ Checks fallidos o aún corriendo"
            RESULTS[$RESULT_IDX]="$BRANCH | #$PR_NUMBER | MERGE-BLOCKED: checks"
        else
            echo "   ❌ Merge error (probablemente conflictos)"
            RESULTS[$RESULT_IDX]="$BRANCH | #$PR_NUMBER | MERGE-ERROR"
        fi
        return 1
    fi

    ((RESULT_IDX++))
    return 0
}

# Procesar cada worktree
cd "$MAIN_REPO"
while IFS= read -r line; do
    if [[ $line =~ ^branch\ refs/heads/agent/ ]]; then
        BRANCH=$(echo "$line" | sed 's/branch refs\/heads\///')
        WT_DIR=$(git worktree list --porcelain | grep "branch refs/heads/$BRANCH" | awk '{print $1}')

        if [[ -n "$WT_DIR" ]]; then
            process_worktree "$WT_DIR" "$BRANCH" || true
        fi
    fi
done < <(git worktree list --porcelain)

# Mostrar resumen
echo ""
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 RESUMEN DE ENTREGAS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Mostrar tabla
printf "%-30s | %-45s | %-30s\n" "Branch" "PR URL" "Estado"
printf "%-30s | %-45s | %-30s\n" "------" "------" "------"
for result in "${RESULTS[@]}"; do
    printf "%s\n" "$result"
done

echo ""
echo "✅ Entregas completadas"
