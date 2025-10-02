#!/usr/bin/env bash

set -euo pipefail
set -o errtrace

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

ORG="${ORG:-intrale}"
API_URL="${API_URL:-https://api.github.com}"
GRAPHQL_ENDPOINT="$API_URL/graphql"
API_VERSION_HEADER="X-GitHub-Api-Version: 2022-11-28"
ACCEPT_HEADER="Accept: application/vnd.github+json"
CONTENT_TYPE_JSON="Content-Type: application/json"

PROJECT_ID="${PROJECT_ID:-}" 
STATUS_FIELD_ID="${STATUS_FIELD_ID:-}"
STATUS_OPTION_BACKLOG="${STATUS_OPTION_BACKLOG:-}"
STATUS_OPTION_TODO="${STATUS_OPTION_TODO:-}"
STATUS_OPTION_INPROGRESS="${STATUS_OPTION_INPROGRESS:-}"
STATUS_OPTION_READY="${STATUS_OPTION_READY:-}"
STATUS_OPTION_DONE="${STATUS_OPTION_DONE:-}"
STATUS_OPTION_BLOCKED="${STATUS_OPTION_BLOCKED:-}"
BATCH_MAX="${BATCH_MAX:-20}"

AUTHORIZATION_HEADER=""

log_info() {
  echo "ℹ️  $*"
}

log_success() {
  echo "✅ $*"
}

log_warn() {
  echo "⚠️  $*" >&2
}

log_error() {
  echo "❌ $*" >&2
}

require_cmd() {
  local cmd
  for cmd in "$@"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      log_error "El comando requerido '$cmd' no está disponible en el sistema."
      exit 1
    fi
  done
}

require_env() {
  local name
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then
      log_error "La variable de entorno '$name' es obligatoria para esta operación."
      exit 1
    fi
  done
}

