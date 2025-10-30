# 🧪 GitHub Project V2 – Ejemplos con `curl` (GraphQL + REST)

> Requiere `GITHUB_TOKEN` (classic o fine-grained) con permisos: `repo`, `project` (ProjectV2) y `read:org` si el Project está en una organización.
>
> Exportá el token: `export GITHUB_TOKEN=xxxxx`

## Variables de entorno sugeridas
```bash
export GH_OWNER="intrale"             # user u org
export GH_REPO="platform"            # repo: intrale/platform
export GH_PROJECT_NUMBER=1             # número visible del Project V2
export ISSUE_NUMBER=417                # ejemplo
export TARGET_STATUS="Todo"           # Backlog|Refined|Todo|In Progress|Ready|Done|Blocked
```

## 1) Obtener `projectId` por `owner` + `number` (GraphQL)
```bash
curl -s -H "Authorization: bearer $GITHUB_TOKEN" \
  -X POST https://api.github.com/graphql \
  -d '{
    "query": "query($login:String!,$number:Int!){ user(login:$login){ projectV2(number:$number){ id title } } organization(login:$login){ projectV2(number:$number){ id title } } }",
    "variables": {"login": "'$GH_OWNER'", "number": '$GH_PROJECT_NUMBER'}
  }' | jq '.'
```
> Usa `user(...)` si el Project es de usuario; `organization(...)` si es de organización. Tomá el primer `id` no nulo como `PROJECT_ID`.

## 2) Buscar `statusFieldId` y opciones (GraphQL)
```bash
read -r PROJECT_ID <<<'$(
  curl -s -H "Authorization: bearer $GITHUB_TOKEN" -X POST https://api.github.com/graphql -d '{
    "query": "query($login:String!,$number:Int!){ user(login:$login){ projectV2(number:$number){ id fields(first:50){ nodes{ ... on ProjectV2SingleSelectField { id name options { id name } } } } } } organization(login:$login){ projectV2(number:$number){ id fields(first:50){ nodes{ ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }",
    "variables": {"login": "'$GH_OWNER'", "number": '$GH_PROJECT_NUMBER'}
  }' | jq -r '.. | .id? // empty' )'
'
```
> Anotá el `id` del campo **Status** como `STATUS_FIELD_ID` y el `id` de la opción cuyo `name` **coincide exactamente** con `$TARGET_STATUS` como `STATUS_OPTION_ID`.

## 3) Agregar una issue al Project (GraphQL)
```bash
# primero necesitamos el nodeId de la issue
ISSUE_NODE_ID=$(curl -s -H "Authorization: bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/$GH_OWNER/$GH_REPO/issues/$ISSUE_NUMBER | jq -r '.node_id')

# agregar al project
curl -s -H "Authorization: bearer $GITHUB_TOKEN" -X POST https://api.github.com/graphql -d '{
  "query": "mutation($projectId:ID!,$contentId:ID!){ addProjectV2ItemById(input:{projectId:$projectId contentId:$contentId}){ item { id } } }",
  "variables": {"projectId": "'$PROJECT_ID'", "contentId": "'$ISSUE_NODE_ID'"}
}' | jq '.'
```
> Guardá el `item.id` como `PROJECT_ITEM_ID`.

## 4) Cambiar el **Status** del item (GraphQL)
```bash
curl -s -H "Authorization: bearer $GITHUB_TOKEN" -X POST https://api.github.com/graphql -d '{
  "query": "mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){ setProjectV2ItemFieldValue(input:{ projectId:$projectId itemId:$itemId fieldId:$fieldId value:{ singleSelectOptionId:$optionId }}){ projectV2Item { id } } }",
  "variables": {"projectId": "'$PROJECT_ID'", "itemId": "'$PROJECT_ITEM_ID'", "fieldId": "'$STATUS_FIELD_ID'", "optionId": "'$STATUS_OPTION_ID'"}
}' | jq '.'
```

## 5) Comentar en la issue (REST v3)
```bash
curl -s -H "Authorization: token $GITHUB_TOKEN" \
  -X POST https://api.github.com/repos/$GH_OWNER/$GH_REPO/issues/$ISSUE_NUMBER/comments \
  -d '{"body": "Status cambiado a \"'$TARGET_STATUS'\" – ver Project #'$GH_PROJECT_NUMBER''"}' | jq '.'
```

## 6) Crear rama y PR **contra `main`** (REST v3)
```bash
# crear rama a partir de main
BASE_SHA=$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/$GH_OWNER/$GH_REPO/git/ref/heads/main | jq -r '.object.sha')
BRANCH="codex/${ISSUE_NUMBER}-auto"

curl -s -H "Authorization: token $GITHUB_TOKEN" \
  -X POST https://api.github.com/repos/$GH_OWNER/$GH_REPO/git/refs \
  -d '{"ref":"refs/heads/'"$BRANCH"'","sha":"'"$BASE_SHA"'"}' | jq '.'

# (opcional) commit mínimo – crear/actualizar un archivo
cat > /tmp/ping.txt <<'EOF'
chore: ping from agent
EOF

BLOB_SHA=$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
  -X POST https://api.github.com/repos/$GH_OWNER/$GH_REPO/git/blobs \
  -d '{"content":"'"$(base64 -w0 /tmp/ping.txt)"'","encoding":"base64"}' | jq -r '.sha')

TREE_BASE=$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/$GH_OWNER/$GH_REPO/git/trees/$BASE_SHA | jq -r '.sha')

TREE_SHA=$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
  -X POST https://api.github.com/repos/$GH_OWNER/$GH_REPO/git/trees \
  -d '{"base_tree":"'"$TREE_BASE"'","tree":[{"path":"tools/ping.txt","mode":"100644","type":"blob","sha":"'"$BLOB_SHA"'"}]}' | jq -r '.sha')

COMMIT_SHA=$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
  -X POST https://api.github.com/repos/$GH_OWNER/$GH_REPO/git/commits \
  -d '{"message":"chore: ping (Closes #'"$ISSUE_NUMBER"')","tree":"'"$TREE_SHA"'","parents":["'"$BASE_SHA"'"]}' | jq -r '.sha')

curl -s -H "Authorization: token $GITHUB_TOKEN" \
  -X PATCH https://api.github.com/repos/$GH_OWNER/$GH_REPO/git/refs/heads/$BRANCH \
  -d '{"sha":"'"$COMMIT_SHA"'","force":false}' | jq '.'

# abrir PR a main
curl -s -H "Authorization: token $GITHUB_TOKEN" \
  -X POST https://api.github.com/repos/$GH_OWNER/$GH_REPO/pulls \
  -d '{"title":"[auto] ping","head":"'"$BRANCH"'","base":"main","body":"Closes #'"$ISSUE_NUMBER"'"}' | jq '.'
```

## 7) Cierre rápido (Ready → Done)
> (si tu QA lo permite)
```bash
export TARGET_STATUS="Ready"
# repetir pasos 1–5 con TARGET_STATUS="Done" cuando esté verificado
```
```