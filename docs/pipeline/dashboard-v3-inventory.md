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
| Matriz (skill × fase, carga actual) | `views/dashboard/satellites.js` `renderMatriz` (legacy 937-1015) | ventana `matriz` (`views/dashboard/matriz.js`) | migrado | #3731 — extraído a módulo propio + slug `matriz`. Path legacy `/matriz` resuelve al MISMO thunk (`renderMatrizView`), `renderMatriz` eliminado de satellites.js + de su `module.exports`. Leyenda heat-map (CA-C3) + tooltips en headers/celdas (CA-C1). Ver sección dedicada. |
| Issues (backlog operacional, vista cards) | `views/dashboard/satellites.js` `renderIssues` (líneas 835-934) | ventana `issues` (`views/dashboard/issues.js`) | migrado | #3730 — **Interpretación B**: reescrito de tabla legacy a **grilla de cards operacional** (estado + fase + rebotes + acciones + drilldown `<dialog>`). Path legacy `/issues` + slug `?view=issues` resuelven al MISMO thunk (`renderIssuesView`). `sat.renderIssues` se **conserva** como fallback de runtime (R-4, regla "pipeline no puede morir"), NO se elimina. Ver sección dedicada. |
| Tabla telemétrica por issue (sesiones/tokens/costo/timeline) | `dashboard.js` `renderIssues` cliente (8324-8334) bajo `panel-issues` (`/consumo`) | ventana `costos` (#3735) | sin-mover | #3730 — **NO se toca** en este split (R-1). Es telemetría de `/consumo`, distinta de la vista operacional. Migra a Costos en #3735. `dashboard.js:8116-8483` intacto. |
| Ventana Pipeline (control bar + allowlist + audit + infra) | `views/dashboard/pipeline.js` `renderPipelineHTML` (ex `dashboard.js:5116-5347`) | main (home) | migrado | #3728 — extraída del monolito (~210 LOC → módulo SSR de ~370 LOC). Owner: pipeline-dev. Deps: #3722 (`lib/escape-html.js`), #3726 (sprite). SSR puro: state inyectado, sin `fetch`/`require` circular. **Referencia (NO extrae)** los 6 handlers state-changing del `<script>` global: `pauseAction`, `allowlistLike`, `allowlistUnlike`, `allowlistRemove`, `allowlistPromote`, `includeMissingDeps` (+ `pwAction`). `renderInfraHealth` y `renderPartialPauseAuditRows` quedan en `dashboard.js` e inyectados. Bug latente `allowedIssues` (ex línea 5290, `'#'+i` sin escape) corregido vía `escapeHtmlText` (CA-PL7). Jerarquía V3: control bar sticky → banner deps → details Allowlist (open si partial-pause) → details Audit (open si chain_broken/sin-autoría) → infra. Tests: `__tests__/pipeline.test.js` (10, incl. 3 payloads XSS). Ver sección dedicada. |
| Bloqueados (necesitan intervención humana) | `dashboard.js::generateHTML` panel inline `bloqueadosHTML` (~2371-2439) | ventana `bloqueados` (`views/dashboard/bloqueados.js`) | migrado | #3729 — extraído a módulo propio + slug `bloqueados`. Binding del render legacy reemplazado por `bloqueadosView.renderBloqueadosSsr(state)` (fallback inerte CA-A3). Handlers `toggleNeedsHumanPanel`/`needsHumanReactivate`/`needsHumanDismiss` movidos a `renderBloqueadosClientScript()` (window.*); `needsHumanBlock` queda en el monolito (issue-tracker). Severidad 3-umbral dual-encoded + empty-state celebratorio. CSS `.v3-bloqueados-*` en `theme.css`; `.needs-human-*` legacy queda como compat en el `<style>` inline del render legacy (retiro = sub posterior). Ver sección dedicada. |

## Decisiones de diseño (#3729 — ventana Bloqueados)

### Mapa campo → contexto HTML → origen → helper de escape (CA-A1 / CA-B3)

| Campo renderizado | Origen | Controlable por | Contexto HTML | Helper |
|---|---|---|---|---|
| `b.issue` | Filesystem marker (`needs-human`) | Pipeline-internal | **attr** (`href`/`onclick`) + text (`#N`) | `safeIssueNumber()` (coerción a entero positivo; fila descartada si falla — CA-D2) |
| `b.title` | GitHub Issue API | Externo (cualquiera con permiso de editar el issue) | text (link) + **attr** (`title="…"`) | `escapeHtmlText` (texto) + `escapeHtmlAttr` (tooltip) |
| `b.skill`, `b.phase` | Filesystem markers | Pipeline-internal | text | `escapeHtmlText` |
| `b.question` / `b.reason` | Motivo del agente al pausar | Externo (puede citar texto del issue) | text (truncado a 280) | `escapeHtmlText` |
| `b.summary` | `issueSummary` (LLM) | Externo (LLM sobre issue body) | text | `escapeHtmlText` |
| `b.recent_events[].author` | `gh issue comments` | Externo | text | `escapeHtmlText` |
| `b.recent_events[].preview` | `gh issue comments` | Externo | text | `escapeHtmlText` |
| `b.age_hours` | Filesystem marker | Pipeline-internal | text (numérico) | coerción numérica (`fmtAge`/`severityOf`) |
| `b.summary_stale` | Pipeline-internal | Pipeline-internal | branch (estado loading) | — |
| `state.bloqueadosStats.*` | Pipeline-internal (mini-stats, opcional) | Pipeline-internal | text | `escapeHtmlText`; `—` si ausente |

### Decisiones congeladas

- **Escape (CA-B3)**: usa `lib/escape-html.js` (`escapeHtmlText` texto / `escapeHtmlAttr` atributo, #3722). NO reusa el `esc()` global del monolito. Fallback inline defensivo si el require falla (CA-A3). En contexto texto, `"`/`'` no se escapan (innecesario y seguro); en contexto atributo (`title=`/`aria-label=`) sí (`escapeHtmlAttr`).
- **Coerción `b.issue` (CA-D2)**: `safeIssueNumber()` (`Number.isInteger(n) && n > 0`). Fila descartada si falla, antes de interpolar en `href`/`onclick`.
- **Severidad dual-encoded (CA-E1)**: rail vertical 4px + pill (ícono emoji + texto numérico de edad). Nunca solo color. 3 umbrales: `info` < 4h, `warning` 4–24h, `danger` ≥ 24h (reusan `--in-info`/`--in-warn`/`--in-bad`, sin tokens nuevos).
- **Empty-state (UX #3729)**: celebratorio (`#bloqueados-empty`) + mini-stats (SLA promedio · Resueltos hoy). El monolito retornaba `''`; ahora SIEMPRE renderiza el wrapper `<section data-slug="bloqueados">`. Mini-stats leen `state.bloqueadosStats` defensivo → `—` si no existe (no se inventan métricas).
- **Iconografía**: emoji ASCII-friendly (precedente ops.js #3732 — el sprite no tiene símbolos de severidad). Sin `<svg>` nuevos.
- **Handlers cliente (R3)**: `toggleNeedsHumanPanel` / `needsHumanReactivate` / `needsHumanDismiss` + restore del estado colapsado portados a `renderBloqueadosClientScript()` como `window.*` (idempotente `__bloqueadosWired`). El KPI rojo (`dashboard.js:744/5385`, scope #3733) sigue llamando `window.toggleNeedsHumanPanel`. `needsHumanBlock` (pausar card del issue-tracker) NO se movió.
- **Routing / compat retro (R5)**: el panel vive en el render legacy `generateHTML` (fallback que sirve `/?view=bloqueados` y `/?section=needs-human`). El popout queda en `?section=needs-human` (mecanismo standalone client-side existente, sin regresión). La migración a un standalone `?view=bloqueados` server-side espera el router #3773; cuando aterrice se agrega la entry en `VIEW_SLUGS`. NO se tocó `dashboard-routes.js` en esta sub.
- **CSS**: diseño `.v3-bloqueados-*` en `theme.css` (consumido por el view standalone futuro). Las clases legacy `.needs-human-*` quedan en el `<style>` inline del render legacy como compat (mis elementos llevan ambas clases; ninguna página carga ambas hojas, así que no compiten). Retiro de `.needs-human-*` = sub posterior.
- **No tocado**: `dashboard.js:744` (tooltip KPI rojo, #3733) ni otros `views/dashboard/*.js`.
## Decisiones de diseño (#3728 — ventana Pipeline)

- **SSR puro + inyección de dependencias**: `renderPipelineHTML(params)` recibe el state ya computado (`partialPauseState`, `allowlistCandidatesList`, `partialPauseAuditData`, `state`, flags) y los helpers compartidos `ic`, `renderInfraHealth`, `renderPartialPauseAuditRows` por argumento. El módulo NO lee filesystem ni requiere el dashboard (sin ciclo). `pwThreshold` lo calcula el caller (lee `config.yaml` una vez) y lo pasa por argumento.
- **Handlers state-changing intactos (CSRF)**: los 6 handlers + `pwAction` siguen en el `<script>` inline de `dashboard.js`. El módulo SOLO emite HTML con `onclick="..."` que los referencia — preserva la cadena same-origin + token (#3688/#2532/#2745). El test CA-PL3 asegura que el fuente del módulo no contiene `fetch(`/`addEventListener`/`XMLHttpRequest`.
- **Escape XSS unificado (CA-B3/CA-D1)**: todo dato dinámico pasa por `escapeHtmlText`/`escapeHtmlAttr` de `lib/escape-html.js` (con fallback inline si el lib no carga). Bug latente de `allowedIssues` corregido (CA-PL7). `onclick` de items usa coerción numérica (`Number(i)`) para evitar inyección JS aunque el input venga corrupto.
- **Aperturas inteligentes (decisión UX #2)**: `<details>` Allowlist abre si partial-pause activo; `<details>` Audit abre si `chain_broken` o `has_unauthorized_non_backfill` — un banner crítico no puede quedar oculto tras un `<summary>` cerrado.

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

### Estado de entrega (#3735 — lo realmente shippeado en este split)

> El plan de arriba describe el end-state completo de la ventana Costos. Este
> split aterriza la **extracción del bloque embebido en la home shell** (pill +
> banner de consumo anómalo), que es el alcance explícito acordado por UX en
> `narrativa-costos-v3.md` ("extraemos el primer bloque, el banner mas el pill
> mas las piezas embebidas en home"). La página `/consumo` standalone (KPIs,
> tablas por skill/fase/issue, proyecciones, LLM-vs-det, TTS) **queda intacta**;
> su consolidación con `costos.js` es la recomendación abierta **#3779**.

- **Módulo:** `.pipeline/views/dashboard/costos.js` (fragmentos SSR, hereda el CSS
  del shell — `.anomaly-pill` / `.cost-anomaly-banner` ya viven en el `<style>`
  de `dashboard.js`; el módulo NO carga theme propio porque no es una página).
- **Exports entregados:** `renderCostosPill(state, {ic})`,
  `renderCostosBanner(state, {ic})`, `renderInert(msg)`,
  `renderCostosClientScript()`. El `renderCostosBanner` es reusable desde
  `home.js` sin doble fetch (Opción A del R3 del architect).
- **Registro:** `dashboard.js` hace `require('./views/dashboard/costos')` con
  guard try/catch (patrón consolidado). Los bloques inline del header (pill y
  banner) delegan al módulo con fallback inerte inline si el require falla (CA-A3).
- **Escape:** todo dato dinámico pasa por `lib/escape-html.js` (#3722).
- **Tooltips (CA-C1):** `title=` server-side en pill + ack + 3 snooze, con el copy
  acordado con PO (`TOOLTIPS` exportado para test).
- **CSP / `onclick` (CA-3.3 / R2):** la pill y el banner ya NO emiten `onclick`
  inline (verificación `grep -c onclick costos.js = 0`). Los handlers se cablean
  por delegación de eventos (`renderCostosClientScript()` → `addEventListener`
  sobre `[data-ca-action]`), prerrequisito de la CSP estricta #3688. El script se
  inyecta una sola vez en el shell de home (guard `__costosWired`).
- **Router (CA-1.2):** se sumó el slug `costos` a `VIEW_SLUGS` en
  `lib/dashboard-routes.js`, resolviendo al MISMO renderer que el path legacy
  `/costos` (`sat.renderCostos`) para que `?view=costos` y `/costos` no diverjan.
- **Endpoints POST `ack`/`snooze` + GET `state` (CA-3.4 / R4):** **migrados** del
  monolito a `.pipeline/lib/cost-anomaly/api.js` (patrón `multi-provider/api.js`,
  `route()` montado antes del catch-all). Aplican defensa en profundidad:
  - **D1** `Sec-Fetch-Site` ≠ `same-origin`/`none` → **403**.
  - **D2** `Content-Type` presente y ≠ `application/json` → **415**.
  - **D3** `hours ∉ {1, 4, 24}` → **400** (whitelist server-side; el cap 24h de
    `rest-mode-state.snoozeAlert()` queda como segunda barrera).
- **Tests:**
  - `.pipeline/views/dashboard/__tests__/costos.test.js` (15 casos: vacío,
    anomalía activa, tooltips PO, XSS canónico en body y atributo, ratio inválido,
    inert fallback, reuso puro, 0 onclick en pill/banner, data-ca-action,
    client-script CSP-safe).
  - `.pipeline/lib/cost-anomaly/__tests__/api.test.js` (15 casos: D1 cross-site →
    403, D2 form-urlencoded → 415, D3 hours:999 → 400 + bordes y happy-path).

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


## Ventana Matriz — split #3731

Extracción de la ventana **Matriz** (carga actual del pipeline: skill × fase)
del monolito `satellites.js` a su propio módulo, siguiendo el patrón de las
hermanas ya migradas (`descanso.js`, `ops.js`, `kpis.js`).

### Identidad

| Atributo | Valor |
|----------|-------|
| Slug nuevo (router cliente) | `matriz` (`?view=matriz`) — registrado en `lib/dashboard-routes.js::VIEW_SLUGS` |
| Path legacy (deep-link directo) | `/matriz` — registrado en `HTML_ROUTES`, resuelve al MISMO thunk (`renderMatrizView`) |
| Módulo | `views/dashboard/matriz.js` |
| Origen legacy | `views/dashboard/satellites.js::renderMatriz` (líneas 937-1015 antes del split) |
| Exports | `{ renderMatriz, renderMatrizInner, slug: 'matriz', escapeHtmlSsr, MATRIZ_CSS }` |
| Endpoint REST que la hidrata | `GET /api/dash/pipeline` (lectura, polling 30s · `fases` + `matrixCounts`) |
| Tipo de ventana | **READ-ONLY** — sin `<form>`, sin POST, sin acciones mutantes |

### Piezas estructurales

- `#matriz-table` — contenedor de la grilla, hidratado client-side por `tickMatriz`
  (DOM morphing: sólo reescribe `innerHTML` si el HTML cambió → anti-flicker).
- `.mtx-legend` — leyenda del heat-map (CA-C3): explica los tres estados de celda
  (sin carga `·`, 1–4 carga normal, 5+ cuello de botella).
- Header satélite (`#hdr-mode` / `#hdr-clock`) + nav V3 (`renderNavTabsSsr('matriz')`).

### Rediseño V3 (vs legacy)

- **Leyenda heat-map nueva** (CA-C3): el legacy mostraba colores de celda sin
  explicación. Ahora hay tres swatches con `title` describiendo cada umbral.
- **Tooltips** (CA-C1): encabezados de columna (`P:fase` → `pipeline/fase`
  completo), celdas con carga (`N issues de <skill> en <pipeline/fase>`) y fila
  de totales. Construidos con `title=""` sobre valores escapados.
- **Subtítulo de lectura**: una línea explicando cómo interpretar la grilla
  (celda alta = cuello de botella del skill en esa fase).
- **Accesibilidad**: contenedor con `role="region"` + `aria-live="polite"`.

### Seguridad — escape (CA-B3 / CA-D1)

- El SSR de Matriz **no interpola datos del servidor**: la grilla se construye
  100% client-side desde el JSON del endpoint. `escapeHtmlSsr` (delegando en
  `lib/escape-html.js`, #3722) queda como punto único de paso para cualquier
  interpolación futura.
- El `<script>` embebido escapa **todo** valor del servidor (nombres de skill,
  claves `pipeline/fase`) con `escapeHtml()` antes de tocar `innerHTML` — única
  asignación, sin concatenación cruda. Test XSS canónico cubre ≥4 payloads.

### Tests (CA-G1 / CA-G2)

- `views/dashboard/__tests__/matriz.test.js` — exports, estructura SSR completa,
  fragmento inner sin shell, leyenda+tooltips, XSS guards (payload canónico),
  hidratación read-only desde `/api/dash/pipeline`.
- `lib/__tests__/dashboard-router-view.test.js` — smoke de routing por slug nuevo
  (`?view=matriz`) y path legacy (`/matriz`) a través de `handle()` (CA-G2/CA-A2).

### Smoke curl (CA-G2)

```bash
# Slug nuevo del router cliente
curl -s 'http://127.0.0.1:3200/dashboard?view=matriz' | grep -q 'id="matriz-table"'

# Path legacy (deep-link directo) — misma ventana
curl -s 'http://127.0.0.1:3200/matriz' | grep -q 'id="matriz-table"'
```


## Ventana **Issues** — split #3730

Extracción de la ventana **Issues** del monolito `satellites.js` a su propio
módulo (`views/dashboard/issues.js`), **rediseñada** de tabla densa a **vista
operacional de cards** según el mockup `28-issues-panel-v3.svg` + la narrativa
`narrativa-issues-panel-v3.md` (UX). Padre: épico #3715.

### Decisión arquitectónica — Interpretación B (vista operacional)

UX cerró por **Interpretación B**
([comment](https://github.com/intrale/platform/issues/3730#issuecomment-4584963619),
aceptada por architect + po): la ventana Issues responde *"¿qué se está
procesando y qué está trabado ahora?"* — NO *"¿cuánto costó cada issue?"*. La
**tabla telemétrica** (sesiones/tokens/costo/timeline) de `/consumo`
(`dashboard.js:8116-8483`) **se preserva intacta** hasta que **#3735 (Costos)**
la absorba. El módulo nuevo reemplaza a `satellites.renderIssues`, **no** al
`renderIssues()` cliente de `/consumo`.

### Identidad

| Atributo | Valor |
|----------|-------|
| Slug nuevo (router cliente) | `issues` (`?view=issues`) — registrado en `lib/dashboard-routes.js::VIEW_SLUGS` |
| Path legacy (deep-link directo / ruta canónica) | `/issues` — registrado en `HTML_ROUTES`, resuelve al MISMO thunk (`renderIssuesView`) |
| Módulo | `views/dashboard/issues.js` |
| Origen legacy | `views/dashboard/satellites.js::renderIssues` (líneas 835-934) — **conservado** como fallback de runtime |
| Exports | `{ renderIssuesHTML, renderIssueCard, renderIssuesClientScript, renderIssuesFilterBar, renderIssuesDialog, buildInitialIssues, normalizeIssue, deriveState, renderInert, ISSUES_CSS, escapeHtmlSsr, escapeHtmlAttr }` |
| Endpoint REST que la hidrata | `GET /api/dash/pipeline` (lectura, polling 60s · `matrix` + `priorityOrder`) |
| Tipo de ventana | Operacional — acciones de prioridad/pausa por **delegación** (`data-action`), drilldown read-only |

### Piezas estructurales

- `#issues-grid` — grilla `auto-fill minmax(320px,1fr)` de cards (`aria-live="polite"`).
  SSR de cards iniciales desde el snapshot del pipeline; el cliente re-hidrata.
- `.iss-filter-bar` (`role="toolbar"`) — chips de estado (`data-filter`,
  `aria-pressed`) + search (`#issues-search`).
- `.iss-card` — `tabindex="0"`, `role="article"`, `aria-label` descriptivo.
  Anatomía: prioridad + `#número` (link GitHub) + chip de estado → título (2
  líneas, prefijo `⏸` si pausado) → fase + bounces + chip rebote → acciones.
- `#issues-dialog` — drilldown `<dialog>` nativo (`showModal()` → focus trap del
  browser, cierra con `Esc`). Contenido por `textContent` (sin `innerHTML` de
  datos del usuario). Timeline de fases + bloque motivo de rechazo + link GitHub.
- `.iss-rail` — firma visual (gradient `--brand-cyan → --brand-blue`).
- Header satélite + nav V3 (`renderNavTabsSsr('issues')`).

### Datos que viven en la ventana ahora vs lo que migró

| Dato | Ventana Issues V3 (operacional) | Costos #3735 (telemetría) |
|------|---------------------------------|---------------------------|
| Estado operacional (trabajando/listo/pendiente/bloqueado/rebote/needs-human) | ✅ chip color+texto+ícono | — |
| Fase actual + skill | ✅ | — |
| Bounces + motivo de rechazo | ✅ badge + chip rebote con tooltip | — |
| Prioridad manual (orden) + acciones (subir/bajar/pausar) | ✅ | — |
| Drilldown timeline de fases | ✅ `<dialog>` | — |
| Sesiones / tokens / costo USD por issue | ❌ | ✅ (sigue en `/consumo` hasta #3735) |

### Acciones operativas + tooltips (CA-C1)

Cada acción usa `title=""` HTML nativo (escapado con `escapeHtmlAttr`) +
`aria-label`. Cero tooltip custom con `innerHTML`. Cero `onclick` inline —
delegación de eventos sobre `[data-action]` (preparación CSP, #3758).

| Acción | Ícono / glyph | `data-action` | Tooltip |
|--------|---------------|---------------|---------|
| Máxima prioridad | `#ic-promote` | `move-top` | "Mover a máxima prioridad" |
| Subir un puesto | ▲ (glyph) | `move-up` | "Subir un puesto" |
| Bajar un puesto | ▼ (glyph) | `move-down` | "Bajar un puesto" |
| Mínima prioridad | ▼▼ (glyph) | `move-bottom` | "Mover a mínima prioridad" |
| Pausar / Reanudar | `#ic-pause-lock` / `#ic-play` | `pause` / `resume` | "Pausar issue" / "Reanudar issue" |
| Abrir en GitHub | `#ic-link-out` | (link `<a>`) | "Abrir en GitHub" |
| Chip de filtro (×5) | — | `data-filter` | "Mostrar todos…" / "Sólo issues trabajando…" / etc. |

### Seguridad — escape (CA-B3 / CA-D1)

- Todo dato dinámico (título, fase, motivo de rechazo) pasa por
  `lib/escape-html.js` (#3722): `escapeHtmlText` (cuerpo) / `escapeHtmlAttr`
  (`title=`/`aria-label=`/`data-*=`). Require **defensivo** con helpers locales
  de la misma semántica como fallback (R-3).
- `renderIssueCard` valida `Number.isFinite(num) && num > 0` ANTES de interpolar
  `issue.number`; retorna `''` si falla (R-6).
- El `<script>` cliente escapa **todo** valor del servidor con un `escapeHtml()`
  embebido (escapa `& < > " ' /`) antes de componer markup; el drilldown se
  llena con `textContent` + `createElement` (sin `innerHTML` de datos).
- Test XSS canónico (`<img src=x onerror=alert(1)>` + `"><svg onload=alert(1)>`)
  sobre `title` + `motivo_rechazo` (CA-D1).

### Iconografía

Iconos exclusivamente vía `<use href="#ic-…">` del sprite global (CA-UX-3):
`ic-promote`, `ic-pause-lock`, `ic-play`, `ic-link-out`, `ic-fase-*`,
`ic-issues-count`. Las flechas de prioridad (▲ ▼ ▼▼) son **glyphs unicode de
texto** (no SVG), por lo que no violan la regla de "cero SVG inline". El sprite
ya contiene todos los iconos necesarios — no se agregó ninguno.

### Paleta (CA-UX-2)

Cero HEX literal en `color:`/`background:` del módulo. La paleta semántica de
estados usa tokens de `design-tokens.css` (`--info`, `--success`, `--warning`,
`--danger`, `--purple`, `--surface-*`, `--text-*`), que el módulo **inyecta
explícitamente** (`loadDesignTokens()`) porque `theme.css` sólo define `--in-*`.
Cada token tiene fallback a su equivalente `--in-*` (`var(--info, var(--in-info))`)
para degradar limpio si `design-tokens.css` no cargara — nunca a HEX.

### Fallback de runtime (R-4 / regla "el pipeline no puede morir")

`renderIssuesView` (en `dashboard-routes.js`) **conserva** `sat.renderIssues`
como cinturón: si el require de `issues.js` falla, o si su render tira, la ruta
degrada a la tabla legacy en vez de un 500. La indirección por arrow en
`HTML_ROUTES['/issues']` evita capturar `null` en module-load. **Decisión
explícita**: NO se eliminó `satellites.renderIssues` (a diferencia de #3731/#3732
que sí borraron su legacy) — el fallback es activo, no código muerto, y la regla
de oro del dominio pipeline es que el dashboard nunca quede fuera de servicio.

### Tests (CA-G1 / CA-G2 / CA-D1)

- `views/dashboard/__tests__/issues.test.js` (15 casos `node:test`): render SSR
  estructural (DOCTYPE + `#issues-grid` + `<dialog>`), cards SSR desde `matrix`,
  XSS canónico (img/svg/motivo), `number` inválido → `''`, ARIA en cards, chips
  con `aria-pressed`, cero HEX en CSS+markup, iconos sólo vía `<use>`, exports
  puros, `deriveState`.
- `views/dashboard/__tests__/router.test.js` (smoke E2E añadido): `?view=issues`
  y `/issues` → 200 con `id="issues-grid"` + `<dialog id="issues-dialog">` (CA-G2/CA-A2).

### Smoke curl (CA-G2)

```bash
# Slug nuevo del router cliente
curl -sf 'http://127.0.0.1:8721/dashboard?view=issues' | grep -q 'id="issues-grid"'

# Path legacy (ruta canónica) — misma ventana
curl -sf 'http://127.0.0.1:8721/issues' | grep -q 'id="issues-grid"'

# NO regresión de la tabla telemétrica de /consumo (sigue viva hasta #3735)
curl -sf 'http://127.0.0.1:8721/consumo' | grep -q 'tbody-issues'
```

## Ventana **Historial** — split #3734

**Módulo destino:** `.pipeline/views/dashboard/historial.js`
**Slug del router:** `?view=historial` (pendiente del router #3723; mientras tanto la ventana se embebe en `/` vía `historyHTML` y el popout legacy `/?section=historial`).
**Contrato:** `renderHistorialSsr(state, opts)` puro, donde `state = { agentHistory: [...] }` (array **ya armado y ordenado por el padre** — el módulo NO toca `matrixEntries`) y `opts = { agentPersona, manualOrderIndex, fmtDuration, ghBaseUrl }`. Exporta además `renderHistCard`, `isSafeFilename`, `loadTheme`, `HIST_VISIBLE`, `HIST_CAP`.
**Estado:** **migrado**.
**Escape:** todo dato dinámico (GitHub `titulo`; filesystem `skill`, `fase`, `resultado`, `logFile`, `rejectionPdf`) pasa por `lib/escape-html.js` (#3722) — `escapeHtmlText` en contexto body, `escapeHtmlAttr` en `href=`/`title=`.
**Out of scope:** filtros + búsqueda + paginación (#3778); CSRF/CSP estricta de `issueMoveTo*` (#3688 / #2532 / #2745); migración `onclick` → `data-attributes` (#3758); snapshot test cross-window de DOM IDs (#3755); enforcement axe-core CI (#3717); migración glyphs Unicode → sprite SVG (opcional CA-22, no realizada en este split).

### Estado de entrega (#3734 — lo realmente shippeado)

- **Módulo:** `.pipeline/views/dashboard/historial.js` (render SSR puro, sin globals del padre).
- **Registro:** `dashboard.js` hace `require('./views/dashboard/historial')` con guard try/catch (junto a las demás vistas, tras el require de `kpis`). El bloque de armado HTML del monolito (antes `dashboard.js:2894-3001`) quedó reemplazado por una sola llamada `historialView.renderHistorialSsr({ agentHistory }, { ... })`, **conservando** el armado/orden de `agentHistory[]` en el padre. Fallback a string vacío si el require falla (no rompe el dashboard).
- **Seguridad:**
  - **CA-5 path traversal:** `logFile` y `rejectionPdf` se validan con `isSafeFilename(s) = /^[A-Za-z0-9._-]+$/` antes de inyectarse en `href`. Si fallan → log omite link y cae al fallback de GitHub; PDF omite el `<a class="ah-pdf">`.
  - **CA-6 anti-tabnabbing:** todo `<a target="_blank">` lleva `rel="noopener noreferrer"` (#2523).
  - **Coerción numérica:** `Number(h.issue)` antes de inyectar en los `onclick` de `prioActions`; si da `NaN`, `prioActions` se omite (defensa adicional al escape).
- **CSS:** las clases `.ah-*` se agregaron a `views/dashboard/theme.css` (sección Historial) resolviendo colores SOLO via tokens `--in-*` (CA-21 sin hex hardcoded; CA-9 contraste por token + `focus-visible`). La página principal del dashboard NO carga `theme.css`, por eso **conserva su copia inline** de las mismas reglas para el render embebido; la copia en `theme.css` es la fuente canónica para el render standalone del router #3723.
- **Tooltips (CA-7):** `title=` en cada acción (subir/bajar/tope/fondo, ver log, ver PDF, link GitHub, popout, colapsar sección) — texto estático en castellano; los datos dinámicos del `title=` pasan por `escapeHtmlAttr`.
- **Leyenda (CA-8):** `.ah-legend` con los 4 estados (`●` en ejecución / `✓` aprobado / `✗` rechazado / `—` finalizado).
- **DOM preservado (R6):** se mantienen IDs/clases `#agent-history`, `data-section="historial"`, `.ah-list`, `.ah-more`, `.ah-card`, `.ah-avatar`, `.ah-skill`, `.ah-fase`, `.ah-status`, `.ah-dur`, `.ah-time`, `.ah-count` para no romper el DOM morphing client-side.
- **Tests:** `.pipeline/views/dashboard/__tests__/historial.test.js` (14 casos: render vacío, render básico, XSS en `titulo`/`logFile`/`resultado`/`skill`/`fase`, path traversal en `logFile`/`rejectionPdf`, anti-tabnabbing, orden trabajando-first, coerción de `issue` no numérico, whitelist `isSafeFilename`, cap de 50 + toggle). Cobertura de líneas **98.41%** (objetivo 85%).

### Smoke (CA-18)

```bash
# El render del módulo incluye el ID canónico que espera el smoke curl.
node -e "const {renderHistorialSsr}=require('./.pipeline/views/dashboard/historial'); \
  process.exit(renderHistorialSsr({agentHistory:[{issue:1,skill:'x',fase:'dev',estado:'procesado',resultado:'aprobado'}]},{}).includes('id=\"agent-history\"')?0:1)"

# Cuando el router #3723 exponga el slug:
curl -s 'http://127.0.0.1:3200/dashboard?view=historial' | grep -q 'id="agent-history"'
# Mientras tanto (embebido en el render completo):
curl -s 'http://127.0.0.1:3200/' | grep -q 'id="agent-history"'
```
