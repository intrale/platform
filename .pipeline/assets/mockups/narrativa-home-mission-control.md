# Narrativa UX — EP8-H1: Home Kiosk → Mission Control de 3 bandas · #3954

Mockup: `34-home-mission-control-v3.svg` (1080×1920, kiosk vertical 1:1 con la resolución objetivo de CA-1).
Construido sobre el sistema de diseño de EP8-H0 (#3953): `design-tokens.css` + `sprite.svg` + set de severidad `ic-ok/warn/bad/info`.

## Qué entrega UX en esta historia

EP8-H1 no agrega vocabulario visual nuevo: **reutiliza** el de H0. El entregable de UX acá es la
**especificación de layout y jerarquía** del Home rediseñado, materializada en un mockup verificable
contra el viewport real (1080×1920). El dev (`pipeline-dev`) **ubica** los slices existentes dentro
de esta grilla; no inventa diseño.

> **Regla rectora (heredada del Arquitecto):** extender, no reescribir. El layout de 3 bandas
> reemplaza el *cuerpo* de `renderHomeHTML`, pero los sub-renderers y slices existentes se reutilizan
> y el contrato SSR↔DOM-morphing por `id` se preserva (CA-13).

## Grilla maestra (CA-1)

Contenedor raíz: `height:100vh; overflow:hidden;` + `display:grid; grid-template-rows: 56px 20fr 50fr 30fr` (header fijo + 3 bandas). En 1080×1920:

| Zona | Alto | Función |
|------|------|---------|
| Header | 56 px | marca + frescura del dato (EP8-H0) + reloj. Mínimo, no es banda. |
| **Banda 1 · Salud** | ~384 px (20%) | semáforo global explicable + 3 KPIs decisorios + bandeja de alertas |
| **Banda 2 · Ahora** | ~960 px (50%) | tarjetas grandes de agentes en ejecución, Commander pinned |
| **Banda 3 · Flujo** | ~520 px (30% útil) | mini-kanban de la ola + próximos 5 |

**Verificable (CA-1):** `document.body.scrollHeight <= document.body.clientHeight` en 1080×1920 → sin scrollbar de página.

## Comportamiento de overflow por banda (CA-2 — decisión PO, materializada acá)

El "sin scroll" es de la **página**, no de los contenidos. Cada banda resuelve su exceso *internamente*:

- **Banda 1:** semáforo + 3 KPIs son **fijos** (nunca scrollean). La bandeja de alertas muestra las N
  más recientes/severas que entran en su caja; el resto cae en un **scroll vertical acotado a la bandeja**
  con contador `+X más` (en el mock: `▾ +1 alerta más`). El scroll jamás propaga a la banda ni a la página.
- **Banda 2:** tarjetas grandes. El **Commander va primero y fijado** (pinned, borde púrpura). El excedente
  de agentes se resuelve con **carrusel horizontal discreto** (indicadores de página tipo dots, sin
  scrollbar de página). Nunca recortar texto crítico: skill / issue / fase / progreso siempre legibles.
- **Banda 3:** mini-kanban de la ola con **scroll horizontal interno contenido**; "próximos" topeado en
  **5 fijos**.

**Verificable:** forzar muchos items en cualquier banda y comprobar que `body.scrollHeight` no crece.

## Anatomía por banda

### Banda 1 — Salud

1. **Semáforo global explicable (CA-3).** Disco grande con estado verde/amarillo/rojo provisto por
   `computeInfraHealthLevel()` extendido a `pulpo + infra + cuota + anomalía`. Bajo el disco: etiqueta de
   estado (`DEGRADADO`) + cuántas razones. El **tooltip enumera cada razón** (`reasons[]`). Con sistema
   sano: "sin degradaciones". Estado **nunca solo por color**: forma de ícono (`ic-warn` triángulo /
   `ic-bad` octógono / `ic-ok` check) + texto. Cada razón se renderiza **escapada** (`escapeHtmlText` — REQ-SEC-6).
2. **3 KPIs decisorios (CA-4).** Exactamente `bouncePct` (% rebote 7d), `activeAgents`, `nextInQueue`, de
   `kpisSlice`. Patrón `kpi-card` de H0: barra lateral de color por severidad + ícono + número monoespaciado.
   Sin mocks/placeholders.
3. **Bandeja de alertas (CA-5/CA-6).** Reemplaza los banners dispersos. Cada entrada: severidad (ícono+borde),
   título escapado, **timestamp de inicio**, **quién la atendió** y botones **ack** / **snooze**.
   - "quién atendió" = chip monoespaciado `operador-local`, **grabado server-side** + timestamp del server.
     Nunca del body del cliente (REQ-SEC-3). El mock lo muestra como pill, no como input editable.
   - **snooze** sólo abre la allowlist `1h / 4h / 24h` (techo 24h). Sin campo free-form (REQ-SEC-2).
   - cada acción deja audit trail verificable con escritura atómica (espejo de `partial-pause-audit`); el
     mock muestra el sello `audit ✓`.

### Banda 2 — Ahora

4. **Tarjeta de agente (CA-7).** Grande, legible a distancia (es un kiosk). Anatomía:
   barra lateral de color por lane · nombre del skill (20px/700) · badge de fase · `issue · fase`
   (monoespaciado) · título del trabajo · lista de pasos (`ic-ok` hechos, anillo punteado el actual) ·
   barra de progreso `N/M · X%` · link "ver log en vivo" · pie `provider · hora`. Datos de
   `activeAgents` + `buildAgentsForActiveFase`.
5. **Commander pinned (CA-8).** Cuando atiende, es **una tarjeta más, primera y fijada** (borde púrpura
   `--purple-dim`, badge `pinned`), mostrando sus fases (R-V6) y el indicador `narrando` (`ic-estado-voz-narrando`)
   si hay TTS activo. Cuando no atiende: no aparece, o estado idle claro.
6. **Un tap → log (CA-9).** Toda la tarjeta es clickeable → log del agente. Mínimo viable: link al log
   existente. Ideal: log-live/SSE. Si se hace SSE, cada línea pasa por `lib/redact.js`, path confinado a
   `.pipeline/logs/` sin `..`, cap de bytes/líneas y **escape** en el DOM (REQ-SEC-4). El SSE no bloquea:
   primero el link, después la mejora.

### Banda 3 — Flujo

7. **Mini-kanban de la ola (CA-10).** `wave-panel` en layout **horizontal**, columnas por lane con sus
   colores de `design-tokens` (`--lane-definicion` púrpura / `--lane-desarrollo` azul / `--lane-qa` teal /
   `--lane-entrega` verde). Tarjetas compactas `#issue + fase`.
8. **Próximos 5 (CA-10).** `nextInQueue(state, ctx, 5)` en panel lateral, lista numerada, tope fijo en 5.

### Transversal — Deep-links (CA-11)

Todo elemento clickeable refleja su estado en la URL vía `pushState/replaceState`: `?view=`, `?alert=`,
`?agent=`, `?phase=`. Recargar restaura el estado. Cada param **validado por allowlist/regex** y **nunca
reflejado sin escapar** (REQ-SEC-5, extensión de CA-S4). Affordance en el mock: ícono de link en
elementos navegables.

## Guidelines para el dev (no inventa diseño, ubica assets)

- **Colores:** sólo tokens de `design-tokens.css`. Cero hex hardcoded nuevos. El mock usa hex literales
  *sólo* para preview standalone; en `home.js`/`theme.css` van como `var(--token)`.
- **Íconos:** siempre `<use href="#ic-…">` desde el sprite vía allowlist server-side. Nunca construir el
  `href` desde input externo (SVG injection). Severidad con el set H0 `ic-ok/warn/bad/info`.
- **Escapado:** todo dato derivado (razones del semáforo, títulos de alertas, líneas de log, params de
  deep-link) pasa por `escapeHtmlText`. REQ-SEC-4/5/6.
- **Morphing (CA-13):** cada banda morphea su sub-árbol por `id`; el polling JSON alimenta los slices.
  No re-renderizar el documento. Conservar IDs invariantes existentes.
- **Modularización:** si un sub-renderer nuevo supera ~150 líneas, extraerlo a módulo (patrón
  `components.js`/`confirm-modal.js`). La modularización completa de `home.js` está trackeada en **#4031**
  (no bloquea esta historia).
- **Endpoints mutantes (CA-12):** ack/snooze (y log-live si aplica) son los **primeros POST** del dashboard;
  replican literalmente el cinturón de gates de `/dashboard/partial` (405 método → 403 no-loopback →
  403 cross-site → Content-Type → cap de body), loopback **independiente de `DASHBOARD_HOST`** (REQ-SEC-7).

## Accesibilidad (WCAG AA)

- Todos los pares texto/fondo del mock usan tokens ya verificados AA en `design-tokens.css` (≥4.5:1 texto
  normal, ≥3:1 íconos/texto grande).
- Severidad **nunca solo por color**: forma de ícono + texto (heredado de H0).
- Foco visible: `--focus-ring` (cyan) en todo elemento interactivo (botones ack/snooze, tarjetas, links).
- Touch targets de ack/snooze ≥ 24px de alto (kiosk táctil); el carrusel se opera también por teclado.
- `prefers-reduced-motion` ya cubierto por `design-tokens.css` (transiciones del carrusel se neutralizan).

## Riesgo principal cerrado por el diseño

El riesgo "sin scroll vs. N agentes variables" que guru/security/PO marcaron como BLOQUEANTE queda resuelto
por la regla de **overflow confinado por sub-componente** (CA-2): bandeja con scroll interno + contador,
Banda 2 con carrusel + Commander pinned, Banda 3 con scroll horizontal interno + tope de 5. La página
nunca scrollea.
