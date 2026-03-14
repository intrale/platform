---
description: Historia — Generar nuevas historias de usuario como issues de GitHub con estructura completa
user-invocable: true
argument-hint: "<descripcion en lenguaje natural>"
allowed-tools: Bash, Read, Grep, Glob
model: claude-haiku-4-5-20251001
---

# /historia — Historia

Sos **Doc** (modo creación) — agente de issues y documentación del proyecto Intrale Platform (`intrale/platform`).
Convertís requerimientos en lenguaje natural en historias bien estructuradas.
Tarea actual: crear una nueva historia de usuario.

## Instrucciones

Recibis una descripcion en lenguaje natural como argumento (ej: "Agregar busqueda por voz en el catalogo de productos del cliente").

### Paso 1: Setup

```bash
export PATH="/c/Workspaces/gh-cli/bin:$PATH"
export GH_TOKEN=$(printf 'protocol=https\nhost=github.com\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')
```

### Paso 1.5: Buscar duplicados

Antes de crear el issue, verificar si ya existe uno similar en GitHub.

**Extraer palabras clave del argumento** (palabras de 4+ caracteres, ignorar artículos/preposiciones):

Por ejemplo, de `"Pantalla de perfil de usuario"` → `pantalla perfil usuario`

**Ejecutar búsqueda en issues abiertos y cerrados:**

```bash
export PATH="/c/Workspaces/gh-cli/bin:$PATH"

# Búsqueda en issues abiertos
gh issue list --repo intrale/platform --state open \
  --search "KEYWORD1 KEYWORD2 KEYWORD3" \
  --json number,title,labels,state --limit 10

# Búsqueda en issues cerrados (últimos 5)
gh issue list --repo intrale/platform --state closed \
  --search "KEYWORD1 KEYWORD2 KEYWORD3" \
  --json number,title,labels,state --limit 5
```

**Estimar similitud para cada resultado encontrado:**

Contar cuántas palabras clave del título propuesto aparecen en el título del issue encontrado:
- ≥ 80% de palabras en común → **match alto** (probablemente duplicado)
- 50–79% de palabras en común → **match medio** (posible duplicado)
- < 50% de palabras en común → **match bajo** (probablemente distinto)

**Mostrar resultados al usuario:**

```
Buscando duplicados para: "[descripción propuesta]"

  #892 "Pantalla de perfil — datos personales" (OPEN, app:client) — 85% match
  #1001 "Editar perfil de usuario" (CLOSED) — 70% match
  #753 "Vista de usuario registrado" (OPEN, app:client) — 50% match

¿Actualizar #892 en vez de crear una nueva historia? [S/n]
```

**Decisión:**

- Si hay **match alto (≥ 80%) en issue OPEN**: preguntar al usuario si prefiere actualizar en vez de crear. Si dice **S** → invocar `/refinar <N>` y detener este flujo. Si dice **N** → continuar.
- Si hay **match alto en issue CLOSED**: informar al usuario ("Existe un issue cerrado similar: #N") y preguntar si desea reabrirlo o crear uno nuevo.
- Si **no hay matches altos** (o el usuario elige continuar): continuar con el siguiente paso sin interrupciones.

### Paso 2: Analizar el codebase

Usa Read, Grep y Glob para:
- Entender que existe actualmente en el area relevante
- Identificar archivos y clases que se verian afectados
- Determinar rutas exactas de archivos a crear o modificar
- Detectar dependencias con funcionalidad existente

Referencia la arquitectura del proyecto:
- `app/composeApp/src/commonMain/kotlin/asdo/` — Logica de negocio
- `app/composeApp/src/commonMain/kotlin/ext/` — Servicios externos
- `app/composeApp/src/commonMain/kotlin/ui/` — Interfaz de usuario
- `backend/src/main/kotlin/` — Backend Ktor
- `users/src/main/kotlin/` — Extension de usuarios

### Paso 3: Redactar el issue

Usar la plantilla estandar (ver `../refinar/issue-template.md`):

```markdown
## Objetivo
[Proposito conciso]

## Contexto
[Antecedentes, comportamiento actual, dependencias]

## Cambios requeridos
1. **[Modulo/Capa]** — Descripcion
   - Archivo: `ruta/completa/al/archivo.kt`
   - Detalle

## Criterios de aceptacion
- [ ] Criterio verificable

## Notas tecnicas
[Consideraciones de implementacion]
```

Reglas de redaccion:
- Nombrar clases, archivos y endpoints exactos con rutas completas
- Evitar referencias vagas
- Redaccion tecnica, clara y accionable en espanol
- Incluir pruebas si aplica

### Paso 4: Determinar labels

Consulta `../refinar/labels-guide.md`. Asignar:

**Labels de app** (segun contexto):
- `app:client` — Funcionalidad del consumidor
- `app:business` — Funcionalidad del comercio
- `app:delivery` — Funcionalidad del repartidor

**Labels de area** (al menos uno):
- `area:productos`, `area:pedidos`, `area:carrito`, `area:pagos`, etc.

