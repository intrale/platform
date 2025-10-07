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
: "${STATUS_OPTION_BLOCKED:?Falta STATUS_OPTION_BLOCKED}"
: "${STATUS_OPTION_READY:=}"

: "${REFINE_WRITE_DOCS:=1}"     # docs-first
: "${REFINE_DOCS_OPEN_PR:=1}"   # abrir PR de docs
BATCH_MAX="${BATCH_MAX:-10}"

graphql () {
  local q="$1"
  curl -fsS "$GH_API/graphql" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "$ACCEPT_GRAPHQL" -H "$API_VER" -d "$q"
}

list_todo_items() {
  local Q out
  Q=$(jq -n --arg id "$PROJECT_ID" '{
    query: "
      query($id:ID!){
        node(id:$id){
          ... on ProjectV2{
            items(first:100){
              nodes{
                id
                content{
                  __typename
                  ... on Issue{
                    id number title
                    repository{ name owner{ login } }
                  }
                }
                fieldValueByName(name:\"Status\"){
                  ... on ProjectV2ItemFieldSingleSelectValue{ optionId }
                }
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
    | [.content.repository.owner.login,
       .content.repository.name,
       .content.number,
       .content.id,
       .id,
       .content.title] | @tsv'
}

add_to_project () {
  local ISSUE_NODE_ID="$1" Q
  Q=$(jq -n --arg p "$PROJECT_ID" --arg c "$ISSUE_NODE_ID" \
    '{query:"mutation($project:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$contentId}){item{id}}}",variables:{project:$p,contentId:$c}}')
  graphql "$Q" | jq -r '.data.addProjectV2ItemById.item.id'
}

set_status () {
  local ITEM_ID="$1" OPTION_ID="$2" Q
  Q=$(jq -n --arg p "$PROJECT_ID" --arg i "$ITEM_ID" --arg f "$STATUS_FIELD_ID" --arg o "$OPTION_ID" \
    '{query:"mutation($project:ID!,$item:ID!,$field:ID!,$optionID:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$optionID}}){clientMutationId}}",
      variables:{project:$p,item:$i,field:$f,optionID:$o}}')
  graphql "$Q" >/dev/null
}

rest_post () { curl -fsS -X POST "$1" -H "Authorization: Bearer $GITHUB_TOKEN" -H "$ACCEPT_V3" -H "$API_VER" -d "$2"; }

open_docs_pr () { # owner repo head_branch issue_num
  local owner="$1" repo="$2" head="$3" num="$4"
  local title body
  title="[auto][docs] Refinamiento #${num}"
  body="Closes #${num}\n\nSnapshot de refinamiento generado automáticamente."
  rest_post "$GH_API/repos/$owner/$repo/pulls" \
    "$(jq -nc --arg t "$title" --arg h "$head" --arg b "$body" --arg base "main" '{title:$t, head:$h, base:$base, body:$b}')"
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

snapshot_to_docs () { # owner repo num title body
  [[ "${REFINE_WRITE_DOCS}" == "1" ]] || return 0
  mkdir -p docs/refinements
  chmod u+w docs docs/refinements 2>/dev/null || true
  local owner="$1" repo="$2" num="$3" title="$4" body="$5"
  local slug md
  slug="$(echo "$title" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-*//; s/-*$//' | cut -c1-40)"
  md="docs/refinements/issue-${num}-${slug:-refinamiento}.md"
  {
    echo "# Refinamiento – Issue #${num}"
    echo
    echo "_Repositorio: ${owner}/${repo}_"
    echo
    printf "%s\n" "$body"
  } > "$md"

  if [[ "${REFINE_DOCS_OPEN_PR}" == "1" ]]; then
    local branch="docs/issue-${num}-${slug:-refinamiento}"
    git checkout -B "$branch" >/dev/null 2>&1 || true
    git add "$md" >/dev/null 2>&1 || true
    git commit -m "[auto][docs] Snapshot de refinamiento para #${num}" >/dev/null 2>&1 || true
    git push -u origin "$branch" >/dev/null 2>&1 || true
    open_docs_pr "$owner" "$repo" "$branch" "$num" >/dev/null || true
  fi
}

process_issue () {
  local owner="$1" repo="$2" num="$3" node_id="$4" item_id="$5" title="$6"
  [[ -z "$item_id" || "$item_id" == "null" ]] && item_id="$(add_to_project "$node_id" || true)"

  if ! set_status "$item_id" "$STATUS_OPTION_INPROGRESS"; then
    set_status "$item_id" "$STATUS_OPTION_BLOCKED" || true
    return 1
  fi

  local body; body="$(refinement_template)"
  snapshot_to_docs "$owner" "$repo" "$num" "$title" "$body"

  if [[ -n "${STATUS_OPTION_READY}" && "${STATUS_OPTION_READY}" != "null" ]]; then
    set_status "$item_id" "$STATUS_OPTION_READY" || set_status "$item_id" "$STATUS_OPTION_TODO" || true
  else
    set_status "$item_id" "$STATUS_OPTION_TODO" || true
  fi
}

main() {
  local count=0
  while IFS=$'\t' read -r owner repo num node item title; do
    process_issue "$owner" "$repo" "$num" "$node" "$item" "$title" || true
    count=$((count+1))
    [[ $count -ge $BATCH_MAX ]] && break
  done < <(list_todo_items)
}
main "$@"