perform_request() {
  local method="$1"
  local url="$2"
  local data="${3:-}"

  require_env AUTHORIZATION_HEADER

  local full_url="$url"
  if [[ ! "$full_url" =~ ^https?:// ]]; then
    full_url="$API_URL$url"
  fi

  local args=(-sS -w '\n%{http_code}' -H "$ACCEPT_HEADER" -H "$API_VERSION_HEADER" -H "$AUTHORIZATION_HEADER")

  if [ "$method" != "GET" ]; then
    args+=(-H "$CONTENT_TYPE_JSON" -X "$method" --data "$data")
  fi

  curl "${args[@]}" "$full_url"
}

split_http_response() {
  local response="$1"
  local status
  status="$(printf '%s' "$response" | tail -n1)"
  local body
  body="$(printf '%s' "$response" | sed '$d')"
  printf '%s\n%s' "$body" "$status"
}

rest_get() {
  local path="$1"
  local response
  response="$(perform_request "GET" "$path")"
  split_http_response "$response"
}

rest_post() {
  local path="$1"
  local payload="$2"
  local response
  response="$(perform_request "POST" "$path" "$payload")"
  split_http_response "$response"
}

rest_patch() {
  local path="$1"
  local payload="$2"
  local response
  response="$(perform_request "PATCH" "$path" "$payload")"
  split_http_response "$response"
}

graphql() {
  local query="$1"
  local variables_json="${2:-}"

  require_env AUTHORIZATION_HEADER

  local payload
  if [ -n "$variables_json" ]; then
    payload="$(jq -cn --arg query "$query" --argjson variables "$variables_json" '{query:$query, variables:$variables}')"
  else
    payload="$(jq -cn --arg query "$query" '{query:$query}')"
  fi

  local response
  response="$(curl -sS -w '\n%{http_code}' \
    -H "$ACCEPT_HEADER" \
    -H "$API_VERSION_HEADER" \
    -H "$CONTENT_TYPE_JSON" \
    -H "$AUTHORIZATION_HEADER" \
    --data "$payload" \
    "$GRAPHQL_ENDPOINT")"

  local body status
  read -r body status < <(split_http_response "$response")

  if [ "$status" != "200" ]; then
    log_error "GraphQL respondió con estado HTTP $status: $body"
    return 1
  fi

  if jq -e '.errors and (.errors | length > 0)' >/dev/null 2>&1 <<<"$body"; then
    local message
    message="$(jq -r '.errors[]?.message' <<<"$body" | paste -sd '; ' -)"
    log_error "GraphQL devolvió errores: $message"
    return 1
  fi

  printf '%s' "$body"
}

determine_auth_header() {
  require_env GITHUB_TOKEN

  local attempts=("Bearer" "token")
  local prefix
  for prefix in "${attempts[@]}"; do
    local response status body
    response="$(curl -sS -w '\n%{http_code}' \
      -H "$ACCEPT_HEADER" \
      -H "$API_VERSION_HEADER" \
      -H "Authorization: $prefix $GITHUB_TOKEN" \
      "$API_URL/user")"

    read -r body status < <(split_http_response "$response")

    if [ "$status" = "200" ]; then
      AUTHORIZATION_HEADER="Authorization: $prefix $GITHUB_TOKEN"
      local login
      login="$(jq -r '.login // empty' <<<"$body")"
      if [ -n "$login" ]; then
        log_success "Autenticado como $login (modo $prefix)."
      else
        log_success "Autenticación exitosa (modo $prefix)."
      fi
      return 0
    fi
  done

  log_error "No se pudo autenticar con el token proporcionado. Verifica permisos y vigencia."
  exit 1
}

sanity_checks() {
  require_cmd curl jq
  determine_auth_header

  local body status

  read -r body status < <(rest_get "/rate_limit")
  if [ "$status" != "200" ]; then
    log_error "Fallo la verificación de /rate_limit (HTTP $status)."
    exit 1
  fi
  local remaining
  remaining="$(jq -r '.resources.core.remaining // empty' <<<"$body")"
  log_info "Límite de peticiones restante: ${remaining:-desconocido}."
}

install_android_sdk() {
  log_info "Instalando Android SDK..."

  local ANDROID_SDK_ROOT="/workspace/android-sdk"
  mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools"

  pushd "$ANDROID_SDK_ROOT/cmdline-tools" >/dev/null
  curl -sS -o commandlinetools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  unzip -oq commandlinetools.zip
  rm -f commandlinetools.zip
  rm -rf latest
  mv cmdline-tools latest
  popd >/dev/null

  export ANDROID_HOME="$ANDROID_SDK_ROOT"
  export ANDROID_SDK_ROOT="$ANDROID_SDK_ROOT"
  export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

  yes | sdkmanager --licenses >/dev/null
  yes | sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0" >/dev/null

  log_success "Android SDK instalado correctamente."
}

discover_status_options() {
  sanity_checks
  require_env PROJECT_ID

  log_info "Consultando campos del Project ($PROJECT_ID)..."

  local query='query($id:ID!){node(id:$id){... on ProjectV2{fields(first:100){nodes{__typename id name ... on ProjectV2SingleSelectField{options{ id name }}}}}}}'
  local variables
  variables="{\"id\":\"$PROJECT_ID\"}"

  local body
  if ! body="$(graphql "$query" "$variables")"; then
    exit 1
  fi

  local status_field
  status_field="$(jq -r '.data.node.fields.nodes[] | select(.name == "Status" and .__typename == "ProjectV2SingleSelectField") | .id' <<<"$body")"

  if [ -z "$status_field" ]; then
    log_error "No se encontró el campo 'Status' en el Project indicado."
    exit 1
  fi

  echo "STATUS_FIELD_ID=$status_field"

  declare -A expected=(
    ["Backlog"]="STATUS_OPTION_BACKLOG"
    ["Todo"]="STATUS_OPTION_TODO"
    ["To Do"]="STATUS_OPTION_TODO"
    ["In Progress"]="STATUS_OPTION_INPROGRESS"
    ["Ready"]="STATUS_OPTION_READY"
    ["Done"]="STATUS_OPTION_DONE"
    ["Blocked"]="STATUS_OPTION_BLOCKED"
  )

  local option_name option_id var_name
  while IFS=$'\t' read -r option_name option_id; do
    var_name="${expected[$option_name]:-}"
    if [ -n "$var_name" ]; then
      printf '%s=%s\n' "$var_name" "$option_id"
      unset 'expected[$option_name]'
    fi
  done < <(jq -r '.data.node.fields.nodes[] | select(.name == "Status") | .options[] | [.name, .id] | @tsv' <<<"$body")

  if [ "${#expected[@]}" -gt 0 ]; then
    log_warn "Algunas opciones no fueron encontradas automáticamente: ${!expected[*]}"
  fi
}

add_to_project() {
  local content_id="$1"

  require_env PROJECT_ID STATUS_FIELD_ID

  local mutation='mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}'
  local variables
  variables="{\"project\":\"$PROJECT_ID\",\"content\":\"$content_id\"}"

  local body
  if ! body="$(graphql "$mutation" "$variables")"; then
    return 1
  fi

  jq -r '.data.addProjectV2ItemById.item.id // empty' <<<"$body"
}

find_project_item_id() {
  local issue_node_id="$1"

  require_env PROJECT_ID

  local query='query($issue:ID!){node(id:$issue){... on Issue{projectItems(first:50){nodes{id project{id}}}}}}'
  local variables
  variables="{\"issue\":\"$issue_node_id\"}"

  local body
  if ! body="$(graphql "$query" "$variables")"; then
    return 1
  fi

  jq -r --arg project "$PROJECT_ID" '.data.node.projectItems.nodes[] | select(.project.id == $project) | .id' <<<"$body"
}

set_status() {
  local item_id="$1"
  local option_id="$2"

  require_env PROJECT_ID STATUS_FIELD_ID

  local mutation='mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){clientMutationId}}'
  local variables
  variables="{\"project\":\"$PROJECT_ID\",\"item\":\"$item_id\",\"field\":\"$STATUS_FIELD_ID\",\"option\":\"$option_id\"}"

  if ! graphql "$mutation" "$variables" >/dev/null; then
    return 1
  fi
}

comment_issue() {
  local owner="$1"
  local repo="$2"
  local number="$3"
  local body="$4"

  local payload
  payload="$(jq -cn --arg body "$body" '{body:$body}')"

  local response
  response="$(rest_post "/repos/$owner/$repo/issues/$number/comments" "$payload")"

  local status
  status="$(printf '%s' "$response" | tail -n1)"
  local body_json
  body_json="$(printf '%s' "$response" | sed '$d')"

  if [[ ! "$status" =~ ^2 ]]; then
    log_error "No se pudo publicar el comentario en $owner/$repo#$number (HTTP $status)."
    log_error "$body_json"
    return 1
  fi
}

patch_issue_body() {
  local owner="$1"
  local repo="$2"
  local number="$3"
  local body="$4"

  local payload
  payload="$(jq -cn --arg body "$body" '{body:$body}')"

  local response
  response="$(rest_patch "/repos/$owner/$repo/issues/$number" "$payload")"

  local status
  status="$(printf '%s' "$response" | tail -n1)"
  local body_json
  body_json="$(printf '%s' "$response" | sed '$d')"

  if [[ ! "$status" =~ ^2 ]]; then
    log_error "No se pudo actualizar el body de $owner/$repo#$number (HTTP $status)."
    log_error "$body_json"
    return 1
  fi
}

get_issue_body() {
  local owner="$1"
  local repo="$2"
  local number="$3"

  local response
  response="$(rest_get "/repos/$owner/$repo/issues/$number")"

  local status
  status="$(printf '%s' "$response" | tail -n1)"
  local body_json
  body_json="$(printf '%s' "$response" | sed '$d')"

  if [ "$status" != "200" ]; then
    log_error "No se pudo obtener el issue $owner/$repo#$number (HTTP $status)."
    log_error "$body_json"
    return 1
  fi

  jq -r '.body // ""' <<<"$body_json"
}

refinement_template() {
  cat <<'TEMPLATE'
## Objetivo

## Contexto

## Cambios Propuestos

## Criterios de Aceptación

## Notas
- 
TEMPLATE
}

handle_issue_error() {
  local owner="$1"
  local repo="$2"
  local number="$3"
  local item_id="$4"
  local message="$5"

  log_error "$message"

  if [ -n "$item_id" ] && [ -n "${STATUS_OPTION_BLOCKED:-}" ]; then
    set_status "$item_id" "$STATUS_OPTION_BLOCKED" || true
  fi

  local body="⚠️ Refinamiento automático falló:\n\n```\n$message\n```"
  comment_issue "$owner" "$repo" "$number" "$body" || true
}

process_issue() {
  local owner="$1"
  local repo="$2"
  local number="$3"
  local node_id="$4"
  local existing_item_id="${5:-}"

  require_env PROJECT_ID STATUS_FIELD_ID STATUS_OPTION_TODO STATUS_OPTION_INPROGRESS STATUS_OPTION_BLOCKED

  log_info "Procesando issue $owner/$repo#$number..."

  local item_id="$existing_item_id"

  if [ -z "$item_id" ] || [ "$item_id" = "-" ]; then
    item_id="$(find_project_item_id "$node_id")"
  fi

  if [ -z "$item_id" ]; then
    item_id="$(add_to_project "$node_id" || true)"
    if [ -z "$item_id" ]; then
      item_id="$(find_project_item_id "$node_id")"
    fi
  fi

  if [ -z "$item_id" ]; then
    handle_issue_error "$owner" "$repo" "$number" "" "No se pudo obtener el item del Project para el issue."
    return 1
  fi

  if ! set_status "$item_id" "$STATUS_OPTION_INPROGRESS"; then
    handle_issue_error "$owner" "$repo" "$number" "$item_id" "No fue posible mover el item a In Progress."
    return 1
  fi

  local original_body
  if ! original_body="$(get_issue_body "$owner" "$repo" "$number")"; then
    handle_issue_error "$owner" "$repo" "$number" "$item_id" "No se pudo obtener el contenido actual del issue."
    return 1
  fi

  local template
  template="$(refinement_template)"

  local new_body
  new_body="$(
    jq -rn --arg tpl "$template" --arg original "$original_body" '
      $tpl + "\n\n---\n\n### Historial previo\n\n" + $original
    '
  )"

  local comment
  comment="$template

---
_refinamiento aplicado automáticamente por init.sh (refine-batch)._"

  if ! comment_issue "$owner" "$repo" "$number" "$comment"; then
    handle_issue_error "$owner" "$repo" "$number" "$item_id" "No se pudo publicar el comentario de refinamiento."
    return 1
  fi

  if ! patch_issue_body "$owner" "$repo" "$number" "$new_body"; then
    handle_issue_error "$owner" "$repo" "$number" "$item_id" "No se pudo actualizar el body del issue."
    return 1
  fi

  if ! set_status "$item_id" "$STATUS_OPTION_TODO"; then
    handle_issue_error "$owner" "$repo" "$number" "$item_id" "No se pudo devolver el estado a Todo."
    return 1
  fi

  log_success "Refinamiento aplicado en $owner/$repo#$number."
}

refine_batch() {
  local tsv_file="$1"

  if [ ! -f "$tsv_file" ]; then
    log_error "El archivo TSV '$tsv_file' no existe."
    exit 1
  fi

  sanity_checks

  local processed=0
  while IFS=$'\t' read -r owner repo number node_id item_id; do
    [[ -z "$owner" || "$owner" =~ ^# ]] && continue

    process_issue "$owner" "$repo" "$number" "$node_id" "$item_id"
    processed=$((processed + 1))

    if [ "$processed" -ge "$BATCH_MAX" ]; then
      log_warn "Se alcanzó el límite BATCH_MAX=$BATCH_MAX."
      break
    fi
  done <"$tsv_file"

  log_info "Total procesado: $processed issues."
}

print_help() {
  cat <<'HELP'
Uso: ./init.sh [comando]

Comandos disponibles:
  android-sdk          Instala y configura el Android SDK como en versiones anteriores.
  sanity               Ejecuta las verificaciones de token y conectividad (/user, /rate_limit).
  discover             Obtiene STATUS_FIELD_ID y optionId del campo Status del Project v2.
  refine-batch <tsv>   Procesa un lote de issues en formato TSV (columnas: owner, repo, number, node_id, item_id).
  help                 Muestra esta ayuda.

Variables relevantes:
  GITHUB_TOKEN         Token con permisos de repo y project (obligatorio para comandos GitHub).
  PROJECT_ID           ID del Project v2 a utilizar.
  STATUS_FIELD_ID      ID del campo Status (descubierto automáticamente con discover).
  STATUS_OPTION_*      optionId correspondientes a cada estado (BACKLOG, TODO, INPROGRESS, READY, DONE, BLOCKED).
  BATCH_MAX            Máximo de issues por ejecución de refine-batch (default: 20).
HELP
}

main() {
  local command="${1:-android-sdk}"
  shift || true

  case "$command" in
    android-sdk)
      install_android_sdk
      ;;
    sanity)
      sanity_checks
      ;;
    discover)
      discover_status_options
      ;;
    refine-batch)
      if [ $# -lt 1 ]; then
        log_error "Debes indicar el archivo TSV a procesar."
        exit 1
      fi
      refine_batch "$1"
      ;;
    help|-h|--help)
      print_help
      ;;
    *)
      log_error "Comando desconocido: $command"
      print_help
      exit 1
      ;;
  esac
}

main "$@"
