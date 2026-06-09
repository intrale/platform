# Narrativa de diseño — Ventana Bloqueados V3

**Sub-historia**: #3729 (split de épico #3715 — rediseño UX integral del Dashboard V3).
**Mockup**: `.pipeline/assets/mockups/27-bloqueados-v3.svg` (kiosk vertical 1080×1920).
**Boundary técnico**: nuevo módulo `.pipeline/views/dashboard/bloqueados.js` siguiendo la
plantilla de `views/dashboard/home.js`. Vive dentro de `<main id="view-content">` del
router cliente entregado por #3773.

## 1. Contexto del rediseño

La ventana **Bloqueados** lista los issues del pipeline donde un agente pidió
intervención humana (`reportHumanBlock(...)`) o que tienen label `needs-human`.
Hoy vive embebida en el monolito `dashboard.js:2371-2439` con estilos
`.needs-human-*` colgados en el `<style>` interno (líneas 3571-3700) y CSS
huérfano del SLA visual: panel completo en rojo aunque haya un solo bloqueo, sin
jerarquía de severidad, tooltips solo en texto literal, escape inconsistente con
el resto de las 11 ventanas que se están extrayendo en paralelo.

El rediseño persigue tres objetivos:

1. **Jerarquía visible de severidad por edad** (`< 4h fresh`, `4-24h warning`,
   `≥ 24h danger`) con dual-encoding: color + forma + ícono. La regla WCAG es no
   comunicar información solo por color (CA-E1 del épico).
2. **Modularidad real**: extraer el módulo, llevar los estilos al `theme.css` con
   prefijo `.v3-bloqueados-*`, registrar como vista del router, mantener compat
   con `?section=needs-human`.
