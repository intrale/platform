# Dashboard V3 — Inventario de migración

> Mapeo "qué existe hoy → dónde queda en el rediseño V3" (épico #3715).
> Esta tabla se completa progresivamente por cada sub-historia hija que
> extrae una ventana o componente. Sin pérdida de funcionalidad: si algo
> existe hoy, debe tener entrada en este inventario antes de cerrar el épico.

## Cómo llenar este inventario

Cada sub-historia hija que extrae una ventana o mueve un componente:

1. Agrega una fila por componente migrado.
2. Marca `Estado` con `pendiente` / `en-progreso` / `migrado` / `eliminado`.
3. Si el componente se elimina (no aporta valor en V3), justifica en `Notas`.
4. Si se mueve a otra ventana, refleja el destino real en `Ventana V3 destino`.
5. Si el origen no es un archivo sino una sección de `dashboard.js`, indica el
   rango aproximado de líneas (ej. `dashboard.js:1403-1410`) para que el
   próximo agente pueda anclarse rápido.

## Tabla

| Componente actual | Archivo origen | Ventana V3 destino | Estado | Notas |
|-------------------|----------------|--------------------|--------|-------|
| Brand bar (logo + ambiente) | `views/dashboard/home.js` `renderBrandBar` | main (home) | migrado | #3725 — extraída a sub-función pura. Suma pill `#bld-status` (build status). |
| Build status pill | `views/dashboard/home.js` `renderBrandBar` | main (home) | migrado | #3725 — NUEVO. Lee marker local `.pipeline/build-status.json` (R-G4), `unknown` si falta. Sin `gh api`. |
| Control bar (pills + toggles + reloj) | `views/dashboard/home.js` `renderControlBar` | main (home) | migrado | #3725 — extraída. Pausa parcial inline preservada con `data-view-link="wizard/partial-pause"` (R-G5). |
| Salud de infra (pulpo/dashboard/telegram) | `views/dashboard/home.js` `renderInfraHealth` | main (home) | migrado | #3725 — NUEVO. Estado binario UP/DOWN + last_ping. Whitelist sin secretos (CA-3725.3). |
| KPIs principales (5) | `views/dashboard/home.js` `renderKpiGrid` | main (home) | migrado | #3725 — PRs·7d, Tokens·24h, Duración/agente, %Rebote·7d, Cuota Plan Max (R-G2). |
| Costo USD · 7d | (no renderizado en main) | ventana `kpis` (#3733) | pendiente | #3725 — decisión R-G2: NO vive en main. |
| Coverage multi-provider | (no renderizado en main) | ventana `providers` / `kpis` | migrado | #3361 ya lo movió fuera del home. |
| Cola detallada (ETA + ejecutando + recientes + cola + olas) | `views/dashboard/home.js` `renderQueueDetailed` | main (home) | migrado | #3725 — agrupa ola-eta + active + recent + queue + wave-panel. Reusa `renderLineRow`/`renderWaveRowSkeleton` (DOM morphing). |
| System card (CPU/RAM/disco/uptime) | `views/dashboard/home.js` `renderSystemCard` | main (home) | migrado | #3725 — NUEVO. Whitelist `cpu/mem/disk/uptime` (CA-3725.6). |
| Pill `#hdr-resources` (CPU/RAM compacto) | `views/dashboard/home.js` `renderControlBar` | main (header) | migrado | #3725 — coexiste con system card (R-G3): pill compacto + card detallada, **un solo endpoint** `/api/dash/header`. |
| `escapeHtmlSsr` inline | `views/dashboard/home.js:39-47` | — | eliminado | #3725 — deuda heredada. Reemplazado por `lib/escape-html.js` (#3722). CA-3725.9. |
| Nav tabs V3 | `views/dashboard/nav-tabs.js` | main (home) | migrado | #3726 — componente compartido, fuera de scope de #3725. |
| Banner quota agotada / snapshot | `views/dashboard/home.js` `renderQuotaBannerSsr` | main (home) | migrado | #2974/#3013 — preservado, fuera del refactor de las 6 sub-funciones. |
| Ventana Ops (render completo) | `views/dashboard/satellites.js` `renderOps` (ex `satellites.js:1018-1183`) | ventana `ops` | migrado | #3732 — extraída a `views/dashboard/ops.js` (espejo de `multi-provider.js`). `renderOps` eliminado de `satellites.js` + de su `module.exports`. |
| Banner Telegram caído | `satellites.js` `renderOps` | ventana `ops` (`#ops-tg-banner`) | migrado | #3732 — SSR dual-encoding (color + icono + texto), oculto cuando `telegramHealth.ok===true`. `lastError.description/code/source` pasa por `sanitizeRuntime` (redacta secrets) + escape. |
| Grid de procesos del pipeline | `satellites.js` `renderOps` | ventana `ops` (`#ops-procesos`) | migrado | #3732 — 5 cards (listener/svc-telegram/svc-github/svc-drive/svc-emulador) con estado alive/dead, PID, uptime, chips de cola (`PROC_QUEUES`). listener+svc-telegram heredan `bot-down` con TG caído. |
| Reconciler · stale orders 24h | `satellites.js` `renderOps` | ventana `ops` (`#stale-orders-count`) | migrado | #3732 — número grande + breakdown por motivo. Datos client-fill desde `/api/dash/reconciler-stale-orders` (sin cambio de endpoint). |
| QA Environment (dump JSON `<pre>`) | `satellites.js` `renderOps` (`#ops-qaenv`) | ventana `ops` (`#ops-qaenv`) | migrado | #3732 — **rediseñado (CA-C2)**: el `<pre>` con JSON crudo se reemplaza por 4 mini-cards (`qaEnv`/`qaRemote`/`infraHealth`/`telegramHealth`) con badge de salud + meta key:value + último error truncado a 80 chars. |
| Modo descanso (calendario semanal) | `views/dashboard/satellites.js` `renderModoDescanso` (legacy 1576-2121) | ventana `descanso` (`views/dashboard/descanso.js`) | migrado | #3736 — extraído a módulo propio + slug `descanso`. Path legacy `/modo-descanso` sigue vivo (delegante de 1 línea en satellites.js). Tooltips CA-C1. Ver sección dedicada. |
| Panel "Necesitan intervención humana" | `dashboard.js` `bloqueadosHTML` (ex 2374-2439) | ventana `matriz` (`views/dashboard/matriz.js` `renderBloqueadosHTML`) | migrado | #3731 — extraído. Itera `state.bloqueados`. Escape `lib/escape-html.js`, `safeIssueId` (CA-4). Dispara `POST /api/needs-human/<n>/{reactivate,dismiss}`. Ver sección dedicada. |
| Board Kanban del Issue Tracker | `dashboard.js` `matrixHTML` (ex 2441-2468) | ventana `matriz` (`views/dashboard/matriz.js` `renderMatrixHTML`) | migrado | #3731 — extraído. `lanesHTML`/`doneLaneHTML`/`activeIssues`/`completedIssues`/`sorted` siguen construyéndose en `dashboard.js` y se pasan por params (decisión D1 / Opción B). IDs invariantes `#issue-tracker`/`#it-search-input`/`#dot-popup`. |

## Decisiones de diseño (#3732 — ventana Ops)

- **Routing dual**: `/ops` (legacy, `HTML_ROUTES`) y `?view=ops` (`VIEW_SLUGS`) resuelven al **mismo thunk** `renderOpsView(ctx)` en `lib/dashboard-routes.js` para que no diverjan. Ambos inyectan el state en vivo vía `slices.opsSlice(ctx.getState())`. El smoke CA-G2 verifica los 4 IDs DOM en ambos paths.
- **Registro (CA-A2)**: el require defensivo `try { opsView = require('../views/dashboard/ops') } catch {}` vive en `lib/dashboard-routes.js` (el router real de `/ops`, lo que ejercita `router.test.js`), no en `dashboard.js` — `dashboard.js` sólo sirve `/multi-provider` directo; `/ops` siempre pasó por el router. Si el require falla, `renderOpsView` cae a un fallback inerte visible (CA-A3 / REQ-SEC-7).
- **SSR + client morphing**: el render produce el estado inicial server-side (banner/procesos/mini-cards desde el slice) y un client JS refresca por polling (`/api/dash/ops` 5s, stale orders 30s) con DOM morphing. El stale-orders count se hidrata client-side (no está en `opsSlice`).
- **Escape (CA-F2)**: usa `lib/escape-html.js` (`escapeHtmlText`/`escapeHtmlAttr`, #3722 ya en main). Sin escape inline duplicado. El payload runtime pasa además por `sanitizeRuntime` → `sanitizer.js` (REQ-SEC-6).
- **Iconografía**: el sprite no tiene `ic-procesos/ic-reconciler/ic-qa-env`; se usa fallback emoji `🛠 ⏳ 📡` (ASCII-safe, ya en uso). Decisión documentada (sin bloquear el split).
- **Mockup `28-ops-v3.svg`**: el SVG referenciado por UX vive en `agent/3728-ux-mockup-pipeline-v3` y no está en `main`. Las decisiones visuales congeladas (comentario `/ux` de #3732) + receta del `architect` se aplicaron igual. La unificación del asset queda como follow-up del épico #3715.

## Decisiones de diseño (#3725)

### R-G2 — Qué KPI vive dónde

5 KPIs en el **main** (siempre visibles para el operador del kiosk):

| KPI | Main | Ventana `kpis` (deep-dive #3733) |
|-----|------|----------------------------------|
| PRs mergeados · 7d | ✅ | + serie 30d |
| Tokens · 24h (todos providers) | ✅ | + breakdown por provider/agente |
| Duración por agente (mediana) | ✅ | + p50/p95/p99 por marker |
| % Rebote · 7d | ✅ | + breakdown por fase |
| Cuota Plan Max (sesión + semanal) | ✅ | + histórico |
| Costo USD · 7d | ❌ | ✅ (no es métrica de kiosk operativo) |
| Coverage multi-provider | ❌ | ✅ (vive en `providers`) |

### R-G3 — System card vs pill `#hdr-resources`

Opción (b) elegida: **pill compacto en el header + system card detallada en el main**. Ambos consumen el **mismo endpoint** `/api/dash/header` (campo `resources`) — un solo polling, dos consumidores. La system card agrega `disco` y `uptime` además de CPU/RAM:

- CPU/RAM: se hidratan client-side desde `/api/dash/header` (`tickHeader`).
- `uptime_s`: se resuelve en SSR vía `os.uptime()` (composer `collectHomeState`).
- `disco`: queda como `—` en SSR hasta que el slice `headerSlice` exponga `diskPercent`. La extensión del slice vive en `lib/dashboard-slices.js` (fuera del scope de archivos de este split; se trackea como follow-up del épico #3715).

### R-G4 — Fuente del build status

El pill `#bld-status` lee el marker local **`.pipeline/build-status.json`** (escrito por `/builder`, recomendación futura #3756). **Prohibido** invocar `gh api` desde el dashboard (latencia de red por refresh). Si el marker no existe → status `unknown` sin romper la página (CA-3725.1). Campos consumidos (whitelist): `status` (`passing`/`failing`/`running`/`unknown`), `branch` (≤80 chars, escapado), `commit` (≤12 chars, escapado).

### R-G5 — Control bar: pausa parcial inline vs wizard

Se **preserva el menú inline** de pausa parcial en este split (no bloquea #3741/#3742). Se agrega `data-view-link="wizard/partial-pause"` como hook a futuro: cuando aterrice el wizard, el control bar puede delegar sin re-trabajar el markup. Transición documentada acá.

## Seguridad — disclaimer de kiosk loopback (OWASP A01)

El dashboard asume **binding loopback (localhost) sin autenticación ni CSRF**. Los toggles operativos del control bar (modo descanso, pausa total/parcial, priority windows) **mutan estado del pipeline sin auth ni token CSRF** — esto es **aceptable para el modelo de kiosk** (un solo operador, máquina local), pero queda explícito acá (CA-3725.12):

- A01 Broken Access Control: sin auth; depende del binding loopback. NO exponer el dashboard fuera de localhost sin agregar auth + CSRF antes.
- A03 Injection (XSS): cubierto por `lib/escape-html.js` (#3722) — `escapeHtmlText` (body) / `escapeHtmlAttr` (atributos). Tests SSR con payloads body + atributo en `__tests__/home.test.js`.
- A05 Security Misconfiguration: falta CSP (recomendación no bloqueante del análisis `/security`).
- A09 Logging Failures: falta audit log de acciones del control bar (recomendación no bloqueante).

Las piezas nuevas (infra health, system card) aplican **whitelist estricta de campos**: nunca emiten token de Telegram, `chat_id`, `os.hostname()`, `process.cwd()`, `os.userInfo()`, paths absolutos ni `process.env.*` (validado por tests en `home.test.js`).

## Ventana Descanso — split #3736

> Extracción de la ventana **Modo descanso** del monolito a su propio módulo
> (`views/dashboard/descanso.js`), siguiendo el patrón de `home.js` /
> `multi-provider.js`. Padre: épico #3715.

### Identidad

| Atributo | Valor |
|----------|-------|
| Slug nuevo (router cliente) | `descanso` (`?view=descanso`) — registrado en `lib/dashboard-routes.js::VIEW_SLUGS` |
| Path legacy (deep-link directo) | `/modo-descanso` — registrado en `HTML_ROUTES`, **se mantiene sin redirect** |
| Módulo | `views/dashboard/descanso.js` |
| Origen legacy | `views/dashboard/satellites.js::renderModoDescanso` (líneas 1576-2121 antes del split) |
| Exports | `{ renderDescanso, renderDescansoInner, slug: 'descanso' }` |
| Endpoint REST que la hidrata | `GET /api/rest-mode` (lectura, polling 8s) + `POST /api/rest-mode` (guardar) |

Discrepancia de slug deliberada (`/modo-descanso` legacy vs `?view=descanso`
nuevo): ambos orígenes operativos conviven sin redirect — deep-link directo vs
router cliente, mismo patrón que `ops` en #3732.

### Piezas estructurales (4)

1. **`#rm-status`** — banner de estado actual (activo/inactivo + sub-texto).
2. **`#rm-form` / `#rm-grid`** — formulario + grid semanal de 7 columnas con N
   periodos por día (editor in-memory, no sincroniza mientras se edita; debounce 3s).
3. **`#rm-bypass`** — labels de bypass (read-only, viven en `config.yaml`).
4. **`#rm-updated`** — timestamp de última actualización.

### Acciones operativas + tooltips (CA-C1)

| Acción | Selector | Tooltip (`title` + `aria-label`) |
|--------|----------|----------------------------------|
| Activar/desactivar modo descanso | checkbox `#rm-active` | "Si destildás, el pipeline opera sin restricciones (CA-1.9)" |
| Guardar configuración | `#rm-save` | "Hot-reload sin reinicio del pipeline. El backend revalida la grilla." |
| Agregar periodo | `.rm-col-add` (client-side) | "Máximo 24 periodos por día" / aria "Agregar periodo (máximo 24 por día)" |
| Eliminar periodo | `.rm-period-remove` (client-side) | "Eliminar periodo" |

Las 3 acciones mutantes pasan por `POST /api/rest-mode`, que ya tiene audit
(`rest-mode-audit.jsonl`, SEC-A03) + hot-reload. NO se introdujo CSRF nuevo en
este split (modelo kiosk loopback — ver disclaimer OWASP A01 más arriba).

### Duplicación deliberada cliente/backend

El JS embebido replica la validación de overlap/HH:MM/cap (`MAX_PERIODS_PER_DAY`)
de `lib/rest-mode-schedule.js`. **Se preserva tal cual** (FE-SEC-1 / SEC-9): el
cliente NUNCA confía en su validación, siempre hace round-trip a `POST
/api/rest-mode` (source of truth). NO se consolida en un módulo client-side
compartido en este split — es decisión arquitectónica del #2890 PR-A.

### Escape SSR

Usa `lib/escape-html.js` (#3722, CA-B3) en vez de un `escapeHtmlSsr` inline.
El SSR sólo interpola `opts.tz` opcional (prefill del input de zona horaria),
escapado en contexto atributo (`escapeHtmlAttr`). Toda la demás hidratación es
client-side via `fetch('/api/rest-mode')`, con `createElement` + `textContent`
(sin `innerHTML` sobre datos del servidor — cubierto por test XSS guard).

### Tests

`views/dashboard/__tests__/descanso.test.js` (`node --test`): exports canónicos,
estructura SSR (5 selectores), fragmento inner sin shell, XSS guard sobre el JS
embebido, escape OWASP del payload por `opts.tz`, y presencia de tooltips. Smoke:
`/modo-descanso` y `/dashboard?view=descanso` devuelven 200 con los 4 selectores
estructurales (verificado vía `handle()`).

## Ventana Matriz — split #3731

> Extracción del centro neurálgico del dashboard: el panel **"Necesitan
> intervención humana"** + el **Board Kanban del Issue Tracker**, del monolito
> `dashboard.js` a su propio módulo (`views/dashboard/matriz.js`). Padre: épico
> #3715.

### Identidad

| Atributo | Valor |
|----------|-------|
| Slug nuevo (router cliente) | `matriz` (`?view=matriz` + `/dashboard/partial?view=matriz`) — registrado en `lib/dashboard-routes.js::VIEW_SLUGS` |
| Módulo | `views/dashboard/matriz.js` |
| Origen legacy | `dashboard.js` `bloqueadosHTML` (ex 2374-2439) + `matrixHTML` (ex 2441-2468) |
| Exports | `{ renderMatrizSsr, renderMatrizClientScript, renderBloqueadosHTML, renderMatrixHTML, safeIssueId, loadTheme, slug: 'matriz' }` |
| Consumo en `dashboard.js` | `matrizView.renderMatrizSsr({ state, bloqueados, lanesHTML, doneLaneHTML, activeIssues, completedIssues, sorted })` → `matrixHTML` (lazy require defensivo) |

### Decisión D1 (Opción B — handoff por params)

`dashboard.js` **sigue siendo el dueño** de los builders del Board Kanban
(`lanesHTML`/`doneLaneHTML`/`activeIssues`/`completedIssues`/`sorted`), que
dependen de helpers locales del monolito (`fmtDuration`, `etaLib`,
`AGENT_PERSONA`, `skillIcon`, `skillColor`, `manualOrderState`). Esos builders
NO se migraron a `matriz.js` — se le pasan por argumento. Se eligió B para
minimizar regresión en el Board Kanban (riesgo R1 del análisis técnico). La
consolidación interna (mover los builders a la vista) queda como sub-historia
futura.

**Implicancia en el partial endpoint**: `lib/dashboard-routes.js` sólo dispone de
`ctx.getState()` (→ `state.bloqueados`). NO tiene los builders del board. Por eso
`?view=matriz` / `/dashboard/partial?view=matriz` degradan a un **esqueleto**:
panel "Necesitan intervención humana" hidratado desde `state.bloqueados` + Board
Kanban con lanes vacías (placeholder "Cargando lanes…"). La primera carga rica del
board sigue viniendo por `/` (SSR completo desde el monolito) + DOM morphing
client-side cada 30s. Si el módulo no cargó, el router degrada a `home` (CA-A3).

### Piezas estructurales

1. **`#bloqueados-humano`** — panel "Necesitan intervención humana". Sólo se
   renderiza si `state.bloqueados.length > 0`. Cada fila: link al issue de GitHub,
   título, skill/fase, antigüedad, resumen funcional, razón, actividad reciente,
   y los botones de acción.
2. **`#issue-tracker`** — Board Kanban centerpiece. Contiene `#it-search-input`
   (search box), tabs `active`/`completed`/`all`, las 3 lanes (def/dev/qa),
   sección de completados, y `#dot-popup` (detalle de agente).

IDs DOM invariantes (CA-3, riesgo R2/R3 — el cliente muta refs por ID textual):
`#bloqueados-humano`, `#issue-tracker`, `#it-search-input`, `#dot-popup`. Renombrarlos
deja la ventana muerta sin error visible. Cubierto por test SSR + smoke.

### Datos personales/sensibles renderizados

**Ninguno.** Son metadata de issues públicos de GitHub (título, número, skill,
fase, comentarios) + nombres de archivos del filesystem del pipeline. Todos los
campos son influenciables por terceros (autor de issue/comentario/rechazo) ⇒
todos pasan por escape.

### Endpoints state-changing que dispara

| Endpoint | Handler (bundle `/js/dashboard.js`) | Acción |
|----------|-------------------------------------|--------|
| `POST /api/needs-human/<n>/reactivate` | `needsHumanReactivate(issue)` | Quita label `needs-human`, devuelve el issue a la cola |
| `POST /api/needs-human/<n>/dismiss` (body `{reason}`) | `needsHumanDismiss(issue)` | Cierra el issue como desestimado |
| `POST /api/needs-human/<n>/dismiss-worktree` | (handler asociado en el bundle) | Desestima + limpia worktree |

El SSR de `matriz.js` renderiza los botones **Reactivar** y **Desestimar** (los
2 onclick inline). `confirm()`/`prompt()` como circuit-breaker UX viven en el
bundle cliente y se preservan (decisión D4).

### Acciones operativas + tooltips (CA-6)

| Acción | Selector | Tooltip |
|--------|----------|---------|
| Reactivar issue | `.nh-btn-reactivate` | "Quitar el label needs-human y devolver el issue a la cola del pipeline" |
| Desestimar issue | `.nh-btn-dismiss` | "Cerrar el issue como desestimado y limpiarlo del panel" |
| Buscar issues | `#it-search-input` | `aria-label` "Buscar issues por número o título" |
| Filtrar tabs | `.ic-tab` | `aria-label` "Mostrar issues en progreso/completados/todos" |

Leyenda del board (CA-C3): "Cada card es un issue; el color del lane indica la
fase (📐 Definición · 🔧 Desarrollo · ✅ QA) y los dots marcan los agentes activos."

### Escape SSR + validación de tipos

Usa `lib/escape-html.js` (#3722, CA-4): `escapeHtmlText` para contenido de
elemento (`b.title`, `b.skill`, `b.phase`, `b.question`/`b.reason`, `b.summary`,
`ev.author`, `ev.preview`) y `escapeHtmlAttr` para los `title="..."`. **Cero**
template literals crudos con datos dinámicos. `b.issue` se coerce con
`safeIssueId()` a entero positivo antes de interpolar en el `href` de GitHub y en
los `onclick` — si no es entero positivo, la fila se **omite** (cierra el vector
de inyección en URL/handler señalado por security). `activeIssues.length` /
`completedIssues.length` / `sorted.length` son longitudes de arrays controlados
por el monolito (enteros, seguros).

### Inline handlers que sobreviven (decisión D4)

Los `onclick="needsHumanReactivate(<int>)"` / `onclick="needsHumanDismiss(<int>)"`
+ `confirm()`/`prompt()` se preservan **1:1**. La migración a `addEventListener` +
`data-attributes` es trabajo de **#3758** (fuera de scope). Cuando aterrice CSP
`script-src 'self'` (**#3688**) estos onclick dejarán de ejecutarse — dependencia
documentada acá y en el header de `matriz.js`.

### Dependencias de seguridad pendientes que la afectan

- **#3688** (+ #2532 / #2745) — CSP del dashboard. Romperá los inline handlers (D4).
- **#2901** — escape HTML unificado en title attributes (cerrado por #3722, ya en uso acá).
- **#3624** — audit log de needs-human reactivate/dismiss (la acción state-changing que esta ventana dispara).
- **#3192** — autor del audit log desde fuente confiable.
- **#3758** — migración onclick → data-attributes (preparación para CSP).

### Tests

`views/dashboard/__tests__/matriz.test.js` (`node --test`): render degenerado
(state vacío), Board Kanban con counts enteros, IDs DOM invariantes (CA-3),
payload XSS canónico (`<script>`, `"><img onerror>`, `javascript:`) por CADA campo
escapable de ambos sub-paneles (CA-7), `safeIssueId` + omisión de fila con
`b.issue` no numérico (CA-4), handlers `needsHumanReactivate/Dismiss` con entero
(CA-5), y tooltips `title=`/`aria-label` (CA-6). Smoke (router.test.js):
`/dashboard?view=matriz` y `/dashboard/partial?view=matriz` devuelven 200 con
`#issue-tracker` (CA-8).

## Ventana **KPIs** — split #3733

Extracción de la ventana KPIs del monolito `dashboard.js` a `views/dashboard/kpis.js`
(presentación SSR) + `lib/kpis-data.js` (slice de datos `getMetricsSlice`, data-only,
testeable en aislamiento). El endpoint `/metrics` se **mantiene** (decisión cerrada #3
del issue): no se deprecó ni se hace redirect 301; lo que se recupera es el **link visual**
desde la ventana V3 (CA-9), cerrando la memoria `project_metrics-endpoint-lost`.

Mapeo "**qué está hoy → dónde queda en V3**" (CA-6):

| Componente actual | Archivo origen | Ventana V3 destino | Estado | Notas |
|-------------------|----------------|--------------------|--------|-------|
| Cálculo matrixEntries + counts (definidos/pendientes/trabajando/blocked/needs-human) | `dashboard.js:1577–1689` | `view=kpis` (compuesto en `dashboard-routes.js::_deriveKpiCounts`) | migrado | #3733 — el home sigue siendo el productor; la ventana `kpis` es consumidor puro (R2). |
| Helpers `buildTtData` / `activeSkills` / `ttLabel` | `dashboard.js:1627–1640` | (home only) | sin-mover | #3733 — tooltips del home; la ventana `kpis` usa tooltips propios `kpi-tooltip` (texto estático). |
| DORA mini HTML (Lead Time / Throughput / Failure Rate / Entregas 7d) | `dashboard.js:3003–3055` | `kpis.js::renderDoraAndCommanderHTML` (`view=kpis`) | migrado | #3733 — reusa `kpisSlice`. El home conserva su `doraMinHTML`. |
| Commander Routing card (det. vs LLM) | `dashboard.js:3057–3105` | `kpis.js::renderDoraAndCommanderHTML` (`view=kpis`) | migrado | #3733 — `routingMetrics` vía `commander-deterministic.computeRoutingMetrics` (7d). |
| `kpis-row` cards (6) + sys-mini (CPU/RAM/Salud) | `dashboard.js:5343–5399` | `kpis.js::renderKpiCardsHTML` (`view=kpis`) | migrado | #3733 — el home mantiene su `kpis-row`; la ventana `kpis` renderiza su propia fila (misma semántica). |
| `getMetricsData()` (snapshots/entregas/agentPerf/tokenEstimates) | `dashboard.js:7428–7551` | `lib/kpis-data.js::getMetricsSlice(ctx)` (consumido por `view=kpis` y `/metrics`) | migrado | #3733 — DI por `ctx` (sin closures sobre globals, R4) + cache 30s por mtime del JSONL (R7). Contrato de retorno idéntico. |
| `generateMetricsHTML()` (página /metrics) | `dashboard.js:7554–7900` | `kpis.js::renderMetricsPage({data})` | migrado | #3733 — body portado con XSS hardening (skill names + session IDs escapados). `dashboard.js` delega con fallback inerte (CA-A3). |
| Handlers `/metrics` y `/api/metrics` | `dashboard.js:10433–10470` | (mismo path, indirección vía `kpisView`/`kpisData`) | migrado | #3733 — `/metrics` se mantiene (decisión #3). Headers CA-15 (`no-store`, `nosniff`, `no-referrer`, sin ACAO) + same-origin en `/api/metrics` (CA-18). |
| KPIs de proveedor (tokens 24h by_provider) | `dashboard.js` (kpisSlice) | `kpis.js::renderProvidersHTML` (`view=kpis`) | migrado | #3733 (D-UX-1) — quedan en `kpis` con TODO de migración a `view=providers` (#3737). SOLO metadata operativa, jamás API keys (CA-19). |
| Rendimiento por agente + top sesiones | `dashboard.js` (getMetricsData.agentPerf) | `kpis.js::renderAgentPerfHTML` (`view=kpis`) | migrado | #3733 — session IDs por `safeSessionId` (CA-17), skill names escapados (R8/CA-14.b). |
| Link visual a `/metrics` desde la home V3 | (perdido — memoria `project_metrics-endpoint-lost`) | `kpis.js::renderMetricsCta` (`view=kpis`) | recuperado | #3733 (CA-9/R10) — CTA `href="/metrics"` con touch target ≥44px (CA-23). |

### Decisiones de la ventana KPIs (#3733)

- **read-only** (D-UX-1): sin acciones state-changing. Sin `<form>`, sin `method=POST`,
  sin `<button onclick>` que dispare backend. Los KPIs "clickeables" (`Bloqueados`,
  `Necesitan humano`) son **links de navegación** a `/bloqueados` (filtros visuales
  locales), no mutaciones. Cierra CA-20 por construcción.
- **Doble slice (no merge)**: `kpisSlice` (`lib/dashboard-slices.js`) queda intacto; el
  nuevo `lib/kpis-data.js::getMetricsSlice` aporta snapshots/agentPerf/tokenEstimates.
  La vista compone ambos.
- **`/metrics` HTML se mantiene** (no 301): scripts/bookmarks externos dependen del path.
  La memoria `project_metrics-endpoint-lost` se cierra recuperando el link, no migrando
  el endpoint. (Guru propuso 301 → KPIs como recomendación futura no bloqueante.)
- **Escape unificado**: usa `lib/escape-html.js` (#3722, ya en main) — sin fallback local
  (CA-4 satisfecho porque el helper existe).

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

