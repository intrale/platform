# Patrones de API de GitHub — con `gh` CLI

## Setup (ejecutar al inicio de cada skill)

```bash
export PATH="/c/Workspaces/gh-cli/bin:$PATH"
export GH_TOKEN=$(printf 'protocol=https\nhost=github.com\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')
```

## Variables comunes

```bash
GH_REPO="intrale/platform"
GH_PROJECT_NUMBER=1
GH_ORG="intrale"
```

## Leer un issue

```bash
gh issue view $ISSUE_NUMBER --repo $GH_REPO --json number,title,body,labels,assignees,state,nodeId
```

## Actualizar body de un issue

```bash
gh issue edit $ISSUE_NUMBER --repo $GH_REPO --body "$BODY"
```

> Para bodies largos con markdown, usar heredoc:
> ```bash
> gh issue edit $ISSUE_NUMBER --repo $GH_REPO --body "$(cat <<'EOF'
> ## Objetivo
> ...contenido markdown...
> EOF
> )"
> ```

## Agregar labels a un issue

```bash
gh issue edit $ISSUE_NUMBER --repo $GH_REPO --add-label "app:client,area:productos"
```

## Crear un issue

```bash
gh issue create --repo $GH_REPO \
  --title "$TITLE" \
  --body "$BODY" \
  --label "app:client,area:productos" \
  --assignee leitolarreta
```

## Listar issues abiertos

```bash
gh issue list --repo $GH_REPO --state open --limit 200 \
  --json number,title,labels,body,assignees
```

Para filtrar sin labels, usar `--jq`:
```bash
gh issue list --repo $GH_REPO --state open --limit 200 \
  --json number,title,labels \
  --jq '.[] | select(.labels | length == 0)'
```

## Listar PRs abiertos

```bash
gh pr list --repo $GH_REPO --state open --limit 30 \
  --json number,title,headRefName,url,author
```

## Project V2 — Listar items del proyecto

```bash
gh project item-list $GH_PROJECT_NUMBER --owner $GH_ORG --format json --limit 100
```

## Project V2 — Agregar issue al proyecto

```bash
gh project item-add $GH_PROJECT_NUMBER --owner $GH_ORG \
  --url "https://github.com/intrale/platform/issues/$ISSUE_NUMBER"
```

## Project V2 — Obtener campo Status y opciones

```bash
gh api graphql -f query='
  query {
    organization(login: "intrale") {
      projectV2(number: 1) {
        id
        fields(first: 50) {
          nodes {
            ... on ProjectV2SingleSelectField {
              id
              name
              options { id name }
            }
          }
        }
      }
    }
  }
'
```

## Project V2 — Cambiar status de un item

```bash
gh api graphql -f query="
  mutation {
    updateProjectV2ItemFieldValue(input: {
      projectId: \"$PROJECT_ID\"
      itemId: \"$ITEM_ID\"
      fieldId: \"$STATUS_FIELD_ID\"
      value: { singleSelectOptionId: \"$STATUS_OPTION_ID\" }
    }) {
      projectV2Item { id }
    }
  }
"
```

## Project V2 — Agregar issue y asignar status (combo completo)

**Patrón recomendado:** usar el helper script `add-to-project-status.js` que encapsula todo el proceso.

```bash
# Setup
export PATH="/c/Workspaces/gh-cli/bin:$PATH"
export GH_TOKEN=$(printf 'protocol=https\nhost=github.com\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')

# Variables
ISSUE_NUMBER=1282
STATUS_NAME="Backlog Tecnico"  # o "Backlog CLIENTE", "Refined", "Done", etc.

# Ejecutar en una línea
node /c/Workspaces/Intrale/platform/.claude/hooks/add-to-project-status.js "$ISSUE_NUMBER" "$STATUS_NAME"

# Retorna JSON si éxito:
# {"status":"ok","issueNumber":1282,"statusName":"Backlog Tecnico","itemId":"PVTI_kwDOBTzBoc..."}
```

**Qué hace `add-to-project-status.js` internamente:**

1. Obtiene token GitHub (`gh auth token` con scope `project`)
2. Agrega el issue al proyecto: `gh project item-add 1 --owner intrale --url "https://github.com/intrale/platform/issues/$ISSUE_NUMBER"`
3. Espera 500ms a que GitHub procese
4. Obtiene `itemId` via GraphQL query `projectItems(...)`
5. Ejecuta mutación `updateProjectV2ItemFieldValue` con el `optionId` del status destino
6. Retorna JSON con resultado

**Option IDs disponibles:**
- `Backlog Tecnico`: `4fef8264`
- `Backlog CLIENTE`: `74b58f5f`
- `Backlog NEGOCIO`: `1e51e9ff`
- `Backlog DELIVERY`: `0fa31c9f`
- `Refined`: `bac097c6`
- `Done`: `b30e67ed`
- (otros: ver `project-utils.js` para lista completa)

**Casos de uso:**

```bash
# /historia: crear nuevo issue y asignar backlog correcto
node .claude/hooks/add-to-project-status.js "$NEW_ISSUE_NUMBER" "Backlog CLIENTE"

# /refinar: mover issue a "Refined"
node .claude/hooks/add-to-project-status.js "$ISSUE_NUMBER" "Refined"

# Script masivo: reparar items sin status
node .claude/hooks/fix-project-status.js  # reparación automatizada
```

## Comentar en un issue

```bash
gh issue comment $ISSUE_NUMBER --repo $GH_REPO \
  --body 'Status cambiado a "Refined"'
```

## Verificar si un PR existe para una rama

```bash
gh pr list --repo $GH_REPO --head "$BRANCH" --state open \
  --json number,url
```

## Crear un PR

```bash
gh pr create --repo $GH_REPO \
  --title "$TITLE" \
  --body "$(cat <<'EOF'
## Resumen
- Punto 1

## Plan de tests
- [ ] Tests pasan
- [ ] Build completo

🤖 Generado con [Claude Code](https://claude.ai/claude-code)
EOF
)" \
  --base main \
  --head "$BRANCH" \
  --assignee leitolarreta
```

## Notas importantes

- `gh` está en `/c/Workspaces/gh-cli/bin/` — siempre agregar al PATH al inicio
- La autenticación se maneja via `GH_TOKEN` (no usar `gh auth login`)
- `gh --json` devuelve JSON estructurado — mucho más fiable que parsear con grep/sed
- `--jq` permite filtrar JSON directamente en el comando gh
- Para operaciones GraphQL complejas (Project V2 mutations), usar `gh api graphql`
- Respetar rate limits de GitHub: no más de 30 requests por minuto para mutaciones
