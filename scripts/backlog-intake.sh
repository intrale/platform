#!/usr/bin/env bash
set -euo pipefail

# Repo e issue actual
REPO="${GITHUB_REPOSITORY:-intrale/platform}"
ISSUE_NUMBER="${ISSUE_NUMBER:-${CODEX_ISSUE_NUMBER:-}}"

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "GITHUB_TOKEN no está definido" >&2
  exit 1
fi

if [ -z "$ISSUE_NUMBER" ]; then
  echo "ISSUE_NUMBER / CODEX_ISSUE_NUMBER no está definido" >&2
  exit 1
fi

GH_ACCEPT="Accept: application/vnd.github+json"
GH_VER="X-GitHub-Api-Version: 2022-11-28"
AUTH_HEADER="Authorization: Bearer ${GITHUB_TOKEN}"

echo "🔎 Leyendo body del issue #${ISSUE_NUMBER} en ${REPO}…"

BODY="$(curl -sS \
  -H "$GH_ACCEPT" \
  -H "$GH_VER" \
  -H "$AUTH_HEADER" \
  "https://api.github.com/repos/${REPO}/issues/${ISSUE_NUMBER}" | jq -r '.body')"

# Extraer bloque ```yaml``` del cuerpo
YAML_BLOCK="$(printf '%s\n' "$BODY" | sed -n '/```yaml/,/```/p' | sed '1d;$d')"

if [ -z "$YAML_BLOCK" ]; then
  echo "No se encontró bloque YAML en el issue #${ISSUE_NUMBER}" >&2
  exit 1
fi

TMP_YAML="$(mktemp)"
printf '%s\n' "$YAML_BLOCK" > "$TMP_YAML"

echo "✅ YAML extraído, creando issues y actualizando Project…"

python - "$TMP_YAML" << 'PY'
import os
import sys
import json
import requests
import yaml

# ----------------------------------------------------------------------
# Contexto / configuración
# ----------------------------------------------------------------------
yaml_path = sys.argv[1]
token = os.environ["GITHUB_TOKEN"]
repo_full = os.environ.get("GITHUB_REPOSITORY", "intrale/platform")
owner, repo = repo_full.split("/", 1)
intake_issue_number = os.environ.get("ISSUE_NUMBER") or os.environ.get("CODEX_ISSUE_NUMBER")
project_number = int(os.environ.get("GH_PROJECT_NUMBER", "1"))

REST_BASE = "https://api.github.com"

