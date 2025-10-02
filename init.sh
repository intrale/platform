#!/usr/bin/env bash
# INIT_VERSION=2025-10-02-router-min
set -euo pipefail

GH_API="https://api.github.com"
ACCEPT_V3="Accept: application/vnd.github.v3+json"
ACCEPT_GRAPHQL="Content-Type: application/json"
API_VER="X-GitHub-Api-Version: 2022-11-28"

: "${ORG:=intrale}"
: "${PROJECT_ID:=PVT_kwDOBTzBoc4AyMGf}"   # Ajustar si cambia

log()  { echo -e "ℹ️  $*"; }
ok()   { echo -e "✅ $*"; }
warn() { echo -e "⚠️  $*"; }
err()  { echo -e "❌ $*" >&2; }

normalize() {
  tr '[:upper:]' '[:lower:]' | sed \
    -e 's/[áàä]/a/g' -e 's/[éèë]/e/g' -e 's/[íìï]/i/g' \
    -e 's/[óòö]/o/g' -e 's/[úùü]/u/g' -e 's/ñ/n/g'
}

detect_intent() {
  local utterance norm
  utterance="$*"
  norm="$(printf '%s' "$utterance" | normalize | xargs)"
  if echo "$norm" | grep -Eq '^refinar (todas )?(las )?(historias|tareas|issues)( pendientes)?( en (estado )?todo)?( del tablero( intrale)?)?$' \
     || echo "$norm" | grep -Eq '^refinar todo$'; then
    echo "INTENT=REFINE_ALL_TODO"; return 0
  fi
  if echo "$norm" | grep -Eq '^trabajar (todas )?(las )?(historias|tareas|issues)( pendientes)?( en (estado )?todo)?( del tablero( intrale)?)?$' \
     || echo "$norm" | grep -Eq '^trabajar todo$'; then
    echo "INTENT=WORK_ALL_TODO"; return 0
  fi
  echo "INTENT=UNKNOWN"; return 1
}

need_token() {
  if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    err "Falta GITHUB_TOKEN (PAT con scopes: repo, workflow, project, read:org)."
    exit 1
  fi
}

graphql() {
  local q="$1"
  curl -fsS "$GH_API/graphql" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "$ACCEPT_GRAPHQL" -H "$API_VER" -d "$q"
}

usage() {
  cat <<'EOF'
Uso:
  ./init.sh help
  ./init.sh sanity          -> valida token y conectividad
  ./init.sh intent "frase"  -> muestra el intent detectado (REFINE_ALL_TODO / WORK_ALL_TODO)
  ./init.sh discover        -> imprime STATUS_FIELD_ID y optionId del campo Status (Project v2)
  ./init.sh auto            -> autodetecta intent desde CODEX_UTTERANCE y despacha scripts

Notas:
- Este init es un shim: por defecto no hace acciones costosas ni instala toolchains.
- Los scripts reales viven en ./scripts/refine_all.sh y ./scripts/work_all.sh
EOF
}

sanity() {
  need_token
  log "Validando token/conectividad…"
  curl -fsS -H "$ACCEPT_V3" -H "$API_VER" -H "Authorization: Bearer $GITHUB_TOKEN" "$GH_API/user" >/dev/null
  curl -fsS -H "$ACCEPT_V3" -H "$API_VER" -H "Authorization: Bearer $GITHUB_TOKEN" "$GH_API/rate_limit" >/dev/null
  ok "Token OK y conectividad confirmada."
}

discover() {
  need_token
  : "${PROJECT_ID:?Falta PROJECT_ID}"
  log "Descubriendo IDs de Status en Project ($PROJECT_ID)…"
  local Q out FIELD
  Q=$(jq -n --arg id "$PROJECT_ID" '{query:"query($id:ID!){ node(id:$id){ ... on ProjectV2{ fields(first:50){ nodes{ __typename ... on ProjectV2SingleSelectField{ id name options{ id name } } } } } } }",variables:{id:$id}}')
  out="$(graphql "$Q")"
  FIELD="$(printf '%s' "$out" | jq -r '.data.node.fields.nodes[] | select(.name=="Status")')"

  echo "STATUS_FIELD_ID=$(printf '%s' "$FIELD" | jq -r '.id')"
  echo "STATUS_OPTION_BACKLOG=$(printf '%s' "$FIELD" | jq -r '.options[] | select(.name=="Backlog") | .id')"
  echo "STATUS_OPTION_TODO=$(printf '%s' "$FIELD" | jq -r '.options[] | select(.name=="Todo") | .id')"
  echo "STATUS_OPTION_INPROGRESS=$(printf '%s' "$FIELD" | jq -r '.options[] | select(.name=="In Progress") | .id')"
  echo "STATUS_OPTION_READY=$(printf '%s' "$FIELD" | jq -r '.options[] | select(.name=="Ready") | .id')"
  echo "STATUS_OPTION_DONE=$(printf '%s' "$FIELD" | jq -r '.options[] | select(.name=="Done") | .id')"
  echo "STATUS_OPTION_BLOCKED=$(printf '%s' "$FIELD" | jq -r '.options[] | select(.name=="Blocked") | .id')"
  ok "Listo."
}

auto() {
  need_token
  local u="${CODEX_UTTERANCE:-}"
  if [[ -z "$u" ]]; then
    warn "No hay CODEX_UTTERANCE; no se ejecuta nada."
    exit 0
  fi
  local intent
  intent="$(detect_intent "$u" || true)"
  case "$intent" in
    INTENT=REFINE_ALL_TODO) exec bash ./scripts/refine_all.sh ;;
    INTENT=WORK_ALL_TODO)   exec bash ./scripts/work_all.sh ;;
    *) warn "Intent no reconocido. Frases válidas: 'refinar ...' / 'trabajar ...'"; exit 0 ;;
  esac
}

cmd="${1:-help}"
shift || true
case "$cmd" in
  help) usage ;;
  sanity) sanity ;;
  intent) detect_intent "$@" ;;
  discover) discover ;;
  auto) auto ;;
  *) warn "Comando desconocido: $cmd"; usage; exit 1 ;;
esac
