#!/usr/bin/env bash
# INIT for Codex – routes intents and discovers Project v2 Status IDs
set -euo pipefail

GH_API="https://api.github.com"
ACCEPT_V3="Accept: application/vnd.github.v3+json"
ACCEPT_GRAPHQL="Content-Type: application/json"
API_VER="X-GitHub-Api-Version: 2022-11-28"

: "${ORG:=intrale}"
: "${PROJECT_ID:=PVT_kwDOBTzBoc4AyMGf}"

log(){ echo -e "ℹ️  $*"; }
ok(){ echo -e "✅ $*"; }
fail(){ echo -e "❌ $*" >&2; }

normalize() { tr '[:upper:]' '[:lower:]' | sed -e 's/[áàä]/a/g' -e 's/[éèë]/e/g' -e 's/[íìï]/i/g' -e 's/[óòö]/o/g' -e 's/[úùü]/u/g' -e 's/ñ/n/g'; }

detect_intent(){
  local utterance norm
  utterance="${*:-}"
  norm="$(printf '%s' "$utterance" | normalize | xargs)"
  if echo "$norm" | grep -Eq '^refinar (todas )?(las )?(historias|tareas|issues)( pendientes)?'; then
    echo "INTENT=REFINE_ALL_TODO"; return 0
  fi
  if echo "$norm" | grep -Eq '^trabajar (todas )?(las )?(historias|tareas|issues)( pendientes)?'; then
    echo "INTENT=WORK_ALL_TODO"; return 0
  fi
  if echo "$norm" | grep -Eq '^(probar|testear|validar) (el )?ambiente|^self ?test$|^probar entorno$'; then
    echo "INTENT=SELF_TEST"; return 0
  fi
  echo "INTENT=UNKNOWN"; return 1
}

usage(){
  cat <<'EOF'
Uso:
  ./init.sh sanity
  ./init.sh discover
  ./init.sh intent "frase en lenguaje natural"
  ./init.sh auto   # usa CODEX_UTTERANCE
  ./init.sh selftest
EOF
  exit 0
}

sanity(){
  [[ -n "${GITHUB_TOKEN:-}" ]] || { fail "Falta GITHUB_TOKEN"; exit 1; }
  curl -fsS -H "$ACCEPT_V3" -H "$API_VER" -H "Authorization: Bearer $GITHUB_TOKEN" "$GH_API/user" >/dev/null
  curl -fsS -H "$ACCEPT_V3" -H "$API_VER" -H "Authorization: Bearer $GITHUB_TOKEN" "$GH_API/rate_limit" >/dev/null
  ok "Token OK y rate limit accesible"
}

discover(){
  set -euo pipefail
  [[ -n "${GITHUB_TOKEN:-}" ]] || { fail "Falta GITHUB_TOKEN"; exit 1; }
  : "${PROJECT_ID:?Falta PROJECT_ID}"

  local Q out FIELD status_field_id status_todo status_inprogress status_ready status_blocked
  Q=$(jq -n --arg id "$PROJECT_ID" '{
    query: "query($id:ID!){ node(id:$id){ ... on ProjectV2{ fields(first:50){ nodes{ __typename ... on ProjectV2SingleSelectField{ id name options{ id name } } } } } } }",
    variables:{id:$id}}')

  out="$(curl -fsS "$GH_API/graphql" -H "Authorization: Bearer $GITHUB_TOKEN" -H "$ACCEPT_GRAPHQL" -H "$API_VER" -d "$Q")"

  FIELD="$(printf '%s\n' "$out" | jq -e -r '.data.node.fields.nodes[] | select(.name=="Status")')"

  status_field_id="$(printf '%s\n' "$FIELD" | jq -e -r '.id')"
  status_todo="$(printf '%s\n' "$FIELD" | jq -e -r '.options[] | select(.name=="Todo") | .id')"
  status_inprogress="$(printf '%s\n' "$FIELD" | jq -e -r '.options[] | select(.name=="In Progress") | .id')"
  status_ready="$(printf '%s\n' "$FIELD" | jq -r '.options[] | select(.name=="Ready") | .id // ""')"
  status_blocked="$(printf '%s\n' "$FIELD" | jq -e -r '.options[] | select(.name=="Blocked") | .id')"

  for v in status_field_id status_todo status_inprogress status_blocked; do
    [[ -n "${!v}" && "${!v}" != "null" ]] || { fail "discover: valor vacío en $v"; exit 1; }
  done

  {
    echo "export PROJECT_ID=$PROJECT_ID"
    echo "export STATUS_FIELD_ID=$status_field_id"
    echo "export STATUS_OPTION_TODO=$status_todo"
    echo "export STATUS_OPTION_INPROGRESS=$status_inprogress"
    echo "export STATUS_OPTION_READY=$status_ready"
    echo "export STATUS_OPTION_BLOCKED=$status_blocked"
  } | tee .codex_env >/dev/null

  ok "IDs escritos en .codex_env"
}

auto(){
  [[ -n "${GITHUB_TOKEN:-}" ]] || { fail "Falta GITHUB_TOKEN"; exit 1; }
  local u="${CODEX_UTTERANCE:-}"
  [[ -n "$u" ]] || { log "Sin CODEX_UTTERANCE"; exit 0; }
  [[ -f .codex_env ]] || { log "Sin .codex_env → discover..."; ./init.sh discover; }
  # shellcheck disable=SC1091
  source .codex_env
  local intent; intent="$(detect_intent "$u" || true)"
  case "$intent" in
    INTENT=WORK_ALL_TODO) exec bash ./scripts/work_all.sh ;;
    INTENT=REFINE_ALL_TODO) exec bash ./scripts/refine_all.sh ;;
    INTENT=SELF_TEST) exec bash ./scripts/self_test.sh ;;
    *) log "Intento no reconocido"; exit 0 ;;
  esac
}

selftest(){
  CODEX_UTTERANCE="probar ambiente" ./init.sh auto
}

cmd="${1:-usage}"; shift || true
case "$cmd" in
  sanity)   sanity ;;
  discover) discover ;;
  intent)   detect_intent "$@" ;;
  auto)     auto ;;
  selftest) selftest ;;
  *)        usage ;;
esac
