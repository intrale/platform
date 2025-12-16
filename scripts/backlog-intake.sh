#!/usr/bin/env bash
set -euo pipefail

# Repositorio actual
REPO="${GITHUB_REPOSITORY:-intrale/platform}"

# Número de issue a procesar.
# Ajustá esta variable a cómo tu entorno le pasa el issue actual al agente.
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

# Extraer bloque YAML entre ```yaml y ```
YAML_BLOCK="$(printf '%s\n' "$BODY" | sed -n '/```yaml/,/```/p' | sed '1d;$d')"

if [ -z "$YAML_BLOCK" ]; then
  echo "No se encontró bloque YAML en el issue #${ISSUE_NUMBER}" >&2
  exit 1
fi

TMP_YAML="$(mktemp)"
printf '%s\n' "$YAML_BLOCK" > "$TMP_YAML"

echo "✅ YAML extraído, creando issues…"

python - "$TMP_YAML" << 'PY'
import os, sys, json, textwrap
import yaml
import requests

yaml_path = sys.argv[1]
token = os.environ["GITHUB_TOKEN"]
repo  = os.environ.get("GITHUB_REPOSITORY", "intrale/platform")

with open(yaml_path) as f:
    data = yaml.safe_load(f)

items = data.get("items", [])
session = requests.Session()
session.headers.update({
    "Authorization": f"Bearer {token}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
})

created = []

def infer_status(labels):
    if "stream:CLIENTE" in labels:
        return "Backlog CLIENTE"
    if "stream:NEGOCIO" in labels:
        return "Backlog NEGOCIO"
    if "stream:DELIVERY" in labels:
        return "Backlog DELIVERY"
    return None

# Buscar issues existentes para evitar duplicados (por título exacto)
def issue_exists(title):
    url = f"https://api.github.com/search/issues"
    q   = f'repo:{repo} "{title}" in:title'
    r = session.get(url, params={"q": q})
    r.raise_for_status()
    data = r.json()
    return any(i["title"] == title for i in data.get("items", []))

for item in items:
    iid   = item["id"]
    title = f'{iid} – {item["title"]}'
    body  = item["body"]
    labels = list(item.get("labels", []))
    labels.append("from-intake")

    if issue_exists(title):
        created.append((iid, None, "ya-existia"))
        continue

    payload = {
        "title": title,
        "body": body,
        "labels": labels,
    }
    r = session.post(f"https://api.github.com/repos/{repo}/issues", json=payload)
    r.raise_for_status()
    issue = r.json()
    number = issue["number"]
    created.append((iid, number, "creado"))

print(json.dumps(created))
PY

CREATED_JSON="$(tail -n1)"

echo "CREATED_JSON=${CREATED_JSON}"
