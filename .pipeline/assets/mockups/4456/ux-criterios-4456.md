# UX — criterios visuales para #4456

Cuota de consumo REAL por proveedor en la vista principal del dashboard.
Historia de `area:infra` sin `app:*`: no hay íconos, splash ni pantallas de la
app; el entregable visual es el **sistema de lectura del panel de cuotas**.

Referencia visual: `quota-por-proveedor-4456.svg` (render verificado en
`quota-por-proveedor-4456.png`). Evidencia del estado previo:
`estado-actual-4456.png`.

## Estado verificado en HEAD (253132b19) — leer antes de implementar

Se comprobó empíricamente el código y el render actual. Dos supuestos del
enunciado original ya no describen el HEAD, y perseguirlos haría perder tiempo:

1. **El KPI agregado ya no es visible en el home.** `_pulseFaroKpis()` (con
   `kpi-quota-session-pct` / `kpi-quota-week-pct`) se invoca desde
   `renderHealthBand()`, que **no** está en el árbol de `renderHomeHTML()`. La
   única invocación viva llega por `renderDiagnostics()`, dentro de
   `<div class="mz-telemetry-sink" hidden aria-hidden="true">`. El screenshot
   del home lo confirma: no hay banda de KPIs faro.
   Lo que **sí** sigue vivo y CA-1 alcanza es la **hidratación**:
   `renderQuotaCard()` + el ticker que escribe esos IDs cada segundo.
2. **No existe un `100%` semanal hardcodeado** en el bloque de cuota. La
   búsqueda de literales en `views/dashboard/home.js` no arroja ninguno: el
   valor semanal proviene de `d.pct` del adapter Anthropic (dato real). El
   `100%` que se ve en el home pertenece al **AVANCE de la ola**, otro
   componente. CA-1 se satisface removiendo markup + hidratación muertos, no
   buscando una constante que no está.

La matriz proveedor × ventana (5 filas) **ya existe** desde #4533. Esta historia
no crea el componente: unifica su semántica y completa sus fuentes.

## Decisión de diseño central — polaridad única: % CONSUMIDO

Hoy la misma tabla mezcla dos magnitudes opuestas:

