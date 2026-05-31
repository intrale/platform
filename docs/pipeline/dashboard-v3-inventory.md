# Dashboard V3 — Inventario por ventana (semilla)

> **Origen:** semilla creada por `/ux` durante #3732 (split de #3715 — ventana Ops).
> **Audiencia:** devs de pipeline que implementen los splits #3725..#3736.
> **Convencion:** una tabla por ventana, con la trazabilidad `pieza visible → fuente de datos → destino post-rediseño V3`.
> Cada split sucesivo del epico extiende este doc agregando su seccion.

## Por que existe

El monolito `.pipeline/dashboard.js` tiene 10.691 lineas y todas las ventanas conviven con el `pageShell` de `views/dashboard/satellites.js`. El epico #3715 lo descompone en `.pipeline/views/dashboard/*.js` por ventana. Para que el rediseño V3 no pierda piezas (CA-A1, CA-A2 heredados), cada split documenta aca lo que migra, lo que se rediseña y lo que se elimina.

El doc tambien sirve para los reviewers (PO, security) y para que UX/QA puedan auditar consistencia visual entre ventanas sin abrir el codigo.

## Convencion de la tabla

| Campo | Significado |
|---|---|
| **Pieza** | Componente visible de la ventana (banner, grid, chip, panel). Nombre humano. |
| **Estado actual** | Donde vive hoy (archivo + lineas + ID DOM si aplica). |
| **Fuente de datos** | Endpoint o slice de `lib/dashboard-slices.js` que la alimenta. |
| **Destino V3** | Decisiones del rediseño: mover/quitar/agregar/preservar. Marca diferencia con el estado actual. |
| **Token / icono** | Token de `assets/design-tokens.css` o simbolo de `assets/icons/sprite.svg` que usa la pieza rediseñada. |
| **Tooltip CA-C5** | Texto del tooltip informativo (cuando aplica) — atributo `title=` + `aria-label=`. |

## Ventana **Ops** — split #3732

**Modulo destino:** `.pipeline/views/dashboard/ops.js`
**Slug del router:** `?view=ops` (preserva el path legacy `/ops`).
**Mockup adjunto:** `.pipeline/assets/mockups/28-ops-v3.svg` (1080×1920, kiosk vertical).
**Out of scope (CA-B2):** acciones operativas mutantes (kill, restart, retry). Split aparte con CSRF + audit log.

### Piezas que se preservan (CA-B1)

| Pieza | Estado actual | Fuente de datos | Destino V3 | Token / icono | Tooltip CA-C5 |
|---|---|---|---|---|---|
| Banner Telegram caido | `satellites.js:1003-1167` → `<div id="ops-tg-banner">` | `state.telegramHealth.lastError` (slice `opsSlice` linea 859) | **Preserva + rediseña**: dual-encoding rail rojo + icono bot-roto + texto. Oculto si `tgHealth.ok===true`. | `--danger`, `--danger-bg`, `--danger-dim`, rail `linearGradient dangerStripe` | `"Origen del error reportado por Telegram API"` |
| Grid de procesos | `satellites.js:1005-1008` → `<div id="ops-procesos" class="ops-grid">` | `state.procesos` (alive, pid, uptime por proceso) | **Preserva**: 5 cards en grid `auto-fill minmax(220px, 1fr)`. Cards de `listener` y `svc-telegram` heredan estado `bot-down` cuando TG cae. | `--success` (vivo), `--danger` (caido), `--surface-1`, `--surface-2` | (por chip de cola, ver abajo) |
| Chips de cola por proceso | `satellites.js:1056-1085` (`PROC_QUEUES`) → `.ops-queue-group` | `state.servicios[queue]` con `{ pendiente, trabajando, listo }` | **Preserva**: chip pendiente en `--warning` si v>0, trabajando en `--info` si v>0, listo siempre en `--text-dim`. | `--warning` (pend), `--info` (work), `--text-dim` (done). Iconos: `ic-fase-criterios`/`ic-fase-dev`/`ic-fase-aprobacion` (semantica reusada) o emojis ⏳⚙✓ preservados. | `"N archivos pendientes (sin tomar)"` / `"N archivos en proceso"` / `"N archivos completados"` |
| Reconciler stale orders 24h | `satellites.js:1010-1018` → `#stale-orders-count` + `#stale-orders-breakdown` | `/api/dash/reconciler-stale-orders` con `{ total_24h, by_reason }` | **Preserva**: numero grande en `--warning` si total>0, en `--text-dim` si total===0 (saludable). Breakdown lista por motivo con linea separadora. | `--warning`, `--text-dim`, `--surface-1`, font-family `var(--font-mono)` | `"Ordenes que el reconciler descarto en las ultimas 24 horas"` |

### Piezas que se rediseñan (CA-C2)

| Pieza | Estado actual | Fuente de datos | Destino V3 | Token / icono | Tooltip CA-C5 |
|---|---|---|---|---|---|
| QA Environment | `satellites.js:1020-1022` → `<pre id="ops-qaenv" class="ops-pre">` (dump JSON crudo, anti-patron UX) | `state.qaEnv`, `state.qaRemote`, `state.infraHealth`, `state.telegramHealth` (slice `opsSlice`) | **Rediseña**: 4 mini-cards (`qaEnv · local`, `qaRemote · AWS Lambda`, `infraHealth`, `telegramHealth`). Cada card con badge de salud + meta key:value en mono + ultimo error truncado a 80 chars. **NO `<pre>` JSON crudo.** | Badge: `--success` (OK), `--warning` (DEGRADADO), `--danger` (CAIDO). Mono: `var(--font-mono)`. Rail: stripe del color de la salud. | `"Algun componente del entorno reporto estado WARN"` (badge degradado) / `"Entorno saludable, ultimo ping OK"` (badge ok) |

### Piezas que NO entran (out-of-scope)

| Pieza | Motivo |
|---|---|
| Boton "Reiniciar proceso" | Accion mutante → split aparte con CSRF + audit log (REQ-SEC-4). |
| Boton "Retry stale orders" | Idem. |
| Boton "Rotar token Telegram" | Idem. La accion sugerida queda como texto en el banner ("rotar token con BotFather y guardarlo en ~/.claude/secrets/telegram-config.json"). |
| Suite de regresion visual automatizada | Cubierto por #3387, fuera de scope del split. |
| Migracion a `lib/escape-html.js` compartido | Dependencia del split #1 del epico; cuando aterrice, PR de unificacion toca `ops.js` + `home.js` + `multi-provider*.js`. |

### Fallback inerte (CA-A3 / REQ-SEC-7)

Cuando `require('./views/dashboard/ops')` arroja (sintaxis rota, dependencia faltante, etc.), `dashboard.js` debe renderizar un panel visible con:

- Icono warning (`stroke="#D29922"`).
- Titulo "Ventana Ops no disponible".
- Subtitulo "El modulo views/dashboard/ops.js fallo al cargar. Ver logs del dashboard para detalle."
- Linea mono "log("ops view unavailable", e) emitido por dashboard.js — el render no queda en blanco."

Variante ilustrada en el mockup adjunto, seccion "VARIANTE FALLBACK INERTE".

### Variante healthy (sin estado degradado)

Cuando `tgHealth.ok===true && stale.total_24h===0 && all procesos.alive===true`, la ventana muestra el grid de procesos verde + chip "Pipeline saludable" en footer. El banner Telegram se oculta (`.ops-banner-hidden { display: none; }` ya en CSS del satellites). Variante ilustrada en el mockup.

### Tests requeridos (CA-D2, CA-G1)

`.pipeline/views/dashboard/__tests__/ops.test.js` con `node:test` + `http.createServer` efimero. Cobertura minima:

1. Render SSR con estado valido (todos los procesos vivos, sin descartes).
2. Render con estado degradado (TG down, svc-emulador caido, stale > 0).
3. Payload XSS canonico en: contenido textual, atributo `title=`, atributo `aria-label`. Espejo del set de `home.test.js`.
4. Fallback inerte cuando se simula error en una sub-pieza (CA-A3).

### Smoke curl (CA-G2)

```bash
# Path legacy
curl -s http://127.0.0.1:3200/ops | grep -c 'ops-procesos\|stale-orders-count\|ops-qaenv\|ops-tg-banner'
# Debe devolver 4

# Query
curl -s 'http://127.0.0.1:3200/?view=ops' | grep -c 'ops-procesos\|stale-orders-count\|ops-qaenv\|ops-tg-banner'
# Debe devolver 4
```

## Ventana **Bloqueados** — split #3729

> Sub-historia hermana en curso. Documentada en `assets/mockups/27-bloqueados-v3.svg` con 10 decisiones congeladas. Esta entrada se completa cuando el split aterrice en main.

## Ventana **Matriz** — split #3731