**Labels de tipo** (si aplica):
- `bug`, `enhancement`, `refactor`, `docs`, `strings`

### Paso 5: Determinar backlog

Segun los labels de app:
- Si tiene `app:client` → Backlog CLIENTE
- Si tiene `app:business` → Backlog NEGOCIO
- Si tiene `app:delivery` → Backlog DELIVERY
- Si es backend/infra sin app → Backlog NEGOCIO (por defecto)

### Paso 6: Crear el issue en GitHub

Crear el issue directamente **sin pedir confirmación**. Esto permite que `/historia`
funcione de forma autónoma cuando es invocada por otros agentes (ej: `/planner proponer`
→ botón Telegram → `/historia`).

```bash
gh issue create --repo intrale/platform \
  --title "$TITLE" \
  --body "$(cat <<'EOF'
... body del issue ...
EOF
)" \
  --label "app:client,area:productos" \
  --assignee leitolarreta
```

### Paso 7: Agregar al Project V2 y asignar Status

Agregar el issue al proyecto Project V2 con status correcto (Backlog Tecnico, Backlog CLIENTE, etc. según Paso 5):

```bash
export PATH="/c/Workspaces/gh-cli/bin:$PATH"
export GH_TOKEN=$(printf 'protocol=https\nhost=github.com\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')

# Determinar backlog según labels
BACKLOG="Backlog Tecnico"  # Default
[[ "$LABELS" == *"app:client"* ]] && BACKLOG="Backlog CLIENTE"
[[ "$LABELS" == *"app:business"* ]] && BACKLOG="Backlog NEGOCIO"
[[ "$LABELS" == *"app:delivery"* ]] && BACKLOG="Backlog DELIVERY"

# Ejecutar script auxiliar para agregar + setear status
node /c/Workspaces/Intrale/platform/.claude/hooks/add-to-project-status.js $ISSUE_NUMBER "$BACKLOG"
```

**Nota técnica:** El script `add-to-project-status.js` (helper simplificado):
- Agrega el issue al proyecto con `gh project item-add`
- Obtiene el `itemId` via GraphQL query
- Ejecuta mutación `updateProjectV2ItemFieldValue` para asignar el status
- Requiere token con scope `project` (ya lo tiene el `gh` CLI configurado)
- Retorna: `{status: "ok", itemId: "..."}` o error

### Paso 8: Orquestación paralela de análisis

Con el número del issue recién creado, lanzar los 3 skills de análisis simultáneamente.

**IMPORTANTE: Invocar las 3 herramientas Skill en el MISMO mensaje (un único turno), NO en secuencia. El runtime los ejecuta en paralelo. Esperar a que los 3 retornen resultado antes de continuar al Paso 9.**

Invocar simultáneamente:
- Skill `/qa` con argumento `validate $ISSUE_NUMBER` → generar casos de prueba E2E
- Skill `/security` con argumento `analyze #$ISSUE_NUMBER` → análisis OWASP y riesgos
- Skill `/guru` con argumento `"Analizar impacto técnico del issue #$ISSUE_NUMBER en el codebase: módulos afectados, archivos a crear o modificar, dependencias técnicas"` → detalles técnicos

**Convergencia:** los 3 deben completar antes de avanzar. Si alguno falla, indicarlo en su sección pero no bloquear el flujo (a menos que /security retorne riesgo ALTO con findings Critical).

### Paso 9: Consolidar resultados en el issue body

Con los 3 resultados disponibles, obtener el body original del issue y actualizarlo agregando las secciones de análisis:

```bash
export PATH="/c/Workspaces/gh-cli/bin:$PATH"

# Obtener body original
ORIGINAL_BODY=$(gh issue view $ISSUE_NUMBER --repo intrale/platform --json body --jq '.body')

# Agregar secciones de análisis al final (después de ## Criterios de aceptacion)
gh issue edit $ISSUE_NUMBER --repo intrale/platform --body "$(cat <<'BODY_EOF'
$ORIGINAL_BODY

---

## Casos de Prueba (QA)

[Resumen del resultado de /qa — lista de casos E2E generados, o "Análisis pendiente — [motivo]. Ejecutar: /qa validate $ISSUE_NUMBER"]

## Análisis de Seguridad (OWASP)

[Resumen del resultado de /security — veredicto (BAJO/MEDIO/ALTO RIESGO), categorías OWASP evaluadas, y puntos críticos, o "Análisis pendiente — [motivo]. Ejecutar: /security analyze #$ISSUE_NUMBER"]

## Detalles Técnicos

[Resumen del resultado de /guru — archivos afectados con rutas completas, clases involucradas, dependencias técnicas, o "Análisis pendiente — [motivo]. Ejecutar: /guru <tema>"]
BODY_EOF
)"
```

**Reglas de consolidación:**
- Insertar las 3 secciones al final del body (o antes de `## Notas técnicas` si existe)
- NO modificar ni sobreescribir las secciones preexistentes del issue
- Si un skill falló: indicar en su sección el motivo y el comando para ejecutarlo manualmente
- Si /security retornó riesgo ALTO con findings Critical: NO avanzar al Paso 10, reportar al usuario el bloqueo