3. **Defense-in-depth XSS** alineado con #3722 — escape por contexto (text vs
   attr), coerción numérica de `b.issue` antes de interpolar en `href` y
   `onclick`. Ver comentario de security en el issue (#3729-comment-4584219501)
   para los 4 vectores canónicos × 5 superficies de origen externo.

## 2. Decisiones congeladas (no se discuten en desarrollo)

| # | Decisión | Justificación / referencia |
|---|---|---|
| D1 | Severidad dual-encoded: rail vertical 4px + pill con ícono (no solo color). | WCAG AA · CA-E1 del épico. |
| D2 | Tres umbrales de edad: fresh (`< 4h`, info azul), warning (`4-24h`, ámbar), danger (`≥ 24h`, rojo). | Hoy el monolito usa fresh (`< 4h`) y old (`≥ 4h`). El paso intermedio reduce ruido visual y refleja el SLA real (operador tolera bloqueos < 1 día). |
| D3 | Tooltip obligatorio en chevron, popout, "▶ Reactivar" y "✕ Desestimar". Helper **attr-context** (`escapeHtmlAttr`) — no `escapeHtml`. | CA-C1 + comentario de security en el issue. |
| D4 | `Number.isInteger(b.issue) && b.issue > 0` antes de renderizar la fila. Si falla, la fila se descarta silenciosamente. | CA-D1 — defense-in-depth. Origen filesystem-controlled, pero riesgo bajo no exime el check. |
| D5 | Empty-state celebratorio con check verde grande + mini-stats: "SLA promedio" + "Resueltos hoy". | Reduce ansiedad visual cuando el panel está vacío y refuerza que la ausencia de bloqueos es buen estado, no error. |
| D6 | Footer permanente con `/unblock <issue> <orientación>` (Telegram) + alternativa GitHub. | Hoy ya está; se mantiene por costumbre del operador. |
| D7 | Iconografía: solo `sprite.svg`. Símbolos usados: `ic-estado-needs-human` (header), `ic-link-out` (popout + GitHub), `ic-play` (Reactivar), `ic-remove-circle` (Desestimar), `ic-retry-clock` (badge edad), `ic-chat-bubble` (eventos), `ic-fase-*` (skill+phase pill). Sin SVG inline raw. | CA-F4 del épico. |
| D8 | Estilos migran a `.pipeline/views/dashboard/theme.css` con prefijo `.v3-bloqueados-*`. Las clases `.needs-human-*` del monolito quedan en hold (no se borran en este PR) — su retiro definitivo va en una sub posterior una vez que las 11 ventanas estén migradas. | CA-B1 + minimizar riesgo de regresión en otras ventanas que pudieran usar las mismas clases. |
| D9 | Router compat: el dev debe registrar redirect server-side `?section=needs-human → ?view=bloqueados` para no romper marcadores guardados por el operador. | Análisis técnico de Guru en el comentario del issue. |
| D10 | "Desestimar" sigue con `prompt()` actual en esta sub. La migración al wizard de doble confirmación (`#3724`) es scope separado — se documenta como follow-up suave. | Mantener cierre del split #3715 sin acoplar a #3724. |
| D11 | Sin tokens nuevos. Sin íconos nuevos. Sin componentes nuevos del design-system. Reusar todo lo existente. | Disciplina del épico #3715 (contrato heredado del análisis UX). |

## 3. Mapa visual (referencia al mockup)

```
┌─ <main id="view-content" data-slug="bloqueados"> ─────────────────────┐
│                                                                      │
│  ┌─[!]─ Necesitan intervención humana  [3]   3 issues esperando ⇕ ↗  │  ← bloqueados-header
│  │                                                                   │
│  │  ┌─░░─ ⓤx · validacion   #2891 [titulo]            ⏱ hace 29h    │  ← bloqueados-row-2891
│  │  │     ┌─ i  Resumen:                              ▶ Reactivar   │  (rail danger)
│  │  │     └─ ?  Motivo:                               ✕ Desestimar  │
│  │  │     └─ ░  Actividad reciente (timeline)                       │
│  │  │                                                               │
│  │  ┌─░─ guru · analisis   #3681 [titulo]            ⏱ hace 12h    │  ← bloqueados-row-3681
│  │  │     ┌─ i  Resumen:                              ▶ Reactivar   │  (rail warning)
│  │  │     └─ ?  Motivo:                               ✕ Desestimar  │
│  │  │                                                               │
│  │  ┌─░─ architect · validacion  #3754 [titulo]      ⏱ hace 47min  │  ← bloqueados-row-3754
│  │  │     ┌─ i  Resumen:                              ▶ Reactivar   │  (rail info)
│  │  │     └─ ?  Motivo:                               ✕ Desestimar  │
│  │                                                                   │
│  ┌─░─ Hint Telegram: /unblock <issue> <orientación>   o GitHub      │
│                                                                      │
│ —— variante empty-state cuando state.bloqueados.length === 0 ——      │
│                                                                      │
│  ┌─░─ [✓] Nada esperando que alguien decida                          │  ← bloqueados-empty
│  │     SLA promedio: 2h 14min   Bloqueos resueltos hoy: 7            │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## 4. Datos consumidos del state (sin tocar el shape)

| Campo | Origen | Contexto HTML | Helper de escape |
|---|---|---|---|
| `b.issue` | filesystem marker (pipeline-controlled) | attr (href + onclick) | `Number.isInteger` strict + descartar si falla. **NO escape text** — debe ser número puro. |
| `b.title` | GitHub Issue API | text + attr (tooltip) | `escapeHtml` para texto, `escapeHtmlAttr` para tooltip. |
| `b.skill`, `b.phase` | filesystem markers | text | `escapeHtml`. |
| `b.question`, `b.reason` | output del agente (LLM) | text | `escapeHtml`. Truncar a 280 chars (igual que hoy). |
| `b.summary`, `b.summary_stale` | `issueSummary.getSummaries()` (LLM) | text | `escapeHtml`. Sin truncate (ya viene corto). |
| `b.recent_events[].author`, `.preview` | `gh issue comments` | text | `escapeHtml`. |
| `b.recent_events[].when` | ISO timestamp | text (formateado a `12h`/`3d`/`ahora`) | numérico — sin escape, ya parseado. |
| `b.age_hours` | número computado | text (formateado) | numérico — sin escape. |

> **Importante**: el dev **no inventa** un nuevo escapador. Reusa
> `.pipeline/lib/escape-html.js` (#3722). Si #3722 no expone helper attr-context
> separado, eso es bloqueante para esta sub — abrir followup contra #3722, no
> hardcodear un fallback inline.

## 5. Iconografía (sprite.svg, sin nuevos símbolos)

| Posición | Símbolo | Sema |
|---|---|---|
| Header — icono pulse | `ic-estado-needs-human` | El estado del panel completo. |
| Header — chevron | (path inline) — sin símbolo de sprite necesario | Toggle colapsar/expandir. |
| Header — popout | `ic-link-out` | Abrir vista en ventana independiente. |
| Fila — skill+phase pill | `ic-fase-${b.phase}` (ej: `ic-fase-validacion`) | Indica fase de bloqueo. |
| Fila — link al issue | `ic-link-out` (opcional, al lado de `#NNNN`) | Click abre GitHub en nueva tab. |
| Fila — badge edad | `ic-retry-clock` | Comunica antigüedad del bloqueo. |
| Fila — sección Resumen | `ic-handoff` o glifo "i" minimal | Resumen funcional del issue. |
| Fila — sección Motivo | glifo "?" minimal (sin símbolo de sprite) | Motivo del bloqueo. |
| Fila — sección Eventos | `ic-chat-bubble` | Timeline compacto. |
| Fila — botón Reactivar | `ic-play` | Quitar `needs-human` y reanudar. |
| Fila — botón Desestimar | `ic-remove-circle` | Cerrar como `not_planned`. |
| Empty-state — icono | `ic-cell-pass` o glifo check grande | Celebra estado healthy. |

## 6. Accesibilidad (WCAG AA — checklist obligatorio)

| Punto | Cumplimiento |
|---|---|
| Contraste texto principal ≥ 4.5:1 | `--text-primary` (`#E6EDF3`) sobre `--surface-1` (`#161B22`) = 13.2:1 ✓ |
| Contraste pill danger ≥ 4.5:1 | `#F85149` sobre `rgba(248,81,73,0.14)` con texto blanco fondo neutro ✓ |
| Información no solo por color | Rail + pill + ícono + texto numérico de edad ✓ |
| Touch target acciones | `padding:4px 10px` produce ≥ 28×80 px ✓ (mínimo recomendado 24×24, target 44×44 para móvil, kiosk teclado/mouse acepta 28) |
| `aria-label` en chevron | `aria-label="Colapsar panel"` (cambiar a "Expandir" al colapsar) |
| `aria-label` en popout | `aria-label="Abrir Bloqueados en ventana independiente"` |
| `aria-label` en botones de acción | `aria-label="Reactivar issue #${b.issue}"` / `aria-label="Desestimar issue #${b.issue}"` |
| `role="tooltip"` + `aria-describedby` en cada `title=` | Aplicado a chevron, popout, Reactivar, Desestimar, badge edad. |
| Soporte `prefers-reduced-motion` | `@media (prefers-reduced-motion: reduce)` desactiva `needs-human-pulse` (mantener visible, sin animación). |
| Navegación teclado | `tabindex` natural en botones; foco visible con `outline: 2px solid var(--brand-cyan)`. |

## 7. Renderizado por estado del state

| Estado | Render |
|---|---|
| `state.bloqueados === undefined`/`null` | Renderiza empty-state (mismo que `length === 0`). |
| `state.bloqueados.length === 0` | Empty-state con check verde, "Nada esperando que alguien decida" y mini-stats. |
| `state.bloqueados.length === 1` | Header con badge `1`, una fila, footer hint. |
| `state.bloqueados.length >= 2` | Header con badge `N`, N filas en orden decreciente de edad, footer hint. |
| `b.summary_stale && !b.summary` | Mostrar línea de Resumen con `📄 Cargando resumen funcional…` (opacidad 0.55, italic). |
| `b.recent_events.length === 0` | Omitir sección "Actividad reciente" — no renderizar el bloque vacío. |
| `b.reason || b.question` truncado a 280 chars | Append `…` si el original era más largo. |
| `Number.isInteger(b.issue) === false` | **Descartar la fila silenciosamente** (loggear warning server-side). |

## 8. Pre-checklist para el dev (CA-G1 + CA-G2)

Antes de cerrar el PR de #3729:

1. **Extracción**: `views/dashboard/bloqueados.js` exporta:
   - `slug: 'bloqueados'`
   - `renderBloqueadosSsr(state) → string` (HTML del módulo, sin envolver en `<main>`)
   - `renderBloqueadosClientScript() → string` (handlers `needsHumanReactivate`, `needsHumanDismiss`, `toggleNeedsHumanPanel` — copiados del monolito, no reescritos).
2. **Registro**: en `dashboard.js`, cerca de las líneas 9027/9039 (donde se cargan las otras vistas):
   ```js
   try { bloqueadosView = require('./views/dashboard/bloqueados'); }
   catch (e) { log('[views] bloqueados no disponible:', e.message); }
   ```
3. **Tests** en `.pipeline/views/dashboard/__tests__/bloqueados.test.js`:
   - SSR con `state.bloqueados = []` → contiene `bloqueados-empty`, no contiene `bloqueados-row-`.
   - SSR con 1 fila normal → datos escapados, no contiene `<script`, tooltip presente.
   - SSR con 4 vectores XSS canónicos × 5 superficies — todos escapados, tags vivos ausentes.
   - SSR con `b.issue = "1) alert(1) //"` y `<script>` → fila descartada, log warning.
   - SSR con `b.summary_stale: true` → renderiza `Cargando resumen funcional…`.
4. **Smoke curl** del PR:
   ```bash
   curl -s 'http://localhost:3200/?view=bloqueados' | grep -q 'bloqueados-view'
   curl -s 'http://localhost:3200/?section=needs-human' | grep -q 'bloqueados-view'   # compat retro D9
   ```
5. **Screenshot Puppeteer** del PR adjunta dos imágenes en mismo viewport
   (1080×1920) — render real + mockup 27 lado a lado.
6. **Inventario** actualizado en `docs/pipeline/dashboard-v3-inventory.md`:
   - Fila por cada campo renderizado: contexto HTML (text/attr), origen
     (pipeline-internal/external), helper de escape usado.
7. **CSS migrado** a `views/dashboard/theme.css` con prefijo `.v3-bloqueados-*`.
   Las clases `.needs-human-*` del monolito permanecen — no borrar en este PR.
8. **Compat retro**: agregar redirect en el handler de `/` cuando
   `req.query.section === 'needs-human'` → `?view=bloqueados`.

## 9. Recomendaciones para el dev (sin scope obligatorio)

- Si el campo `b.recent_events` viene con > 5 entradas, **mostrar las 3 más
  recientes + un "+N más"** colapsable. El mockup 27 muestra 3 entradas como
  patrón target.
- La animación `needs-human-pulse` (1.6s ease-in-out) se mantiene como hoy. Si
  el dev nota que satura visualmente cuando hay > 5 filas, puede limitarla al
  ícono del header (no por fila). Documentar la decisión en el PR.
- El badge de cantidad en el header puede saltar a `99+` cuando supera 99 — patrón
  ya usado en otros badges del dashboard. No es obligatorio.

## 10. Boundary explícito — qué NO toca esta sub

- **NO mover** el tooltip del KPI rojo `dashboard.js:744` (`V3 — Bloqueados
  esperando humano`). Pertenece a la sub de KPIs (#3733).
- **NO migrar** el endpoint `POST /api/needs-human/:issue/:action` a CSRF. Eso
  lo cubren #3191 / #3612 / #3724 — gaps documentados en el comentario de
  security.
- **NO crear** wizard de doble confirmación para Desestimar. Esto pertenece a
  #3724 (wizards base) — la migración se hará cuando #3724 esté merge.
- **NO inlinear** el SVG sprite raw — usar `<use href="#ic-...">` con el sprite
  cargado una sola vez por `dashboard.js`.
- **NO crear** tokens nuevos en `design-tokens.css`. Reusar `--danger`,
  `--warning`, `--info`, `--success` y sus dim/bg.
- **NO borrar** las clases `.needs-human-*` del monolito (D8).

## 11. Validación visual del mockup contra los criterios del épico

| CA del épico | Cómo lo cumple este mockup |
|---|---|
| CA-A1 (no perder funcionalidad) | Header, filas, summary, motivo, eventos, acciones, footer — todos presentes. |
| CA-A2 (actualizar inventario) | Sección 4 documenta el mapeo campo → contexto → helper. |
| CA-B1 (extracción obligatoria) | Boundary visual `<main id="view-content">` marcado en el mockup. |
| CA-B3 (usar `lib/escape-html.js`) | Sección 4 + sección 8 punto 3 lo exigen explícitamente. |
| CA-C1 (tooltips en acciones) | D3 + ejemplo amarillo sobre chevron en el mockup. |
| CA-C3 (leyenda) | Sección "leyenda de severidad" embebida en el mockup. |
| CA-D1 (payload XSS) | Sección 4 + sección 8 punto 3 listan los 4 × 5 vectores. |
| CA-E1-E4 (WCAG AA) | Sección 6 con checklist. |
| CA-F1-F4 (mockup + tokens + sprite) | Este archivo + 27-bloqueados-v3.svg + sin tokens/íconos nuevos. |
| CA-G1, CA-G2 (test SSR + smoke curl) | Sección 8 puntos 3 + 4. |

## 12. Recomendaciones pendientes de aprobación humana

Durante este análisis se identificaron 2 oportunidades de mejora no
bloqueantes. Cumplen el cap de #2653 (máximo 3) y van como issues separados
con label `tipo:recomendacion + needs-human`, sin entrar al pipeline automático:

- **#tbd-A** — Wizard de doble confirmación para "Desestimar" (escribir
  `DESESTIMAR` para confirmar + preview de side-effects: cerrar issue, borrar
  worktree, audit log NDJSON). Hoy queda con `prompt()` actual.
- **#tbd-B** — Persistir el estado colapsado/expandido del panel por
  operador (localStorage), igual que #3719/#3720 ya proponen para densidad y
  sidebar.

No se crea recomendación sobre CSRF/audit log porque ya están abiertos
(#3191, #3612, #3238).
