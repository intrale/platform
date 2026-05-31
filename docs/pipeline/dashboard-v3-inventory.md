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

## Otras ventanas del epico #3715

| Split | Ventana | Mockup | Estado |
|---|---|---|---|
| #3725 | Frame + brand bar | — | pendiente |
| #3726 | Home (KPIs principales) | `assets/mockups/26-dashboard-main-v3.svg` | en flight |
| #3727 | Equipo | — | pendiente |
| #3728 | Pipeline (flujo de agentes) | — | en flight |
| #3729 | Bloqueados | `assets/mockups/27-bloqueados-v3.svg` | en flight |
| #3730 | Issues | — | pendiente |
| #3731 | **Matriz (este split)** | `assets/mockups/29-matriz-v3.html` | criterios |
| #3732 | **Ops (este split)** | `assets/mockups/28-ops-v3.svg` | criterios |
| #3733 | Multi-provider | — | pendiente |
| #3734 | Multi-provider coverage | — | pendiente |
| #3735 | Allowlist audit trail | — | pendiente |
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
