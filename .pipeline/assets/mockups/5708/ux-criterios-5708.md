# UX · Criterios visuales — #5708 (QA visual: inventario completo + cobertura declarada)

> Entregable de UX en fase `definicion/criterios`. Mockup de referencia:
> `.pipeline/assets/mockups/48-rejection-visual-inventory.svg` (1240×2400, A4 ~150dpi).
> Extiende el mockup 19 (`19-rejection-visual-comparison.svg`, #3383), que sigue vigente
> para el bloque side-by-side base.

## 1. Qué cambia visualmente

El rejection report visual pasa de **lista plana de hasta 5 hallazgos** a **inventario
completo estructurado**. Tres bloques nuevos y una regla de truncado:

| # | Bloque | Estado hoy | Estado objetivo |
|---|--------|-----------|-----------------|
| V1 | Cobertura visual declarada | no existe | bloque propio arriba de la comparación, obligatorio en APROBADO y RECHAZADO |
| V2 | Inventario de desvíos | `<ol>` plana, `slice(0,5)` silencioso | agrupado por sección del mockup, ordenado por impacto desc, con contador por grupo |
| V3 | Tipificación de regresión | no existe | chip `REGRESION` + línea explicativa cuando el desvío cae en sección declarada verificada en una pasada previa |
| V4 | Truncado | silencioso a 5 | declarado: `"N de M desvíos mostrados — inventario completo en visual-comparison.json"` |

## 2. Especificación de cada bloque

### V1 · Cobertura visual declarada

Card `--surface-1` con borde `--border-default`, ancho completo (1144 en el canvas de
referencia), altura 180. Contiene:

- **Fila superior**: `Secciones declaradas por el mockup <N>:` + la lista de IDs en
  monoespaciada, y a la derecha una barra de progreso segmentada
  (verde = verificadas, ámbar = no verificadas). La barra **nunca** va sola: siempre
  acompañada del texto `X verificadas · Y no verificada(s) (motivo declarado)`.
- **Chips por sección**, uno por cada sección declarada, en grilla de 4 columnas
  (268×92, gap 24). Cada chip lleva:
  - ícono de estado (check en círculo verde / `!` en círculo ámbar),
  - ID + nombre de la sección (14px/700),
  - etiqueta textual del estado — `VERIFICADA` / `NO VERIFICADA` — obligatoria,
  - cantidad de desvíos detectados, o el **motivo** si no fue verificada.
- **Pie**: la invariante que valida el guardrail,
  `verificadas ∪ no_verificadas = secciones_declaradas`.

Estados de chip:

| Estado | Borde | Fondo ícono | Texto de estado |
|--------|-------|-------------|-----------------|
| verificada sin desvíos | `#196C2E` | `#0F3D26` | `VERIFICADA` |
| verificada con desvíos | `#196C2E` | `#0F3D26` | `VERIFICADA` + contador de desvíos |
| no verificada | `#7D5E10` | `#3A2D0B` | `NO VERIFICADA` + motivo (máx 2 líneas) |

El motivo es obligatorio y debe ser objetivable (`estado no alcanzable sin datos de
negocio`, `requiere issue estancado real`). Prohibido `no se pudo`, `no aplica`, vacío.

### V2 · Inventario agrupado

- Un **grupo por sección** con desvíos. Header de grupo: barra 34px `--surface-info`
  (`#1F2D3F`) con `SECCION <ID> · <nombre>` a la izquierda, `N desvíos · X alto · Y medio`
  al centro y `cobertura: verificada` a la derecha.
- Orden de grupos: por **impacto máximo del grupo** descendente; a igualdad, por ID de
  sección ascendente.
- Orden dentro del grupo: `alto` → `medio` → `bajo`.
- Ítem: card 1144×84 (`--surface-2`, borde `--border-default`) con
  - índice numerado en círculo, del **mismo color que el impacto**, y **el mismo número
    que el marcador sobre la captura** en el side-by-side (correspondencia 1:1),
  - título (14px/700) que empieza por el componente afectado, no por la corrección,
  - badge de impacto con **texto** `ALTO` / `MEDIO` / `BAJO` (nunca solo color),
  - descripción objetivable citando tokens o números (12px),
  - línea de impacto sobre el usuario (11px, `--text-muted`).

Paleta de impacto (coherente con `design-tokens.css` y con el mockup 19):

| Impacto | Círculo/acento | Fondo badge | Borde badge |
|---------|----------------|-------------|-------------|
| alto | `#F85149` | `#3B1F1B` | `#8B1A14` |
| medio | `#D29922` | `#3A2D0B` | `#7D5E10` |
| bajo | `#58A6FF` | `#1F2D3F` | `#1F4C7A` |
| regresión (modificador) | `#BC8CFF` | `#2B2140` | `#4C3A76` |

### V3 · Tipificación de regresión

Cuando el desvío cae en una sección que una pasada anterior declaró verificada y sin
desvíos:

- header del grupo en violeta (`#2B2140` / `#BC8CFF`) en vez de azul,
- borde del ítem `#4C3A76`, círculo de índice `#BC8CFF`,
- chip `REGRESION` **además** del chip de impacto (no lo reemplaza),
- línea explícita: `Tipificado como REGRESION del codigo: la seccion <ID> fue declarada
  verificada y sin desvios en la pasada rev-<N> (visual-coverage-rev<N>.json)`.

La distinción es el corazón del CA-5: el lector del PDF tiene que poder decir, sin abrir
un JSON, si el hallazgo es regresión del código o barrido incompleto del verificador.

### V4 · Truncado declarado

Banda 1144×44, `--surface-1`, borde punteado. Siempre presente, aun cuando no haya
truncado (`Mostrando 6 de 6 desvios · tope de render del PDF: 50`). Cuando trunca:
`Mostrando 50 de 63 desvios — inventario completo en qa/evidence/<issue>/visual-comparison.json`.

### V5 · Variantes del veredicto

Dos cards 560×130 al pie:

- **APROBADO con cobertura**: header verde, lista de secciones verificadas y la frase
  que explica que el aprobado también declara cobertura porque es la línea base para
  tipificar regresiones futuras. Path del `visual-coverage-rev<N>.json`.
- **Veredicto no aceptado por forma**: header ámbar,
  `visual-report-shape-gate → block · reason: coverage-incomplete · missing: [...]`,
  más la aclaración de que **1 solo desvío con cobertura completa es válido** (el
  discriminante es la cobertura, no `diffs.length`) y de que el flag va default OFF
  (`gate: disabled`).

## 3. Criterios de aceptación UX (verificables sobre el PDF generado)

- **UX-1** · Todo rejection report visual (aprobado o rechazado) renderiza el bloque de
  cobertura con una entrada por cada sección declarada. Ninguna sección queda sin
  clasificar visualmente.
- **UX-2** · Toda sección `NO VERIFICADA` muestra el motivo en el mismo chip. Motivo
  vacío o genérico = defecto de UX.
- **UX-3** · Los desvíos se renderizan agrupados por sección y ordenados por impacto
  descendente. Ningún grupo mezcla secciones.
- **UX-4** · Ningún estado se codifica sólo por color: impacto, cobertura y regresión
  llevan siempre etiqueta textual. Verificable poniendo el PDF en escala de grises —
  toda la información debe seguir siendo legible.
- **UX-5** · Los números de los marcadores sobre la captura de entrega coinciden 1:1 con
  los índices del inventario.
- **UX-6** · La banda de truncado está siempre presente y declara `N de M`. Nunca se
  omite un desvío sin decirlo.
- **UX-7** · Contraste mínimo AA (4.5:1) para todo texto ≥ 11px sobre su fondo; los
  textos de estado (`ALTO`, `VERIFICADA`, `REGRESION`) cumplen AAA sobre su chip.
- **UX-8** · Todo texto del reporte pasa por `lib/redact.js` antes de renderizar: el
  repo es público y el inventario ahora incluye descripciones largas escritas por el
  agente QA.

## 4. Guidelines para el agente QA al redactar el inventario

- Un ítem = un desvío. Prohibido consolidar `"varios problemas de color"` en un ítem.
- Título: componente afectado primero. Bien: *"A3 nunca se pinta en rojo cuando el stall
  es critico"*. Mal: *"Arreglar el banner"*.
- Descripción: `Mockup: <valor esperado>. Entrega: <valor observado>.` con token o número.
  Prohibido `se ve mal`, `queda raro`, `no matchea`.
- Impacto: sobre el **usuario**, no sobre el código. `el operador no percibe que el
  dispatch esta caido` es impacto; `usa el token equivocado` es descripción.
- El barrido se completa siempre. Si al segundo desvío ya está decidido el rechazo, se
  siguen recorriendo las secciones restantes igual: el costo de la pasada ya se pagó.

## 5. Trazabilidad

- Mockup base heredado: `19-rejection-visual-comparison.svg` (#3383).
- Mockup nuevo: `48-rejection-visual-inventory.svg` (#5708).
- Spec de doc a actualizar por dev: `docs/pipeline/visual-validation.md` §4.5 / §4.6 /
  §4.7 (nueva) — reemplaza la regla `"máximo 5 items por reporte"` por V4.
- Render afectado: `.pipeline/rejection-report.js` → `renderVisualComparisonBlock`.
