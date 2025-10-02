#!/usr/bin/env bash
set -euo pipefail

GH_API="https://api.github.com"
ACCEPT_V3="Accept: application/vnd.github.v3+json"
ACCEPT_GRAPHQL="Content-Type: application/json"
API_VER="X-GitHub-Api-Version: 2022-11-28"

: "${GITHUB_TOKEN:?Falta GITHUB_TOKEN}"
: "${ORG:=intrale}"
: "${PROJECT_ID:?Falta PROJECT_ID}"

# Opciones de Status (ideal: exportarlas con ./init.sh discover)
: "${STATUS_FIELD_ID:?Falta STATUS_FIELD_ID}"
: "${STATUS_OPTION_TODO:?Falta STATUS_OPTION_TODO}"
: "${STATUS_OPTION_INPROGRESS:?Falta STATUS_OPTION_INPROGRESS}"
: "${STATUS_OPTION_BLOCKED:?Falta STATUS_OPTION_BLOCKED}"

BATCH_MAX="${BATCH_MAX:-10}"

# ---- Guard REPO READ-ONLY para 'refinar' ----
if [[ "${REFINE_READONLY:-1}" == "1" ]]; then
  if git status --porcelain 2>/dev/null | grep -q .; then
    echo "codex: REFINE_READONLY=1 → ejecución cancelada: hay cambios locales. Marco Blocked y dejo comentario."
    exit 1
  fi
fi

graphql () {
  local q="$1"
  curl -fsS "$GH_API/graphql" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "$ACCEPT_GRAPHQL" -H "$API_VER" -d "$q"
}

rest_post () { curl -fsS -X POST "$1" -H "Authorization: Bearer $GITHUB_TOKEN" -H "$ACCEPT_V3" -H "$API_VER" -d "$2"; }
rest_patch () { curl -fsS -X PATCH "$1" -H "Authorization: Bearer $GITHUB_TOKEN" -H "$ACCEPT_V3" -H "$API_VER" -d "$2"; }
rest_get () { curl -fsS "$1" -H "Authorization: Bearer $GITHUB_TOKEN" -H "$ACCEPT_V3" -H "$API_VER"; }

list_todo_items() {
  # Lista items del Project con Status == Todo (owner/repo/number/node_id/item_id) como TSV
  local Q out
  Q=$(jq -n --arg id "$PROJECT_ID" '{
    query: "
      query($id:ID!){
        node(id:$id){
          ... on ProjectV2{
            items(first:100){
              nodes{
                id
                content{ __typename ... on Issue{ id number title repository{ name owner{ login } } } }
                fieldValueByName(name:\"Status\"){ ... on ProjectV2ItemFieldSingleSelectValue{ optionId } }
              }
            }
          }
        }
      }",
    variables:{id:$id}}')
  out="$(graphql "$Q")"
  printf '%s' "$out" | jq -r --arg opt "$STATUS_OPTION_TODO" '
    .data.node.items.nodes[]
    | select(.fieldValueByName.optionId==$opt)
    | select(.content.__typename=="Issue")
    | [.content.repository.owner.login, .content.repository.name, .content.number, .content.id, .id] | @tsv'
}

add_to_project () { # ISSUE_NODE_ID -> ITEM_ID
  local ISSUE_NODE_ID="$1" Q
  Q=$(jq -n --arg p "$PROJECT_ID" --arg c "$ISSUE_NODE_ID" \
    '{query:"mutation($project:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$contentId}){item{id}}}",variables:{project:$p,contentId:$c}}')
  graphql "$Q" | jq -r '.data.addProjectV2ItemById.item.id'
}

set_status () { # ITEM_ID OPTION_ID
  local ITEM_ID="$1" OPTION_ID="$2" Q
  Q=$(jq -n --arg p "$PROJECT_ID" --arg i "$ITEM_ID" --arg f "$STATUS_FIELD_ID" --arg o "$OPTION_ID" \
    '{query:"mutation($project:ID!,$item:ID!,$field:ID!,$optionID:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$optionID}}){clientMutationId}}",
      variables:{project:$p,item:$i,field:$f,optionID:$o}}')
  graphql "$Q" >/dev/null
}

comment_issue () { # owner repo num body
  rest_post "$GH_API/repos/$1/$2/issues/$3/comments" "$(jq -nc --arg b "$4" '{body:$b}')" >/dev/null
}
patch_issue_body () { # owner repo num body
  rest_patch "$GH_API/repos/$1/$2/issues/$3" "$(jq -nc --arg b "$4" '{body:$b}')" >/dev/null
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

process_issue () { # owner repo num issue_node_id item_id
  local owner="$1" repo="$2" num="$3" node_id="$4" item_id="$5"
  [[ -z "$item_id" || "$item_id" == "null" ]] && item_id="$(add_to_project "$node_id" || true)"


  if ! set_status "$item_id" "$STATUS_OPTION_INPROGRESS"; then
    comment_issue "$owner" "$repo" "$num" "codex: no pude mover a **In Progress**. Marco **Blocked**. Verificá IDs/permiso."
    set_status "$item_id" "$STATUS_OPTION_BLOCKED" || true
    return 1
  fi

    # Idempotencia: omitir si el body ya tiene la plantilla estándar
    local issue_json body_text
    issue_json="$(rest_get "$GH_API/repos/$owner/$repo/issues/$num")" || true
    body_text="$(echo "$issue_json" | jq -r '.body // ""')"
    if echo "$body_text" | grep -qiE '^## Objetivo' && \
       echo "$body_text" | grep -qiE '^## Contexto' && \
       echo "$body_text" | grep -qiE '^## Cambios requeridos' && \
       echo "$body_text" | grep -qiE '^## Criterios de aceptación' && \
       echo "$body_text" | grep -qiE '^## Notas técnicas'; then
      comment_issue "$owner" "$repo" "$num" "codex: ya estaba refinado previamente. Omito para no duplicar contenido." || true
      set_status "$item_id" "$STATUS_OPTION_TODO" || true
      return 0
    fi

  local body; body="$(refinement_template)"
  comment_issue "$owner" "$repo" "$num" "codex (refinamiento):\n\n$body" || true
  patch_issue_body "$owner" "$repo" "$num" "$body" || true

  set_status "$item_id" "$STATUS_OPTION_TODO" || true
  comment_issue "$owner" "$repo" "$num" "codex: refinamiento aplicado. Estado devuelto a **Todo**." || true
}

main() {
  local count=0
  list_todo_items | while IFS=$'\t' read -r owner repo num node item; do
    process_issue "$owner" "$repo" "$num" "$node" "$item" || true
    count=$((count+1))
    [[ $count -ge $BATCH_MAX ]] && break
  done
}
main "$@"
