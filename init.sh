#!/usr/bin/env bash
# INIT_VERSION=2025-10-05 docs-first refine/work (autodiscover + jq fixes)
set -euo pipefail

GH_API="https://api.github.com"
ACCEPT_V3="Accept: application/vnd.github.v3+json"
ACCEPT_GRAPHQL="Content-Type: application/json"
API_VER="X-GitHub-Api-Version: 2022-11-28"

: "${ORG:=intrale}"
: "${PROJECT_ID:=PVT_kwDOBTzBoc4AyMGf}"
: "${REFINE_WRITE_DOCS:=1}"
: "${REFINE_DOCS_OPEN_PR:=1}"
: "${ENFORCE_READONLY:=0}"
: "${BATCH_MAX:=10}"

log()  { echo -e "ℹ️  $*"; }
ok()   { echo -e "✅ $*"; }
warn() { echo -e "⚠️  $*"; }
err()  { echo -e "❌ $*" >&2; }

normalize() {
  tr '[:upper:]' '[:lower:]' | sed     -e 's/[áàä]/a/g' -e 's/[éèë]/e/g' -e 's/[íìï]/i/g'     -e 's/[óòö]/o/g' -e 's/[úùü]/u/g' -e 's/ñ/n/g'
}

detect_intent() {
  local utterance norm
  utterance="$*"
  norm="$(printf '%s' "$utterance" | normalize | xargs)"
  if echo "$norm" | grep -Eq '^refinar (todas )?(las )?(historias|tareas|issues)( pendientes)?( en (estado )?todo)?( del tablero( intrale)?)?$'      || echo "$norm" | grep -Eq '^refinar todo$'; then
    echo "INTENT=REFINE_ALL_TODO"; return 0
  fi
  if echo "$norm" | grep -Eq '^trabajar (todas )?(las )?(historias|tareas|issues)( pendientes)?( en (estado )?todo)?( del tablero( intrale)?)?$'      || echo "$norm" | grep -Eq '^trabajar todo$'; then
    echo "INTENT=WORK_ALL_TODO"; return 0
  fi
  echo "INTENT=UNKNOWN"; return 1
}

need_token() {
  [[ -n "${GITHUB_TOKEN:-}" ]] || { err "Falta GITHUB_TOKEN (scopes: repo, project, read:org)"; exit 1; }
}

graphql() {
  local q="$1"
  curl -fsS "$GH_API/graphql"     -H "Authorization: Bearer $GITHUB_TOKEN"     -H "$ACCEPT_GRAPHQL" -H "$API_VER" -d "$q"
}

usage() {
  cat <<'EOF'
Uso:
  ./init.sh sanity
  ./init.sh intent "frase"
  ./init.sh discover
  ./init.sh auto
EOF
}

sanity() {
  need_token
  curl -fsS -H "$ACCEPT_V3" -H "$API_VER" -H "Authorization: Bearer $GITHUB_TOKEN" "$GH_API/user" >/dev/null
  curl -fsS -H "$ACCEPT_V3" -H "$API_VER" -H "Authorization: Bearer $GITHUB_TOKEN" "$GH_API/rate_limit" >/dev/null
  ok "Token OK y conectividad confirmada."
}

discover() {
  need_token
  : "${PROJECT_ID:?Falta PROJECT_ID}"
  local Q out FIELD
  Q=$(jq -n --arg id "$PROJECT_ID" '{
    query:"query($id:ID!){ node(id:$id){ ... on ProjectV2{ fields(first:50){ nodes{ __typename ... on ProjectV2SingleSelectField{ id name options{ id name } } } } } } }",
    variables:{id:$id}}')
  out="$(graphql "$Q")"
  FIELD="$(printf '%s' "$out" | jq -r '.data.node.fields.nodes[] | select(.name=="Status")')"

  {
    echo "export PROJECT_ID=$PROJECT_ID"
    echo "export STATUS_FIELD_ID=$(printf '%s' "$FIELD" | jq -r '.id')"
    echo "export STATUS_OPTION_TODO=$(printf '%s' "$FIELD" | jq -r '.options[] | select(.name=="Todo") | .id')"
    echo "export STATUS_OPTION_INPROGRESS=$(printf '%s' "$FIELD" | jq -r '.options[] | select(.name=="In Progress") | .id')"
    echo "export STATUS_OPTION_READY=$(printf '%s' "$FIELD" | jq -r '.options[] | select(.name=="Ready") | .id')"
    echo "export STATUS_OPTION_BLOCKED=$(printf '%s' "$FIELD" | jq -r '.options[] | select(.name=="Blocked") | .id')"
  } | tee .codex_env >/dev/null

  ok "IDs escritos en .codex_env"
}

post_refine_guard() {
  local changed bad
  changed="$(git status --porcelain | awk '{print $2}')"
  [[ -z "$changed" ]] && return 0
  bad="$(echo "$changed" | grep -Ev '^docs/(refinements/|$)' || true)"
  if [[ -n "$bad" ]]; then
    echo "❌ Desvío fuera de docs/refinements durante REFINE" >&2
    echo "$bad" | xargs -r git restore -q --worktree --staged -- || true
    git clean -fdq || true
    return 1
  fi
}

auto() {
  need_token
  local u="${CODEX_UTTERANCE:-}"
  [[ -n "$u" ]] || { warn "No hay CODEX_UTTERANCE"; exit 0; }

  if [[ ! -f .codex_env ]]; then
    echo "ℹ️  .codex_env no encontrado, ejecutando discover…"
    ./init.sh discover || { err "No pude obtener IDs del Project"; exit 1; }
  fi
  # shellcheck disable=SC1091
  source .codex_env

  local intent; intent="$(detect_intent "$u" || true)"
  case "$intent" in
    INTENT=REFINE_ALL_TODO)
      bash ./scripts/refine_all.sh
      post_refine_guard
      ;;
    INTENT=WORK_ALL_TODO)
      exec bash ./scripts/work_all.sh
      ;;
    *)
      warn "Intent no reconocido. Usá: 'refinar …' / 'trabajar …'"
      exit 0
      ;;
  esac
}

cmd="${1:-help}"
shift || true
case "$cmd" in
  sanity)   sanity ;;
  intent)   detect_intent "$@" ;;
  discover) discover ;;
  auto)     auto ;;
  *) usage; exit 1 ;;
esac
