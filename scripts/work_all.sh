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
: "${STATUS_OPTION_READY:=}"
: "${STATUS_OPTION_BLOCKED:?Falta STATUS_OPTION_BLOCKED}"

: "${WORK_OPEN_PR:=1}"
: "${PR_BASE:=main}"
BATCH_MAX="${BATCH_MAX:-10}"

: "${WORK_USE_REFINEMENT_DOC:=1}"
: "${WORK_REQUIRE_REFINEMENT:=0}"

graphql () { curl -fsS "$GH_API/graphql" -H "Authorization: Bearer $GITHUB_TOKEN" -H "$ACCEPT_GRAPHQL" -H "$API_VER" -d "$1"; }
rest_post () { curl -fsS -X POST "$1" -H "Authorization: Bearer $GITHUB_TOKEN" -H "$ACCEPT_V3" -H "$API_VER" -d "$2"; }

issue_comment () { rest_post "$GH_API/repos/$1/$2/issues/$3/comments" "$(jq -nc --arg b "$4" '{body:$b}')" >/dev/null; }

list_todo_items() {
  local Q out
  Q=$(jq -n --arg id "$PROJECT_ID" '{
    query:"query($id:ID!){ node(id:$id){ ... on ProjectV2{ items(first:100){ nodes{ id content{ __typename ... on Issue{ id number title repository{ name owner{ login } } } } fieldValueByName(name:\"Status\"){ ... on ProjectV2ItemFieldSingleSelectValue{ optionId } } } } } } }",
    variables:{id:$id}}')
  out="$(graphql "$Q")"
  printf '%s' "$out" | jq -r --arg opt "$STATUS_OPTION_TODO" '
    .data.node.items.nodes[] | select(.fieldValueByName.optionId==$opt)
    | select(.content.__typename=="Issue")
    | [.content.repository.owner.login, .content.repository.name, .content.number, .content.id, .id, .content.title] | @tsv'
}

add_to_project () { local Q; Q=$(jq -n --arg p "$PROJECT_ID" --arg c "$1" '{query:"mutation($project:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$contentId}){item{id}}}",variables:{project:$p,contentId:$c}}'); graphql "$Q" | jq -r '.data.addProjectV2ItemById.item.id'; }
set_status () { local Q; Q=$(jq -n --arg p "$PROJECT_ID" --arg i "$1" --arg f "$STATUS_FIELD_ID" --arg o "$2" '{query:"mutation($project:ID!,$item:ID!,$field:ID!,$optionID:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$optionID}}){clientMutationId}}",variables:{project:$p,item:$i,field:$f,optionID:$o}}'); graphql "$Q" >/dev/null; }

open_pr () { rest_post "$GH_API/repos/$1/$2/pulls" "$(jq -nc --arg t "$4" --arg h "$3" --arg b "$5" --arg base "${PR_BASE}" '{title:$t, head:$h, base:$base, body:$b}')" | jq -r '.html_url'; }

branch_name () {
  local title="$1" num="$2"
  local slug
  slug="$(echo "$title" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' )"
  slug="$(echo "$slug" | sed 's/^-*//; s/-*$//')"
  printf 'feature/issue-%s-%s' "$num" "$(echo "$slug" | cut -c1-40)"
}

find_refinement_md () {
  local num="$1" cand
  shopt -s nullglob
  for cand in "docs/refinements/issue-${num}-"*.md "./docs/refinements/issue-${num}-"*.md; do
    [[ -f "$cand" ]] && { echo "$cand"; shopt -u nullglob; return 0; }
  done
  shopt -u nullglob
  return 1
}

compose_pr_body () {
  local num="$1" md body
  if [[ "${WORK_USE_REFINEMENT_DOC}" == "1" ]]; then
    md="$(find_refinement_md "$num" || true)"
    if [[ -n "$md" && -f "$md" ]]; then
      echo "ℹ️  Picked refinement MD: $md" >&2
      PR_TITLE_SUFFIX="[uses-refinement]"
      body="Closes #${num}

---
**Refinamiento**: \`${md}\`

$(sed -e 's/\r$//' "$md")"
      printf "%s" "$body"
      return 0
    fi
  fi
  PR_TITLE_SUFFIX=""
  printf "Closes #%s" "$num"
}

process_issue () {
  local owner="$1" repo="$2" num="$3" node_id="$4" item_id="$5" title="$6"
  [[ -z "$item_id" || "$item_id" == "null" ]] && item_id="$(add_to_project "$node_id" || true)"

  if ! set_status "$item_id" "$STATUS_OPTION_INPROGRESS"; then
    set_status "$item_id" "$STATUS_OPTION_BLOCKED" || true
    issue_comment "$owner" "$repo" "$num" "codex: no pude mover a In Progress, queda en Blocked."
    return 1
  fi

  if [[ "${WORK_REQUIRE_REFINEMENT}" == "1" ]]; then
    if ! find_refinement_md "$num" >/dev/null 2>&1; then
      set_status "$item_id" "$STATUS_OPTION_BLOCKED" || true
      issue_comment "$owner" "$repo" "$num" "codex: no hay documento de refinamiento (.md). Marco Blocked."
      return 1
    fi
  fi

  if [[ "${WORK_OPEN_PR}" == "1" ]]; then
    local branch pr_url pr_body pr_title
    branch="$(branch_name "$title" "$num")"
    pr_body="$(compose_pr_body "$num")"
    if [[ -n "${PR_TITLE_SUFFIX:-}" ]]; then
      pr_title="[auto][uses-refinement] $title"
    else
      pr_title="[auto] $title"
    fi
    pr_url="$(open_pr "$owner" "$repo" "$branch" "$pr_title" "$pr_body" || echo "")"
    if [[ -n "$pr_url" ]]; then
      issue_comment "$owner" "$repo" "$num" "codex: PR abierto → ${pr_url}"
      [[ -n "${STATUS_OPTION_READY}" ]] && set_status "$item_id" "$STATUS_OPTION_READY" || true
      return 0
    fi
  fi

  set_status "$item_id" "$STATUS_OPTION_TODO" || true
  issue_comment "$owner" "$repo" "$num" "codex: no pude abrir PR. Vuelvo a Todo."
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