**Modulo destino:** `.pipeline/views/dashboard/matriz.js`
**Slug del router:** `?view=matriz` (servido via router cerrado en #3723).
**Mockup adjunto:** `.pipeline/assets/mockups/29-matriz-v3.html` — HTML/CSS integrado (decision D3 del PO: UN solo archivo con ambos sub-paneles juntos). Renderizable con Puppeteer para la comparacion visual del PR (CA-9).
**Out of scope:** la migracion de inline handlers `onclick=` a `addEventListener + data-attrs` queda en #3758 (decision D4 del PO). La unificacion del escapador via `lib/escape-html.js` queda en #3722 (decision D5 del PO con fallback aceptable).

### Composicion de la ventana

La Matriz agrupa **dos sub-paneles** que viven juntos en la ventana porque ambos representan trabajo del operador sobre el pipeline:

| Sub-panel | ID DOM invariante | Proposito | Trigger de visibilidad |
|---|---|---|---|
| Necesitan intervencion humana | `#bloqueados-humano` | Issues con label `needs-human` esperando decision del operador | Solo se renderiza si `state.bloqueados.length > 0` (sino, el panel queda fuera del HTML) |
| Board Kanban del Pipeline V3 | `#issue-tracker` | Visualizacion en columnas de los issues del pipeline por fase, con tabs activos/completados/todos | Siempre visible (el board es el centro funcional del dashboard) |

### Piezas que se preservan (CA-A1, CA-A2, CA-B1)

| Pieza | Estado actual | Fuente de datos | Destino V3 | Token / icono | Tooltip CA-6 |
|---|---|---|---|---|---|
| Encabezado "Necesitan intervencion humana" + pulse + badge | `dashboard.js:2375-2382` → `<h2 class="needs-human-header">` con `🚨` emoji | `state.bloqueados.length` | **Preserva**: rediseno usa `ic-estado-needs-human` del sprite + pulse anim sutil + badge contador rojo. Sin emoji crudo. | `--danger`, `--danger-bg`, badge `--danger` | `"Click para colapsar/expandir el panel"` |
| Fila por bloqueado | `dashboard.js:2417-2432` → `.needs-human-row` | `b in state.bloqueados`: `{ issue, title, skill, phase, age_hours, summary, question, reason, recent_events }` | **Preserva**: misma jerarquia (head + summary + reason + events). Borde lateral `3px --danger` para reforzar severidad por forma (dual-encoding WCAG). | `--surface-2` (bg), `--danger` (border-left), `--text-primary` (texto), `--text-dim` (meta) | (por boton, ver siguientes filas) |
| Boton "Reactivar" | `dashboard.js:2425` → `<button class="nh-btn nh-btn-reactivate" onclick="needsHumanReactivate(${b.issue})">` | inline handler con coercion a entero (CA-4) | **Preserva**: handler `onclick` queda 1:1 (decision D4). Tooltip + aria-label obligatorios. Touch target >= 36px (CA-10). | `--success` (border/texto), `--success-bg` (hover) | `"Quitar el label needs-human y devolver el issue a la cola del pipeline"` |
| Boton "Desestimar" | `dashboard.js:2426` → `<button class="nh-btn nh-btn-dismiss" onclick="needsHumanDismiss(${b.issue})">` | inline handler con `prompt()` de razon | **Preserva**: handler `onclick` + `prompt()`/`confirm()` quedan (D4). | `--danger` (border/texto), `--danger-bg` (hover) | `"Cerrar el issue como desestimado y limpiarlo del panel"` |
| Eventos recientes por bloqueado | `dashboard.js:2407-2413` → `.needs-human-events-list` | `b.recent_events: [{ when, author, preview }]` | **Preserva**: lista `ul` con tiempo relativo (`12min`/`3h`/`5d`) + author + preview. CA-7 exige escape XSS en `ev.author` y `ev.preview`. | `--purple` (author chip), `--text-dim` (when), `--text-secondary` (preview) | — |
| Resumen funcional | `dashboard.js:2414-2416` → `.needs-human-summary` | `b.summary` (puede ser `undefined` con `b.summary_stale: true`) | **Preserva**: si hay summary, mostrar; si esta stale, placeholder con shimmer. | `--info` (border-left), `--surface-3` (bg) | — |
| Footer "Desbloquear desde Telegram" | `dashboard.js:2435-2437` → `.needs-human-footer` con `<code>/unblock</code>` | estatico | **Preserva**: redundancia operativa (UI dashboard + comando TG + label GH). | `--text-dim`, `--surface-3` (code bg) | — |
| Encabezado Board Kanban | `dashboard.js:2446-2448` → `<h2>` con `🎯` emoji + `V3` badge | estatico | **Preserva**: rediseno con `ic-issues-count` + badge teal "V3" + chevron de colapso. | `--brand-cyan` (icono), `--teal-bg` + `--teal` (badge V3) | `"Click para colapsar/expandir el Board Kanban"` |
| Search box `#it-search-input` | `dashboard.js:2450-2453` → `.it-search-box` con `🔍` placeholder | client-side `filterIssuesBySearch(value)` | **Preserva**: `placeholder` + `aria-label` ambos accesibles. Click en `×` limpia. CA-3 invariante: `id="it-search-input"`. | `--surface-2` (bg), `--info` (focus border) | placeholder `"Buscar por # o titulo..."` + aria-label `"Buscar issues por numero o titulo"` |
| Tabs `active`/`completed`/`all` | `dashboard.js:2454-2458` → `.ic-tabs` con `role="tablist"` | client-side `filterIssueTab(this, name)`; counts dinamicos `${activeIssues.length}` etc. | **Preserva**: 3 tabs con count chips. Tab activo: borde + bg `--info`. WCAG: `role`+`aria-selected`. | `--info-bg` (activo), `--surface-2` (inactivo) | `"Mostrar issues que estan avanzando ahora mismo"` / `"...mergeados con qa:passed o qa:skipped"` / `"...todos los issues del board sin filtro"` |
| Lanes del Kanban | `dashboard.js:2461` → `.it-lanes` con `${lanesHTML}` | builder local en `dashboard.js:2200-2369` con `state.issueMatrix` + `manualOrderState` + `etaLib` | **Preserva via handoff (Opcion B / decision D1)**: `dashboard.js` sigue construyendo `lanesHTML` y lo pasa al partial como param. Lanes por fase: criterios (`--purple`), dev (`--info`), build (`--teal`), verificacion (`--brand-cyan`). | iconos `ic-fase-*` por lane, chips de skill con paleta `--provider-*` segun source | (por card, dot + skill chip) |
| Done lane | `dashboard.js:2462` → `${doneLaneHTML}` | mismo builder, ultimas 24h | **Preserva**: pills compactos `--success-bg` agrupados en "Terminados — ultimos 24h". | `--success` (border + texto pill) | — |
| Popup `#dot-popup` | `dashboard.js:2463-2466` → `<div id="dot-popup" style="display:none">` | client-side `closeDotPopup()` mas mutacion DOM por handler | **Preserva**: invariante `id="dot-popup"` (CA-3). No cambia estructura, solo estilo. | `--surface-3` (bg), `--border-strong` (border) | — |

### Piezas que se rediseñan (CA-C2)

| Pieza | Estado actual | Destino V3 |
|---|---|---|
| Emojis crudos (`🚨`, `🎯`, `🔍`, `📜`, `📄`, `❓`, `▶`, `✕`, `↗`) | inline en template literals | Reemplazados por `<svg><use href="../icons/sprite.svg#ic-*">` (botones operativos mantienen prefijo unicode como redundancia textual para WCAG dual-encoding). |
| Borde lateral severidad | unico color rojo difuso | **Rediseña**: borde de `3px` con `--danger` por defecto, en futuro modulable por severidad (`age_hours` -> stale -> intensidad). En esta historia: solo color, no cambia ancho. |
| Tabs sin tooltips | `title` ausente en los botones de tab | **Agrega tooltip CA-6**: cada tab tiene `title=` + `aria-label=` explicando el filtro que aplica. |
| Sin leyenda visible | el operador adivina que significa cada color | **Agrega leyenda CA-C3**: bloque informativo bajo el panel needs-human con chips fresh/old/active/done + nota que "Reactivar/Desestimar" dispara endpoints state-changing. |

### Piezas que NO entran (out-of-scope)

| Pieza | Motivo |
|---|---|
| Migracion `onclick=` -> `addEventListener` | Decision D4 del PO: queda en #3758, fuera del split #3731. CSP `script-src 'self'` (#3688) lo forzara en una ola posterior. |
| Migracion al helper `lib/escape-html.js` | Decision D5 del PO: si #3722 mergea antes que esta historia entre a dev, import directo; si no, fallback aceptable de duplicar `escapeHtmlSsr` local (espejo de `home.js:33-41`) con TODO. |
| Mover builders de lanes a `matriz.js` | Decision D1 del PO (Opcion B): los builders quedan en `dashboard.js` y se pasan por param. Consolidacion futura — split aparte. |
| Boton "Desestimar + worktree" como pieza visual nueva | El endpoint `POST /api/needs-human/<n>/dismiss-worktree` ya existe; el boton fisico aparece en otra fase del UX (no en esta historia). |
| Suite axe-core CI | Cubierto por #3717, fuera de scope. |

### Datos personales / sensibles renderizados

**Ninguno detectado.** Los campos interpolados son metadata publica de issues de GitHub (titulo, autor del comentario, fase del pipeline). Aun asi todos pasan por `escapeHtmlSsr` por defensa en profundidad (CA-4 / CA-7).

### Endpoints state-changing que dispara (CA-5)

- `POST /api/needs-human/<n>/reactivate` — disparado por `needsHumanReactivate(issue)`.
- `POST /api/needs-human/<n>/dismiss` (body `{ reason }`) — disparado por `needsHumanDismiss(issue)`.
- `POST /api/needs-human/<n>/dismiss-worktree` — disparado por handler asociado (no en MVP visual de esta historia).

Los 3 endpoints son state-changing y disparan acciones en GitHub (remove label, close issue, dismiss worktree). El `confirm()`/`prompt()` actual es **circuit-breaker UX**, no defensa CSRF real.

### Dependencias de seguridad pendientes que afectan a la ventana

| Issue | Tema | Como impacta |
|---|---|---|
| #3688 / #2532 / #2745 | CSP `script-src 'self'` del dashboard | Cuando aterrice, los `onclick="needsHumanReactivate(...)"` morirán. Migracion en #3758. |
| #2901 | Escape HTML unificado en `title=` attrs | Esta historia ya escapa comillas en tooltips (CA-4); cuando #2901 cierre, unificar para evitar drift. |
| #3624 | Audit log de reactivate/dismiss | Fuertemente recomendado tenerlo listo ANTES de que esta vista entre a prod (cada accion del operador deberia quedar en audit). |
| #3192 | Autor del audit log desde fuente confiable | Complementa #3624. |
| #3722 | Helper `lib/escape-html.js` compartido | Si mergea antes, esta vista debe importar; si no, fallback con TODO (decision D5). |

### Fallback inerte (CA-A3 / REQ-SEC-7)

Cuando `require('./views/dashboard/matriz')` arroja (sintaxis rota, dependencia faltante), `dashboard.js` debe:

1. Loguear `log('matriz view unavailable: ' + e.message)` (patron consolidado).
2. Renderizar un fallback minimo en el lugar del partial: contenedores vacios con los IDs invariantes (`#bloqueados-humano` oculto, `#issue-tracker` con mensaje "Board no disponible — ver logs"). NO dejar string vacio silencioso (anti-patron).
3. En `dashboard-routes.js`, el resolver degrada a `home.renderHomeSsr(opts)` (referencia en la receta del architect — "degrada a home si la vista no cargo").

### Tests requeridos (CA-7)

`.pipeline/views/dashboard/__tests__/matriz.test.js` con `node:test`. Cobertura minima:

1. Render SSR del sub-panel "Necesitan intervencion humana" con `state.bloqueados` no vacio.
2. Render SSR del sub-panel "Board Kanban" con `state.issueMatrix` no vacio.
3. Render combinado con ambos no vacios (caso real).
4. Render con ambos vacios (degenerado: contenedores existen, sin crash).
5. **Payload XSS canonico por CADA campo escapable** — `b.title`, `b.question`, `b.reason`, `b.summary`, `b.skill`, `b.phase`, `ev.preview`, `ev.author` — con `<script>alert(1)</script>`, `"><img src=x onerror=alert(1)>`, `javascript:void(0)`. Asercion: el HTML de salida NO contiene la string sin escapar.
6. `b.issue = "javascript:alert(1)"` debe omitir la fila (coercion a entero positivo via `safeIssueId`).
7. Verificar tooltips obligatorios (`title=` o `aria-label=`) en cada boton de accion.
8. Verificar IDs DOM invariantes presentes: `#bloqueados-humano`, `#issue-tracker`, `#it-search-input`, `#dot-popup`.

### Smoke curl (CA-8)

```bash
# Path partial (router cerrado en #3723)
curl -s 'http://127.0.0.1:3200/dashboard?view=matriz' | grep -c 'id="bloqueados-humano"\|id="issue-tracker"\|id="it-search-input"\|id="dot-popup"'
# Debe devolver 4 (un match por ID invariante)

# Verificar que el partial responda 200
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3200/dashboard/partial?view=matriz'
# Debe devolver 200
```

## Ventana **Historial** — split #3734

**Modulo destino:** `.pipeline/views/dashboard/historial.js`
**Slug del router:** `?view=historial` (path legacy `/?section=historial` mantenido por compatibilidad).
**Mockup adjunto:** `.pipeline/assets/mockups/31-historial-v3.svg` (1080×1920, kiosk vertical) + narrativa Lili en `narrativa-historial-v3.md`.
**Contrato:** `renderHistorialSsr(state, opts)` donde `state.agentHistory[]` viene **ya armado y ordenado** desde el padre. El modulo NO toca `matrixEntries` (mitiga R6 acoplamiento upstream con #3728).
**Out of scope:** filtros + busqueda + paginacion mas alla del cap 50 (tracked en #3778); CSRF/CSP estricta de `issueMoveTo*` (#3688 / #2532 / #2745); migracion `onclick` -> `data-attributes` (#3758); snapshot test cross-window de DOM IDs (#3755); enforcement axe-core CI (#3717).

### Piezas que se preservan (CA-A1, CA-A2, CA-B1)

| Pieza | Estado actual | Fuente de datos | Destino V3 | Token / icono | Tooltip CA-7 |
|---|---|---|---|---|---|
| Header colapsable + chevron | `dashboard.js:2986-2993` → `<h2 class="section-title-clickable" onclick="toggleSection('historial')">` | estatico (binding al estado global `collapsedSections`) | **Preserva**: invariante `id="agent-history"` + `data-section="historial"` para el DOM morphing. Chevron `▼` + texto. | `--info` (rail header), `--text-primary` (titulo), `--text-dim` (chevron) | `"Click para colapsar/expandir el panel del historial"` |
| Chip count `N ejecuciones` | `dashboard.js:2992` → `<span class="ah-count">` | `agentHistory.length` | **Preserva**: chip pill `--info-bg` con borde `--info` y texto del mismo color. | `--info`, `--info-bg` | `"Total de ejecuciones de agentes registradas en este snapshot"` |
| Popout a `/?section=historial` | `dashboard.js:2991` → `<a class="section-popout">` | estatico | **Preserva**: link `target="_blank"` + `rel="noopener noreferrer"`. Sprite `ic-link-out` reemplaza `↗`. | `--text-dim`, `--surface-1` (hover `--surface-2`) | `"Abrir el historial en una ventana independiente"` |
| Card de ejecucion | `dashboard.js:2963-2974` → `<a class="ah-card">` | item de `agentHistory[]` | **Preserva**: layout horizontal denso (avatar + skill + chip prio + #issue + titulo + chip fase + chip estado + duracion + timestamp + acciones). Rail lateral 3px del color del estado (dual-encoding). | `--surface-1` (bg), `--border` (borde), rail `--info`/`--success`/`--danger`/`--text-dim` segun estado | (por accion, ver siguientes filas) |
| Avatar persona (`.ah-avatar`) | `dashboard.js:2964` | `AGENT_PERSONA[h.skill]` (`dashboard.js:1557`) — fallback `{ icon: '⚙', name: skill, color: 'var(--dim)' }` | **Preserva**: circulo color persona con icono unicode. En carriers donde el sprite ya cubre el skill, se puede swap a `<svg><use href="#ic-*"/>`. | color persona (`AGENT_PERSONA[skill].color`), texto `--surface-0` para contraste | `"Agente {skillName}"` |
| Chip posicion manual (`.lc-pos`) | `dashboard.js:2960-2961` | `manualOrderIndex.get(String(h.issue))` (Map, `dashboard.js:1591`) | **Preserva**: chip pill `#N+1` con tooltip explicativo. Solo si el issue esta en el indice. | `--brand-cyan-bg`, `--brand-cyan` | `"Posicion en el orden manual (1 = mas prioritario)"` |
| Issue + titulo (`.ah-issue`) | `dashboard.js:2967` | `h.issue` + `h.titulo.slice(0,40)` | **Preserva**: `#N` en `--text-primary` + titulo truncado a 40 chars en `--text-secondary`. `escapeHtmlSsr` aplicado a `titulo`. | `--text-primary`, `--text-secondary` | `"#{issue} · {titulo completo escapado}"` |
| Chip fase (`.ah-fase`) | `dashboard.js:2968` | `h.fase` | **Preserva**: chip pill con color de la lane correspondiente (criterios=purple, analisis=teal, dev=info, build=teal, verificacion=brand-cyan, aprobacion=success). Sprite `ic-fase-*` opcional. | tokens `--purple/--teal/--info/--brand-cyan/--success` | (no necesario, el texto explica) |
| Chip estado (`.ah-status`) | `dashboard.js:2969` | combinacion `h.estado` + `h.resultado` | **Preserva**: glyph (●/✓/✗/—) + label (`En ejecucion`/`aprobado`/`rechazado`/`finalizado`). Dual-encoding obligatorio. | running=`--info`, ok=`--success`, fail=`--danger`, neutral=`--text-dim` | (no necesario, dual-encoding suficiente) |
| Duracion (`.ah-dur`) | `dashboard.js:2970` | `fmtDuration(h.duration)` (`dashboard.js:396`) | **Preserva**: texto mono. En running muestra `"durando {Xm Ys}"`; en finalizados muestra `"{Xm Ys}"` neto. | `--text-dim`, `var(--font-mono)` | — |
| Timestamp (`.ah-time`) | `dashboard.js:2971` | `new Date(ts).toLocaleString('es-AR', ...)` | **Preserva**: `DD/MM HH:MM`. Mono. | `--text-dim`, `var(--font-mono)` | — |
| PrioActions (`.ah-prio-actions`) | `dashboard.js:2952-2959` → 4 botones `⏫▲▼⏬` | inline handlers `issueMoveToTop/Up/Down/Bottom(N)` que viven en `renderClientScript` del padre | **Preserva**: handlers `onclick` 1:1, NO se mueven al modulo (decision cerrada, igual que #3731). `Number(h.issue)` antes de inyectar (R5). Solo se rendea si `isRunning`. | `--surface-3` (bg), `--border-strong` (borde) | `"Mover al tope de la columna"` / `"Subir una posicion"` / `"Bajar una posicion"` / `"Mover al fondo de la columna"` |
| Link PDF rejection (`.ah-pdf`) | `dashboard.js:2949-2951` | `h.hasRejectionPdf && isSafeFilename(h.rejectionPdf)` | **Preserva**: badge cuadrado con glyph `PDF` enmarcado, rail `--danger` para reforzar gravedad. Whitelist filename obligatoria (R3). | `--danger`, `--danger-bg`, `--danger` (texto) | `"Reporte de rechazo (PDF)"` |
| Link Ver log (CTA card) | `dashboard.js:2946` → `href={isLog ? "/logs/view/..." : GH(issue)}` | `h.hasLog && isSafeFilename(h.logFile)`; fallback `ghBaseUrl + Number(h.issue)` | **Preserva**: CTA pill a la derecha. Texto `Ver log en vivo →` en running, `Ver log` en finalizados, `Ver #N en GitHub` cuando no hay log. | `--info` (texto running), `--text-dim` (finalizados), `--surface-2` (bg) | tooltip dinamico del tip actual `"Ver log · {skill} · #{issue}"` o `"Ver #{issue} en GitHub"` |
| Toggle "Ver N mas" | `dashboard.js:2981-2983` → `<details class="ah-more"><summary class="ah-more-btn">` | hidden = `agentHistory.slice(15,50)` | **Preserva**: elemento nativo `<details>`, accesible por teclado, independiente del `toggleSection('historial')`. | `--info` (texto), `--surface-2` (bg al expandir) | (no necesario, el texto del summary explica) |

### Piezas que se rediseñan (CA-C2)

| Pieza | Estado actual | Destino V3 |
|---|---|---|
| Leyenda de estados | Ausente — el operador adivina que significa cada color de chip. | **Agrega leyenda CA-8**: bloque fijo arriba de la lista, antes del primer card. 4 chips (`En ejecucion`/`Aprobado`/`Rechazado`/`Finalizado sin resultado`) con dual-encoding (color + icono + texto). Hint a la derecha `"Trabajando-first; resto por timestamp desc"`. |
| Emojis crudos del header (`📜`, `↗`) | inline en template literal | Reemplazados por `<svg><use href="#ic-*">` del sprite (`ic-fase-criterios` o un futuro `ic-historial` + `ic-link-out`). Mantener prefijo Unicode si se posterga el sprite (CA-22). |
| Glyphs de estado (●/✓/✗/—) | Unicode inline | **Mantener Unicode** en este split (CA-22 explicito). Migracion a sprite trackeada como opcional dentro del propio CA — si se hace, agregar `ic-status-running/ok/fail/neutral` en `sprite.svg`. |
| Tooltips ausentes en acciones | Solo `prioActions` y `pdfLink` tienen `title`; el resto carece. | **Agrega tooltips CA-7**: cada accion operativa y cada chip informativo lleva `title=` + (cuando aplica) `aria-label=`. Texto en castellano, hardcoded. Si incluye datos dinamicos, escape obligatorio. |
| Chip count sin estilo distintivo | `<span class="ah-count">` simple sin pill ni borde | **Rediseña**: pill `--info-bg` con borde `--info-dim`. Refuerza identidad de la ventana como zona de consulta. |

### Piezas que NO entran (out-of-scope)

| Pieza | Motivo |
|---|---|
| Filtros por skill / resultado / issue | Cubierto por recomendacion abierta #3778 (`[ux] Filtros + busqueda en Historial`). |
| Busqueda full-text del historial | Idem #3778. |
| Paginacion mas alla del cap de 50 | Idem #3778. El cap se mantiene en 50 (15 visibles + 35 toggle) por riesgo de DoS render server-side (tracked en padre #3715). |
| Migracion `onclick="issueMoveTo*"` -> `addEventListener + data-attrs` | Decision D4 heredada (igual que #3731): queda en #3758. CSP estricta `script-src 'self'` (#3688) lo forzara en una ola posterior. |
| Migracion al helper `lib/escape-html.js` | Si #3722 mergea antes que esta hija entre a dev, import directo. Si no, fallback aceptable copiando `escapeHtmlSsr` inline desde `home.js:33-41` con TODO. |
| Mover el armado de `agentHistory[]` al modulo | Decision cerrada por architect: el padre arma el array (a partir de `matrixEntries`) y el modulo recibe el array ya ordenado via `state.agentHistory`. Mitiga R6 (acoplamiento upstream con #3728). |
| Snapshot test cross-window de DOM IDs | Cubierto por #3755 (aplicable a TODAS las ventanas extraidas). |
| Enforcement axe-core CI | Cubierto por #3717. WCAG AA se valida manualmente en este PR. |
| Acciones operativas mutantes que no sean `issueMoveTo*` | Fuera de scope. El historial es zona de consulta + reorden. Otras acciones (cancelar, retry) se manejan desde Equipo/Pipeline. |

### Datos personales / sensibles renderizados

**Ninguno detectado.** Todos los campos interpolados (`titulo`, `skill`, `fase`, `resultado`, `logFile`, `rejectionPdf`) son metadata publica del pipeline o de GitHub. Aun asi pasan TODOS por `escapeHtmlSsr` y los filenames adicionalmente por `isSafeFilename(/^[A-Za-z0-9._-]+$/)` por defensa en profundidad.

### Endpoints state-changing que dispara (CA-5)

- `POST /api/issue/<n>/move-to-top` — disparado por `issueMoveToTop(n)`.
- `POST /api/issue/<n>/move-up` — disparado por `issueMoveUp(n)`.
- `POST /api/issue/<n>/move-down` — disparado por `issueMoveDown(n)`.
- `POST /api/issue/<n>/move-to-bottom` — disparado por `issueMoveToBottom(n)`.

Solo visibles para cards `isRunning`. Comparten infraestructura CSRF/auth del resto del dashboard. **No es scope de este split fortalecerlos** — vive en #3688 / #2532 / #2745. El split solo debe garantizar que los handlers se referencian por nombre desde el SSR del modulo y NO se duplican.

### Dependencias de seguridad pendientes que afectan a la ventana

| Issue | Tema | Como impacta |
|---|---|---|
| #3722 | Helper `lib/escape-html.js` compartido | SOFT. Mientras no aterrice, usar `escapeHtmlSsr` inline copiado de `home.js:33-41`. Swap diferido. |
| #3723 | Router cliente `?view=<slug>` | SOFT para CA-18. Si todavia no expone `?view=historial`, el smoke se valida via render completo. |
| #2901 | Escape unificado en `title=` attrs | Cubierto por defensa local del modulo (escape de `tip` y todos los campos dinamicos). Cuando cierre, unificar. |
| #3688 / #2532 / #2745 | CSP estricta + CSRF dashboard | NO bloquea este split. Cuando entren, `onclick="issueMoveTo*"` morira -> migracion en #3758. |
| #3755 | Snapshot test cross-window | SOFT. Recomendacion abierta. |
| #3758 | Migracion onclick -> data-attrs | SOFT. Recomendacion abierta. |
| #3717 | Enforcement axe-core CI | SOFT. WCAG AA validado manualmente. |

### Fallback inerte (CA-A3 / REQ-SEC-7)

Cuando `require('./views/dashboard/historial')` arroja (sintaxis rota, dependencia faltante, etc.), `dashboard.js` debe:

1. Loguear `log('historial view unavailable: ' + e.message)` (patron consolidado en `dashboard.js:9027/9039`).
2. Renderizar en el lugar del partial un cartel visible con:
   - Icono warning (`--warning`).
   - Titulo `"Ventana Historial no disponible"`.
   - Subtitulo `"El modulo views/dashboard/historial.js fallo al cargar. Ver logs del dashboard para detalle."`
   - Linea mono explicativa: `'log("historial view unavailable: " + e.message) emitido por dashboard.js — el render no queda en blanco.'`
3. NO dejar string vacio silencioso (anti-patron). Variante ilustrada en el mockup adjunto, seccion "VARIANTE FALLBACK INERTE".

### Tests requeridos (CA-11..CA-17)

`.pipeline/views/dashboard/__tests__/historial.test.js` con `node:test`. Cobertura minima (12 casos):

1. Render vacio: `renderHistorialSsr({ agentHistory: [] }, opts)` retorna string vacio (el wrapper no se renderiza).
2. Render basico: 1 entrada `procesado` aprobada -> HTML valido con `<div id="agent-history">`, `.ah-list`, 1 `.ah-card`.
3. XSS en `titulo` (`<img src=x onerror=alert(1)>`) -> output sin `<img` literal, con `&lt;img`.
4. XSS combinado en `logFile` (`"><script>1</script>`) -> link omitido (whitelist), fallback a GitHub.
5. XSS en `resultado` (`"><svg onload=alert(1)>`) -> output escapado.
6. XSS en `skill` (`<img onerror=alert(1)>`) -> escapado en `.ah-skill` y en `title=`.
7. XSS en `fase` (`"><svg onload=1>`) -> escapado en `.ah-fase`.
8. Path traversal en `logFile` (`../../etc/passwd`) -> link omitido.
9. Path traversal en `rejectionPdf` (`../../../config`) -> `<a class="ah-pdf">` omitido.
10. Anti-tabnabbing: parsear HTML del output y verificar que TODO `<a target="_blank">` lleva `rel="noopener noreferrer"`.
11. Orden trabajando-first: mix 2 `trabajando` + 3 `procesado` -> las 2 trabajando aparecen antes (`ah-running` antes de `ah-ok` en posicion).
12. Coercion `issue`: `agentHistory[0].issue = '1234; alert(1)'` -> `Number(...) === NaN` -> `prioActions` omitido.

**Cobertura minima:** 85% de lineas del modulo (Istanbul / `node --test --experimental-test-coverage`).

### Smoke curl (CA-18 / CA-G2)

```bash
# Si el router #3723 ya expone ?view=historial
curl -s 'http://127.0.0.1:3200/dashboard?view=historial' | grep -q 'id="agent-history"'

# Fallback si router todavia no expone el slug standalone
curl -s 'http://127.0.0.1:3200/' | grep -q 'id="agent-history"'

# Conteo de IDs invariantes
curl -s 'http://127.0.0.1:3200/' | grep -c 'id="agent-history"\|data-section="historial"\|class="ah-list"'
# Debe devolver 3
```

## Ventana **Costos** — split #3735

**Modulo destino:** `.pipeline/views/dashboard/costos.js`
**Slug del router:** `?view=costos` (path legacy `/?section=costos` y embedido en `/` para el banner mantenidos por compatibilidad).
**Mockup adjunto:** `.pipeline/assets/mockups/32-costos-v3.svg` (1080×1920, kiosk vertical) + narrativa Lili en `narrativa-costos-v3.md`.
**Contrato:** `renderCostosSsr(state)` + `renderCostosBanner(state)` exportado para que `home.js` lo embeba sin duplicar request (Opcion A del R3 del architect). `renderCostosClientScript()` para los handlers `addEventListener`. **Endpoints POST migran al mismo split** a `.pipeline/lib/cost-anomaly/api.js` (patron `multi-provider/api.js`).
**Out of scope:** pagina `/consumo` standalone (recomendacion abierta #3779); export CSV (historia futura con threat model anti CSV-injection); CSRF/CSP estricta de `POST /api/cost-anomaly/*` (#3688 / #2532 / #2745); migracion `onclick` -> `data-attributes` global (#3758); snapshot test cross-window (#3755); enforcement axe-core CI (#3717).

### Piezas que se preservan (CA-1.3 / CA-A1, CA-A2, CA-B1)

| Pieza | Estado actual | Fuente de datos | Destino V3 | Token / icono | Tooltip CA-4.1 / CA-C5 |
|---|---|---|---|---|---|
| Pill de anomalia en header | `dashboard.js:5023-5029` → `<button id="cost-anomaly-pill" onclick="...scrollIntoView(...)">` | `state.costAnomaly.visible` + `state.costAnomaly.ratio` | **Preserva**: pill `--alert-anomaly-bg` con borde `--alert-anomaly-dim` y texto `CONSUMO ANÓMALO · +X%`. `onclick` inline migra a `addEventListener` (CA-3.3). | `--alert-anomaly`, `--alert-anomaly-bg`, `--alert-anomaly-fg`, glow `--alert-anomaly-glow` | `"Pico de consumo detectado. Click para ver el detalle en el banner."` |
| Banner persistente de anomalia | `dashboard.js:5058-5099` → `<section id="cost-anomaly-banner">` | `state.costAnomaly.{headline, detail, top_skills, snoozed_until}` | **Preserva**: rail rosa-rojo + icono pico + headline + detalle + top-3 skills + acciones. Visual de mockup 06 adaptado a kiosk vertical 1080×1920. `escapeHtmlSsr` en `top_skills[i].skill`. | `--alert-anomaly`, `--alert-anomaly-bg`, `--alert-anomaly-fg`, gradient `alertBannerGrad` | (por accion, ver siguientes filas) |
| KPI "Costo estimado" (rail teal) | `dashboard.js:8280-8291` → `<div class="cost-kpi-card">` | `state.totals.cost_usd` + delta vs periodo previo | **Preserva + rediseña**: rail lateral `--teal` (metrica protagonica). Valor grande en mono + delta% con flecha (verde si baja, rojo si sube — bajar es bueno en costos). Chip "i" leyenda. | `--teal`, `--surface-1`, `var(--font-mono)`, `--danger`/`--success` (delta) | `"Costo total estimado en la ventana seleccionada (USD)"` |
| KPI "TTS costo" (rail violeta) | `dashboard.js:8280-8291` | `state.totals.tts_cost_usd` | **Preserva**: rail `--rest-mode` (familia indigo TTS). Valor + delta. | `--rest-mode`, `var(--font-mono)` | `"Costo de generacion TTS (edge / groq / gemini) en la ventana"` |
| Tabla por skill | `dashboard.js:8293-8334` → `renderAgents(rows)` | `state.costsBySkill[] = {skill, cost_usd, sessions, pct, provider}` | **Preserva + rediseña**: rail lateral 3px del color del `--provider-*` token (#3086) por fila. Columnas: skill, provider chip, sesiones, costo USD, % total, promedio/sesion. Filas clicables -> drill-down. `Number(cost_usd)` antes de format. `escapeHtmlSsr` en `skill`. | `--provider-anthropic/codex/groq/gemini/cerebras` (rail), `--surface-1`, `var(--font-mono)` | `"Click para drill-down de las ultimas sesiones de este skill."` (tooltip #5) |
| Tabla por fase | `dashboard.js:8293-8334` → `renderPhases(rows)` | `state.costsByPhase[] = {fase, cost_usd, pct}` | **Preserva**: tabla compacta side-by-side con tabla por issue. Chips de fase con color de lane (criterios=purple, dev=teal, aprobacion=success, verificacion=info). Sin drill-down separado. | tokens `--purple/--teal/--success/--info` | (no necesario, el texto explica) |
| Tabla por issue | `dashboard.js:8293-8334` → `renderIssues(rows)` | `state.costsByIssue[] = {issue, titulo, cost_usd, sessions}` | **Preserva + rediseña**: tabla compacta clicable -> drill-down a timeline cronologica del issue. `Number(issue)` antes de inyectar en handler (defensa coercion debil). Titulo truncado a 40 chars + `escapeHtmlSsr`. | `--surface-1`, `var(--font-mono)`, `--text-primary` | `"Click para ver timeline cronologica del issue."` (tooltip #6) |
| Tarjetas de proyeccion (`projCard`) | `dashboard.js:8336-8380` → `renderProjections(totals)` | `state.projections.{month_usd, quota_usd, status}` con `status ∈ {over, warning, ok}` | **Preserva + rediseña**: 3 tarjetas (mensual, semanal, hoy) con semaforo dual-encoding (color + icono + texto). Rail lateral con gradiente del estado. WCAG AA. | `--danger`/`--warning`/`--success` (rail + chip), gradients `dangerStripe/warningStripe/successStripe` | `"Proyeccion extrapolando ratio historico ultimos 7 dias"` (por card) |
| Comparativa LLM vs determinístico | `dashboard.js:8382-8401` → `renderLlmVsDet()` | `state.llmVsDet.{llm_pct, det_pct, llm_cost_usd, det_cost_usd, savings_usd, savings_pct}` | **Preserva + rediseña**: barra horizontal de dos segmentos (`--info` LLM, `--deterministic` det). Leyendas + ahorro estimado en verde. `Number()` coercion. | `--info`, `--deterministic`, `--success` (ahorro), `var(--font-mono)` | `"Comparativa de costo por skill: cuanto se ahorro migrando el roleplay de LLM a deterministico."` (tooltip #7) |
| TTS por issue + drilldown | `dashboard.js:8403-8438` → `renderTtsByIssue() + showTtsProviders()` | `state.ttsByIssue[] = {issue, titulo, tts_usd, providers: [{name, usd, sec}]}` | **Preserva + rediseña**: tabla con `<details>` nativo por fila. Drilldown muestra providers (edge=teal free, groq=ambar paid, gemini=blue). Patron accesible por teclado sin JS adicional, mismo que Historial. | `--teal` (edge), `--retry` (groq), `--info` (gemini), `--surface-1` | `"Expandir para ver providers TTS y costos por proveedor"` |

### Piezas que se rediseñan (CA-2.1 / CA-C2)

| Pieza | Estado actual | Destino V3 |
|---|---|---|
| Pill de anomalia | Texto plano `CONSUMO ANÓMALO · +X%` sin tooltip. | **Agrega tooltip** `"Pico de consumo detectado. Click para ver el detalle..."` + migracion del `onclick` inline a `addEventListener` (preparacion CSP). |
| KPI grid | Lista plana 6 valores. | **Rediseña**: grilla 3x2 con rail lateral por familia (teal/violeta/info/purple/amber/success), delta% con flecha, chip "i" leyenda. Identidad visual coherente con el resto del epico. |
| Tabla por skill sin rail provider | Filas planas, identifica provider solo por texto. | **Agrega rail provider**: 3px lateral del `--provider-*` token (#3086) para que el operador identifique de un vistazo si el consumo es Anthropic, Codex, Groq, etc. |
| Proyecciones sin semaforo visual | Texto plano con costo proyectado. | **Agrega semaforo dual-encoding**: color + icono (triangulo over / rombo warning / check ok) + texto explicito. WCAG AA cumplido. |
| LLM vs determinístico sin barra comparativa | Lista de numeros. | **Agrega barra horizontal** de dos segmentos con porcentajes y leyendas + ahorro en verde grande para impacto visual inmediato. |
| TTS por issue sin drilldown expandible | Toggle JS custom con `showTtsProviders(issue)`. | **Migra a `<details>` nativo** (patron Historial). Accesibilidad keyboard sin JS adicional. |
| Tooltips ausentes en acciones | Solo el banner tiene texto explicativo en el cuerpo; las acciones no llevan `title`. | **Agrega tooltips CA-4.1**: 7 acciones operativas con `title=` + `aria-label=`, texto estatico server-side escapado. |

### Piezas que NO entran (out-of-scope)

| Pieza | Motivo |
|---|---|
| Pagina `/consumo` standalone | `dashboard.js:7913+` queda intacta en este split. Su consolidacion con `costos.js` sale como recomendacion #3779 (post-split). Evita PR enorme con dos superficies mezcladas. |
| Boton "Exportar a CSV" | Historia futura con su propio threat model. Si entra sin prevencion de CSV injection (prefijo apostrofe en celdas que arranquen con `= + - @ \t \r`), se rechaza. |
| CSRF / CSP estricta para `POST /api/cost-anomaly/*` | NO bloquea este split. El split aplica defensas D1-D3 in-line (Sec-Fetch-Site, Content-Type estricto, hours whitelist). CSP estricta global vive en #3688 / #2532 / #2745. |
| Migracion global `onclick` -> `data-attributes` | Decision D4 heredada (igual que Historial): el split solo migra los `onclick` de la propia ventana Costos. Migracion completa del dashboard vive en #3758. |
| Helper compartido `lib/escape-html.js` | Si #3722 mergea antes que esta hija entre a dev, import directo. Si no, fallback aceptable copiando `escapeHtmlSsr` inline desde `home.js:33-41` con `// TODO migrar a lib/escape-html.js post-#3722` (CA-3.1). |
| Mover el calculo de costos al modulo | El padre arma el snapshot (`state.costAnomaly`, `state.totals`, `state.costsBySkill/Phase/Issue`, `state.projections`, `state.llmVsDet`, `state.ttsByIssue`) y el modulo recibe los arrays/objetos ya armados. Mitiga acoplamiento con el detector de anomalias (`.pipeline/anomaly-detector.js`). |
| Snapshot test cross-window de DOM IDs | Cubierto por #3755 (aplicable a TODAS las ventanas extraidas). |
| Enforcement axe-core CI | Cubierto por #3717. WCAG AA se valida manualmente en este PR (CA-5.1..5.4). |

### Datos personales / sensibles renderizados

**Ninguno detectado.** Los campos interpolados (`skill`, `fase`, `issue`, `titulo`, `top_skills[i].skill`, `provider`, `cost_usd`) son metadata publica del pipeline o de GitHub. Aun asi pasan TODOS por `escapeHtmlSsr` por defensa en profundidad. Verificaciones adicionales:

- **NO** se renderizan claves de API en el HTML — el wizard de providers (#3624) se encarga del masking upstream `sk-•••••<last4>`.
- **NO** se renderizan paths absolutos del filesystem en mensajes de error — solo mensaje generico `"No se pudieron cargar los datos de costos."` con stack solo en `console.error` server-side (CA-3.5).
- **NO** se renderizan stack traces JS al cliente.

### Endpoints state-changing que dispara (CA-3.4)

- `POST /api/cost-anomaly/ack` — disparado por el boton "Ya lo vi" del banner. **Migra** a `.pipeline/lib/cost-anomaly/api.js` (patron `multi-provider/api.js`).
- `POST /api/cost-anomaly/snooze` — body `{hours: 1|4|24}`. Disparado por los 3 botones de snooze. **Migra** al mismo modulo.

Defensas in-line obligatorias para ambos (CA-3.4 D1-D3):
1. Header `Sec-Fetch-Site: same-origin` obligatorio. Rechazar `cross-site` con `403`.
2. Content-Type `application/json` estricto. Rechazar `application/x-www-form-urlencoded` con `415`.
3. `hours` whitelist `{1, 4, 24}` server-side. Rechazar otro valor con `400`. Cap 24h hardcoded (modo descanso).

Tests en `.pipeline/lib/cost-anomaly/__tests__/api.test.js`: cross-site → 403, form-urlencoded → 415, `hours: 999` → 400.

### Dependencias de seguridad pendientes que afectan a la ventana

| Issue | Tema | Como impacta |
|---|---|---|
| #3722 | Helper `lib/escape-html.js` compartido | SOFT. Mientras no aterrice, usar `escapeHtmlSsr` inline copiado de `home.js:33-41` con TODO de migracion. |
| #3725 / #3773 | Router cliente `?view=<slug>` + endpoint `/dashboard/partial` | SOFT. Smoke curl tiene fallback para path legacy `/` mientras router no expone `?view=costos`. |
| #2901 | Escape unificado en `title=` attrs | Cubierto por defensa local del modulo (escape de `tip` y todos los campos dinamicos). |
| #3688 / #2532 / #2745 | CSP estricta + CSRF dashboard | NO bloquea este split. El split SI elimina `onclick` inline de la ventana Costos (preparacion). |
| #3624 | Wizard providers + masking API keys | El masking lo hace upstream el wizard, costos.js confia en que el state ya viene mascarado. |
| #3755 | Snapshot test cross-window | SOFT. Recomendacion abierta. |
| #3758 | Migracion global onclick -> data-attrs | SOFT. Recomendacion abierta. |
| #3717 | Enforcement axe-core CI | SOFT. WCAG AA validado manualmente. |

### Fallback inerte (CA-A3 / REQ-SEC-7)

Cuando `require('./views/dashboard/costos')` arroja (sintaxis rota, dependencia faltante, etc.), `dashboard.js` debe:

1. Loguear `log('costos view unavailable: ' + e.message)` (patron consolidado en `dashboard.js:9027/9039`).
2. Renderizar en el lugar del partial un cartel visible con:
   - Icono warning (`--warning`).
   - Titulo `"Ventana Costos no disponible"`.
   - Subtitulo `"El modulo views/dashboard/costos.js fallo al cargar. Ver logs del dashboard para detalle."`
   - Linea mono explicativa: `'log("costos view unavailable: " + e.message) emitido por dashboard.js — el render no queda en blanco.'`
3. **Critico para el banner embedido en home**: si `renderCostosBanner` falla cuando se invoca desde `home.js`, el home.js NO debe romper — captura el error, loguea, y omite el banner. La ventana Costos sigue mostrando el fallback inerte en su propio slot. NO dejar string vacio silencioso en NINGUNO de los dos lugares.

Variante ilustrada en el mockup adjunto, seccion "VARIANTE FALLBACK INERTE".

### Tests requeridos (CA-6.1, CA-6.2, CA-6.3)

`.pipeline/views/dashboard/__tests__/costos.test.js` con `node:test`. Cobertura minima (7 casos):

1. **Render SSR vacio**: `renderCostosSsr({ costAnomaly: { visible: false }, totals: {}, costsBySkill: [], ... })` -> HTML sin banner pero con KPIs y tablas en estado vacio (`"Sin datos en la ventana seleccionada"`).
2. **Render SSR con anomalia activa**: fixture con `state.costAnomaly.visible=true` + 3 top skills -> HTML contiene `<section id="cost-anomaly-banner">` + los 3 nombres escapados.
3. **XSS canonico (CA-3.2)**: payload `skill: '<img src=x onerror=alert(1)>'` en `top_skills[0]` -> HTML contiene `&lt;img` y NO `<img src=x onerror`.
4. **XSS en provider name**: payload `provider: '"><svg onload=alert(1)>'` -> escapado en el chip de provider.
5. **Coercion Number en cost_usd**: `cost_usd: '1.42; alert(1)'` -> `Number(...) === NaN` -> celda muestra `"--"`, no inyecta el string.
6. **Coercion Number en issue (cost-bi-row)**: `issue: '1234; alert(1)'` -> `Number(...) === NaN` -> fila omitida.
7. **Render banner embedido desde home.js (CA-6.3 / R3 Opcion A)**: `renderCostosBanner({costAnomaly: {visible: true, ...}})` retorna HTML del banner sin acoplarse al snapshot global de costos.js.

Tests adicionales en `lib/cost-anomaly/__tests__/api.test.js`:
- Snooze cross-site (Sec-Fetch-Site: cross-site) -> 403.
- Snooze form-urlencoded -> 415.
- Snooze fuera de whitelist (`hours: 999`) -> 400.
- Snooze valido (`hours: 4`) -> 200.

**Cobertura minima:** 85% de lineas del modulo.

### Smoke curl (CA-6.2 / CA-G2)

```bash
# Si el router #3725 ya expone ?view=costos
curl -s 'http://127.0.0.1:3200/dashboard?view=costos' | grep -q 'id="cost-anomaly-banner"\|id="costos-window"'

# Fallback si router todavia no expone el slug standalone
curl -s 'http://127.0.0.1:3200/' | grep -q 'id="cost-anomaly-banner"\|id="cost-anomaly-pill"'

# Conteo de IDs invariantes (ventana costos)
curl -s 'http://127.0.0.1:3200/' | grep -c 'id="costos-window"\|data-section="costos"\|class="cost-kpi-grid"\|class="cost-bs-table"'
# Debe devolver 4
```

## Ventana **Providers** — split #3737

**Modulo destino:** `.pipeline/views/dashboard/providers.js`
**Slug del router:** `?view=providers` (servido via router cerrado en #3723).
**Mockup adjunto:** `.pipeline/assets/mockups/33-providers-v3.html` — HTML/CSS integrado, renderizable con Puppeteer (CA-F2). Narrativa en `narrativa-providers-v3.md`.
**Origen declarado:** **Vista nueva — sin pieza heredada de `dashboard.js`.** Verificado empiricamente por `guru` (#issuecomment-4587478317): la palabra "Providers" en `dashboard.js` solo aparece en el drill-down de costos TTS (lineas 8150, 8407, 8415-8428, 9021-9060), que es scope del split de Costos (#3735). Esta historia CREA el modulo nuevo siguiendo la plantilla de `views/dashboard/home.js`. El verbo "EXTRAER" del scope del issue queda resuelto como NO APLICA (decision D1 del PO).
**Out of scope:** edicion de bindings agente-provider, fallback chain, catalogo de modelos, permission overrides, health historico — todo eso vive en `?view=multi-provider` (#3733). KPIs de proveedor (tokens, latencia, cost por provider) tampoco entran en este split — decision D2 del PO, queda para #3729 KPIs. Wizard guiado de set inicial — decision D3 del PO, queda para sub-historia de "wizards" del epico.

### Composicion de la ventana

La ventana es **read-only operativa** (no read-only pura como KPIs): el operador puede disparar `Reload` para re-hidratar metadata desde `credentials.json`, pero NO puede escribir keys via UI (CA-PRV-6 / SEC-2 inquebrantable — set/rotate por terminal Windows).

| Sub-bloque | ID DOM invariante | Proposito | Trigger de visibilidad |
|---|---|---|---|
| Leyenda de status + anti-leak callout | `#providers-legend` | Explica status `present`/`placeholder`/`absent`/`error` + advertencia SEC-1 visible | Siempre |
| Grilla de provider cards | `#providers-list` | Una `<article class="provider-card">` por entry de `MANAGED_KEYS` | Siempre — si esta vacio (improbable), muestra "Sin providers gestionados" |
| Reload global + Modal instructional | `#providers-ops` | Boton `Reload todo` + modal read-only "Como rotar / setear" con pasos de terminal | Siempre visible |
| Audit callout | `#providers-audit` | Linea sobria explicando que se loguea en `lib/audit-log` (SEC-5/SEC-6) | Siempre |
| Fallback inerte | (variante de `dashboard.js`) | Render minimo cuando `require` del modulo arroja | Solo si el require falla |

### Diferenciacion con `?view=multi-provider` (#3733)

Cruz operativa explicita — la cierra D0 del PO:

| | `?view=providers` (este split) | `?view=multi-provider` (#3733) |
|---|---|---|
| **Audiencia** | Operador que mira el estado | Operador que cambia configuracion |
| **Capacidad** | Read-only + reload-only | Read + write (bindings, fallback chain) |
| **Datos** | Metadata masked + status + (futuro: metricas) | Bindings por agente, catalogo, overrides, health |
| **Interacciones** | "Rotate" = modal instructional con comando de terminal | Editar binding, definir fallback chain, override permissions |
| **Tabs** | Sin tabs (vista plana) | 5 tabs (1-Proveedores, 2-Por agente, 3-Catalogo, 5-Health, 6-Permission overrides) |
| **Fuente de masking** | `lib/multi-provider/secrets-rw.js` (unica) | `lib/multi-provider/secrets-rw.js` (unica) |

**Garantia anti-leak cross-route** (inquebrantable): ambas vistas obtienen metadata exclusivamente desde `lib/multi-provider/secrets-rw.js`. Ningun modulo de vista re-implementa masking propio — cualquier dato derivado de la key sale ya enmascarado desde el lib. Cierra el riesgo que `guru` levanto de "dos lugares que enmascarar".

### Piezas que se crean (vista nueva — CA-A1, CA-A2)

| Pieza | Fuente de datos | Token / icono | Tooltip CA-PRV-12 |
|---|---|---|---|
| Header de ventana + V3 badge | estatico | `--teal` (badge), `--text-primary` (titulo), `--info-bg` (link primario) | `"Volver a la vista Home del dashboard"` / `"Abrir consola Multi-Provider de configuracion avanzada"` / `"Abrir runbook de rotacion de credenciales"` |
| Leyenda de status (4 chips dual-encoding) | estatico | `--success`/`--warning`/`--text-dim`/`--danger` (chips), `--success-bg`/`--warning-bg`/`--surface-2`/`--danger-bg` | (los chips se auto-explican) |
| Anti-leak callout SEC-1 | estatico | `--danger`, `--danger-bg`, border `--danger` | `"Garantia SEC-1: la API key completa NUNCA viaja por HTTP. Aca solo se muestra el masked preview sk-•••••<last4>. El set/rotate se hace por terminal Windows."` |
| Provider card (una por entry de `MANAGED_KEYS`) | `secrets-rw.listKeys()` retorna `{provider, jsonField, canonicalPath, label, editable, reason, free_tier_notes, status, masked, fingerprint}` | rail lateral 3px con `--provider-*` del token correspondiente | (por pieza interna, ver siguientes filas) |
| Provider name + dot + sub-label | `spec.label` + `spec.free_tier_notes` o reason corto | `--provider-anthropic/openai/elevenlabs/gemini/cerebras/nvidia-nim` (dot color) | (auto-explicativo) |
| Status badge dual-encoding (color + icono + texto) | `entry.status ∈ {present, placeholder, absent, error}` | mismo set que la leyenda | tooltip dinamico: `"Credencial cargada y valida. Last hydrate OK."` (present) / `"Hay un texto demo en el slot (REVOKED/PLACEHOLDER/EXAMPLE/etc.). Necesita set inicial desde terminal."` (placeholder) / `"No hay credencial cargada para este provider. El multi-provider fallback la salteara."` (absent) / `"Fallo la lectura. Ver detalle abajo. El multi-provider fallback omite este provider hasta que se resuelva."` (error) |
| Meta `Masked` | `entry.masked` (ya enmascarado upstream) — NUNCA recomputar | `--brand-cyan` (mono) | `"Preview sk-•••••<last4>. Solo los primeros 6 y los ultimos 4 chars son visibles."` |
| Meta `Fingerprint` | `entry.fingerprint` (SHA-256 truncado a 16 hex chars) | `--purple` (mono) | `"SHA-256(api_key) truncado a 16 chars hex. Sirve para comparar entre maquinas/backups sin exponer la key."` |
| Meta `Path` (`canonicalPath`) | `entry.canonicalPath` | `--text-secondary` (mono) | — |
| Meta `Editable UI` | `entry.editable` + `entry.reason` (cuando no editable) | `--text-secondary` | tooltip dinamico con `reason` cuando `editable=false` |
| Meta `Detalle` (solo en `error`) | mensaje de error **sanitizado server-side** (sin paths absolutos, sin key material) | `--danger` (mono) | `"Mensaje de error sanitizado server-side. NO incluye la key, NO incluye paths absolutos del disco."` |
| Boton `Reload` por card | endpoint `POST /api/providers/<name>/reload` (sin body) | `--info-bg`/`--info`/`--info-dim` (primary) | `"Releer credentials.json desde disco para volver a hidratar la metadata de este provider. NO recibe key por HTTP."` |
| Boton `Como rotar` por card | abre el modal/section `#rotate-instructions` (anchor) | `--surface-2`/`--text-secondary` | `"Abrir instrucciones del comando de terminal para rotar la key (SEC-2: jamas se acepta key por HTTP)."` |
| Boton `Rotate (n/a)` para Anthropic | deshabilitado, `aria-disabled="true"` | `--text-dim` (disabled) | `"Rotar la credencial de Anthropic no aplica por UI. Pasa por re-loguear Claude MAX desde el CLI."` |
| Ops card `Reload global` | endpoint `POST /api/providers/reload` (sin body) — re-hidrata TODOS los providers | `--info-bg` (primary) | `"POST /api/providers/reload — sin body. Re-hidrata desde credentials.json. Audit log queda en lib/audit-log con timestamp + masked previews."` |
| Helper text `SEC-3` debajo del reload global | estatico | `--text-dim` | (texto educativo, sin tooltip) |
| Modal instructional `Como rotar / setear` | estatico — 4 pasos + 2 bloques `<pre><code>` con comandos | `--info-dim` (border), `--info` (border-left), `--surface-2` (pre bg) | (auto-explicativo, los pasos numerados son redundancia textual) |
| Audit callout SEC-5/SEC-6 | estatico | `--surface-2`, border-dashed `--border-strong` | (auto-explicativo) |
| Footer note (canales redundantes) | estatico | `--text-dim`, italic | (auto-explicativo) |

### Piezas que NO entran (out-of-scope)

| Pieza | Motivo |
|---|---|
| `<input type="password">` para rotar | CA-PRV-6 / SEC-2 inquebrantable. Memoria post-incidente Groq `feedback_api-keys-terminal-only`. Se rechaza en `aprobacion` si aparece. |
| Edicion de bindings agente-provider | Scope de `?view=multi-provider` (#3733). |
| Catalogo de modelos por provider | Idem #3733 / `multi-provider/model-catalog.js`. |
| Fallback chain editor | Idem #3733. |
| Permission overrides | Idem #3733. |
| Health checks historicos / cron metrics | Idem #3733 / `multi-provider/health-*`. |
| KPIs de tokens/latencia/cost por provider | Decision D2 del PO — queda para split de KPIs (#3729) decidir si los mueve aca cuando entre a `criterios`. Por ahora siguen en KPIs. |
| Wizard guiado de set inicial | Decision D3 del PO — sub-historia de "wizards" del epico. Cualquier wizard que pida key por HTTP se rechaza por CA-PRV-6. |
| Boton "Exportar credenciales" en cualquier forma | Diametralmente opuesto al objetivo del split. NO entra. |
| Filtros / busqueda sobre el listado | El listado es corto (6 providers) — no justifica complejidad. |
| Snapshot test cross-window de DOM IDs | Cubierto por #3755. |
| Enforcement axe-core CI | Cubierto por #3717. WCAG AA validado manualmente. |

### Datos personales / sensibles renderizados

- **API keys reales**: PROHIBIDO. La vista consume `entry.masked` (`sk-•••••<last4>`) y `entry.fingerprint` (SHA-256 truncado). El raw value JAMAS sale del proceso Node — `secrets-rw.listKeys()` ya lo enmascara antes de devolver. CA-PRV-5 / SEC-1 verificable por `curl + grep -cE 'sk-(ant-)?[A-Za-z0-9_-]{20,}'` que debe devolver `0`.
- **Paths absolutos del disco**: PROHIBIDO en mensajes de error visibles al cliente. Solo en `console.error` server-side. El campo `Detalle` de status `error` muestra mensaje generico saneado (ej. `"credentials.json no es JSON valido (linea 12)"`).
- **Stack traces JS**: PROHIBIDO al cliente.
- **PIDs y nombres de proceso**: el PID del requester se loguea en el audit trail (SEC-6) pero NO se renderiza en la ventana.

Todos los campos dinamicos pasan por `escapeHtmlSsr` (CA-PRV-8 / SEC-4) — `provider.label`, `provider.reason`, `provider.free_tier_notes`, `entry.masked` (defensa en profundidad aunque ya viene saneado), `entry.fingerprint`, mensaje de error.

### Endpoints state-changing que dispara (CA-PRV-7 / SEC-3)

- `POST /api/providers/<name>/reload` — disparado por el boton `Reload` por card. **Sin body**. Re-hidrata solo ese provider.
- `POST /api/providers/reload` — disparado por el boton `Reload todo`. **Sin body**. Re-hidrata todos.

**Defensas in-line obligatorias** (CA-PRV-7 / SEC-3 inquebrantable):

1. Validar `Origin === 'http://localhost:3200'` (o `Host === 'localhost:3200'` como fallback). Rechazar cross-site con `403 Forbidden`.
2. Method debe ser `POST`. `GET`/`PUT`/`DELETE`/etc. retornan `405 Method Not Allowed`.
3. Content-Type estricto `application/json` o ausente (sin body). Rechazar `application/x-www-form-urlencoded` con `415 Unsupported Media Type` (defense in depth — no estamos esperando body, pero el header signal previene un browser form attack).
4. Body, si existe, debe ser `{}` o ausente. Cualquier campo extra (especialmente uno que parezca key) se ignora silenciosamente Y se loguea en audit-log como `suspicious_extra_fields` (CA-PRV-10 / SEC-6).
5. Reusa `lib/multi-provider/csrf.js` si esta disponible (mismo patron que `?view=multi-provider`).

### Audit trail (CA-PRV-10 / SEC-6)

Cada reload escribe entrada NDJSON en `lib/audit-log` con:

```json
{
  "ts": "2026-05-31T20:34:12.123Z",
  "action": "provider-reload",
  "provider": "openai",
  "scope": "single",                  // o "all" para reload global
  "masked_preview": "sk-proj-****8a01",
  "fingerprint_before": "abc123...",  // del state anterior (null si era absent/error)
  "fingerprint_after":  "def456...",  // del state nuevo
  "requester_pid": 1234,
  "requester_ip":  "127.0.0.1",
  "result": "ok"                      // o "error: <mensaje saneado>"
}
```

Los logs server-side (no audit, los generales `dashboard-*.log`) tambien solo loguean el masked — `grep -E "sk-[A-Za-z0-9_-]{20,}" logs/dashboard-*.log` debe devolver 0 lineas tras ejercitar el flow (CA-PRV-9 / SEC-5).

### Dependencias de seguridad pendientes que afectan a la ventana

| Issue | Tema | Como impacta |
|---|---|---|
| #3688 / #2532 / #2745 | CSP `script-src 'self'` del dashboard | SOFT (CA-PRV-20). Esta vista nace NUEVA — no se introducen `onclick=` inline ni `<script>` inline para evitar deuda contra CSP estricta. Documentar en PR. |
| #3722 | Helper `lib/escape-html.js` compartido | SOFT. Si #3722 ya mergeo: import directo. Si no: `escapeHtmlSsr` inline copiado de `home.js:33-41` con `// TODO migrar a lib/escape-html.js post-#3722` (decision D5 del PO en #3731, aceptable aca tambien). |
| #3765 | Helper `maskApiKey()` reusable (recomendacion `needs-human`) | SOFT. Si `needs-human` se aprueba antes que dev: usar el helper. Si no: confiar en `secrets-rw.maskValue()` que ya esta consolidado. |
| #3781 | Test de invariante `MANAGED_KEYS ↔ ENV_MAPPING` (recomendacion `needs-human`) | SOFT. Es defensa contra drift cross-lib, no bloquea esta vista. |
| #2901 | Escape unificado en `title=` attrs | Cubierto por defensa local del modulo (`escapeHtmlSsr` en cada interpolacion de `title`). |
| #3755 | Snapshot test cross-window | SOFT. Recomendacion abierta. |
| #3717 | Enforcement axe-core CI | SOFT. WCAG AA validado manualmente. |

### Fallback inerte (CA-A3 / CA-PRV-14)

Cuando `require('./views/dashboard/providers')` arroja (sintaxis rota, dependencia faltante, etc.), `dashboard.js` debe:

1. Loguear `log('providers view unavailable: ' + e.message)` (patron consolidado en `dashboard.js:9027/9039`).
2. Renderizar en el lugar del partial un cartel visible con:
   - Icono warning (`stroke="#D29922"` / `--warning`).
   - Titulo `"Ventana Providers no disponible"`.
   - Subtitulo `"El modulo views/dashboard/providers.js fallo al cargar. Ver logs del dashboard para detalle."`
   - Linea mono explicativa: `'log("providers view unavailable: " + e.message) emitido por dashboard.js — el render no queda en blanco.'`
   - **Tip de recovery**: link a `/dashboard?view=multi-provider` como alternativa de consulta. La consola avanzada tambien muestra el estado de las keys (mismo masking via `secrets-rw.js`). El operador no queda ciego.
3. **Critico**: NO dejar string vacio silencioso. Anti-patron rechazado en `verificacion`.

Variante ilustrada en el mockup adjunto, seccion "VARIANTE FALLBACK INERTE".

### Tests requeridos (CA-PRV-17 / CA-G1)

`.pipeline/views/dashboard/__tests__/providers.test.js` con `node:test`. Cobertura minima (8 casos):

1. **Render SSR con 6 providers en estado mixto** (2 `present`, 2 `placeholder`, 1 `absent`, 1 `error`) — HTML contiene 6 `<article class="provider-card">` + cada uno con su status badge correspondiente.
2. **Render SSR con state vacio** (`listKeys()` devuelve `[]`, hipotetico) — mensaje "Sin providers gestionados", sin crash, IDs `#providers-list` + `#providers-legend` presentes.
3. **Payload XSS canonico** sobre `provider.label`, `provider.reason`, `provider.free_tier_notes`, `entry.masked`, mensaje de error: payloads `<script>alert(1)</script>`, `"><img src=x onerror=alert(1)>`, `javascript:void(0)`. Asercion: HTML output NO contiene la string sin escapar, contiene `&lt;script` / `&lt;img`. **Incluye contenido de tooltips** (CA-PRV-8 / SEC-4).
4. **Asercion CA-PRV-5 anti-leak**: HTML resultante de TODO test no matchea la regex `sk-(ant-)?[A-Za-z0-9_-]{20,}` ni `AIza[A-Za-z0-9_-]{30,}` (gemini-shape). Verificar tambien que ningun `data-*` attribute, comentario HTML, ni JSON embebido contiene la key completa.
5. **Asercion CA-PRV-6**: el HTML NO contiene `<input type="password"`, `<input type=password`, `<textarea`, ni patron equivalente. Grep server-side: 0 matches.
6. **Asercion CA-PRV-7**: simular `POST /api/providers/reload` con `Origin: http://evil.example.com` -> respuesta `403`. Variante con `Content-Type: application/x-www-form-urlencoded` -> `415`. Variante con method `GET` -> `405`.
7. **Asercion CA-PRV-10**: tras un reload valido, `lib/audit-log` tiene una entrada NDJSON nueva con los campos esperados (`ts`, `action: 'provider-reload'`, `provider`, `masked_preview`, `fingerprint_before`, `fingerprint_after`, `requester_pid`, `result: 'ok'`).
8. **IDs DOM invariantes presentes**: `#providers-list`, `#providers-legend`, `#rotate-instructions` (anchor del modal), `#providers-ops` (si el dev lo agrupa). Slugs estables para QA/UX cross-window.

Tests **adicionales** en `lib/multi-provider/__tests__/secrets-rw.test.js` o `lib/multi-provider/api.test.js` (segun donde vivan los endpoints):

- Reload de provider no gestionado (`POST /api/providers/inexistent/reload`) -> `404`.
- Reload con body que incluye un campo `api_key` cualquiera -> ignorado + audit entry con `suspicious_extra_fields`.
- Reload cuando `credentials.json` esta corrupto -> response 200 con estado `error` por provider + log generico server-side.

**Cobertura minima:** 85% de lineas del modulo.

**Fixtures (CA-PRV-11 / SEC-7):** los tests usan keys ficticias con prefijo `PLACEHOLDER_` o el helper `secrets-rw.isPlaceholder()`. Verificable: `grep -E "sk-(ant-)?[A-Za-z0-9_-]{20,}" .pipeline/views/dashboard/__tests__/providers.test.js` retorna 0.

### Smoke curl (CA-PRV-18 / CA-G2)

```bash
# Render completo (legacy + query)
curl -s 'http://127.0.0.1:3200/dashboard?view=providers' \
  | grep -c 'id="providers-list"\|id="providers-legend"'
# Debe devolver 2

# Partial endpoint (router cerrado en #3723)
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3200/dashboard/partial?view=providers'
# Debe devolver 200

# Anti-leak cross-route (SEC-1 verificable end-to-end)
for view in providers multi-provider; do
  curl -s "http://127.0.0.1:3200/dashboard?view=$view" \
    | grep -cE 'sk-(ant-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}'
done
# Ambas deben devolver 0

# Defensa CSRF / Origin guard (SEC-3 verificable end-to-end)
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST -H 'Origin: http://evil.example.com' \
  'http://127.0.0.1:3200/api/providers/reload'
# Debe devolver 403
```

### Accesibilidad WCAG AA (CA-PRV-19 / CA-E1..E4)

- **Dual-encoding de status**: nunca solo color. Cada status badge tiene color + icono unicode (`✓`/`⚠`/`—`/`✕`) + texto en MAYUSCULAS (`PRESENT`/`PLACEHOLDER`/`ABSENT`/`ERROR`). Daltonismo cubierto.
- **Touch target botones operativos**: `min-height: 36px` (provider-btn) + `min-height: 44px` (reload global primary). Cumple guideline WCAG 2.5.5 (Target Size, AAA reach).
- **Contraste AA verificado** manualmente con devtools sobre el screenshot del PR. Tokens `--provider-*` ya tienen variantes `-fg` documentadas con ratio >= 10:1 sobre `-bg` (ver `design-tokens.css:143..223`).
- **Keyboard navigation**: cada card es `tabindex="0"`, cada boton es nativo `<a class="provider-btn">` con `:focus-visible` outline. Modal "Como rotar" es estatico embebido (no overlay JS) — accesible por scroll/anchor.
- **Screen readers**: cada card tiene `aria-label` resumiendo provider + status + masked. Cada boton tiene `aria-label` describiendo la accion. `aria-hidden="true"` en iconos unicode decorativos.

### Coherencia con el resto del epico

Esta ventana mantiene la identidad visual V3 establecida por las hermanas:

- **Header**: titulo + V3 badge teal + acciones derecha (mismo formato que Matriz / KPIs / Ops).
- **Leyenda**: misma posicion (debajo del header), mismo formato chip + dot + texto.
- **Cards en grilla**: rail lateral 3px del token del subject (igual que Costos por skill, Historial por estado).
- **Tooltips**: misma estetica (texto castellano, hardcoded server-side, escape en parte dinamica).
- **Footer note**: misma posicion y tono ("Tip: si esta ventana se cae...").
- **Fallback inerte**: mismo formato (icono warning + titulo + subtitulo + linea mono del log).

## Ventana **Descanso** — split #3736

**Modulo destino:** `.pipeline/views/dashboard/descanso.js` (NUEVO — extraido de `satellites.js:1561-2106`).
**Slug del router:** `?view=descanso` (slug nuevo, sin `modo-`) + **path legacy** `/modo-descanso` preservado sin redirect (CA-3736-B1, B2, B3). Ambos coexisten — son origenes operativos distintos (deep-link directo vs router cliente). Mismo patron que adopto Ops con su slug `ops` + path legacy `/ops`.
**Mockup adjunto:** `.pipeline/assets/mockups/34-descanso-v3.svg` (1080x1920, kiosk vertical). Narrativa en `narrativa-descanso-v3.md`.
**Origen declarado:** **Extraccion mecanica** de `renderModoDescanso()` en `satellites.js:1561-2106` (~545 lineas: body HTML + CSS + JS embebido + cierre con `pageShell(...)`). El nuevo modulo replica el patron canonico de `home.js`/`multi-provider.js` (inline shell, sin importar `pageShell` del monolito). Decision D1 confirmada por architect.
**Out of scope:** introducir CSRF nuevo en `POST /api/rest-mode` (CA-3736-I3 — el endpoint ya esta hardened con audit `rest-mode-audit.jsonl` / SEC-A03), consolidar la duplicacion deliberada cliente/backend de validacion `rest-mode-schedule.js` (CA-3736-A4 — preservar tal cual con FE-SEC-1), migrar al helper `lib/escape-html.js` compartido (CA-3736-E1 — fuera de scope, es split aparte #2901), wizard de doble confirmacion, preview live del countdown.

### Composicion de la ventana

La ventana es **read + write operativa** sobre la schedule del modo descanso. Toda la hidratacion es **client-side** via `fetch('/api/rest-mode')` cada 8s — el SSR solo emite estructura + textos hardcodeados, NO recibe state del servidor. Mutaciones via `POST /api/rest-mode` con hot-reload sin reinicio del pipeline.

| Sub-bloque | ID DOM invariante | Proposito | Trigger de visibilidad |
|---|---|---|---|
| Header de ventana + V3 badge + rail luna | (textual + `<svg use href="#ic-rest-mode">`) | Titulo "Modo descanso · calendario semanal" + badge teal V3 + subtitulo "gating de skills LLM · hot-reload sin reinicio" | Siempre |
| Hint text explicativo | (estatico) | Tres lineas: skills deterministicos siguen corriendo / cuales son / bypass labels priority:critical | Siempre |
| Status pill / banner | `#rm-status` (clases `.rm-status .rm-active` o `.rm-status .rm-inactive`) | Dual-encoding (icono luna + color rest-mode + texto). Activo muestra `currentPeriod` + `periodsToday` + `nextPeriod`. Inactivo muestra "Pipeline opera sin restricciones". | Siempre — el estado se deriva del slice |
| Checkbox "Activar" | `#rm-active` (input checkbox) | Toggle de activacion total. Si destildado, el pipeline opera sin restricciones (CA-1.9 heredado de #2882). | Siempre |
| Input "Zona horaria" + datalist | `#rm-timezone` + `#rm-tz-list` | Combobox con default `America/Argentina/Buenos_Aires`. Data list hidratado client-side via `Intl.supportedValuesOf('timeZone')` (con fallback a `TZ_DEFAULTS` estatico). | Siempre |
| Grilla semanal 7 columnas | `#rm-grid` (con atributo `data-rm-editing="0|1"`) | Lun..Dom, cada columna con N periodos (`max 24`). Caption por periodo: `☀ Dia completo` (00:00–23:59) / `🌙 Cruza medianoche · +1 dia` (start>end) / sin caption (intra-dia normal). Conteo `N/24` en header de columna (warning si N≥1, danger si overlap). | Siempre — el grid es el core funcional |
| Botones `+ Periodo` por columna | `.rm-col-add` (uno por dia, dentro del grid) | Agrega periodo nuevo `22:00–07:00` (default sensato para inicio nocturno). Disabled si `list.length >= MAX_PERIODS_PER_DAY`. | Siempre, disabled si cap alcanzado |
| Botones `✕` remove por periodo | `.rm-period-remove` (uno por periodo) | Elimina periodo del state local + re-renderiza grid. | Solo cuando hay periodos |
| Errors box | `#rm-errors` (hidden si vacio) + `#rm-error-count` (badge) | Validacion cliente: overlap entre periodos, HH:MM invalido, cap excedido. Texto: "Errores de validacion de cliente (nota: el backend revalida igual)". | Solo cuando `validateScheduleClient().errors.length > 0` |
| Boton "💾 Guardar configuracion" + msg | `#rm-save` + `#rm-msg` (`.rm-ok` / `.rm-err`) | Submit del form. Disabled si hay errores cliente. Mensaje post-submit: "✓ Guardado · hot-reload sin reinicio del pipeline." (ok) / "✗ <error sanitizado>" (err). | Siempre, disabled si validacion falla |
| Meta footer | `#rm-bypass` + `#rm-updated` + `.rm-meta` | Bypass labels (read-only desde `config.yaml`, chips de color por familia) + ultima actualizacion humanizada `es-AR`. | Siempre |
| Leyenda visual | (estatico, parte del shell SSR) | 6 items: periodo activo, dia completo, cruza medianoche, error, conteo, deterministicos. Cumple WCAG AA porque cada status tiene dual-encoding (color + icono + texto). | Siempre |
| Fallback inerte | (variante de `dashboard.js`) | Render minimo cuando `require('./views/dashboard/descanso')` arroja. | Solo si el require falla |

### Piezas que se preservan (CA-3736-A1, A4 + heredados CA-B1)

| Pieza | Estado actual | Fuente de datos | Destino V3 | Token / icono | Tooltip CA-3736-C* |
|---|---|---|---|---|---|
| Status header con `currentPeriod`/`nextPeriod`/`periodsToday` | `satellites.js:1942-1983` (renderStatus client-side) | `payload.window.active`, `payload.currentPeriod`, `payload.nextPeriod`, `payload.periodsToday` (slice enriquecido #3241) | **Preserva + rediseña**: dual-encoding (icono luna `ic-rest-mode` + color `--rest-mode-fg` sobre `--rest-mode-bg` + texto descriptivo) | `--rest-mode`, `--rest-mode-bg`, `--rest-mode-fg`, `--rest-mode-dim`. Icono `#ic-rest-mode` | (textos auto-explicativos en pill) |
| Checkbox "Activar modo descanso" | `satellites.js:1574` | `payload.window.active` (boolean) | **Preserva**: input checkbox nativo + label en strong. **Formaliza tooltip operativo** existente como `title=` + `aria-label=` (CA-3736-C1). | `--rest-mode` (checked), `--border-strong` (default) | `"Si destildas, el pipeline opera sin restricciones (CA-1.9)"` |
| Zona horaria | `satellites.js:1578-1583` | `payload.window.timezone` | **Preserva**: input texto + datalist hidratado client-side. Default `America/Argentina/Buenos_Aires`. | `--surface-0` (input), `var(--font-mono)` (texto) | — |
| Grilla semanal (7 columnas) | `satellites.js:1585-1665` (CSS) + `1801-1853` (buildGrid) | `payload.schedule` (schema nuevo CA-8.1) o `payload.window.start/end/days` (legacy mapeado) | **Preserva**: estructura 7 cols + max 24 periodos/dia. Validacion cliente espejo backend permanece tal cual (CA-3736-A4 / FE-SEC-1, NO consolidar). | `--surface-1` (col), `--rest-mode-bg` (periodo activo), `--danger-bg` (periodo error), `--warning` (conteo ≥1), `--border-strong` (col vacio) | — (por boton interno, ver siguientes filas) |
| Boton `+ Periodo` por columna | `satellites.js:1840-1848` | (estatico — agrega periodo `22:00–07:00` al state) | **Preserva**: boton dashed con texto centrado. Disabled si cap. **Formaliza tooltip operativo** existente (`addBtn.title`) como `title=` + `aria-label=` (CA-3736-C3). | `--border-strong` (default), `--rest-mode-fg` (hover) | `"Maximo 24 periodos por dia"` |
| Boton `✕` remove por periodo | `satellites.js:1882-1888` | (estatico — elimina periodo del state local) | **Preserva**: boton ghost minimal. **Formaliza tooltip operativo** existente (`aria-label`) como `title=` + `aria-label=` (CA-3736-C4). | `--text-dim` (default), `--danger` (hover) | `"Eliminar periodo"` |
| Errors box con validacion cliente | `satellites.js:1908-1927` (refreshErrorsBox) | `validateScheduleClient(scheduleState)` (overlap/HH:MM/cap) | **Preserva**: caja con borde danger atenuado + ul de items. Texto literal preservado para no romper expectativa del operador. | `--danger`, `--danger-bg` | — |
| Boton "💾 Guardar configuracion" | `satellites.js:1590` + `2066-2098` (submit handler) | (form submit → `POST /api/rest-mode`) | **Preserva**: boton primary en color rest-mode. Disabled si validacion falla. **Formaliza tooltip operativo** que NO existia (nuevo) — CA-3736-C2. | `--rest-mode-bg` (bg), `--rest-mode` (border), `--rest-mode-fg` (text) | `"Hot-reload sin reinicio del pipeline. El backend revalida la grilla."` |
| Meta footer (`bypass` + `updatedAt`) | `satellites.js:1595-1599` (HTML) + `1976-1982` (hidratacion) | `payload.bypassLabels` (array de strings, viene de `config.yaml`) + `payload.window.updatedAt` (ISO) | **Preserva + rediseña**: chips de color por familia (priority:critical → danger, rest-mode:exclude → rest-mode). `updatedAt` humanizado con `toLocaleString('es-AR')`. | `--danger-bg` (priority:critical/bypass chips), `--rest-mode-bg` (rest-mode:exclude chip), `var(--font-mono)` (timestamp) | — (chips auto-explicativos) |

### Piezas que se rediseñan (CA-3736 herencia CA-C2)

| Pieza | Estado actual | Fuente de datos | Destino V3 | Token / icono | Tooltip |
|---|---|---|---|---|---|
| Status pill + countdown panel | Status pill simple con icono + texto (1942-1983) | `payload.currentPeriod` + derivable: `currentPeriod.end - now` en minutos | **Rediseña**: status pill mantiene icono + texto, y agrega un mini panel a la derecha con 3 celdas: "Cierra en `4h 46m`" + "Periodos hoy `2/24`" + "Skills LLM `en cola`". Reusa exclusivamente el slice enriquecido del PR #3241 (no agrega request nuevo). | `--rest-mode-bg`, `--rest-mode-fg`, `var(--font-mono)` | — (cifras auto-explicativas) |
| Header con badge V3 | Header simple `<h2 class="in-section-title">` | (estatico) | **Rediseña**: agrega rail lateral `linearGradient restMoonRail` + badge teal "V3" + subtitulo "gating de skills LLM · hot-reload sin reinicio" para alinear con la identidad V3 del epico. | `--teal` (V3 badge), `--text-primary`, `--text-secondary` | — |
| Leyenda visual | NO existe en el codigo actual | (estatico — agregado nuevo por el split) | **Nueva**: 6 items con dual-encoding para cubrir CA-E1 (WCAG AA). Misma posicion que las demas ventanas V3 (debajo del meta footer, antes del out-of-scope). | Tokens del sistema | — (auto-explicativa) |

### Piezas que NO entran (out-of-scope — CA-3736-I3, A4, E1)

| Pieza | Motivo |
|---|---|
| CSRF nuevo en `POST /api/rest-mode` | CA-3736-I3. El endpoint ya esta hardened (Origin/Host guard + audit `rest-mode-audit.jsonl` SEC-A03). Introducir CSRF nuevo es scope de #3688/#2532/#2745 cuando aterrice CSP estricta. |
| Consolidar duplicacion cliente/backend de validacion (`overlap`/`HH:MM`/`MAX_PERIODS_PER_DAY`) | CA-3736-A4. Es decision deliberada del split #2890 PR-A (FE-SEC-1). El comentario inline `satellites.js:1668-1669` justifica defensa en profundidad cliente+backend. Consolidar a modulo client-side compartido es refactor cross-ventana fuera de este split. |
| Migracion a `lib/escape-html.js` compartido | CA-3736-E1. El helper aun no existe en main (dep #1 del epico, verificado por architect con `ls .pipeline/lib/escape-html.js` → No such file). Migracion es PR separado #2901 que toca TODAS las ventanas extraidas en una sola pasada. Mientras tanto, inline `escapeHtmlSsr` con cobertura OWASP canonica `& < > " ' /` (mismo cuerpo que `home.js:33-41`). |
| Wizard de doble confirmacion para "Guardar" | Decision UX consciente: el operador ya tiene feedback inmediato (errores cliente + msg post-submit + auditoria server-side). El wizard introduce friccion innecesaria para una configuracion reversible. |
| Preview live del countdown mientras edita | Decision UX: el countdown live ya se muestra en el status pill (hidratado por polling cada 8s). Un preview adicional en el form duplicaria informacion sin valor agregado. El usuario ve el efecto post-submit. |
| Helper compartido `validateScheduleClient` extraido a `lib/rest-mode-schedule-client.js` | CA-3736-A4. Espejo del backend `lib/rest-mode-schedule.js`. Consolidar es refactor cross-modulo fuera de scope. |
| Redirect entre `/modo-descanso` y `?view=descanso` | CA-3736-B3. Son origenes operativos distintos. Misma decision que tomo Ops con su slug + path legacy. |
| Snapshot test cross-window de DOM IDs | Cubierto por recomendacion abierta #3755. |
| Enforcement axe-core CI | Cubierto por recomendacion abierta #3717. WCAG AA validado manualmente sobre el screenshot del PR. |

### Datos personales / sensibles renderizados

- **Schedule del operador** (`schedule[day]` con periodos HH:MM): no es PII, pero define ventanas operativas del pipeline. Auditado server-side en `rest-mode-audit.jsonl` (SEC-A03).
- **Timezone**: no es PII (es metadata del operador). Default `America/Argentina/Buenos_Aires` hardcoded en el codigo.
- **Bypass labels**: viene de `config.yaml` (read-only). No hay PII. Se renderiza directamente como chip text.
- **`updatedAt`**: ISO timestamp, humanizado con `toLocaleString('es-AR')` client-side. No es PII.

Todos los campos dinamicos que aterricen al SSR (si en el futuro se interpola algun valor, ej. timezone default) DEBEN pasar por `escapeHtmlSsr` (CA-3736-D3 / E1+E2). Hoy el SSR no interpola — el XSS guard se concentra en el JS embebido del modulo (validacion: no usa `innerHTML` con datos del servidor, ver test D3).

### Endpoints state-changing que dispara (CA-3736-I3 — ya hardened SEC-A03)

- `POST /api/rest-mode` — disparado por el form submit. Body: `{ active, timezone, schedule, manual }`. Re-valida server-side con `lib/rest-mode-schedule.js` (overlap, HH:MM, MAX_PERIODS_PER_DAY). Audit trail en `rest-mode-audit.jsonl`. Hot-reload sin reinicio via watcher de `rest-mode-state.js`.

**Defensas inquebrantables del endpoint** (ya implementadas, NO se tocan en este split):

1. Validar `Origin === 'http://localhost:3200'` (o `Host === 'localhost:3200'` como fallback).
2. Method debe ser `POST`. Otros metodos retornan `405`.
3. Content-Type estricto `application/json`. Otros retornan `415`.
4. Body sanitizado server-side antes de aceptar (whitelist de fields: `active`, `timezone`, `schedule`, `manual`).
5. Backend revalida la grilla — el cliente NO es fuente de verdad (FE-SEC-1).

### Dependencias de seguridad pendientes que afectan a la ventana

| Issue | Tema | Como impacta |
|---|---|---|
| #3722 / #2901 | Helper `lib/escape-html.js` compartido | SOFT (CA-3736-E1). Mientras no aterrice: inline `escapeHtmlSsr` con cobertura OWASP canonica. Cuando aterrice: PR de unificacion toca todas las ventanas en una pasada. |
| #3688 / #2532 / #2745 | CSP `script-src 'self'` del dashboard | SOFT (CA-3736-I3). Esta ventana NO introduce `onclick=` inline ni `<script>` inline nuevos (el JS embebido vive dentro del shell del modulo). Documentar en PR. |
| #3755 | Snapshot test cross-window de DOM IDs | SOFT. Recomendacion abierta. Cubre `#rm-status`, `#rm-form`, `#rm-grid`, `#rm-errors`, `#rm-bypass`, `#rm-updated` como invariantes cross-window. |
| #3717 | Enforcement axe-core CI | SOFT. WCAG AA validado manualmente sobre el screenshot del PR. |

### Fallback inerte (CA-A3 / CA-3736-A2)

Cuando `require('./views/dashboard/descanso')` arroja, `dashboard.js` debe:

1. Loguear `log('descanso view unavailable: ' + e.message)` (patron consolidado en `dashboard.js:9027/9039`).
2. Renderizar en el lugar del partial un cartel visible con:
   - Icono warning (`stroke="#D29922"` / `--warning`).
   - Titulo `"Ventana Descanso no disponible"`.
   - Subtitulo `"El modulo views/dashboard/descanso.js fallo al cargar. Ver logs del dashboard para detalle."`
   - Linea mono explicativa: `'log("descanso view unavailable: " + e.message) emitido por dashboard.js — el render no queda en blanco.'`
   - **Tip de recovery**: el path legacy `/modo-descanso` sigue activo via guard en `dashboard-routes.js` (CA-3736-B1). Patron: `() => (descansoView && descansoView.renderDescanso) ? descansoView.renderDescanso() : sat.renderModoDescanso()`.
3. **Critico**: NO dejar string vacio silencioso. Anti-patron rechazado en `verificacion`.

Variante ilustrada en el mockup adjunto, seccion "VARIANTE FALLBACK INERTE".

### Tests requeridos (CA-3736-D1..D5 / CA-G1)

`.pipeline/views/dashboard/__tests__/descanso.test.js` con `node:test`. Cobertura minima (4 casos consolidados — patron base `__tests__/router.test.js`):

1. **Exports canonicos del modulo**: `slug === 'descanso'`, `renderDescanso` y `renderDescansoInner` son funciones. Cubre CA-3736-A1.
2. **Render SSR emite estructura esperada**: `renderDescanso()` retorna string que matchea regex de cada selector estructural (`rm-status`, `rm-grid`, `rm-bypass`, `rm-updated`, `rm-form`). Cubre CA-3736-D2.
3. **XSS guard sobre JS embebido**: extraer el contenido del `<script>` embebido y assertar que NO usa `\.innerHTML\s*=` con datos del servidor. El SSR de esta ventana no interpola state — el riesgo XSS vive en el JS embebido (toda hidratacion via `fetch('/api/rest-mode')` debe pasar por `textContent`/`createElement`). Cubre CA-3736-D3.
4. **Escape OWASP canonico sobre payload XSS**: pasar `opts = { tz: '<img src=x onerror=alert(1)>' }` a `renderDescanso()` y assertar que el output NO contiene la string sin escapar. Si el modulo NO interpola `opts.tz` (caso actual), el test sigue verde — pero garantiza que cualquier interpolacion futura pase por `escapeHtmlSsr`. Cubre CA-3736-D3 + E2.

Tests **adicionales** sobre router (cuando `VIEW_SLUGS['descanso']` se registre):

- `__tests__/router.test.js` debe seguir verde despues del cambio en `VIEW_SLUGS` y `HTML_ROUTES['/modo-descanso']`. Cubre CA-3736-B1, B2.

**Cobertura minima:** 100% de los exports del nuevo modulo (3 exports, todos testeados). Comando: `node --test .pipeline/views/dashboard/__tests__/descanso.test.js` debe pasar en verde sin warnings de deprecation (CA-3736-D5).

### Smoke curl (CA-3736-D4 / CA-G2)

```bash
# Path legacy (preserva CA-3736-B1)
curl -s 'http://127.0.0.1:3200/modo-descanso' \
  | grep -cE 'rm-grid|rm-status|rm-form|rm-bypass'
# Debe devolver 4

# Nuevo slug (CA-3736-B2, cuando se registre en VIEW_SLUGS)
curl -s 'http://127.0.0.1:3200/dashboard?view=descanso' \
  | grep -cE 'rm-grid|rm-status|rm-form|rm-bypass'
# Debe devolver 4

# Partial endpoint (router cerrado en #3723)
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3200/dashboard/partial?view=descanso'
# Debe devolver 200

# Defensa Origin guard del endpoint hardened (verificable end-to-end, ya implementado SEC-A03)
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST -H 'Origin: http://evil.example.com' -H 'Content-Type: application/json' \
  -d '{"active":true,"timezone":"UTC","schedule":{}}' \
  'http://127.0.0.1:3200/api/rest-mode'
# Debe devolver 403
```

### Accesibilidad WCAG AA (CA-3736-F1..F4 / CA-E1..E4)

- **Dual-encoding de status**: nunca solo color. Status header tiene color (`--rest-mode-fg` sobre `--rest-mode-bg`) + icono unicode (`🌙` activo / `○` inactivo) + texto descriptivo (`"Activa · ahora HH:MM–HH:MM"` o `"Inactivo · pipeline opera sin restricciones"`). Daltonismo cubierto.
- **Touch target botones operativos**: boton `Guardar` 40px alto, botones `+ Periodo` 32px (acceptable AA, no AAA), boton `✕` 22px (compacto pero accesible — patron del monolito preservado). Reusa `min-height` y `padding` heredados del CSS.
- **Contraste AA verificado** sobre los tokens: `--rest-mode-fg` (#C5B7FF) sobre `--rest-mode-bg` (rgba(124,92,255,0.16)) tiene ratio >= 7.4:1 documentado en `design-tokens.css:91`. Texto secundario `--text-secondary` sobre `--surface-1` >= 9.7:1.
- **Keyboard navigation**: todas las acciones operativas son nativas (`<input type="checkbox">`, `<button type="submit">`, `<button type="button">`). Tab/Enter/Space funcionan. `<label for="...">` une cada input con su label semantico. No hay `<div onclick>` (CA-3736-F2).
- **Tooltips no son la unica fuente de informacion**: el texto visible del boton ya comunica la accion base (`Guardar configuracion`, `+ Periodo`, `✕`). El tooltip aporta contexto adicional, no semantica unica (CA-3736-F3).
- **`aria-label` en botones con solo emoji**: el boton `✕` tiene `aria-label="Eliminar periodo"` (CA-3736-F4). El boton de guardar tiene texto visible ademas del emoji 💾.

### Coherencia con el resto del epico

Esta ventana mantiene la identidad visual V3 establecida por las hermanas:

- **Header**: titulo + V3 badge teal + rail lateral con gradiente semantico (igual que Matriz / KPIs / Ops / Bloqueados / Costos / Historial / Providers).
- **Hint text**: 3 lineas cortas debajo del header explicando que hace la ventana (igual que Bloqueados / Ops).
- **Status pill dual-encoding**: misma estetica que Costos (banner anomalia) / Historial (rail por estado).
- **Grid cards**: rail lateral 3px del token del subject (`--rest-mode` activo, `--border-strong` vacio, `--danger` error). Igual que Costos por skill / Historial por estado / Bloqueados por severidad.
- **Tooltips**: misma estetica (texto castellano, hardcoded server-side, escape canonico OWASP en parte dinamica si la hubiera).
- **Footer note out-of-scope**: misma posicion y formato (boundary dashed + tone neutro).
- **Fallback inerte**: mismo formato (icono warning + titulo + subtitulo + linea mono del log + tip de recovery).

## Otras ventanas del epico #3715

| Split | Ventana | Mockup | Estado |
|---|---|---|---|
| #3725 | Frame + brand bar | — | pendiente |
| #3726 | Home (KPIs principales) | `assets/mockups/26-dashboard-main-v3.svg` | en flight |
| #3727 | Equipo | — | pendiente |
| #3728 | Pipeline (flujo de agentes) | `assets/mockups/28-pipeline-v3.svg` | criterios |
| #3729 | Bloqueados | `assets/mockups/27-bloqueados-v3.svg` | criterios |
| #3730 | Issues | — | pendiente |
| #3731 | Matriz | `assets/mockups/29-matriz-v3.html` | criterios |
| #3732 | Ops | `assets/mockups/28-ops-v3.svg` | criterios |
| #3733 | KPIs principales (home) | `assets/mockups/30-kpis-v3.html` | criterios |
| #3734 | Historial | `assets/mockups/31-historial-v3.svg` | criterios |
| #3735 | Costos | `assets/mockups/32-costos-v3.svg` | criterios |
| #3736 | **Descanso (este split)** | `assets/mockups/34-descanso-v3.svg` | criterios |
| #3737 | Providers | `assets/mockups/33-providers-v3.html` | criterios |

> A medida que cada split entra a `criterios`, su `/ux` debe agregar la fila correspondiente con la tabla `pieza → fuente → destino`.

## Convenciones inquebrantables del rediseño V3

1. **Sin HEX libres en el codigo** — toda regla de estilo viene de `assets/design-tokens.css`. Si falta un token, se agrega ahi.
2. **Sin iconografia inline** — todo `<svg>` viene del sprite `assets/icons/sprite.svg` via `<use href="#ic-*">`.
3. **Sin `<pre>` con JSON crudo** — anti-patron UX. Reemplazar por estructuras semanticas (mini-cards, badges, listas key:value).
4. **Dual-encoding de severidad** — nunca solo color: agregar icono + texto + forma para WCAG AA (CA-E1).
5. **Tooltips informativos (CA-C5)** — toda zona accionable o informativa con `title=` + `aria-label=`. La parte dinamica del tooltip pasa por `escapeHtmlSsr` (REQ-SEC-3).
6. **Escape SSR canonico** — toda interpolacion de string dinamico pasa por `escapeHtmlSsr` (CA-D1). Mientras `lib/escape-html.js` no aterrice (split #1), seguir el patron inline de `home.js:33-41`.
7. **Sanitizado de payload runtime** — el estado consumido por la vista pasa por `lib/sanitize-payload.js` antes de entrar al SSR (CA-D3 / REQ-SEC-6).
8. **Fallback inerte (CA-A3)** — si `require` del modulo de vista falla, mostrar mensaje visible al operador. Nunca string vacio silencioso.

## Idioma

Doc operativa en español. Identificadores de codigo, slugs del router, labels GitHub y env vars en ingles.
