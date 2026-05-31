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
| #3735 | **Costos (este split)** | `assets/mockups/32-costos-v3.svg` | criterios |
| #3736 | Modo descanso | — | pendiente |

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