rest_headers = {
    "Authorization": f"Bearer {token}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}
graphql_headers = {
    "Authorization": f"Bearer {token}",
    "Content-Type": "application/json",
}

session = requests.Session()
session.headers.update(rest_headers)

with open(yaml_path, "r", encoding="utf-8") as f:
    data = yaml.safe_load(f) or {}

items = data.get("items", [])

def graphql(query: str, variables: dict):
    r = requests.post(
        "https://api.github.com/graphql",
        headers=graphql_headers,
        json={"query": query, "variables": variables},
    )
    r.raise_for_status()
    payload = r.json()
    if "errors" in payload:
        raise RuntimeError(f"GraphQL errors: {payload['errors']}")
    return payload["data"]

# ---------------------------------------------------------------------------
# Project + campo Status
# ---------------------------------------------------------------------------

def get_project_and_status(owner: str, number: int):
    query = """
    query($owner:String!,$number:Int!){
      user(login:$owner){
        projectV2(number:$number){
          id
          fields(first:50){
            nodes{
              __typename
              ... on ProjectV2SingleSelectField{
                id
                name
                options{ id name }
              }
            }
          }
        }
      }
      organization(login:$owner){
        projectV2(number:$number){
          id
          fields(first:50){
            nodes{
              __typename
              ... on ProjectV2SingleSelectField{
                id
                name
                options{ id name }
              }
            }
          }
        }
      }
    }
    """
    data = graphql(query, {"owner": owner, "number": number})

    proj = None
    if data.get("user") and data["user"].get("projectV2"):
        proj = data["user"]["projectV2"]
    if not proj and data.get("organization") and data["organization"].get("projectV2"):
        proj = data["organization"]["projectV2"]

    if not proj:
        raise RuntimeError("No se encontró el Project V2 para ese owner/number")

    fields = proj["fields"]["nodes"]
    status_field = None
    for f in fields:
        if f and f.get("name") == "Status":
            status_field = f
            break
    if not status_field:
        raise RuntimeError("No se encontró el campo Status en el Project")

    status_options = {opt["name"]: opt["id"] for opt in status_field["options"]}
    return proj["id"], status_field["id"], status_options

# Mapeo de label → columna de backlog
STATUS_BY_APP = {
    "app:client": "Backlog CLIENTE",
    "app:business": "Backlog NEGOCIO",
    "app:delivery": "Backlog DELIVERY",
}

def infer_app_label(labels):
    for l in labels:
        if l.startswith("app:"):
            return l
    return None

def issue_exists(title: str):
    """Evita duplicados buscando por título exacto en este repo."""
    url = f"{REST_BASE}/search/issues"
    q = f'repo:{owner}/{repo} "{title}" in:title'
    r = session.get(url, params={"q": q})
    r.raise_for_status()
    data = r.json()
    for it in data.get("items", []):
        if it["title"] == title:
            return it["number"], it["node_id"]
    return None, None

# ---------------------------------------------------------------------------
# Crear issues (o reutilizar existentes)
# ---------------------------------------------------------------------------

created = []

for item in items:
    iid = item["id"]
    raw_title = item["title"]
    title = f"{iid} – {raw_title}"
    body = item["body"]
    labels = list(item.get("labels", []))
    labels.append("from-intake")

    app_label = infer_app_label(labels)
    status_name = STATUS_BY_APP.get(app_label)

    existing_number, existing_node = issue_exists(title)
    if existing_number is not None:
        created.append({
            "id": iid,
            "number": existing_number,
            "status": "ya-existia",
            "app_label": app_label,
            "status_name": status_name,
            "node_id": existing_node,
            "project_item_id": None,
        })
        continue

    payload = {"title": title, "body": body, "labels": labels}
    r = session.post(f"{REST_BASE}/repos/{owner}/{repo}/issues", json=payload)
    r.raise_for_status()
    issue = r.json()
    created.append({
        "id": iid,
        "number": issue["number"],
        "status": "creada",
        "app_label": app_label,
        "status_name": status_name,
        "node_id": issue["node_id"],
        "project_item_id": None,
    })

if not created:
    print(json.dumps({"created": [], "comment": "No se encontraron items en el YAML"}))
    sys.exit(0)

project_id, status_field_id, status_options = get_project_and_status(owner, project_number)

# ---------------------------------------------------------------------------
# Utilidades Project V2: buscar/crear item y cambiar Status
# ---------------------------------------------------------------------------

def get_project_item_for_content(content_id: str):
    """Devuelve el item del Project para esta issue/PR si ya existe."""
    query = """
    query($contentId:ID!){
      node(id:$contentId){
        ... on Issue{
          projectItems(first:20){
            nodes{
              id
              project{ id }
            }
          }
        }
        ... on PullRequest{
          projectItems(first:20){
            nodes{
              id
              project{ id }
            }
          }
        }
      }
    }
    """
    data = graphql(query, {"contentId": content_id})
    node = data.get("node")
    if not node:
        return None
    for it in node.get("projectItems", {}).get("nodes", []):
        if it["project"]["id"] == project_id:
            return it["id"]
    return None

def add_issue_to_project(node_id: str) -> str:
    mutation = """
    mutation($projectId:ID!,$contentId:ID!){
      addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}){
        item{ id }
      }
    }
    """
    data = graphql(mutation, {"projectId": project_id, "contentId": node_id})
    return data["addProjectV2ItemById"]["item"]["id"]

def ensure_project_item(node_id: str) -> str:
    item_id = get_project_item_for_content(node_id)
    if item_id:
        return item_id
    return add_issue_to_project(node_id)

def set_status(item_id: str, status_name: str):
    option_id = status_options.get(status_name)
    if not option_id:
        return
    mutation = """
    mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){
      updateProjectV2ItemFieldValue(
        input:{
          projectId:$projectId,
          itemId:$itemId,
          fieldId:$fieldId,
          value:{ singleSelectOptionId:$optionId }
        }
      ){
        projectV2Item{ id }
      }
    }
    """
    graphql(mutation, {
        "projectId": project_id,
        "itemId": item_id,
        "fieldId": status_field_id,
        "optionId": option_id,
    })

# ---------------------------------------------------------------------------
# Añadir cada issue al Project y ponerla en el Backlog correcto
# ---------------------------------------------------------------------------

for entry in created:
    node_id = entry.get("node_id")
    status_name = entry.get("status_name")
    if not node_id or not status_name:
        continue
    try:
        item_id = ensure_project_item(node_id)
        set_status(item_id, status_name)
        entry["project_item_id"] = item_id
    except Exception as e:
        entry["status"] = f"{entry['status']}-pero-sin-status ({e})"

# ---------------------------------------------------------------------------
# Issue de intake: label + moverlo al mismo Backlog
# ---------------------------------------------------------------------------

r = session.get(f"{REST_BASE}/repos/{owner}/{repo}/issues/{intake_issue_number}")
r.raise_for_status()
intake_issue = r.json()
intake_node_id = intake_issue["node_id"]

# Label intake-processed
session.post(
    f"{REST_BASE}/repos/{owner}/{repo}/issues/{intake_issue_number}/labels",
    json={"labels": ["intake-processed"]},
)

# Usamos el mismo Status que el primer item creado (si hay)
intake_status_name = None
for e in created:
    if e.get("status_name") and e["status"].startswith("creada"):
        intake_status_name = e["status_name"]
        break

try:
    intake_item_id = ensure_project_item(intake_node_id)
    if intake_status_name:
        set_status(intake_item_id, intake_status_name)
except Exception:
    pass

# ---------------------------------------------------------------------------
# Comentario resumen en el issue de intake
# ---------------------------------------------------------------------------

lines = ["### Resultado del backlog intake", ""]
for entry in created:
    if entry["status"] == "creada":
        lines.append(f'* {entry["id"]}: creada como #{entry["number"]}')
    elif entry["status"] == "ya-existia":
        lines.append(f'* {entry["id"]}: ya existía como #{entry["number"]}')
    else:
        lines.append(f'* {entry["id"]}: {entry["status"]}')

comment_body = "\n".join(lines)

session.post(
    f"{REST_BASE}/repos/{owner}/{repo}/issues/{intake_issue_number}/comments",
    json={"body": comment_body},
)

print(json.dumps({"created": created}))
PY

echo "✅ backlog-intake completado."
