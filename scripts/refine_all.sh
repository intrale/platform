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

: "${REFINE_WRITE_DOCS:=0}"     # 1 -> generar docs/refinements/*.md
: "${REFINE_DOCS_OPEN_PR:=1}"   # 1 -> abrir PR de docs por defecto

BATCH_MAX="${BATCH_MAX:-10}"

graphql () {
  local q="$1"
  curl -fsS "$GH_API/graphql"     -H "Authorization: Bearer $GITHUB_TOKEN"     -H "$ACCEPT_GRAPHQL" -H "$API_VER" -d "$q"
}

rest_post () { curl -fsS -X POST "$1" -H "Authorization: Bearer $GITHUB_TOKEN" -H "$ACCEPT_V3" -H "$API_VER" -d "$2"; }
rest_patch () { curl -fsS -X PATCH "$1" -H "Authorization: Bearer $GITHUB_TOKEN" -H "$ACCEPT_V3" -H "$API_VER" -d "$2"; }
rest_get () { curl -fsS "$1" -H "Authorization: Bearer $GITHUB_TOKEN" -H "$ACCEPT_V3" -H "$API_VER"; }

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

add_to_project () {
  local ISSUE_NODE_ID="$1" Q
  Q=$(jq -n --arg p "$PROJECT_ID" --arg c "$ISSUE_NODE_ID"     '{query:"mutation($project:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$contentId}){item{id}}}",variables:{project:$p,contentId:$c}}')
  graphql "$Q" | jq -r '.data.addProjectV2ItemById.item.id'
}

set_status () {
  local ITEM_ID="$1" OPTION_ID="$2" Q
  Q=$(jq -n --arg p "$PROJECT_ID" --arg i "$ITEM_ID" --arg f "$STATUS_FIELD_ID" --arg o "$OPTION_ID"     '{query:"mutation($project:ID!,$item:ID!,$field:ID!,$optionID:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$optionID}}){clientMutationId}}",
      variables:{project:$p,item:$i,field:$f,optionID:$o}}')
  graphql "$Q" >/dev/null
}

comment_issue () { rest_post "$GH_API/repos/$1/$2/issues/$3/comments" "$(jq -nc --arg b "$4" '{body:$b}')" >/dev/null; }
patch_issue_body () { rest_patch "$GH_API/repos/$1/$2/issues/$3" "$(jq -nc --arg b "$4" '{body:$b}')" >/dev/null; }

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

snapshot_to_docs () { # owner repo num body
  [[ "${REFINE_WRITE_DOCS:-0}" == "1" ]] || return 0
  mkdir -p docs/refinements
  chmod u+w docs docs/refinements 2>/dev/null || true
  local owner="$1" repo="$2" num="$3" body="$4"
  local title slug
  title="$(echo "$body" | sed -n 's/^## Objetivo[[:space:]]*//p' | head -n1 | tr '[:upper:]' '[:lower:]')"
  slug="$(echo "${title:-refinamiento}" | tr -cs 'a-z0-9' '-' | sed 's/^-*//; s/-*$//' | cut -c1-40)"
  local md="docs/refinements/issue-${num}-${slug:-refinamiento}.md"
  {
    echo "# Refinamiento – Issue #${num}"
    echo
    echo "_Repositorio: ${owner}/${repo}_"
    echo
    printf "%s
" "$body"
  } > "$md"

  if [[ "${REFINE_DOCS_OPEN_PR:-1}" == "1" ]]; then
    local branch="docs/issue-${num}-${slug:-refinamiento}"
    git checkout -B "$branch" >/dev/null 2>&1 || true
    git add "$md" >/dev/null 2>&1 || true
    git commit -m "[auto][docs] Snapshot de refinamiento para #${num}" >/dev/null 2>&1 || true
    git push -u origin "$branch" >/dev/null 2>&1 || true
    local pr_url
    pr_url=$(curl -fsS -X POST "$GH_API/repos/$owner/$repo/pulls"       -H "Authorization: Bearer $GITHUB_TOKEN" -H "$ACCEPT_V3" -H "$API_VER"       -d "$(jq -nc --arg t "[auto][docs] Refinamiento #$num" --arg h "$branch" --arg base "main" --arg b "Closes #$num" '{title:$t,head:$h,base:$base,body:$b}')"       | jq -r '.html_url // empty')
    if [[ -n "$pr_url" ]]; then
      comment_issue "$owner" "$repo" "$num" "codex: snapshot de refinamiento agregado a \`$md\` y PR abierto → $pr_url" || true
    else
      comment_issue "$owner" "$repo" "$num" "codex: snapshot de refinamiento agregado a \`$md\`, no pude abrir el PR automático." || true
    fi
  else
    comment_issue "$owner" "$repo" "$num" "codex: snapshot de refinamiento agregado a \`$md\`." || true
  fi
}

process_issue () {
  local owner="$1" repo="$2" num="$3" node_id="$4" item_id="$5"
  [[ -z "$item_id" || "$item_id" == "null" ]] && item_id="$(add_to_project "$node_id" || true)"

  if ! set_status "$item_id" "$STATUS_OPTION_INPROGRESS"; then
    comment_issue "$owner" "$repo" "$num" "codex: no pude mover a **In Progress**. Marco **Blocked**. Verificá IDs/permiso."
    set_status "$item_id" "$STATUS_OPTION_BLOCKED" || true
    return 1
  fi

  # Idempotencia: si ya tiene plantilla, sólo dejar constancia y no duplicar
  local issue_json body_text
  issue_json="$(rest_get "$GH_API/repos/$owner/$repo/issues/$num")" || true
  body_text="$(echo "$issue_json" | jq -r '.body // ""')"
  if echo "$body_text" | grep -qiE '^## Objetivo' &&      echo "$body_text" | grep -qiE '^## Contexto' &&      echo "$body_text" | grep -qiE '^## Cambios requeridos' &&      echo "$body_text" | grep -qiE '^## Criterios de aceptación' &&      echo "$body_text" | grep -qiE '^## Notas técnicas'; then
    comment_issue "$owner" "$repo" "$num" "codex: ya estaba refinado previamente. Omito para no duplicar contenido." || true
    set_status "$item_id" "$STATUS_OPTION_TODO" || true
    return 0
  fi

  local body; body="$(refinement_template)"
  comment_issue "$owner" "$repo" "$num" "codex (refinamiento):

$body" || true
  patch_issue_body "$owner" "$repo" "$num" "$body" || true

  snapshot_to_docs "$owner" "$repo" "$num" "$body"

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
