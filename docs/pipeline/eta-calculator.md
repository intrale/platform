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

## Limitaciones conocidas

- El modelo de paralelismo `ceil(sum / concurrency)` es una cota superior. Cuando los tiempos por issue varían mucho, el agregado puede sobreestimar. No es planning exacto; el dashboard lo declara así en la UI (subtítulo "concurrency 3").
- Los markers FS sólo tienen el filename `{issue}.{skill}`; no exponen el rebote individual del issue dentro de una misma fase. El rebote se detecta como flag binaria (rejected/not) a nivel marker.
- Si el operador rebobina el pipeline (rewind manual de archivos a fases anteriores), los `ctime` se actualizan y los samples pueden desviarse hacia arriba. No es un caso operativo normal; documentado acá por completitud.

---

## Historial

- **2026-05-25** — Issue #3492 cerrado. Librería + tests entregados en commit `6b064aee`. Integración (dashboard, home, doc) entregada en este rebote (rebote_numero 3, motivo "entrega incompleta vs sizing"). Verificado contra CA-1..CA-24.