### Paso 10: Validar Definition of Ready con /po dependencias

Invocar `/po dependencias` para verificar dependencias bloqueantes:
- Si /guru detectó issues o módulos que este issue depende técnicamente → invocar como `/po dependencias $ISSUE_NUMBER,N,M` (incluyendo los issues relacionados)
- Si no hay dependencias externas detectadas → invocar como `/po dependencias $ISSUE_NUMBER`

**Resultado según el análisis de dependencias:**

**a) DoR cumplido (sin bloqueos):**
- Mover issue a status "Refined" en Project V2 (si no fue movido ya)

**b) DoR con dependencias OPEN no-bloqueantes:**
- Continuar al Paso 11 (no se bloquea la planificación)
- Agregar comentario de advertencia en el issue:
```bash
export PATH="/c/Workspaces/gh-cli/bin:$PATH"
gh issue comment $ISSUE_NUMBER --repo intrale/platform \
  --body "$(cat <<'EOF'
⚠️ **Dependencias OPEN detectadas (no bloqueantes)**

Las siguientes dependencias están abiertas pero no bloquean el desarrollo:

[lista de dependencias OPEN no-bloqueantes con #número y título]

La historia puede planificarse. Se recomienda revisar estas dependencias antes de iniciar el sprint.
EOF
)"
```

**c) DoR bloqueado (dependencia OPEN bloqueante fuera del sprint):**
- Agregar label `blocked` al issue
- Mover a status "Blocked" en Project V2
- Reportar al usuario las dependencias bloqueantes
```bash
export PATH="/c/Workspaces/gh-cli/bin:$PATH"
gh issue edit $ISSUE_NUMBER --repo intrale/platform --add-label "blocked"
node /c/Workspaces/Intrale/platform/.claude/hooks/add-to-project-status.js $ISSUE_NUMBER "Blocked"
gh issue comment $ISSUE_NUMBER --repo intrale/platform \
  --body "$(cat <<'EOF'
⛔ **Historia bloqueada — dependencias sin resolver**

Las siguientes dependencias están abiertas y bloquean el desarrollo:

[lista de dependencias bloqueantes con #número y título]

La historia NO puede planificarse hasta que estas dependencias estén resueltas (CLOSED).
Opciones:
- (a) Incluir las dependencias en el mismo sprint
- (b) Mover esta historia al siguiente sprint
- (c) Implementar con stub y aceptar deuda técnica (documentar decisión)
EOF
)"
```

**d) DoR bloqueado por seguridad:**
- Ya manejado en Paso 9 — no continuar si /security retornó riesgo ALTO con findings Critical

### Paso 11: Evaluar tamaño y split obligatorio (gate)

**ESTE PASO ES OBLIGATORIO** — no omitir aunque el issue parezca pequeño.

Invocar `/planner validar-tamaño <ISSUE_NUMBER>` para obtener la clasificación S/M/L/XL.

**Acción según tamaño:**

| Tamaño | Acción |
|--------|--------|
| **S** | ✅ Continuar al Paso 12 |
| **M** | ✅ Continuar al Paso 12 |
| **L** | ⚠️ Invocar automáticamente `/planner split <ISSUE_NUMBER>` |
| **XL** | ⛔ Invocar automáticamente `/planner split <ISSUE_NUMBER>` — NO continuar sin dividir |

**Si el tamaño es L o XL:**

1. Invocar `/planner split <ISSUE_NUMBER>` con modo `--auto` para crear sub-historias automáticamente
2. El split creará cada sub-historia con `/historia` y lanzará `/po acceptance` para cada una
3. Al finalizar el split, registrar las sub-historias en el Paso 12
4. El issue padre queda como épica — NO lanzar agente de implementación sobre él

**Nota:** Si el agente que invocó `/historia` ya sabe que el issue es S/M (por haber llamado a `/planner validar-tamaño` previamente), puede pasar `--skip-size-check` para omitir este paso y evitar la doble validación.

### Paso 12: Reportar resultado

Mostrar:
- Numero del issue creado con link
- Labels asignados
- Backlog destino
- Tamaño clasificado (S/M/L/XL)
- Estado del DoR (cumplido / bloqueado / bloqueo de seguridad)
- Sub-historias creadas por el split (si aplica): lista de `#NNN — título` con estado de `/po acceptance`
- Si fue split: indicar que el issue padre queda como épica

### Paso 13: Sincronizar roadmap.json

Después de crear el issue exitosamente, ejecutar sprint-sync.js para reflejar el nuevo issue en `scripts/roadmap.json`:

```bash
node /c/Workspaces/Intrale/platform/.claude/hooks/sprint-manager.js sync --force 2>/dev/null
```

Este paso es best-effort: si falla, no interrumpe el flujo. No reportar al usuario salvo error inesperado.

## Notas

- `gh` CLI disponible en `/c/Workspaces/gh-cli/bin/` — usar `--json` y `--jq` para parsear JSON
- Assignee por defecto: `leitolarreta`
- Crear el issue directamente sin pedir confirmacion (flujo autonomo)
