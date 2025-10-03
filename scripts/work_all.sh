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

: "${WORK_OPEN_PR:=1}"   # SIEMPRE PR
: "${PR_BASE:=main}"
: "${WORK_USE_REFINEMENT_DOC:=1}"
: "${WORK_REQUIRE_REFINEMENT:=0}"
BATCH_MAX="${BATCH_MAX:-10}"

log(){ echo -e "ℹ️  $*"; }
ok(){ echo -e "✅ $*"; }
fail(){ echo -e "❌ $*" >&2; }

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

add_to_project () { local Q; Q=$(jq -n --arg p "$PROJECT_ID" --arg c "$1" '{query:"mutation($project:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$contentId}){item{id}}}",variables:{project:$p,contentId:$c}}'); graphql "$Q" | jq -r '.data.addProjectV2ItemById.item.id'; }
set_status () { local Q; Q=$(jq -n --arg p "$PROJECT_ID" --arg i "$1" --arg f "$STATUS_FIELD_ID" --arg o "$2" '{query:"mutation($project:ID!,$item:ID!,$field:ID!,$optionID:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$optionID}}){clientMutationId}}",variables:{project:$p,item:$i,field:$f,optionID:$o}}'); graphql "$Q" >/dev/null; }

find_refinement_md () {
  local num="$1" cand
  shopt -s nullglob
  for cand in "docs/refinements/issue-${num}-"*.md "./docs/refinements/issue-${num}-"*.md; do
    [[ -f "$cand" ]] && { echo "$cand"; shopt -u nullglob; return 0; }
  done
  shopt -u nullglob
  return 1
}

branch_name () {
  local title="$1" num="$2"
  local slug
  slug="$(echo "$title" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' )"
  slug="$(echo "$slug" | sed 's/^-*//; s/-*$//')"
  printf 'auto/issue-%s-%s' "$num" "$(echo "$slug" | cut -c1-40)"
}

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

create_commit_for_issue () {
  local owner="$1" repo="$2" num="$3" title="$4" md_ref="$5"
  local branch pr_file
  branch="$(branch_name "$title" "$num")"
  ensure_git_setup
  ensure_remote_url "$owner" "$repo"

  git checkout -B "$branch" >/dev/null 2>&1 || git checkout -b "$branch" >/dev/null 2>&1

  mkdir -p docs/work
  pr_file="docs/work/issue-${num}-worklog.md"
  {
    echo "# Worklog – Issue #$num"
    echo
    echo "Título: $title"
    echo
    if [[ -n "$md_ref" ]]; then
      echo "- Refinamiento: \`$md_ref\`"
    else
      echo "- Refinamiento: (no encontrado)"
    fi
    echo "- Checklist (inicial):"
    echo "  - [ ] Implementación"
    echo "  - [ ] Pruebas"
    echo "  - [ ] Documentación"
  } > "$pr_file"

  git add "$pr_file"
  git commit -m "chore(worklog): issue #${num} – ${title}" >/dev/null
  git push -u origin "$branch" >/dev/null
  echo "$branch"
}

open_pr () {
  local owner="$1" repo="$2" head_branch="$3" title="$4" body="$5"
  rest_post "$GH_API/repos/$owner/$repo/pulls"     "$(jq -nc --arg t "$title" --arg h "$head_branch" --arg b "$body" --arg base "${PR_BASE}" '{title:$t, head:$h, base:$base, body:$b}')"     | jq -r '.html_url'
}

compose_pr_body () {
  local num="$1" md="$2"
  if [[ -n "$md" ]]; then
    printf "Closes #%s

Documentación de refinamiento: \`%s\`" "$num" "$md"
  else
    printf "Closes #%s

(Refinamiento no encontrado; se completará durante el PR)." "$num"
  fi
}

process_issue () {
  local owner="$1" repo="$2" num="$3" issue_node_id="$4" item_id="$5" title="$6"
  log "→ Issue #$num ($owner/$repo)  item_id=$item_id  issueNode=$issue_node_id"

  if [[ -z "$item_id" || "$item_id" == "null" ]]; then
    log "  · itemId vacío: añadiendo al Project…"
    item_id="$(add_to_project "$issue_node_id" || true)"
    log "  · nuevo item_id=$item_id"
  fi

  log "  · moviendo a In Progress…"
  if ! set_status "$item_id" "$STATUS_OPTION_INPROGRESS"; then
    fail "  · no pude mover a In Progress → Blocked"
    set_status "$item_id" "$STATUS_OPTION_BLOCKED" || true
    issue_comment "$owner" "$repo" "$num" "codex: no pude mover a In Progress (mutación GraphQL). Marco Blocked."
    return 1
  fi

  local md=""; [[ "${WORK_USE_REFINEMENT_DOC}" == "1" ]] && md="$(find_refinement_md "$num" || true)"
  issue_comment "$owner" "$repo" "$num" "$(if [[ -n "$md" ]]; then printf "codex: iniciando trabajo. Se usará \`%s\`." "$md"; else printf "codex: iniciando trabajo sin snapshot de refinamiento."; fi)"

  local branch pr_url pr_title pr_body
  branch="$(create_commit_for_issue "$owner" "$repo" "$num" "$title" "$md")"
  pr_title="[auto] $title"
  pr_body="$(compose_pr_body "$num" "$md")"
  log "  · abriendo PR desde rama $branch…"
  pr_url="$(open_pr "$owner" "$repo" "$branch" "$pr_title" "$pr_body" || echo "")"
  if [[ -n "$pr_url" ]]; then
    ok  "  · PR: $pr_url"
    issue_comment "$owner" "$repo" "$num" "codex: PR abierto → ${pr_url}"
    if [[ -n "${STATUS_OPTION_READY}" ]]; then
      log "  · moviendo a Ready…"
      set_status "$item_id" "$STATUS_OPTION_READY" || true
    fi
    return 0
  fi

  fail "  · no pude abrir PR → regreso a Todo"
  set_status "$item_id" "$STATUS_OPTION_TODO" || true
  issue_comment "$owner" "$repo" "$num" "codex: no pude abrir PR. Vuelvo a Todo."
}

main() {
  local count=0
  list_todo_items | while IFS=$'\t' read -r owner repo num issue_node item_id title; do
    process_issue "$owner" "$repo" "$num" "$issue_node" "$item_id" "$title" || true
    count=$((count+1))
    [[ $count -ge $BATCH_MAX ]] && break
  done
}
main "$@"
