#!/usr/bin/env bash
set -euo pipefail

GH_API="https://api.github.com"
ACCEPT_V3="Accept: application/vnd.github.v3+json"
ACCEPT_GRAPHQL="Content-Type: application/json"
API_VER="X-GitHub-Api-Version: 2022-11-28"

: "${GITHUB_TOKEN:?Falta GITHUB_TOKEN}"
: "${ORG:=intrale}"

# Cargar IDs de .codex_env (discover debió haberlos generado)
if [[ -f .codex_env ]]; then
  # shellcheck disable=SC1091
  source .codex_env
fi
: "${PROJECT_ID:?Falta PROJECT_ID}"
: "${STATUS_FIELD_ID:?Falta STATUS_FIELD_ID}"
: "${STATUS_OPTION_TODO:?Falta STATUS_OPTION_TODO}"
: "${STATUS_OPTION_INPROGRESS:?Falta STATUS_OPTION_INPROGRESS}"
: "${STATUS_OPTION_BLOCKED:?Falta STATUS_OPTION_BLOCKED}"
: "${STATUS_OPTION_READY:=}"

log(){ echo -e "ℹ️  $*"; }
ok(){ echo -e "✅ $*"; }
fail(){ echo -e "❌ $*" >&2; }

graphql () { curl -fsS "$GH_API/graphql" -H "Authorization: Bearer $GITHUB_TOKEN" -H "$ACCEPT_GRAPHQL" -H "$API_VER" -d "$1"; }
rest_post () { curl -fsS -X POST "$1" -H "Authorization: Bearer $GITHUB_TOKEN" -H "$ACCEPT_V3" -H "$API_VER" -d "$2"; }

infer_repo () {
  if git remote get-url origin >/dev/null 2>&1; then
    local url; url="$(git remote get-url origin)"
    if [[ "$url" =~ github.com[:/](.+)/(.+)\.git$ ]]; then
      ORG="${BASH_REMATCH[1]}"
      REPO="${BASH_REMATCH[2]}"
      echo "$ORG/$REPO"; return 0
    fi
  fi
  : "${REPO:?Falta REPO (no pude inferirlo de git remote origin)}"
  echo "$ORG/$REPO"
}

add_to_project () { local Q; Q=$(jq -n --arg p "$PROJECT_ID" --arg c "$1" '{query:"mutation($project:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$contentId}){item{id}}}",variables:{project:$p,contentId:$c}}'); graphql "$Q" | jq -r '.data.addProjectV2ItemById.item.id'; }
set_status () { local Q; Q=$(jq -n --arg p "$PROJECT_ID" --arg i "$1" --arg f "$STATUS_FIELD_ID" --arg o "$2" '{query:"mutation($project:ID!,$item:ID!,$field:ID!,$optionID:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$optionID}}){clientMutationId}}",variables:{project:$p,item:$i,field:$f,optionID:$o}}'); graphql "$Q" >/dev/null; }

ensure_git_setup () {
  git config user.name  "${GIT_AUTHOR_NAME:-codex-bot}" || true
  git config user.email "${GIT_AUTHOR_EMAIL:-codex-bot@users.noreply.github.com}" || true
  git config --global --add safe.directory "$(pwd)" || true
  git fetch --unshallow >/dev/null 2>&1 || true
  git fetch --all --quiet || true
}

ensure_remote_url () {
  local owner="$1" repo="$2"
  local url="https://x-access-token:${GITHUB_TOKEN}@github.com/${owner}/${repo}.git"
  if git remote | grep -qx origin; then
    git remote set-url origin "$url"
  else
    git remote add origin "$url"
  fi
}

main() {
  local owner_repo; owner_repo="$(infer_repo)"
  local owner="${owner_repo%/*}" repo="${owner_repo#*/}"

  log "Repo: $owner/$repo"

  # 1) Crear issue sandbox
  local title body create_resp num node_id
  title="[self-test] Validación de ambiente Codex"
  body="Issue generado automáticamente para validar credenciales, GraphQL y PR."
  create_resp="$(rest_post "$GH_API/repos/$owner/$repo/issues" "$(jq -nc --arg t "$title" --arg b "$body" '{title:$t, body:$b}')")"
  num="$(echo "$create_resp" | jq -r '.number')"
  node_id="$(echo "$create_resp" | jq -r '.node_id')"
  ok "Issue #$num creado"

  # 2) Agregar al Project y mover estados
  local item_id
  item_id="$(add_to_project "$node_id")"
  ok "Item agregado al Project: $item_id"
  set_status "$item_id" "$STATUS_OPTION_INPROGRESS"
  ok "Movido a In Progress"

  # 3) Generar refinamiento y worklog
  mkdir -p docs/refinements docs/work
  local refmd="docs/refinements/issue-${num}-selftest.md"
  cat > "$refmd" <<'EOF'
## Objetivo
Prueba automática del flujo (issue + project + PR) sin impactar código productivo.

## Contexto
Validar permisos y mutaciones mínimas contra GitHub (Project v2 e Issues).

## Cambios requeridos
- Ninguno (solo documentación de validación).

## Criterios de aceptación
- [x] Issue creado y agregado al Project
- [x] Estado movido a "In Progress"
- [x] PR documental abierto
- [x] Estado final actualizado
EOF

  local wl="docs/work/issue-${num}-worklog.md"
  cat > "$wl" <<EOF
# Worklog – Issue #$num

- Refinamiento: \`$refmd\`
- Resultado: pruebas de ambiente correctas.
EOF

  # 4) Rama + PR
  ensure_git_setup
  ensure_remote_url "$owner" "$repo"
  local branch="auto/selftest-${num}"
  git checkout -B "$branch" >/dev/null 2>&1 || git checkout -b "$branch" >/dev/null 2>&1
  git add "$refmd" "$wl" >/dev/null
  git commit -m "[auto][selftest] Docs de validación para #${num}" >/dev/null
  git push -u origin "$branch" >/dev/null

  local pr_title="[auto][selftest] Validación de ambiente"
  local pr_body="Closes #${num}\n\nDocumentación: \`$refmd\`"
  local pr_url
  pr_url="$(rest_post "$GH_API/repos/$owner/$repo/pulls" "$(jq -nc --arg t "$pr_title" --arg h "$branch" --arg b "$pr_body" --arg base "main" '{title:$t, head:$h, base:$base, body:$b}') " | jq -r '.html_url')"
  ok "PR abierto: $pr_url"

  # 5) Estado final
  if [[ -n "${STATUS_OPTION_READY}" && "${STATUS_OPTION_READY}" != "null" ]]; then
    set_status "$item_id" "$STATUS_OPTION_READY"
    ok "Movido a Ready"
  else
    set_status "$item_id" "$STATUS_OPTION_TODO"
    ok "Volvió a Todo (no hay opción Ready)"
  fi

  # Comentario de evidencia
  rest_post "$GH_API/repos/$owner/$repo/issues/$num/comments" "$(jq -nc --arg b "codex: self-test completado. PR → $pr_url" '{body:$b}')" >/dev/null
}
main "$@"
