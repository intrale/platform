#!/usr/bin/env bash
set -euo pipefail

GH_API="https://api.github.com"
ACCEPT_V3="Accept: application/vnd.github.v3+json"
ACCEPT_GRAPHQL="Content-Type: application/json"
API_VER="X-GitHub-Api-Version: 2022-11-28"

: "${GITHUB_TOKEN:?Falta GITHUB_TOKEN}"
: "${ORG:=intrale}"
: "${PROJECT_ID:?Falta PROJECT_ID}"

: "${STATUS_FIELD_ID:?Falta STATUS_FIELD_ID}"
: "${STATUS_OPTION_TODO:?Falta STATUS_OPTION_TODO}"
: "${STATUS_OPTION_INPROGRESS:?Falta STATUS_OPTION_INPROGRESS}"
: "${STATUS_OPTION_READY:?Falta STATUS_OPTION_READY}"
: "${STATUS_OPTION_BLOCKED:?Falta STATUS_OPTION_BLOCKED}"

: "${WORK_OPEN_PR:=0}"   # 1 para habilitar PRs
: "${PR_BASE:=main}"

BATCH_MAX="${BATCH_MAX:-20}"

graphql () { curl -fsS "$GH_API/graphql" -H "Authorization: Bearer $GITHUB_TOKEN" -H "$ACCEPT_GRAPHQL" -H "$API_VER" -d "$1"; }
rest_post () { curl -fsS -X POST "$1" -H "Authorization: Bearer $GITHUB_TOKEN" -H "$ACCEPT_V3" -H "$API_VER" -d "$2"; }
rest_patch () { curl -fsS -X PATCH "$1" -H "Authorization: Bearer $GITHUB_TOKEN" -H "$ACCEPT_V3" -H "$API_VER" -d "$2"; }

list_todo_items() {
  local Q out
  Q=$(jq -n --arg id "$PROJECT_ID" '{query:"query($id:ID!){ node(id:$id){ ... on ProjectV2{ items(first:100){ nodes{ id content{ __typename ... on Issue{ id number title repository{ name owner{ login } } } } fieldValueByName(name:\"Status\"){ ... on ProjectV2ItemFieldSingleSelectValue{ optionId } } } } } } }",variables:{id:$id}}')
  out="$(graphql "$Q")"
  printf '%s' "$out" | jq -r --arg opt "$STATUS_OPTION_TODO" '
    .data.node.items.nodes[]
    | select(.fieldValueByName.optionId==$opt)
    | select(.content.__typename=="Issue")
    | [.content.repository.owner.login, .content.repository.name, .content.number, .content.id, .id, .content.title] | @tsv'
}

add_to_project () { local Q; Q=$(jq -n --arg p "$PROJECT_ID" --arg c "$1" '{query:"mutation($project:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$contentId}){item{id}}}",variables:{project:$p,contentId:$c}}'); graphql "$Q" | jq -r '.data.addProjectV2ItemById.item.id'; }
set_status () { local Q; Q=$(jq -n --arg p "$PROJECT_ID" --arg i "$1" --arg f "$STATUS_FIELD_ID" --arg o "$2" '{query:"mutation($project:ID!,$item:ID!,$field:ID!,$optionID:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$optionID}}){clientMutationId}}",variables:{project:$p,item:$i,field:$f,optionID:$o}}'); graphql "$Q" >/dev/null; }
comment_issue () { rest_post "$GH_API/repos/$1/$2/issues/$3/comments" "$(jq -nc --arg b "$4" '{body:$b}')" >/dev/null; }
patch_issue_body () { rest_patch "$GH_API/repos/$1/$2/issues/$3" "$(jq -nc --arg b "$4" '{body:$b}')" >/dev/null; }

open_pr () { # owner repo head_branch title body
  rest_post "$GH_API/repos/$1/$2/pulls" "$(jq -nc --arg t "$4" --arg h "$3" --arg b "$5" --arg base "${PR_BASE}" '{title:$t, head:$h, base:$base, body:$b}')" \
    | jq -r '.html_url'
}

refinement_template () {
cat <<'EOF'
## Objetivo
(Completar con el objetivo concreto de la tarea)

## Contexto
(Estado actual / antecedentes. Referencias de rutas del repo.)

## Cambios requeridos
- Ruta/componente 1: /workspace/...
- Ruta/componente 2: /workspace/...
- Pruebas esperadas
- Documentación a actualizar en /docs si aplica

## Criterios de aceptación
- [ ] Criterio 1 verificable
- [ ] Criterio 2 verificable

## Notas técnicas
(Decisiones, riesgos, toggles, migraciones)
EOF
}

branch_name () { # slug a partir del título + número
  local title="$1" num="$2"
  printf 'feature/issue-%s-%s' "$num" "$(echo "$title" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-*\|-*$//g' | cut -c1-40)"
}

process_issue () { # owner repo num node_id item_id title
  local owner="$1" repo="$2" num="$3" node_id="$4" item_id="$5" title="$6"
  [[ -z "$item_id" || "$item_id" == "null" ]] && item_id="$(add_to_project "$node_id" || true)"

  if ! set_status "$item_id" "$STATUS_OPTION_INPROGRESS"; then
    comment_issue "$owner" "$repo" "$num" "codex: no pude mover a **In Progress**. Marco **Blocked**. Verificá IDs/permiso."
    set_status "$item_id" "$STATUS_OPTION_BLOCKED" || true
    return 1
  fi

  local body; body="$(refinement_template)"
  comment_issue "$owner" "$repo" "$num" "codex (trabajo: refinamiento + acciones):\n\n$body" || true
  patch_issue_body "$owner" "$repo" "$num" "$body" || true

  if [[ "$WORK_OPEN_PR" == "1" ]]; then
    # Rama “lógica” (solo nomenclatura; la creación real de commits queda para el pipeline/agent que corresponda)
    local branch; branch="$(branch_name "$title" "$num")"
    # Abrimos PR vacío apuntado a esa rama (suponiendo que exista en remoto por otro proceso/agent); si no existe, GitHub retornará error → lo registramos como comentario pero no rompemos el flujo.
    local pr_url
    pr_url="$(open_pr "$owner" "$repo" "$branch" "[auto] $title" "Closes #$num" || echo "")"
    if [[ -n "$pr_url" ]]; then
      comment_issue "$owner" "$repo" "$num" "codex: PR abierto → $pr_url" || true
      set_status "$item_id" "$STATUS_OPTION_READY" || true
      return 0
    fi
  fi

  # Sin PR o fallo abriendo PR → dejar en Todo por defecto
  set_status "$item_id" "$STATUS_OPTION_TODO" || true
  comment_issue "$owner" "$repo" "$num" "codex: trabajo aplicado (refinamiento). Estado por defecto → **Todo**." || true
}

main() {
  local count=0
  list_todo_items | while IFS=$'\t' read -r owner repo num node item title; do
    process_issue "$owner" "$repo" "$num" "$node" "$item" "$title" || true
    count=$((count+1))
    [[ $count -ge $BATCH_MAX ]] && break
  done
}
main "$@"
