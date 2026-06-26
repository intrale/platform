# Spike de relevamiento de gaps — Ola 7.1 (rediseños MIZPÁ del dashboard)

**Issue:** #4229 · Parte de #4227
**Alcance:** 13 pantallas de rediseño (#4189–#4201) del centro de mando MIZPÁ.
**Objetivo:** medir el gap entre el render actual en `main` y el mockup aprobado de cada pantalla. **El spike NO corrige: solo releva y documenta** para decidir qué issues de corrección crear.

---

## Metodología (y su límite)

La comparación se hizo **código de render vs mockup aprobado**, no por captura de pixeles en vivo:

- **Mockup aprobado:** se leyó visualmente el PNG aprobado de cada issue (`.pipeline/assets/mockups/<pantalla>-redesign-*.png`).
- **Render actual:** se leyó el **código realmente wireado al tab** (resuelto vía `.pipeline/lib/dashboard-routes.js`), no el archivo "obvio" por nombre — hubo dos trampas de wiring (ver abajo).
- **Por qué no screenshots:** `puppeteer` no está instalado en el entorno (`node_modules/puppeteer` ausente; requeriría descargar Chromium) y los tabs del dashboard se conmutan **client-side**, así que un solo `goto` no captura las 13 pantallas. La comparación estructural código-vs-mockup es, de hecho, más precisa para "secciones de más/menos, header, orden de bloques" — y detectó un bug de runtime (DESCANSO) que un screenshot también mostraría.
- **Recomendación de cierre:** validar en runtime las 2 pantallas marcadas **mayor** con `node .pipeline/dashboard.js` (puerto 3200) antes de crear los issues de corrección.

### Trampas de wiring detectadas (importante para futuros relevamientos)

El dashboard tiene **dos caminos de render**: el monolito `.pipeline/dashboard.js` (ventanas embebidas en la HOME single-page) y los **satélites navegables** vía `dashboard-routes.js` → `views/dashboard/*.js` y `satellites.js`. Varios archivos por nombre son **legacy embebido**, no el tab:

| Pantalla | Archivo "obvio" por nombre | Render REAL del tab (wireado) |
|---|---|---|
| EQUIPO | `views/dashboard/equipo.js` (legacy embebido) | **`satellites.js::renderEquipo`** (`/equipo`) |
| HISTORIAL | `views/dashboard/historial.js` (legacy #3734) | **`satellites.js::renderHistorial`** (`/historial`) |
| PIPELINE | `views/dashboard/pipeline.js` (ventana HOME) | **`views/dashboard/pipeline-redesign.js`** (`/pipeline`) |
| PROVIDERS | `views/dashboard/multi-provider.js` (huérfano) | **`views/dashboard/providers.js`** (`/providers`) |

> Auditar el archivo legacy en vez del wireado produce **falsos "gap mayor"**. (Le pasó al primer pase de EQUIPO; corregido tras verificar el routing.)

---

## Resumen ejecutivo — gap por pantalla

| # | Pantalla | Issue | Render wireado | Gap | Divergencia principal |
|---|----------|-------|----------------|-----|-----------------------|
| 1 | HOME | #4189 | `home.js` | 🔴 **mayor** | Header con pastillas viejas superpuestas + sección "Diagnóstico" que el mockup no tiene + "Issues en la ola"/"Ahora en ejecución" son reuso re-estilado del dashboard viejo |
| 2 | PIPELINE | #4190 | `pipeline-redesign.js` | 🟢 **OK** | Coincide 1:1 (flujo de fases + kanban). Board legacy solo como fallback |
| 3 | LOGS | #4191 | `logs.js` | 🟢 **OK** | Solo cosmético: render en 1 columna vs 2 del mockup; chat en módulo externo |
| 4 | ISSUES | #4192 | `issues.js` | 🟢 **OK** | Fiel a v2; difiere naming interno de acción y contenido ilustrativo del menú "⋯" |
| 5 | BLOQUEADOS | #4193 | `bloqueados.js` | 🟡 **menor** | Falta barra de chips-resumen por motivo + menú de acciones secundarias por tarjeta |
| 6 | COSTOS | #4194 | `costos.js` | 🟢 **OK** | Contempla los 5 proveedores; estructura 1:1 |
| 7 | EQUIPO | #4195 | `satellites.js::renderEquipo` | 🟢 **OK** | Redesign completo (banner EN VIVO + slots + roster). El verdadero render NO es `equipo.js` |
| 8 | MATRIZ | #4196 | `matriz.js` | 🟡 **menor** | Falta strip de stats rápidos + búsqueda y telemetría Pulpo/CPU/RAM; "carga actual" es texto plano, no badge |
| 9 | OPS | #4197 | `ops.js` | 🟡 **menor** | Layout 1 columna vs rail de 2; falta sección "VÍAS"/causas + botón "Log completo"; chip "N caídos" |
| 10 | KPIs | #4198 | `kpis.js` | 🟢 **OK** | Banner que diagnostica + DORA + alertas; fiel al mockup |
| 11 | HISTORIAL | #4199 | `satellites.js::renderHistorial` | 🟢 **OK** | Timeline agrupado por día completo; estado vacío rediseñado |
| 12 | DESCANSO | #4200 | `descanso.js::renderDescanso` | 🔴 **mayor** | **BUG de runtime**: el path wireado no inyecta `REST_TIMELINE_GEOMETRY_JS` → `ReferenceError` en `buildTimeline()` → calendario roto/vacío. Falta CTA "Proponer bloque" |
| 13 | PROVIDERS | #4201 | `providers.js` | 🟡 **menor** | Falta toolbar de filtro + "Guardar cambios". Pestañas internas ya eliminadas (sobreviven solo en `multi-provider.js` huérfano) |

**Conteo:** 🟢 OK = 7 · 🟡 menor = 4 · 🔴 mayor = 2

---

## Detalle por pantalla

### 1. HOME — #4189 → `home.js` — 🔴 mayor
- **Header con pastillas viejas superpuestas** (la principal): `renderControlBar` (home.js:3990-4016) sigue emitiendo `hdr-mode` ("⏸ Parcial · N issues", :1812), `hdr-window-qa` (:4009), `hdr-window-build` (:4010). El mockup v6 tiene header limpio: marca + selector a la izquierda; Pulpo/CPU/RAM/reloj a la derecha. Sin las pastillas de ventana ni "Parcial".
- **Pill "🟢 Build OK"** pegado a la marca (`renderBrandBar` :3979-3981) — ausente del mockup.
- **Sección "🔎 Diagnóstico y métricas detalladas"** (`renderDiagnostics` :4626-4643) — el mockup NO la contempla.
- **"Issues de la Ola"** (`renderWaveBoard` :4594-4621) — reuso re-estilado del `#wave-panel` legacy, no el tablero denso por issue del mockup.
- **"Ahora · En ejecución"** (`renderNowColumn` :4574-4589) — reuso de `#active-list` viejo, sin la anatomía de tarjeta rica del mockup.
- **Coincide:** brand bar MIZPÁ + selector multiproyecto, banner de misión, panel Estado del sistema con cuotas por proveedor, orden vertical de bloques.
- **Nota:** estas 4 divergencias **ya están documentadas en #4227** (OPEN, `Ready`, `qa:passed`, `priority:high`), no mergeado. El código en `main` es el estado pre-corrección. → **El issue de corrección de HOME ya existe (#4227).**

### 2. PIPELINE — #4190 → `pipeline-redesign.js` — 🟢 OK
- Flujo de 6 fases con flechas + contadores + fases vacías atenuadas (`renderPhaseFlowSsr` :179-209), kanban solo de fases activas con cards de título completo + barra de progreso + link GitHub + Logs (`renderIssuesByPhaseSsr`/`plRenderCard` :477-516). Toggle "Solo issues de la ola". Coincide con el mockup.
- Wiring real: `satellites.js::renderPipeline` → `pipeline-redesign`. El board legacy con scroll horizontal sobrevive solo como fallback defensivo. `pipeline.js` es otra superficie (ventana embebida en HOME), fuera del scope de #4190.

### 3. LOGS — #4191 → `logs.js` — 🟢 OK (cosmético)
- Implementa el rediseño MIZPÁ completo: ficha del agente (`renderFicha` :363-427), consola con filtros + "Seguir" (`renderConsole` :473-503), sub-pasos con `(N/M · X%)` mostrando todos (`renderSubsteps` :431-468), intervención (chips + chat real #3605).
- Única divergencia: el mockup arma 2 columnas (logs | sub-pasos+chat); el render apila en 1 columna. El historial de chat lo pinta el módulo externo `chat-panel`, no inline. No rompe ningún CA.

### 4. ISSUES — #4192 → `issues.js` — 🟢 OK
- Chrome MIZPÁ + toolbar (contadores + buscador + orden + agrupar + 6 chips), agrupado por estado, acción primaria por estado, accesos fijos 🔗/📄, menú "⋯" contextual, anti-truncado (CA-7), tooltips. (`renderMizpaChrome` :512-600, `GROUP_META` :127-148.)
- Diferencias menores no normativas: la acción "Lanzar" usa internamente `move-top` (label visible OK); el contenido exacto del menú "⋯" difiere del ejemplo ilustrativo del mockup.

### 5. BLOQUEADOS — #4193 → `bloqueados.js` — 🟡 menor
- Implementado: marca, banner de alarma con "El que más espera" + SLA, agrupado por motivo real, acciones core (destrabar/ver issue/ver logs), empty-state condicional.
- **Gap concreto:** falta la **barra de chips-resumen por motivo con contador** (Todos · Circuit breaker · Dependencia · QA fallido · …) que el mockup pone bajo los filtros — `renderFilterBarSsr` (:601-619) solo tiene búsqueda + selects. Y el **menú de acciones secundarias por tarjeta** (reintentar con otro proveedor, reabrir definición, ver historial de rebotes, cancelar) que el render pone planas en una fila (:449-467).

### 6. COSTOS — #4194 → `costos.js` — 🟢 OK
- Contempla **los 5 proveedores** (Claude/Codex/Groq/Gemini/Cerebras), no solo Anthropic (`PROVIDER_META` :227-235, grid `repeat(5,1fr)`). Banner de alarma, consumo diario apilado de 14 días con línea de presupuesto, proyecciones, detalle por skill con columna de proveedor, cuota por proveedor. 1:1 con el mockup.

### 7. EQUIPO — #4195 → `satellites.js::renderEquipo` — 🟢 OK *(corregido)*
- El tab `/equipo` se sirve desde **`satellites.js::renderEquipo`** (dashboard-routes.js:654), que **sí** es el rediseño MIZPÁ: banner de misión (EN VIVO + "roles despiertos" + 🔥 QUEMANDO AHORA tok/min + ⏱ EL MÁS VETERANO + ❄ EN ENFRIAMIENTO + visor ⚡ SLOTS DE CONCURRENCIA), chips de resumen + búsqueda, roster por categoría (`satellites.js:313-365`).
- El archivo `views/dashboard/equipo.js` (que parecía el render) es **legacy embebido** y conserva el estado vacío "Sin agentes vivos" — pero **no es el tab navegable**. → No requiere corrección por este eje.

### 8. MATRIZ — #4196 → `matriz.js` — 🟡 menor
- Núcleo del rediseño presente: banner de misión diagnóstico (tag CUELLO/FASE SATURADA + "LECTURA AUTOMÁTICA"), heatmap con ícono+rol por skill, leyenda de carga, tendencias vs 24h, cuello resaltado, fila de totales.
- **Gap:** falta el **strip de stats rápidos** (ACTIVOS/CUELLO/CARGA ALTA/GRILLA) + **barra de búsqueda** entre nav y matriz; falta telemetría "Pulpo latiendo · Ns" + CPU/RAM en el header; "carga actual" es texto inline en el `<h2>` (:356) en vez de un badge resaltado.

### 9. OPS — #4197 → `ops.js` — 🟡 menor
- Implementado: brand bar MIZPÁ, banner de misión (3 métricas + acción sugerida), topología jerárquica pulpo→servicios→dashboard, card Reconciler, pills QA, leyenda con dual-encoding.
- **Gap:** el render apila todo en **1 columna** (`opsBodyHtml` :553-589) vs el **rail de 2 columnas** del mockup (Reconciler + QA Environment a la derecha). El panel de detalle de nodo no tiene la sección **"VÍAS"/causas conocidas** ni el botón **"Log completo"** separado (solo "Restart", :706-712). Falta el **chip "N nodo caído"** en el título de Topología.
- (El estado standby de `outbox-drain` vs "CAÍDO" del mockup es **decisión de diseño documentada** en el propio issue, no un defecto.)

### 10. KPIs — #4198 → `kpis.js` — 🟢 OK
- Banner que **diagnostica** (gauge de salud 0-100 + lectura del cuello + conclusión accionable con salto), fila de KPI cards clickeables, DORA adaptado con objetivo+tendencia+sparkline, bandeja de alertas con umbral + salto contextual, consumo por proveedor, entregables por skill, manejo honesto de "sin datos". 1:1 con el mockup. (Wireado a `kpis.js`; el `renderKpisDetail` legacy de `satellites.js` NO está ruteado.)

### 11. HISTORIAL — #4199 → `satellites.js::renderHistorial` — 🟢 OK
- El tab `/historial` se sirve desde **`satellites.js::renderHistorial`** (dashboard-routes.js:676), no desde `views/dashboard/historial.js` (legacy #3734 embebido). Implementa: banner de pulso (EVENTOS HOY + último merge/rebote/agente), filtros + búsqueda, feed cronológico agrupado por día con cards (tipo coloreado, avatar de skill, issue↗, badges, enlaces issue/log/PR/PDF), estado vacío rediseñado. Alimentado por `/api/dash/historial`. 1:1 con el mockup.

### 12. DESCANSO — #4200 → `descanso.js::renderDescanso` — 🔴 mayor
- **BUG funcional de runtime (no cosmético):** el tab "Descanso" → `/modo-descanso` (nav-tabs.js:61) → `descansoView.renderDescanso()` (dashboard-routes.js:680-682). El bloque `<script>` de `renderDescanso()` inyecta `FETCH_CLIENT_JS + CONFIRM_MODAL_JS + COMMON_HELPERS + script` (descanso.js:1424-1427) pero **omite `REST_TIMELINE_GEOMETRY_JS`**. El símbolo `RestTimelineGeo` se define **únicamente** en ese bundle (`rest-timeline-geometry.js:172`). `buildTimeline()` —que corre en el render inicial— llama `RestTimelineGeo.blockRect(...)` (descanso.js:974) y `RestTimelineGeo.minToY(...)` (:983) en el loop por día. Con bloques de descanso por defecto (Noche L-V), el primer día con bloque lanza **`ReferenceError: RestTimelineGeo is not defined`**, dejando el calendario sin bloques (eje + hourlines pintan; los bloques no). Coincide con el síntoma del issue ("el calendario nace vacío"). `renderDescansoInner()` SÍ inyecta el bundle (:1325) — pero ese path no es el wireado al tab.
- **Gap visual adicional:** el mockup tiene un hero con countdown gigante + CTA "Proponer bloque 14-20"; el render arma tiles de métrica equivalentes (`renderStatus` :1081-1154) pero sin ese CTA.
- **Acción de corrección:** inyectar `REST_TIMELINE_GEOMETRY_JS` en el `<script>` de `renderDescanso()` (igual que `renderDescansoInner`). Validar en runtime que el calendario pinta los 7 días con bloques + línea AHORA.

### 13. PROVIDERS — #4201 → `providers.js` — 🟡 menor
- Wireado a `providers.js` (`/providers`), que ya es la v2: **sin pestañas internas**, **un proveedor por fila** unificada (id+tier | key | salud+cuota | modelos | kill-switch), banner diagnóstico real, franja "Por agente" con cadena DEFAULT. (`renderProviderRow` :361-382.)
- **Gap:** falta la **toolbar entre banner y lista** (toggle de filtro + botón "Guardar cambios" verde) que muestra el mockup. Es el único elemento estructural ausente.
- Las pestañas internas que el v2 elimina ("Por agente"/"Catálogo"/"Health") sobreviven solo en `multi-provider.js` (`/multi-provider`), ruta **huérfana** fuera de `NAV_TABS` — desde la nav MIZPÁ ya están eliminadas.

---

## Insumo para crear issues de corrección

Pantallas que requieren issue de corrección (las OK no requieren acción):

| Prioridad sugerida | Pantalla | Issue origen | Trabajo |
|---|---|---|---|
| Ya existe | HOME | #4189 | **#4227** ya abierto y documentado (header, diagnóstico, issues-en-ola, en-ejecución). |
| Alta | DESCANSO | #4200 | **Bug:** inyectar `REST_TIMELINE_GEOMETRY_JS` en `renderDescanso()` + agregar CTA "Proponer bloque". Verificar render del calendario en runtime. |
| Media | BLOQUEADOS | #4193 | Barra de chips-resumen por motivo + menú de acciones secundarias por tarjeta. |
| Media | OPS | #4197 | Layout de rail de 2 columnas + sección "VÍAS"/causas + botón "Log completo" + chip "N caídos". |
| Media | MATRIZ | #4196 | Strip de stats rápidos + búsqueda + telemetría Pulpo/CPU/RAM + badge "carga actual". |
| Baja | PROVIDERS | #4201 | Toolbar de filtro + botón "Guardar cambios". |
| Baja (opcional) | LOGS | #4191 | Layout 2 columnas (mejora cosmética, no rompe CA). |

> **Hallazgo transversal de proceso:** dos verdades sobre el wiring (EQUIPO, HISTORIAL) explican por qué el gate de UX dejó pasar entregas y por qué relevamientos por nombre de archivo dan falsos positivos. El refuerzo del gate (#4228) debería resolver el tab **navegable real** (vía `dashboard-routes.js`), no el archivo por nombre.
