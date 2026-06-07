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