- `anthropic` → **% consumido** (`_mzHydrateWinCell`, rama `isConsumedView`, #4884).
- resto de las filas → **% disponible** (gauge free-tiers #4533 y evento Codex #4900).

Dos filas con el número `20%` significan hoy cosas opuestas: una es holgura, la
otra es agotamiento. Es el defecto de legibilidad más grave del panel y lo que
CA-2 pide cerrar. **Toda la matriz pasa a `% consumido`.**

Fundamento de la elección (consumido y no disponible):

- El objetivo y el título del issue hablan de «cuota de **consumo** real»; CA-3
  pide «porcentaje de consumo». El vocabulario del operador ya es ese.
- Anthropic —el proveedor dominante y el de dato más rico— ya está en consumido
  tras #4884; invertirlo sería reintroducir el bug que ese issue cerró.
- La conversión es **exacta y sin pérdida** para los free-tiers, cuyo dato nativo
  es `remaining/limit`:
  `consumido = 100 − available = 100·(limit − remaining)/limit`.

**Cero regresión cromática:** `_mzConsumedClass()` ya es el espejo exacto de
`_mzThresholdClass()` (`consumido > 80 ⇔ available < 20`; `consumido > 50 ⇔
available < 50`). Ninguna celda cambia de color: cambian el número y el rótulo.

## Estados de celda

Una **única magnitud entera normalizada** alimenta texto visible, ancho de
barra, clase cromática, `title` y `aria-label`. No pueden divergir.

| Estado | Render | Token | Condición |
|---|---|---|---|
| Fresco · holgado | `N%` + barra | `--in-ok` `#3FB950` | consumido 0–50 |
| Fresco · medio | `N%` + barra | `--in-warn` `#D29922` | consumido 51–80 |
| Fresco · crítico | `N%` + barra | `--in-bad` `#F85149` | consumido 81–100 |
| Tope activo | `tope activo` | `--in-bad` `#F85149` | `eventState=exhausted`; precede a cualquier % |
| Sin dato | `sin dato`, sin barra | `--text-dim` `#8B949E` | ausente · stale · futuro · fuera de rango · malformado |
| Pendiente | `…`, sin barra | `--text-disabled` `#6E7681` | aún no llegó el primer tick |

Precedencia: `exhausted` > `nodata` > porcentaje fresco. Un porcentaje residual
nunca puede pisar un estado categórico.

## Reglas no negociables

- **R-1 · Rótulo explícito.** El encabezado del panel declara la magnitud una
  sola vez: `% CONSUMIDO · leído del proveedor · reset propio por bucket`
  (hoy dice `% leído del proveedor`, ambiguo). Cada celda la repite en `title` y
  `aria-label`: «`<Proveedor> <ventana>: N% consumido`». La palabra
  «disponible» **no aparece** en el panel — ni en el skeleton de `_mzWinCell`,
  cuyo `hint` hoy se bifurca por proveedor y debe quedar único.
- **R-2 · WCAG 1.4.1, no sólo color.** El número y los literales `sin dato` /
  `tope activo` comunican el estado sin depender del matiz. La barra es refuerzo,
  nunca el único portador de significado.
- **R-3 · Contraste AA — corregir defecto actual.** `sin dato` se pinta hoy a
  `10px` con `--in-fg-soft #6E7681`, que sobre el panel `#161B22` da **3.77:1**
  (ratio calculado, fórmula WCAG 2.1) e **incumple AA** (4.5:1 para texto
  < 18px). CA-4 convierte `sin dato` en un estado protagonista y permanente
  (Gemini), así que deja de ser un caso de borde. **Subir a `--text-dim
  #8B949E` → 5.62:1.** Aplica a `.mz-qm-cell.mz-qm-nodata .mz-qm-pct`.
  Los tres colores de estado ya cumplen AA sobre `#161B22`
  (ok 6.81:1 · warn 6.85:1 · bad 5.16:1): no se tocan.
- **R-4 · La ausencia nunca se pinta como 0%.** `sin dato` y `pendiente` no
  dibujan barra. Una barra vacía se lee como «0% consumido» = luz verde falsa y
  habilita una decisión de pacing errónea. Es el mismo criterio fail-closed que
  CA-4 exige en el dato.
- **R-5 · Ausencia explicada.** Cada `sin dato` conserva su motivo específico en
  el tooltip (`QUOTA_SINDATO_REASON`), para que el operador no lo lea como un
  bug del dashboard. Los motivos deben actualizarse: los de Cerebras/NVIDIA hoy
  dicen «cuando estén conectados», y esta historia justamente los conecta.
- **R-6 · Densidad y layout intactos.** No se agregan componentes, íconos ni
  columnas. Se preservan IDs DOM (`mz-qm-<key>-<slot>-*`), tipografía tabular,
  transición de 400 ms y dimensiones. El panel sigue siendo de apoyo: no compite
  con «Ahora · En Ejecución» ni con «Issues de la Ola».
- **R-7 · Coherencia del contador de proveedores sanos.** `mz-sig-healthy`
  cuenta proveedores con cuota utilizable. Con polaridad consumida, «sano» es
  `consumido < 100` **y** dato fresco. Un proveedor en `sin dato` **no** cuenta
  como sano (no se puede afirmar que lo esté).
- **R-8 · Texto por `textContent`.** Ningún dato de proveedor se interpola como
  HTML.

## Verificación visual esperada (fase aprobación)

- Las cinco filas presentes, ninguna rotulada «disponible».
- Número, barra, color, `title` y `aria-label` coincidentes en la misma celda.
- Gemini en `sin dato` con motivo, sin barra, con contraste AA.
- Ausencia total de KPIs de cuota general en el home visible **y** de su
  hidratación por JS.
