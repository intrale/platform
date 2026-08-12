# Calculadora ETA por ola e issue (`lib/eta-wave.js`)

**Issue origen:** [#3492](https://github.com/intrale/platform/issues/3492) — Spike #3378 H4
**Módulo:** `.pipeline/lib/eta-wave.js`
**Estado:** producción
**Consumidores:** `.pipeline/dashboard.js` (cache + endpoint `/api/dash/ola-eta`), `.pipeline/views/dashboard/home.js` (panel "Ola actual · ETA").

---

## Por qué existe

El pipeline V3 trabaja en olas de hasta 3 agentes concurrentes. El operador necesita visibilidad predictiva del tiempo que falta para que la ola actual termine, basado en datos históricos reales del propio pipeline, no en estimaciones manuales.

Esta calculadora computa percentiles **p50 / p75 / p90** de duración por issue y agregados por ola, leyendo dos fuentes complementarias del filesystem del pipeline:

1. **Markers FS** de las carpetas `procesado/` y `listo/` de cada fase (`ctimeMs - birthtimeMs` = duración real del agente en esa fase).
2. **`metrics-history.jsonl`** leído por streaming para `rebounceRate` agregado y metadatos del sistema (snapshots, rango temporal).

El módulo **NO** consulta GitHub, **NO** invoca al LLM, **NO** escribe nada en el FS. Es 100 % offline y read-only.

---

## API pública

Las cuatro funciones expuestas, con ejemplos.

### `analyzeHistoricalMetrics(): Promise<HistoricalStats>`

Análisis agregado del histórico del pipeline. Cache TTL 30 s in-memory.

```js
const { analyzeHistoricalMetrics } = require('./lib/eta-wave');

const stats = await analyzeHistoricalMetrics();
// {
//   bySize: {
//     S: { avgTime: 20, stddev: 5, samples: 12 },
//     M: { avgTime: 50, stddev: 12, samples: 28 },
//     L: { avgTime: 100, stddev: 30, samples: 8 }
//   },
//   rebounceRate: 0.18,         // 0..1 — proxy de issues que rebotan a dev
//   avgPhaseTime: {             // minutos por fase del pipeline
//     analisis: 5, criterios: 5, sizing: 3, validacion: 5,
//     dev: 25, build: 8, verificacion: 4, linteo: 2,
//     aprobacion: 3, entrega: 2
//   },
//   _meta: { snapshotCount, tsRange, jsonl, sortedBySize }   // diagnóstico
// }
```

- `samples = 0` indica que el bucket cayó al fallback hardcodeado (`DEFAULT_BY_SIZE`). La vista lo trata como señal de "estimación con poca muestra" (CA-22).
- `rebounceRate` se calcula primero desde JSONL (deltas de `byFase.dev.pending`); fallback a `totalRejected / totalProcessed` de markers FS si el JSONL aún no tiene suficiente señal.

### `calculateIssueETA(issueNumber, size): Promise<IssueETA>`

ETA puntual para un issue dado su tamaño canónico.

```js
const { calculateIssueETA } = require('./lib/eta-wave');

const eta = await calculateIssueETA(3492, 'medium');
// {
//   p50: 45,         // mediana en minutos
//   p75: 62,
//   p90: 85,
//   samples: 24,     // 0 si cayó al fallback default
//   sizeCanonical: 'M',
//   sizeLabel: 'medio'
// }
```

- Si `size` es inválido (ej. `'XL'`, `null`, `undefined`), cae al canónico `M` sin crashear (CA-6).
- Si `issueNumber` es inválido, el cálculo procede igual ignorándolo (el percentil depende del size, no del número).

### `calculateOlaETA(issueList, concurrency?): Promise<OlaETA>`

ETA agregada de una ola de issues con factor de paralelismo.

```js
const { calculateOlaETA } = require('./lib/eta-wave');

// Lista mixta: enteros o objetos {number, size}.
const ola = await calculateOlaETA([3492, { number: 3500, size: 'small' }], 3);
// {
//   totalP50: 75,        // ceil(sumP50 / concurrency)
//   totalP75: 100,
//   totalP90: 140,
//   byIssue: {
//     3492: { p50:45, p75:62, p90:85, samples:24, sizeCanonical:'M', sizeLabel:'medio' },
//     3500: { p50:20, p75:24, p90:28, samples:8,  sizeCanonical:'S', sizeLabel:'simple' }
//   },
//   concurrencyUsed: 3
// }
```

- **Modelo de paralelismo:** bin-packing simple `total = ceil(sum / concurrency)`. Es una cota superior conservadora cuando los tiempos son comparables; el dashboard lo etiqueta como "estimación", no como planning exacto.
- **Cap de inputs (CA-7/CA-8):** `concurrency` clamp a `[1, 50]` con default 3; `issueList` truncado a 1000 items con warning.
- **Precedencia del size por item:**
  1. `item.size` si vino explícito.
  2. `getIssueSize(issueNumber)` (lee `scripts/roadmap.json`).
  3. Fallback `M`.

### `mapSizeToCanonical(rawValue): { canonical, label }`

Mapeo público del vocabulario aceptado al canon S/M/L.

```js
const { mapSizeToCanonical } = require('./lib/eta-wave');

mapSizeToCanonical('size:large');   // { canonical:'L', label:'grande' }
mapSizeToCanonical('M');            // { canonical:'M', label:'medio' }
mapSizeToCanonical('xl');           // { canonical:'M', label:'medio' }  (fallback)
mapSizeToCanonical(null);           // { canonical:'M', label:'medio' }  (fallback)
```

---

## Mapeo canónico de size (Decisión D3)

| Canónico | Label (UI) | Vocabulario aceptado                                 |
|----------|------------|------------------------------------------------------|
| `S`      | `simple`   | `s`, `simple`, `small`, `size:simple`, `size:small`  |
| `M`      | `medio`    | `m`, `medio`, `medium`, `size:medio`, `size:medium`  |
| `L`      | `grande`   | `l`, `grande`, `large`, `size:grande`, `size:large`  |

- Cualquier otro valor (incluyendo `null`, `''`, `'XL'`, número) cae a `M` con label `medio`.
- El label en español es el que la UI muestra; el canónico es la clave de bucket interno.
- Misma normalización se aplica al leer `roadmap.json` (`scripts/roadmap.json → sprints[*].stories[*].effort`).

---

## Estructura del JSONL consumido

El módulo consume `.pipeline/metrics-history.jsonl` por streaming (CA-12) — **nunca con `readFileSync`** para evitar OOM si el archivo crece a varios MB.

Cada línea del JSONL es un snapshot del estado del pipeline en un instante:

```json
{
  "ts": 1716800000000,
  "byFase": {
    "dev":          { "pending": 3, "working": 2 },
    "build":        { "pending": 1, "working": 1 },
    "verificacion": { "pending": 0, "working": 1 }
  }
}
```

Lo que el módulo extrae de cada snapshot:

- **`ts`** (number): timestamp del snapshot. Usado para `tsRange` (primer/último visto).
- **`byFase.{fase}.pending` / `.working`** (number): contadores por fase. El módulo usa los deltas entre snapshots consecutivos para detectar transiciones `verificacion/build → dev` (proxy de rebote).

Reglas de defensa:

- Líneas que no parsean (truncadas, corruptas) se cuentan en `skipped` y se ignoran (CA-9). No abortan el stream.
- Snapshots sin `ts` numérico o sin `byFase` objeto se ignoran silenciosamente.
- Si el archivo no existe, el resultado es `{ ok:false, processed:0, skipped:0 }` y el cálculo cae a fallback (ver abajo).

**El JSONL no contiene `issueNumber`** — por eso los percentiles per-size salen de markers FS, no del JSONL (ver Decisión D2 abajo).

---

## Comportamiento ante archivo ausente

| Recurso ausente                              | Efecto                                                                                        |
|----------------------------------------------|-----------------------------------------------------------------------------------------------|
| `.pipeline/metrics-history.jsonl`            | `rebounceRate` cae al cálculo basado en markers FS (`totalRejected / totalProcessed`).        |
| Markers FS también vacíos                    | `rebounceRate = 0.15` (`DEFAULT_REBOUNCE_RATE`).                                              |
| `scripts/roadmap.json`                       | `getIssueSize(n)` devuelve `M` para todos los issues no provistos vía API.                    |
| Bucket de size sin samples                   | `bySize[sz] = { ...DEFAULT_BY_SIZE[sz], samples: 0 }`, badge "poca muestra" en UI (CA-22).    |
| Todo ausente (instalación fresca)            | Toda la API devuelve valores razonables del `DEFAULT_*` sin crashear (CA-11).                 |

Ningún error del FS aborta la operación. Todo está envuelto en `try/catch` o usa `fs.existsSync` defensivo.

---

## Decisión D2: fuente híbrida (markers FS + JSONL)

El módulo combina dos fuentes con scopes complementarios. Esto fue cerrado en la fase de criterios del issue #3492 (revisado por guru y PO) por la siguiente razón:

| Métrica                                  | Fuente principal | Fuente fallback                  | Por qué                                                                                  |
|------------------------------------------|------------------|----------------------------------|------------------------------------------------------------------------------------------|
| `bySize.{S,M,L}.avgTime/stddev/samples`  | Markers FS       | `DEFAULT_BY_SIZE`                | El JSONL no tiene `issueNumber`. Los markers FS sí (filename `{issue}.{skill}`).         |
| `avgPhaseTime[fase]`                     | Markers FS       | `DEFAULT_PHASE_TIME_MIN`         | La duración real por fase sale del `ctime - birthtime` de archivos en `procesado/`.      |
| `rebounceRate`                           | JSONL            | Markers FS (`rejected/processed`)| Los deltas inter-snapshot detectan rebotes a `dev`. Si el JSONL es pobre (snapshots < 20), markers FS aportan señal estable. |
| `_meta.snapshotCount`, `tsRange`         | JSONL            | (n/a)                            | Metadata operativa del JSONL.                                                            |

**Trade-offs explícitos:**

- Markers FS son confiables para per-issue pero requieren que el pipeline ya haya procesado al menos algunos issues del size pedido para tener samples no triviales.
- JSONL escala mejor (snapshot-based, no per-file) pero carece de granularidad per-issue por diseño.
- Combinar ambas fuentes da resultados estables aún con pipeline joven (fallback a defaults) o con JSONL ausente (pre-merge de #3012).

---

## Performance y resource budget

- **Cache TTL:** 30 s in-memory (`ANALYSIS_CACHE_TTL_MS`). Una llamada cada 30 s satura el cálculo; las llamadas dentro del TTL son `O(1)`.
- **Markers FS:** lectura `readdirSync` + `statSync` por archivo. En pipeline maduro (~1000 archivos procesados) el escaneo completo toma < 200 ms en Windows local.
- **JSONL streaming:** `fs.createReadStream` + `readline`. Memoria constante O(1) sin importar el tamaño del archivo. Procesa ~20k líneas/segundo en hardware típico.
- **No dependencias npm nuevas (CA-17):** sólo `fs`, `path`, `readline` de stdlib.
- **No `eval` / `new Function` / `vm` (CA-13):** confirmado, cero matches en código.

---

## Integración con dashboard

El consumo desde el dashboard sigue el patrón fire-and-forget cacheado:

```js
// .pipeline/dashboard.js
let etaWaveLib = null;
try { etaWaveLib = require('./lib/eta-wave'); } catch { /* opcional */ }

// getPipelineState() es sync, calculateOlaETA es async → cache TTL 30s.
function _scheduleOlaETARefresh(state) {
  if (!etaWaveLib) return;
  // ... (programa Promise.resolve().then(async () => await etaWaveLib.calculateOlaETA(...)))
}

function getPipelineState() {
  // ... (escaneo FS, construcción de state.issueMatrix)
  _scheduleOlaETARefresh(state);
  state.olaETA = _olaETACache;   // null en el primer tick, cacheado después
  return state;
}
```

El endpoint `/api/dash/ola-eta` (en `lib/dashboard-routes.js`) lee `state.olaETA` y lo devuelve como JSON. La vista `views/dashboard/home.js` lo consume con polling 30 s y renderiza:

- **CA-21:** labels en español (`simple`, `medio`, `grande`).
- **CA-22:** badge "estimación con poca muestra" si `samples < 5` agregado o en cualquier size en uso.
- **CA-23:** formato de minutos `45m` / `1h 2m` calculado en `fmtMin()` del cliente, no en la librería.

---

## Tests

`node --test .pipeline/lib/__tests__/eta-wave.test.js` — 24 tests, cubren:

- API pública completa con happy path y edge cases.
- Streaming del JSONL con líneas truncadas / corruptas (`skipped` counter).
- Mapeo de size con vocabulario completo + fallback.
- Validación defensiva de inputs (issueNumber/size/concurrency inválidos no crashean).
- Read-only del FS (cero `fs.write*` en el módulo).
- Cap de `issueList` (1000 items max).
- Comportamiento con archivos ausentes (markers vacíos + JSONL ausente → defaults sin error).

---

## Operación

- **Refrescar manualmente** (sin esperar al cache TTL):

```bash
node -e "require('./.pipeline/lib/eta-wave').analyzeHistoricalMetrics().then(s => console.log(JSON.stringify(s, null, 2)));"
```

- **Inspeccionar la ETA de la ola actual**:

```bash
curl -s http://127.0.0.1:3200/api/dash/ola-eta | jq
```

- **Override de root del pipeline para tests/dry-run** (variable de entorno):

```bash
PIPELINE_ROOT_OVERRIDE=/tmp/fixture-pipeline node -e "..."
```

---

## Higiene de la serie de velocidad de la ola (#4886)

La velocidad de la ola (`calculateWaveVelocityETA`, `.pipeline/lib/eta-wave.js`) se
persiste entre olas en `.pipeline/wave-velocity-history.jsonl`
(`.pipeline/lib/wave-velocity-history.js`) para que una ola nueva herede una
estimación previa (#4532). Esa serie se contaminaba con los **saltos artificiales**
de los resets/restores: al re-hidratarse el espejo local, el avance salta de golpe
(18% → 97% entre dos snapshots) y esa pendiente gigante —positiva, así que pasaba
los filtros de #4532— entraba al store como si fuera ritmo real. El promedio
resultante daba ~307 %/hora sobre una ola quieta, y la ETA derivada de ese número
mostraba tiempos absurdos ("2 minutos").

Defensas (todas activas a la vez):

| Punto | Regla | Dónde |
|-------|-------|-------|
| Medición | Los saltos discontinuos se **neutralizan con un offset** (`_repairDiscontinuities`), no descartan el tramo: el avance real anterior y posterior al restore se conserva | `eta-wave.js` |
| Escritura | `recordSample()` rechaza toda muestra > techo (el store no se re-contamina en el próximo reinicio) | `wave-velocity-history.js` |
| Lectura | `readSamples()` ignora las muestras implausibles ya persistidas (higiene retroactiva, sin borrar el archivo) | `wave-velocity-history.js` |
| Poda | `pruneStore()` las elimina del disco (saneo permanente) | `wave-velocity-history.js` |
| Consumo | `getHistoricalVelocity()` devuelve `null` si el promedio queda por encima del techo | `wave-velocity-history.js` |

**Techo de plausibilidad**: `WAVE_VELOCITY_MAX_PCT_PER_MIN`, default **2 %/min**
(= 120 %/hora). La velocidad real proviene de cierres de issues: con N issues de la
ola, cerrar uno mueve `100/N` puntos y los cierres llegan de a pocos por hora.
2 %/min implicaría completar una ola entera en 50 minutos — un orden de magnitud
por encima de cualquier ritmo observado. Ambos umbrales son configurables por env
(un valor inválido cae al default; nunca rompe el pipeline).

**Degradación honesta**: con la ola quieta (snapshots suficientes pero sin pendiente
positiva) el cálculo devuelve `{source:'fallback', reason:'non-positive-velocity'|'discontinuous-jump'}`
en vez de caer al promedio histórico. El banner muestra la leyenda
`sin datos suficientes` (#4325) y el ETA `—`, nunca un tiempo falso. El histórico
sigue reservado a la ola **nueva** sin serie propia (`insufficient-snapshots` /
`delta-too-small`), que es el caso para el que se creó en #4532.

### Granularidad de la señal: por qué el criterio va en quantums y no en %/min

`avancePct` es **entero** y la cadencia real de `wave-progress.jsonl` es **~33 s**
(mediana medida sobre la ola 8: 0,55 min). La señal está **cuantizada** en escalones
de `100/N` puntos: en una ola de 37 issues, cerrar **uno solo** mueve 2,7 puntos de
golpe, que instantáneamente son **4,9 %/min** — 2,5× el techo físico. Un criterio de
plausibilidad aplicado **tramo a tramo** clasifica entonces todo cierre real como
"salto artificial": hace falta `100/N ≤ 2 × 0,55`, o sea `N ≥ 91` issues, para que un
cierre pase el techo. En cualquier ola de menos de ~91 issues se descartarían **todos**.

Por eso el cálculo trabaja en dos escalas distintas:

| Qué | Escala | Umbral |
|-----|--------|--------|
| Detectar el escalón artificial | Tramo **crudo** (~33 s), donde la discontinuidad es observable | `WAVE_MAX_STEP_ISSUES` (4) × quantum `100/N` de la ola — 10,8 puntos en la ola 8. Sin `N` resoluble cae al absoluto `WAVE_VELOCITY_MAX_STEP_PCT` |
| Medir el ritmo | Pendiente **agregada** sobre toda la ventana efectiva (mínimo `WAVE_VELOCITY_MIN_SPAN_MS` = 15 min, típicamente las 3 h de `WAVE_VELOCITY_WINDOW_MS`) | Techo físico `WAVE_VELOCITY_MAX_PCT_PER_MIN`, que a esa escala sí es una magnitud con sentido |

El filtro de discontinuidad es **simétrico** (`Math.abs`): la caída de −94 puntos que
produce el espejo al vaciarse es tan artificial como la subida de +79 posterior.

**Estimador agregado, no EWMA por tramo.** #4734 promediaba las pendientes por tramo
con un EWMA para que la velocidad "no saltara con cada snapshot". La causa de ese
salto era la **ventana angosta** (`WAVE_VELOCITY_WINDOW` = 5 snapshots ≈ 2,2 min a la
cadencia real), no el estimador. Al ensancharla a las 3 h de `WAVE_VELOCITY_WINDOW_MS`
la pendiente agregada ya es estable —un cierre nuevo la mueve ~1/N de su valor— y
además es la única correcta sobre una señal en escalones: el EWMA por tramo pesa cada
escalón independientemente de su duración, así que sobreestima cuando el último tramo
tuvo un cierre y subestima cuando no. `WAVE_VELOCITY_WINDOW` quedó **sin uso**.

---

## Avance de ola ponderado por tamaño (#5836)

`avancePct` — la señal que alimenta toda la velocidad y el ETA de esta doc — dejó de
ser un **conteo plano de issues** y pasa a ser un **promedio ponderado por `size:*`**:

```
totalPct = Σ(peso_i × pct_i) / Σ(peso_i)          // wave-weight.js
```

### Qué problema resuelve

Con conteo plano cada issue pesaba `1`. Al partir un issue, los hijos se sumaban a la
ola y el padre quedaba abierto y dentro de ella, así que **el mismo trabajo pasaba a
ocupar `1 + N` posiciones del denominador**. Medido el 2026-08-11 en la ola 9.4: 4
cierres y 18 altas por splits movieron la ola de 95/50 a 113/54 y el indicador **bajó
de 57 % a 52 %** sin que se perdiera una sola unidad de trabajo. La cascada
multiplicaba: 17 entradas por 1 issue original.

Eso rompía la lectura del indicador y la ETA derivada, y penalizaba justo la práctica
que se quiere incentivar — partir issues grandes.

### Reglas

| Regla | Detalle |
|---|---|
| Peso por tamaño | `S=1`, `M=2`, `L=5`. Se reusa el `SIZE_VOCAB` de `eta-wave.js`, así que **`size:large` y `size:grande` colapsan al mismo bucket `L`** (ambos conviven en la ola: 10 y 6 issues) |
| Peso default | `M` (2) para los issues sin ningún `size:*`. **No es un caso borde: 36 de 116 issues (31 %) de la ola medida no declaran tamaño**, así que el default gobierna casi un tercio del denominador. El renderer lo hace visible con el sufijo `N sin estimar` |
| Conservación ante split | El peso de un subárbol es **siempre el peso propio de su raíz**, repartido entre las hojas en proporción a su `size:*`. Partir es neutro por construcción, no por aproximación |
| Padre cubierto | Un padre cuyo trabajo ya vive en hijos presentes en la ola **pesa 0**; su avance es el agregado ponderado de los hijos. Aplica recursivamente: en una cascada sólo las hojas aportan |
| Parentesco | Se deriva del **título canónico `[Split de #N]`** (`split-orphan-reconciler.parentOfSplitOrphan`), NO de `blockDependencies`: `authorization_ttls` está vacío en producción, así que esa fuente detectaría **cero** padres y el doble conteo persistiría |
| Re-estimación | Si los hijos declaran más peso que el padre, el denominador **no se infla**: se reparte proporcionalmente y el exceso queda en `weightInflations` como re-estimación, no como retroceso de la ola |

Verificado sobre la ola 9.4 real (116 issues): **24 padres** detectados y puestos en
peso 0, profundidad máxima **5 niveles**, denominador ponderado 124 contra 116 del
conteo plano.

### Corte de serie, no recálculo

Los registros de `wave-progress.jsonl` llevan ahora tres campos **opcionales y
aditivos** (todos primitivos, SEC-2 intacto): `totalWeight`, `issueCount` y
`formulaV` (`1` = conteo plano, `2` = ponderado).

Los snapshots previos **no se recalculan**: nunca guardaron el peso, así que
reconstruirlo sería inventar datos. `classifyProgressDelta` detecta el cambio de
fórmula entre dos puntos y lo reporta como `series-break` en vez de atribuirle una
causa. Los registros viejos se siguen leyendo sin migración.

### Por qué el peso total se cuantiza

El reparto proporcional divide y multiplica en punto flotante: un padre de peso 5
repartido entre 3 hijos vuelve a sumar `4.999999999999999`. El residuo es irrelevante
para el porcentaje (entero), pero **no** aguas abajo: `classifyProgressDelta` decide
"el denominador creció" con una comparación, y un residuo de `+4e-15` alcanzaba para
reportar un split perfectamente neutro como "caída por altas". Por eso el peso total
se cuantiza a 6 decimales al publicarse y la comparación usa `WEIGHT_EPSILON = 1e-6`.

### Distinguir una caída por altas de un retroceso

Con dos `avancePct` sueltos el caso era **indecidible**. Con el peso persistido,
`classifyProgressDelta(prev, curr)` devuelve `altas` (bajó el % pero creció el
denominador), `retroceso` (bajó sin crecer), `avance`, `estable`, `series-break` o
`unknown`. Cuando la causa es una alta, el header de `/wave` lo anota en la **línea 2**
(itálica, discreta — no compite con el `%` ni el ETA, que son los valores accionables
en bold):

```
_116 issues · 54 cerrados · 62 activos · 36 sin estimar · −5 pp por 18 altas, no retroceso_
```

El texto porta la señal completa —magnitud, unidad (`pp`, no `%`) y causa—; no depende
de color ni de emoji.

---

## Limitaciones conocidas

- El modelo de paralelismo `ceil(sum / concurrency)` es una cota superior. Cuando los tiempos por issue varían mucho, el agregado puede sobreestimar. No es planning exacto; el dashboard lo declara así en la UI (subtítulo "concurrency 3").
- Los markers FS sólo tienen el filename `{issue}.{skill}`; no exponen el rebote individual del issue dentro de una misma fase. El rebote se detecta como flag binaria (rejected/not) a nivel marker.
- Si el operador rebobina el pipeline (rewind manual de archivos a fases anteriores), los `ctime` se actualizan y los samples pueden desviarse hacia arriba. No es un caso operativo normal; documentado acá por completitud.

---

## Historial

- **2026-08-12** — Issue #5836. El avance de ola contaba issues sin peso, así que partir uno hundía el porcentaje aunque no se hubiera perdido trabajo (ola 9.4: 57 % → 52 % por 18 altas de split). Se pasó a promedio ponderado por `size:*` con conservación de peso ante splits (`wave-weight.js`), parentesco derivado del título `[Split de #N]`, y se extendió `wave-progress.jsonl` con `totalWeight`/`issueCount`/`formulaV` para poder distinguir una caída por altas de un retroceso. Corte de serie explícito, sin recálculo del histórico. Verificado sobre la ola real: 24 padres puestos en peso 0, 5 niveles de cascada, denominador 124 vs 116.

- **2026-07-23** — Issue #4886. Velocidad/ETA de la ola falseadas por la serie histórica envenenada con saltos de reset/restore. Se agregó el techo de plausibilidad (escritura + lectura + poda), el descarte de tramos discontinuos y la degradación honesta con la ola quieta. Medición sobre el store real: 112 de 761 muestras eran picos artificiales (máximo 78,7 %/min ≈ 4723 %/hora); el promedio de las últimas 20 pasó de 306,8 %/hora a 51,5 %/hora.

- **2026-07-23 (rev-1)** — Rebote de review sobre #4886: el fix anterior sobre-corregía y dejaba la métrica inutilizable. El techo de 2 %/min aplicado **tramo a tramo** quedaba por debajo de la granularidad de la señal (1 cierre = 4,9 %/min instantáneos), y la ventana de 5 snapshots medía sólo 2,2 min, así que "sin ritmo medible" pasó a ser el estado permanente. Se movió el criterio de discontinuidad a **quantums de la ola**, se hizo **simétrico**, se reemplazó el descarte de tramos por **reparación con offset**, y la medición pasó a la **pendiente agregada** sobre la ventana temporal. Replay A/B sobre las 45 h reales de la ola 8 (1250 evaluaciones, histórico limpio en ambos lados): número visible **4,8 % → 44,7 %**; momentos con avance real en los últimos 30 min sin número en pantalla **88,8 % → 36,9 %**; máximo mostrado 26,6 %/hora (bajo el techo, sin recorte). Los 198 huecos restantes son honestos: 138 con avance neto negativo en 3 h (reset / `wave add`), 47 con la ola plana 3 h, 14 en la ventana del salto de re-hidratación (CA-5 lo exige) y 3 en el arranque de la ola (van al histórico).

- **2026-05-25** — Issue #3492 cerrado. Librería + tests entregados en commit `6b064aee`. Integración (dashboard, home, doc) entregada en este rebote (rebote_numero 3, motivo "entrega incompleta vs sizing"). Verificado contra CA-1..CA-24.
