// =============================================================================
// eta-wave.js — Calculadora ETA probabilística por ola e issue (#3492 / Spike #3378 H4).
//
// Módulo Node.js puro que computa estimaciones p50/p75/p90 a partir de:
//   - Markers del filesystem del pipeline V3 (ctime - birthtime de los archivos
//     en `procesado/`/`listo/` de cada fase). Fuente per-issue/per-size.
//   - `.pipeline/metrics-history.jsonl` leído por streaming (CA-12). Fuente
//     agregada a nivel sistema (proxy de `rebounceRate` y metadatos).
//
// Decisiones de diseño (cerradas en criterios — ver #3492):
//   - D1: el módulo se llama `eta-wave.js` para NO colisionar con `lib/eta.js`
//         (#2895). Ambos coexisten con scopes distintos.
//   - D2: fuente híbrida. Markers FS para per-issue/per-size, JSONL para
//         agregados sistémicos. `metrics-history.jsonl` NO tiene issueNumber,
//         por eso los percentiles per-size salen de markers FS.
//   - D3: tabla canónica de size (S/M/L) con etiquetas en español
//         (simple/medio/grande) y orden de precedencia explícito.
//
// Contratos inquebrantables del módulo:
//   - Read-only sobre el FS (CA-14): cero fs.writeFile*, fs.appendFile*,
//     fs.createWriteStream.
//   - Sin eval / new Function / vm.runInNewContext (CA-13).
//   - Sin nuevas dependencias npm (CA-17): solo `fs`, `path`, `readline`.
//   - JSONL leído con `fs.createReadStream` + `readline` (CA-12); NUNCA
//     `fs.readFileSync` sobre `.pipeline/metrics-history.jsonl`.
//   - Output sin paths absolutos, hostnames ni usernames (CA-15).
//   - Logs solo agregados (counts), nunca contenido raw del JSONL (CA-16).
//   - Validación defensiva de inputs (CA-5..CA-8); valores inválidos caen a
//     fallback documentado, NO crashea.
//
// API pública: 4 funciones — ver JSDoc de cada una.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// #3517 — infra de scanning de markers extraída a `lib/eta-markers.js` para
// compartir lógica con `lib/eta.js` y `dashboard.js`. Las APIs públicas de
// este módulo (calculateIssueETA, calculateOlaETA, analyzeHistoricalMetrics,
// mapSizeToCanonical, getIssueSize) no cambian — solo dejamos de duplicar
// el walk del FS y los filtros de duración.
const etaMarkers = require('./eta-markers');
// #4532 — Serie histórica de velocidad cross-ola. Alimenta la estimación previa
// de una ola nueva (sin snapshots propios) y persiste las muestras medidas.
const velocityHistory = require('./wave-velocity-history');
// #4588 — Métrica de espera de operador. Balde `waitOperatorMin` del lead time,
// derivado de audit logs append-only (no gameable). Read-only, no rompe CA-14.
const operatorWaitLib = require('./operator-wait');
// #4734 — Ventanas de reposo de proveedores para el ETA por reloj de pared.
// `providerSchedule.getProviderSchedule('anthropic')` da la ventana OFF; los
// helpers puros de `rest-mode-window` calculan solapamiento OFF sin reparsear
// horarios ni manejar timezone/DST a mano. Se cargan de forma perezosa/tolerante:
// si el módulo no está disponible, el ETA degrada a reloj de pared sin descuento.
let providerSchedule = null;
let restModeWindow = null;
try { providerSchedule = require('./provider-schedule'); } catch { providerSchedule = null; }
try { restModeWindow = require('./rest-mode-window'); } catch { restModeWindow = null; }

// ─── Constantes públicas ───────────────────────────────────────────────────

const SIZE_VOCAB = {
    S: ['s', 'simple', 'small', 'size:simple', 'size:small'],
    M: ['m', 'medio', 'medium', 'size:medio', 'size:medium'],
    L: ['l', 'grande', 'large', 'size:grande', 'size:large'],
};
const SIZE_LABELS = { S: 'simple', M: 'medio', L: 'grande' };

// Fases conocidas del pipeline V3. Si llega una fase nueva no listada, igual
// la tomamos para `avgPhaseTime` (no es lista cerrada en runtime).
const KNOWN_FASES = [
    'analisis', 'criterios', 'sizing',
    'validacion', 'dev', 'build', 'verificacion', 'linteo',
    'aprobacion', 'entrega',
];

// Estimaciones por defecto cuando no hay histórico (CA-11). En minutos.
// Aproximaciones razonables observadas en el pipeline en operación normal.
const DEFAULT_PHASE_TIME_MIN = {
    analisis: 5, criterios: 5, sizing: 3, validacion: 5,
    dev: 25, build: 8, verificacion: 4, linteo: 2,
    aprobacion: 3, entrega: 2,
};

// Distribución por defecto por size cuando no hay samples históricos del size
// solicitado. Valores en minutos, derivados conservadoramente.
const DEFAULT_BY_SIZE = {
    S: { avgTime: 20, stddev: 5 },
    M: { avgTime: 50, stddev: 15 },
    L: { avgTime: 100, stddev: 30 },
};

// Tasa de rebote por defecto cuando no hay histórico ni en JSONL ni en markers.
const DEFAULT_REBOUNCE_RATE = 0.15;

// Cap de elementos aceptados en issueList (CA-8 — defensa anti-DoS).
const ISSUE_LIST_MAX = 1000;

// Cap de concurrency (CA-7 — defensa contra valores absurdos).
const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 50;
const CONCURRENCY_DEFAULT = 3;

// Límites de duración válida por marker. Re-exportados desde `eta-markers.js`
// (#3517) — son la fuente única de verdad para los tres consumidores que antes
// duplicaban estos literales (eta-wave, eta, dashboard).
const MIN_VALID_DURATION_MS = etaMarkers.MIN_VALID_DURATION_MS;
const MAX_VALID_DURATION_MS = etaMarkers.MAX_VALID_DURATION_MS;

// Cache TTL del análisis histórico (sigue el patrón de waves.js).
const ANALYSIS_CACHE_TTL_MS = 30 * 1000;

// ─── Constantes de velocidad de ola (#4039) ────────────────────────────────
// Mínimo de snapshots de la ola actual para proyectar por velocidad. Por
// debajo → fallback (CA-4). Δt mínimo entre el primero y el último de la
// ventana para no proyectar sobre ruido / división por ~0.
const WAVE_MIN_SNAPSHOTS = 2;
const WAVE_MIN_DELTA_MS = 60 * 1000;
// Ventana de suavizado (media móvil): se toman los últimos N snapshots de la
// ola; si hay menos, se usan los que haya (≥ WAVE_MIN_SNAPSHOTS).
// #4734 — LEGACY: la ventana pasó de contar snapshots a ser TEMPORAL (ver
// WAVE_VELOCITY_WINDOW_MS). Se conserva la constante como piso mínimo de
// muestras para el fallback y por compat de tests/exports existentes.
const WAVE_VELOCITY_WINDOW = 5;

// #4734 — Ventana TEMPORAL de reloj de pared para medir velocidad. En vez de
// "últimos N snapshots" (que mide tiempo de cómputo del agente y salta si el
// muestreo es irregular), se toman las muestras caídas dentro de las últimas
// 2.5 h de reloj de pared. Esto hace la velocidad %/hora comparable entre olas
// y estable frente a la densidad de muestreo.
const WAVE_VELOCITY_WINDOW_MS = 2.5 * 3600000; // 2.5 h
// Factor de suavizado del EWMA sobre los slopes por tramo de la ventana. α alto
// pondera más el tramo reciente sin descartar el histórico de la ventana; evita
// el salto de la pendiente punta-a-punta ante un único snapshot nuevo.
const WAVE_VELOCITY_EWMA_ALPHA = 0.5;
// Tope de iteraciones al re-expandir el horizonte por ventanas OFF encadenadas
// (proyección hacia adelante). Corta y cae a fallback si no converge.
const WAVE_REST_PROJECTION_MAX_ITERS = 8;
// Máximo de segmentos que barre `_offOverlapMs` sobre un rango; backstop de
// loop acotado (una ventana de días tiene pocas transiciones).
const WAVE_OFF_SCAN_MAX_SEGMENTS = 500;

// #4532 — Throttle de registro de muestras de velocidad en el histórico cross-ola.
// La velocidad se mide en cada tick (~30s dashboard + /wave status). Sin throttle
// el store se llenaría de casi-duplicados. Registramos como mucho una muestra cada
// 5 min por proceso (in-memory) — suficiente para un promedio histórico estable.
const VELOCITY_SAMPLE_MIN_INTERVAL_MS = 5 * 60 * 1000;
let _lastVelocitySampleTs = 0;

// ─── Paths (con override por env para tests) ───────────────────────────────

function pipelineRoot() {
    if (process.env.PIPELINE_ROOT_OVERRIDE) return process.env.PIPELINE_ROOT_OVERRIDE;
    // .pipeline/lib/eta-wave.js → root = ../..
    return path.join(__dirname, '..', '..');
}

function pipelineDir() { return path.join(pipelineRoot(), '.pipeline'); }
function metricsHistoryPath() { return path.join(pipelineDir(), 'metrics-history.jsonl'); }
// #4039 — serie temporal de avance de ola. Path FIJO; este módulo SOLO lee
// (el writer vive en `lib/wave-progress.js`).
function waveProgressPath() { return path.join(pipelineDir(), 'wave-progress.jsonl'); }
function roadmapPath() { return path.join(pipelineRoot(), 'scripts', 'roadmap.json'); }

// ─── Validación de inputs (CA-5..CA-8) ─────────────────────────────────────

function isValidIssueNumber(n) {
    return typeof n === 'number' && Number.isInteger(n) && Number.isFinite(n) && n > 0;
}

function isValidConcurrency(c) {
    return typeof c === 'number' && Number.isInteger(c) && c >= CONCURRENCY_MIN && c <= CONCURRENCY_MAX;
}

// ─── Mapeo canónico de size (D3 / CA-6) ────────────────────────────────────

/**
 * Mapea un valor crudo de tamaño (label GitHub, roadmap, letra) al canon S/M/L.
 *
 * Vocabulario aceptado:
 *   S ← s, simple, small, size:simple, size:small
 *   M ← m, medio, medium, size:medio, size:medium
 *   L ← l, grande, large, size:grande, size:large
 *
 * Cualquier otro valor → fallback `M` con label `medio`.
 *
 * @param {*} rawValue
 * @returns {{canonical:'S'|'M'|'L', label:'simple'|'medio'|'grande'}}
 */
function mapSizeToCanonical(rawValue) {
    if (rawValue == null) {
        return { canonical: 'M', label: SIZE_LABELS.M };
    }
    const norm = String(rawValue).trim().toLowerCase();
    if (!norm) return { canonical: 'M', label: SIZE_LABELS.M };
    for (const [canonical, vocab] of Object.entries(SIZE_VOCAB)) {
        if (vocab.includes(norm)) {
            return { canonical, label: SIZE_LABELS[canonical] };
        }
    }
    return { canonical: 'M', label: SIZE_LABELS.M };
}

// ─── Cálculos estadísticos ─────────────────────────────────────────────────

/**
 * Percentil por interpolación lineal sobre array ya ordenado asc.
 *
 * Algoritmo: rank = (p/100) * (N-1); si rank es entero → arr[rank];
 * si no → interpolación entre los dos vecinos.
 */
function percentile(sortedAsc, p) {
    if (!Array.isArray(sortedAsc) || sortedAsc.length === 0) return null;
    if (sortedAsc.length === 1) return sortedAsc[0];
    const rank = (p / 100) * (sortedAsc.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi) return sortedAsc[lo];
    const frac = rank - lo;
    return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/**
 * Insert-sort en posición sobre un array ascendente.
 * O(log N) búsqueda + O(N) splice — adecuado para muestras de cientos.
 */
function insertSorted(arr, value) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] < value) lo = mid + 1;
        else hi = mid;
    }
    arr.splice(lo, 0, value);
}

function mean(arr) {
    if (!arr || arr.length === 0) return 0;
    let s = 0;
    for (const v of arr) s += v;
    return s / arr.length;
}

function stddev(arr, mu) {
    if (!arr || arr.length <= 1) return 0;
    const m = (typeof mu === 'number') ? mu : mean(arr);
    let ss = 0;
    for (const v of arr) ss += (v - m) * (v - m);
    return Math.sqrt(ss / arr.length);
}

// ─── Roadmap loader (D3 — precedencia: label > roadmap > fallback) ──────────

let _roadmapCache = { path: null, data: null };

function _invalidateRoadmapCache() {
    _roadmapCache = { path: null, data: null };
}

function _loadRoadmapIssueSizes() {
    const file = roadmapPath();
    if (_roadmapCache.path === file && _roadmapCache.data) return _roadmapCache.data;
    const map = {};
    try {
        const txt = fs.readFileSync(file, 'utf8');
        const data = JSON.parse(txt);
        const sprints = Array.isArray(data && data.sprints) ? data.sprints : [];
        for (const sprint of sprints) {
            const stories = Array.isArray(sprint && sprint.stories) ? sprint.stories : [];
            for (const s of stories) {
                if (!s) continue;
                const issueNum = Number(s.issue);
                if (!Number.isInteger(issueNum) || issueNum <= 0) continue;
                if (!s.effort) continue;
                const mapped = mapSizeToCanonical(s.effort);
                map[issueNum] = mapped.canonical;
            }
        }
    } catch { /* archivo ausente o malformado → mapa vacío */ }
    _roadmapCache = { path: file, data: map };
    return map;
}

/**
 * Devuelve el size canónico (S/M/L) de un issue según `scripts/roadmap.json`.
 * Fallback a `M` si el issue no está en el roadmap o el archivo no existe.
 *
 * NOTA: el módulo NO consulta GitHub. Si el caller tiene un label cacheado
 * (más fresco que roadmap.json), debe pasarlo explícitamente vía la API
 * (ej. `calculateOlaETA([{number, size}])`).
 */
function getIssueSize(issueNumber) {
    if (!isValidIssueNumber(issueNumber)) return 'M';
    const map = _loadRoadmapIssueSizes();
    return map[issueNumber] || 'M';
}

// ─── Lectura de markers FS (per-issue / per-fase) ──────────────────────────
//
// #3517 — Toda la infraestructura de walk + filtros + parsing de markers
// vive ahora en `lib/eta-markers.js`. Este wrapper solo adapta la API a la
// shape histórica que `analyzeHistoricalMetrics` consume (perIssue + perFase
// + totalProcessed + totalRejected, sin perFaseSkill que es del dashboard).
// Mantenemos `includeRejection: true` para preservar el comportamiento
// previo: el `rebounceRate` cae a markers FS si el JSONL no aporta señal,
// y eso necesita la detección de `resultado: rechazado` en cada marker.

function _collectMarkers() {
    const result = etaMarkers.collectMarkers({
        root: pipelineDir(),
        includeRejection: true,
    });
    // Compat byte-a-byte con el shape histórico — descartamos `perFaseSkill`
    // que es nuevo y solo lo consume el dashboard.
    return {
        perIssue: result.perIssue,
        perFase: result.perFase,
        totalProcessed: result.totalProcessed,
        totalRejected: result.totalRejected,
    };
}

// ─── Streaming JSONL (CA-12) ───────────────────────────────────────────────

/**
 * Recorre `.pipeline/metrics-history.jsonl` línea por línea con streams.
 * Cada línea se intenta parsear con `JSON.parse` envuelto en try/catch (CA-9).
 * Última línea truncada o cualquier corrupción → skip silencioso + contador.
 *
 * Si el archivo no existe → retorna `{ ok:false, processed:0, skipped:0 }`
 * y `onLine` NUNCA es llamado (CA-11).
 *
 * IMPORTANTE: prohibido `fs.readFileSync` sobre este archivo (CA-12).
 *
 * @param {(snap:object) => void} onLine
 * @returns {Promise<{ok:boolean, processed:number, skipped:number}>}
 */
function _streamMetricsHistory(onLine) {
    return new Promise((resolve) => {
        const file = metricsHistoryPath();
        let exists = false;
        try { exists = fs.existsSync(file); } catch { exists = false; }
        if (!exists) {
            resolve({ ok: false, processed: 0, skipped: 0 });
            return;
        }
        let processed = 0;
        let skipped = 0;
        const stream = fs.createReadStream(file, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        rl.on('line', (line) => {
            if (!line) return;
            let parsed;
            try { parsed = JSON.parse(line); }
            catch { skipped++; return; }
            processed++;
            try { onLine(parsed); } catch { /* nunca rompemos el stream */ }
        });
        rl.on('close', () => resolve({ ok: true, processed, skipped }));
        rl.on('error', () => resolve({ ok: true, processed, skipped }));
    });
}

// ─── Cache de análisis histórico ───────────────────────────────────────────

let _analysisCache = { ts: 0, value: null };

function _invalidateAnalysisCache() {
    _analysisCache = { ts: 0, value: null };
}

// ─── analyzeHistoricalMetrics (CA-4) ──────────────────────────────────────

/**
 * Analiza el histórico completo del pipeline y devuelve métricas agregadas.
 *
 * Hace dos cosas en paralelo conceptual:
 *   1. Stream del JSONL (CA-12) para `rebounceRate` (proxy desde deltas de
 *      `byFase.dev.pending` vs `byFase.verificacion.working/build.working`) y
 *      `snapshotCount`/`tsRange` de metadata.
 *   2. Lectura de markers FS para `bySize` (percentiles por size canónico
 *      a partir de duraciones per-issue) y `avgPhaseTime` (avg por fase).
 *
 * Si el JSONL no existe → caemos a markers FS para `rebounceRate`
 * (total rechazados / total procesados).
 *
 * @returns {Promise<{
 *   bySize: { S:{avgTime,stddev,samples}, M:{...}, L:{...} },
 *   rebounceRate: number,
 *   avgPhaseTime: { [fase:string]: number },
 *   _meta: { snapshotCount, tsRange, jsonl, sortedBySize }
 * }>}
 */
async function analyzeHistoricalMetrics() {
    const now = Date.now();
    if (_analysisCache.value && (now - _analysisCache.ts) < ANALYSIS_CACHE_TTL_MS) {
        return _analysisCache.value;
    }

    // 1) JSONL stream
    let prevSnap = null;
    let snapshotCount = 0;
    const tsRange = { first: null, last: null };
    let rebounceEvents = 0;
    let devEntries = 0;

    const jsonlResult = await _streamMetricsHistory((snap) => {
        if (!snap || typeof snap.ts !== 'number') return;
        if (!snap.byFase || typeof snap.byFase !== 'object') return;
        snapshotCount++;
        if (tsRange.first === null || snap.ts < tsRange.first) tsRange.first = snap.ts;
        if (tsRange.last === null || snap.ts > tsRange.last) tsRange.last = snap.ts;

        if (prevSnap && prevSnap.byFase) {
            const devPrev = (prevSnap.byFase.dev && prevSnap.byFase.dev.pending) || 0;
            const devCur = (snap.byFase.dev && snap.byFase.dev.pending) || 0;
            const devDelta = devCur - devPrev;
            if (devDelta > 0) {
                devEntries += devDelta;
                const verifWPrev = (prevSnap.byFase.verificacion && prevSnap.byFase.verificacion.working) || 0;
                const verifWCur = (snap.byFase.verificacion && snap.byFase.verificacion.working) || 0;
                const buildWPrev = (prevSnap.byFase.build && prevSnap.byFase.build.working) || 0;
                const buildWCur = (snap.byFase.build && snap.byFase.build.working) || 0;
                if (verifWCur < verifWPrev || buildWCur < buildWPrev) {
                    rebounceEvents += devDelta;
                }
            }
        }
        prevSnap = snap;
    });

    // 2) Markers FS
    const markers = _collectMarkers();

    // 3) bySize a partir de markers per-issue
    const bySizeBuckets = { S: [], M: [], L: [] };
    for (const [issueStr, data] of Object.entries(markers.perIssue)) {
        const issue = Number(issueStr);
        const sz = getIssueSize(issue);
        const minutes = data.totalMs / 60000;
        insertSorted(bySizeBuckets[sz], minutes);
    }

    const bySize = {};
    const sortedBySize = {};
    for (const sz of ['S', 'M', 'L']) {
        const sorted = bySizeBuckets[sz];
        sortedBySize[sz] = sorted;
        if (sorted.length === 0) {
            const def = DEFAULT_BY_SIZE[sz];
            bySize[sz] = { avgTime: def.avgTime, stddev: def.stddev, samples: 0 };
        } else {
            const avg = mean(sorted);
            bySize[sz] = {
                avgTime: Math.round(avg),
                stddev: Math.round(stddev(sorted, avg)),
                samples: sorted.length,
            };
        }
    }

    // 4) avgPhaseTime: derivar desde markers per-fase (fallback a defaults)
    const avgPhaseTime = {};
    for (const fase of KNOWN_FASES) {
        const arr = markers.perFase[fase];
        if (arr && arr.length > 0) {
            const avgMs = mean(arr);
            avgPhaseTime[fase] = Math.max(1, Math.round(avgMs / 60000));
        } else {
            avgPhaseTime[fase] = DEFAULT_PHASE_TIME_MIN[fase];
        }
    }
    // Fases no listadas que aparezcan en markers — exponerlas también
    for (const fase of Object.keys(markers.perFase)) {
        if (avgPhaseTime[fase] != null) continue;
        const avgMs = mean(markers.perFase[fase]);
        avgPhaseTime[fase] = Math.max(1, Math.round(avgMs / 60000));
    }

    // 5) rebounceRate: primario desde JSONL (D2). Fallback a markers FS si
    //    el JSONL no aporta señal suficiente (snapshots < 20 o sin transiciones).
    let rebounceRate = DEFAULT_REBOUNCE_RATE;
    if (devEntries >= 1 && snapshotCount >= 20) {
        rebounceRate = Math.min(1, rebounceEvents / devEntries);
    } else if (markers.totalProcessed > 0) {
        rebounceRate = Math.min(1, markers.totalRejected / markers.totalProcessed);
    }

    const result = {
        bySize,
        rebounceRate: Math.round(rebounceRate * 1000) / 1000,
        avgPhaseTime,
        _meta: {
            snapshotCount,
            tsRange,
            jsonl: jsonlResult,
            sortedBySize,
        },
    };
    _analysisCache = { ts: now, value: result };
    return result;
}

// ─── calculateIssueETA (CA-2) ─────────────────────────────────────────────

/**
 * ETA probabilístico para un issue puntual, según size canónico.
 *
 * Si no hay samples históricos del size solicitado, devuelve fallback derivado
 * de `DEFAULT_BY_SIZE` con `samples: 0` (CA-2).
 *
 * Input inválido (CA-5/CA-6): no crashea, devuelve fallback `M`.
 *
 * @param {number} issueNumber
 * @param {*} size
 * @returns {Promise<{p50, p75, p90, samples, sizeCanonical, sizeLabel}>}
 */
async function calculateIssueETA(issueNumber, size) {
    // CA-5: si issueNumber es inválido, no crasheamos — el cálculo de ETA por
    // size no depende intrínsecamente del número, pero registramos `null`.
    if (!isValidIssueNumber(issueNumber)) {
        // No-op por ahora: la API sigue siendo válida pero issueNumber se
        // ignora porque no afecta el cálculo histórico por size.
        issueNumber = null;
    }
    const sm = mapSizeToCanonical(size);
    const stats = await analyzeHistoricalMetrics();
    const sorted = (stats._meta && stats._meta.sortedBySize && stats._meta.sortedBySize[sm.canonical]) || [];

    if (sorted.length === 0) {
        // Fallback documentado (CA-2): aproximación normal con μ + zσ.
        // z_75 ≈ 0.674, z_90 ≈ 1.282 (tabla normal estándar).
        const def = stats.bySize[sm.canonical] || DEFAULT_BY_SIZE[sm.canonical];
        const avg = def.avgTime;
        const sd = def.stddev;
        return {
            p50: Math.max(1, Math.round(avg)),
            p75: Math.max(1, Math.round(avg + sd * 0.674)),
            p90: Math.max(1, Math.round(avg + sd * 1.282)),
            samples: 0,
            sizeCanonical: sm.canonical,
            sizeLabel: sm.label,
        };
    }

    return {
        p50: Math.max(1, Math.round(percentile(sorted, 50))),
        p75: Math.max(1, Math.round(percentile(sorted, 75))),
        p90: Math.max(1, Math.round(percentile(sorted, 90))),
        samples: sorted.length,
        sizeCanonical: sm.canonical,
        sizeLabel: sm.label,
    };
}

// ─── calculateOlaETA (CA-3) ───────────────────────────────────────────────

/**
 * ETA agregado de una ola (lista de issues) con factor de paralelismo.
 *
 * Modelo de paralelismo: bin-packing simple por techo — `total = ceil(sum / concurrency)`.
 * Sirve como cota superior cuando los tiempos son comparables; el dashboard
 * lo declara explícitamente para que el usuario no asuma planning exacto.
 *
 * Cada item de `issueList` puede ser:
 *   - `number` (issue id) — el size se busca en `getIssueSize(n)` (roadmap.json + fallback).
 *   - `{ number:int, size?:string }` — si trae `size`, anula al roadmap.
 *
 * CA-7/CA-8: input inválido → fallback documentado (concurrency 3, lista vacía).
 *
 * @param {Array<number|{number:number,size?:string}>} issueList
 * @param {number} [concurrency=3]
 * @returns {Promise<{totalP50, totalP75, totalP90, byIssue, concurrencyUsed}>}
 */
async function calculateOlaETA(issueList, concurrency) {
    let usedConcurrency = (typeof concurrency === 'number') ? concurrency : CONCURRENCY_DEFAULT;
    if (!isValidConcurrency(usedConcurrency)) {
        // CA-7: log de warning sin contenido sensible (CA-16).
        try { console.warn(`[eta-wave] concurrency inválido (${usedConcurrency}) — fallback a ${CONCURRENCY_DEFAULT}`); } catch {}
        usedConcurrency = CONCURRENCY_DEFAULT;
    }

    if (!Array.isArray(issueList)) issueList = [];
    if (issueList.length > ISSUE_LIST_MAX) {
        try { console.warn(`[eta-wave] issueList excede cap ${ISSUE_LIST_MAX}, truncando`); } catch {}
        issueList = issueList.slice(0, ISSUE_LIST_MAX);
    }

    if (issueList.length === 0) {
        return {
            totalP50: 0, totalP75: 0, totalP90: 0,
            byIssue: {}, concurrencyUsed: usedConcurrency,
        };
    }

    const stats = await analyzeHistoricalMetrics();
    const byIssue = {};
    let sumP50 = 0, sumP75 = 0, sumP90 = 0;

    for (const item of issueList) {
        let issueNumber = null;
        let rawSize;
        if (typeof item === 'number') {
            issueNumber = item;
            rawSize = undefined;
        } else if (item && typeof item === 'object') {
            issueNumber = item.number != null ? item.number : item.issue;
            rawSize = item.size;
        } else {
            continue;
        }
        if (!isValidIssueNumber(issueNumber)) continue;

        // Precedencia: size del item → roadmap → fallback M
        let sizeMapped;
        if (rawSize != null) {
            sizeMapped = mapSizeToCanonical(rawSize);
        } else {
            const canonical = getIssueSize(issueNumber);
            sizeMapped = { canonical, label: SIZE_LABELS[canonical] || SIZE_LABELS.M };
        }

        const sorted = (stats._meta.sortedBySize[sizeMapped.canonical]) || [];
        let p50, p75, p90, samples;
        if (sorted.length === 0) {
            const def = stats.bySize[sizeMapped.canonical] || DEFAULT_BY_SIZE[sizeMapped.canonical];
            p50 = Math.max(1, Math.round(def.avgTime));
            p75 = Math.max(1, Math.round(def.avgTime + def.stddev * 0.674));
            p90 = Math.max(1, Math.round(def.avgTime + def.stddev * 1.282));
            samples = 0;
        } else {
            p50 = Math.max(1, Math.round(percentile(sorted, 50)));
            p75 = Math.max(1, Math.round(percentile(sorted, 75)));
            p90 = Math.max(1, Math.round(percentile(sorted, 90)));
            samples = sorted.length;
        }

        byIssue[issueNumber] = {
            p50, p75, p90, samples,
            sizeCanonical: sizeMapped.canonical,
            sizeLabel: sizeMapped.label,
        };
        sumP50 += p50;
        sumP75 += p75;
        sumP90 += p90;
    }

    return {
        totalP50: Math.ceil(sumP50 / usedConcurrency),
        totalP75: Math.ceil(sumP75 / usedConcurrency),
        totalP90: Math.ceil(sumP90 / usedConcurrency),
        byIssue,
        concurrencyUsed: usedConcurrency,
    };
}

// ─── calculateDecomposedOlaETA (#4588) ─────────────────────────────────────

/** Normaliza un item de issueList a su número de issue, o null. */
function _issueNumOf(item) {
    if (typeof item === 'number') return isValidIssueNumber(item) ? item : null;
    if (item && typeof item === 'object') {
        const n = item.number != null ? item.number : item.issue;
        return isValidIssueNumber(n) ? n : null;
    }
    return null;
}

/**
 * ETA descompuesto de la ola en dos lecturas (diseño #4588 · gates-firma-operador):
 *   - **pipeline-bound** ("ETA si firmás ya"): sólo trabajo de agente activo.
 *     Es exactamente el `totalP50/75/90` de `calculateOlaETA`, que deriva de los
 *     tiempos de fase de `metrics-history` (agente activo) — NO incluye la espera
 *     de operador (CA-3: la velocidad de pipeline la excluye).
 *   - **operador-bound** ("ETA con tu latencia histórica de firma"): pipeline-bound
 *     + la espera de operador PENDIENTE proyectada. El `gap` entre ambos es el
 *     costo visible de los gates.
 *
 * La métrica agregada de espera de operador (total, por gate, distribución de
 * latencia) viaja en `operatorWait` para el banner/API (CA-2/CA-4).
 *
 * Read-only y defensivo: si la métrica de operador falla (audit corrupto, etc.)
 * degrada a `operatorWait: null` y ambos ETAs colapsan al pipeline-bound, nunca
 * rompe el cálculo de ola (robustez / no tumbar el pipeline).
 *
 * @param {Array<number|{number:number,size?:string}>} issueList
 * @param {number} [concurrency]
 * @param {object} [opts] — { operatorWaitOpts } inyectable para tests.
 */
async function calculateDecomposedOlaETA(issueList, concurrency, opts = {}) {
    const ola = await calculateOlaETA(issueList, concurrency);
    const issueNums = (Array.isArray(issueList) ? issueList : [])
        .map(_issueNumOf)
        .filter((n) => n !== null);

    let operatorWait = null;
    let projection = { projectedWaitMin: 0, perSignatureMin: null, pendingSignatures: 0, overdueSignatures: 0 };
    try {
        operatorWait = operatorWaitLib.calculateOperatorWait(issueNums, opts.operatorWaitOpts || {});
        projection = operatorWaitLib.projectPendingOperatorWait(operatorWait);
    } catch (e) {
        try { console.warn(`[eta-wave] operator-wait no disponible: ${e && e.message}`); } catch {}
        operatorWait = null;
    }

    const projectedWaitMin = Number.isFinite(projection.projectedWaitMin) ? projection.projectedWaitMin : 0;
    const etaPipelineBoundMin = ola.totalP50;
    const etaOperatorBoundMin = Math.round(ola.totalP50 + projectedWaitMin);

    return {
        ...ola,
        // Dos ETAs (CA-2) + métrica agregada (CA-4).
        pipelineBound: { p50: ola.totalP50, p75: ola.totalP75, p90: ola.totalP90 },
        etaPipelineBoundMin,
        etaOperatorBoundMin,
        operatorGapMin: Math.round(projectedWaitMin),
        operatorWait,                 // { totalWaitMin, byGate, byIssue, waitingNow, operatorLatency, ... }
        projectedOperatorWait: projection,
    };
}

// ─── Streaming wave-progress.jsonl (#4039, read-only) ──────────────────────

/**
 * Recorre `.pipeline/wave-progress.jsonl` por streaming (mismo patrón
 * read-only que `_streamMetricsHistory`) y devuelve los snapshots válidos de
 * un `waveKey` dado, ordenados por `ts`.
 *
 * Tolerante a líneas corruptas (SEC-6): cada línea se parsea con try/catch;
 * inválida → skip silencioso. Si el archivo no existe → `[]`.
 *
 * IMPORTANTE: este módulo NO escribe nunca sobre este archivo (CA-7); el
 * writer es `lib/wave-progress.js`.
 *
 * @param {number} waveKey
 * @returns {Promise<Array<{ts:number, avancePct:number}>>}
 */
function _streamWaveProgress(waveKey) {
    return new Promise((resolve) => {
        const file = waveProgressPath();
        let exists = false;
        try { exists = fs.existsSync(file); } catch { exists = false; }
        if (!exists) { resolve([]); return; }

        const out = [];
        const stream = fs.createReadStream(file, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        rl.on('line', (line) => {
            if (!line) return;
            let rec;
            try { rec = JSON.parse(line); } catch { return; }
            if (!rec || typeof rec !== 'object') return;
            if (rec.waveKey !== waveKey) return;
            if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts)) return;
            if (typeof rec.avancePct !== 'number' || !Number.isFinite(rec.avancePct)) return;
            out.push({ ts: rec.ts, avancePct: rec.avancePct });
        });
        rl.on('close', () => { out.sort((a, b) => a.ts - b.ts); resolve(out); });
        rl.on('error', () => { out.sort((a, b) => a.ts - b.ts); resolve(out); });
    });
}

// ─── Ventanas de reposo de proveedor (#4734) ───────────────────────────────

/**
 * Resuelve la ventana OFF del proveedor cuyo reposo detiene el pipeline
 * (default: `anthropic`). Devuelve un objeto `{active, schedule, timezone}` apto
 * para `isWithinWindow`/`nextWindowTransition`, o `null` si no hay ventana
 * activa / el módulo de schedule no está disponible.
 *
 * Inyectable en tests vía `opts.restWindow` (override directo) o
 * `opts.scheduleEntry` (se pasa a `getProviderSchedule`). Sin override, lee la
 * config real del pipeline (`.pipeline/provider-schedule.json`).
 *
 * @param {{restWindow?:object|null, provider?:string, scheduleEntry?:object}} [opts]
 * @returns {{active:boolean, schedule:object, timezone:string}|null}
 */
function _restWindow(opts = {}) {
    // Override explícito (tests deterministas). `null` desactiva el descuento.
    if (Object.prototype.hasOwnProperty.call(opts, 'restWindow')) {
        const w = opts.restWindow;
        return (w && w.active) ? w : null;
    }
    if (!providerSchedule || typeof providerSchedule.getProviderSchedule !== 'function') return null;
    const provider = opts.provider || 'anthropic';
    let resolved;
    try {
        resolved = providerSchedule.getProviderSchedule(provider,
            opts.scheduleEntry !== undefined ? { scheduleEntry: opts.scheduleEntry } : {});
    } catch { return null; }
    if (!resolved || !resolved.active) return null;
    return { active: resolved.active, schedule: resolved.schedule, timezone: resolved.timezone };
}

/**
 * Milisegundos de reposo OFF que solapan el rango `[t0, t1)`. Itera las
 * transiciones de la ventana con `nextWindowTransition` y acumula los tramos en
 * los que `isWithinWindow` es `true`. Loop acotado (WAVE_OFF_SCAN_MAX_SEGMENTS)
 * y garantiza avance (paso ≥ 1 min) para no colgarse en un borde exacto.
 *
 * Delega 100% el manejo de horarios/timezone/DST en `rest-mode-window`.
 * Devuelve 0 si la ventana es nula/inactiva, el rango es vacío, o el módulo no
 * está disponible (degradación limpia: reloj de pared sin descuento).
 *
 * @param {object|null} window
 * @param {number} t0
 * @param {number} t1
 * @returns {number} ms OFF dentro de [t0, t1)
 */
function _offOverlapMs(window, t0, t1) {
    if (!window || !window.active) return 0;
    if (!restModeWindow
        || typeof restModeWindow.isWithinWindow !== 'function'
        || typeof restModeWindow.nextWindowTransition !== 'function') return 0;
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return 0;

    let off = 0;
    let cursor = t0;
    let guard = 0;
    while (cursor < t1 && guard < WAVE_OFF_SCAN_MAX_SEGMENTS) {
        guard++;
        let within = false;
        try { within = restModeWindow.isWithinWindow(window, cursor); } catch { within = false; }

        let stepMs;
        let trans = null;
        try { trans = restModeWindow.nextWindowTransition(window, cursor); } catch { trans = null; }
        if (trans && Number.isFinite(trans.minutesFromNow)) {
            // Al menos 1 min de avance para no quedar clavado en un borde exacto.
            stepMs = Math.max(60000, trans.minutesFromNow * 60000);
        } else {
            // Sin más transiciones: el estado se mantiene hasta t1.
            stepMs = t1 - cursor;
        }

        const segEnd = Math.min(cursor + stepMs, t1);
        if (within) off += segEnd - cursor;
        cursor = segEnd;
    }
    return off;
}

/**
 * EWMA de una serie de slopes (%/ms) en orden cronológico. Pondera el tramo
 * reciente sin descartar el resto de la ventana → suaviza el ruido de un único
 * snapshot nuevo (a diferencia de la pendiente global punta-a-punta).
 *
 * @param {number[]} slopes — pendientes por tramo, cronológicas.
 * @param {number} alpha — factor de suavizado (0..1).
 * @returns {number} velocidad suavizada (%/ms); NaN si no hay slopes válidos.
 */
function _ewma(slopes, alpha) {
    let acc = null;
    for (const s of slopes) {
        if (!Number.isFinite(s)) continue;
        acc = (acc === null) ? s : (alpha * s + (1 - alpha) * acc);
    }
    return acc === null ? NaN : acc;
}

// ─── calculateWaveVelocityETA (#4039 · reloj de pared + reposo #4734) ────────

/**
 * ETA de ola por VELOCIDAD MEDIA del conjunto (#4039).
 *
 * En vez de sumar promedios teóricos por issue (`calculateOlaETA`), mide el
 * ritmo real observado de la ola — `Δ(avancePct) / Δ(tiempo)` sobre una
 * ventana reciente de snapshots — y proyecta el restante:
 *   `remainingMs = (100 − avancePctActual) / velocidad`.
 *
 * Propiedad clave (CA-1/CA-5): si la ola avanza a ritmo estable, el restante
 * BAJA con cada lectura y la hora meta (`now + remaining`) converge en vez de
 * alejarse 1 min por minuto.
 *
 * Suavizado (CA-2 / nota técnica): la velocidad se calcula como pendiente
 * global sobre la VENTANA de los últimos `WAVE_VELOCITY_WINDOW` snapshots
 * (media móvil por ventana), no entre dos puntos sueltos → evita oscilación
 * ante un snapshot ruidoso.
 *
 * Fallback documentado (CA-4): con < `WAVE_MIN_SNAPSHOTS` snapshots de la ola
 * o `Δt < WAVE_MIN_DELTA_MS`, devuelve `{ source: 'fallback' }` y el caller
 * usa su modelo previo (`calculateOlaETA` / `computeLaneEmptyEta`).
 *
 * Clamp (CA-14): velocidad ≤ 0 / no finita (por rebotes o `/wave add` que
 * bajan el avancePct) → `{ source: 'fallback' }`; NUNCA propaga
 * `NaN`/`Infinity`/restante negativo.
 *
 * Reset al resembrar (CA-6): al cambiar `waveKey`, la serie anterior no
 * matchea → cae a fallback hasta acumular snapshots propios.
 *
 * #4532 — Cuando no hay ritmo medible propio, en vez de `fallback` mudo se deriva
 * de la VELOCIDAD HISTÓRICA cross-ola (`source:'historical'`, `snapshots:0`), para
 * que una ola nueva muestre velocidad/ETA desde el primer tick. Sólo cae a
 * `fallback` cuando tampoco hay histórico.
 *
 * @param {number} waveKey — entero positivo (`waves.getActiveWave().number`).
 * @param {number} avancePctActual — `snapshot.totalPct` (0..100).
 * @param {number} [now=Date.now()] — inyectable para tests determinísticos.
 * @returns {Promise<
 *   {source:'velocity'|'historical', remainingMs:number, absoluteMs:number, velocityPctPerMin:number, snapshots:number, reason?:string}
 *   | {source:'fallback', reason:string}
 * >}
 */
async function calculateWaveVelocityETA(waveKey, avancePctActual, now, opts = {}) {
    const ts = (typeof now === 'number' && Number.isFinite(now)) ? now : Date.now();
    if (!opts || typeof opts !== 'object') opts = {};

    // Validación de inputs (CA-11/CA-14). Inputs rotos → fallback DURO (sin
    // histórico): no hay `avancePct` confiable para derivar un restante.
    if (!Number.isInteger(waveKey) || waveKey <= 0) {
        return { source: 'fallback', reason: 'invalid-wavekey' };
    }
    if (typeof avancePctActual !== 'number' || !Number.isFinite(avancePctActual)) {
        return { source: 'fallback', reason: 'invalid-avance' };
    }

    // #4532 — Fallback por VELOCIDAD HISTÓRICA cross-ola. Cuando la ola activa no
    // tiene ritmo medible propio (pocos snapshots, Δt chico, o pendiente ≤ 0 por
    // rebote / `/wave add`), en vez de devolver "—" derivamos velocidad/ETA de la
    // estimación previa persistida (issue #4532, puntos 5 y 6). El ETA sale de
    // `remaining / velocidad` con `remaining = 100 − avancePct` (equivale a
    // Σ(% restante por issue)/N, porque avancePct ya está normalizado por issue).
    const historicalFallback = (reason) => {
        let histPctPerMin;
        try { histPctPerMin = velocityHistory.getHistoricalVelocity({}); }
        catch { histPctPerMin = null; }
        if (!Number.isFinite(histPctPerMin) || histPctPerMin <= 0) {
            return { source: 'fallback', reason };
        }
        const remainingPct = 100 - avancePctActual;
        if (remainingPct <= 0) {
            return {
                source: 'historical',
                remainingMs: 0,
                absoluteMs: ts,
                velocityPctPerMin: histPctPerMin,
                snapshots: 0,
                reason,
            };
        }
        const velPerMs = histPctPerMin / 60000;
        const remainingMs = remainingPct / velPerMs;
        if (!Number.isFinite(remainingMs) || remainingMs < 0) {
            return { source: 'fallback', reason };
        }
        return {
            source: 'historical',
            remainingMs,
            absoluteMs: ts + remainingMs,
            velocityPctPerMin: histPctPerMin,
            snapshots: 0,
            reason,
        };
    };

    let allSnapshots;
    try { allSnapshots = await _streamWaveProgress(waveKey); }
    catch { return historicalFallback('read-error'); }

    // #4734 — Ventana TEMPORAL de reloj de pared: muestras dentro de las últimas
    // WAVE_VELOCITY_WINDOW_MS (no "últimos N snapshots"). Ancladas al `ts` real.
    const windowStart = ts - WAVE_VELOCITY_WINDOW_MS;
    const snapshots = allSnapshots.filter((s) => s.ts >= windowStart && s.ts <= ts);

    if (snapshots.length < WAVE_MIN_SNAPSHOTS) {
        return historicalFallback('insufficient-snapshots');  // CA-4 / #4734 fallback
    }

    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];
    const spanMs = last.ts - first.ts;
    if (!Number.isFinite(spanMs) || spanMs < WAVE_MIN_DELTA_MS) {
        return historicalFallback('delta-too-small');  // CA-4
    }

    // #4734 — Seam de reposo. En producción delega en `rest-mode-window` sobre la
    // ventana del proveedor; en tests se inyecta `opts.offOverlapFn` para
    // determinismo (evita depender del reloj de pared/timezone reales).
    const restWindow = _restWindow(opts);
    const offFn = (typeof opts.offOverlapFn === 'function')
        ? opts.offOverlapFn
        : (a, b) => _offOverlapMs(restWindow, a, b);
    const hasRest = (typeof opts.offOverlapFn === 'function') || !!restWindow;

    // #4734 (a) — Descontar el reposo del proveedor DENTRO de la ventana medida:
    // el pipeline estuvo parado, no lento. Medir sobre el tiempo EFECTIVO (reloj
    // de pared menos OFF) evita subestimar la velocidad real.
    const offPastMs = offFn(first.ts, last.ts);
    const effectiveSpanMs = spanMs - offPastMs;
    if (!Number.isFinite(effectiveSpanMs) || effectiveSpanMs < WAVE_MIN_DELTA_MS) {
        return historicalFallback('effective-span-too-small');
    }

    // #4734 — Velocidad = EWMA de los slopes por tramo, en %/ms de reloj de pared
    // EFECTIVO. Cada tramo descuenta su propio OFF para no diluir la pendiente;
    // el EWMA suaviza el ruido de un único snapshot nuevo (vs pendiente global).
    const slopes = [];
    for (let i = 1; i < snapshots.length; i++) {
        const a = snapshots[i - 1];
        const b = snapshots[i];
        const segEff = (b.ts - a.ts) - offFn(a.ts, b.ts);
        if (segEff <= 0) continue;             // tramo íntegramente OFF → sin señal
        slopes.push((b.avancePct - a.avancePct) / segEff);
    }
    let velocity = _ewma(slopes, WAVE_VELOCITY_EWMA_ALPHA);
    // Robustez: si el EWMA no dejó señal (todos los tramos OFF o un único punto),
    // cae a la pendiente global sobre el tiempo efectivo de la ventana.
    if (!Number.isFinite(velocity)) {
        velocity = (last.avancePct - first.avancePct) / effectiveSpanMs;
    }

    // Clamp (CA-14): velocidad ≤ 0 / no finita (rebotes / `/wave add` que bajan
    // el avancePct) → NO se registra ni se propaga negativo; se cae a la
    // estimación histórica (robustez #4532: sin velocidades negativas).
    if (!Number.isFinite(velocity) || velocity <= 0) {
        return historicalFallback('non-positive-velocity');
    }

    // Unidad canónica del #4734: %/hora de reloj de pared. Se conserva
    // `velocityPctPerMin` en el retorno para compat de consumers (mission-ola-eta,
    // dashboard-routes) y del histórico persistido `wave-velocity-history.jsonl`.
    const velocityPctPerMin = velocity * 60000;
    const velocityPctPerHour = velocity * 3600000;
    // #4532 — Registrar la muestra medida en el histórico cross-ola (throttled).
    // Best-effort: nunca rompe el cálculo. Sólo muestras positivas (recordSample
    // ya descarta ≤ 0), y como mucho una cada VELOCITY_SAMPLE_MIN_INTERVAL_MS.
    if ((ts - _lastVelocitySampleTs) >= VELOCITY_SAMPLE_MIN_INTERVAL_MS) {
        _lastVelocitySampleTs = ts;
        try { velocityHistory.recordSample({ waveKey, velocityPctPerMin, now: ts }); }
        catch { /* telemetría best-effort */ }
    }

    const remainingPct = 100 - avancePctActual;
    if (remainingPct <= 0) {
        // Ola completada — restante 0, meta = ahora.
        return {
            source: 'velocity',
            remainingMs: 0,
            absoluteMs: ts,
            velocityPctPerMin,
            velocityPctPerHour,
            snapshots: snapshots.length,
            restOffFutureMs: 0,
        };
    }

    // Tiempo de cómputo puro (sin reposo): restante / velocidad efectiva.
    const computeMs = remainingPct / velocity;
    if (!Number.isFinite(computeMs) || computeMs < 0) {
        return historicalFallback('degenerate-remaining');
    }

    // #4734 (b) — Proyección: sumar el reposo FUTURO que caiga dentro del
    // horizonte de finalización, para no dar un ETA optimista que colapsa cuando
    // entra un reposo. Iterativo porque `now + eta` puede caer en OTRA ventana
    // OFF; converge (Δ < 1 min) o corta acotado (cota superior aceptada).
    let etaMs = computeMs;
    if (hasRest) {
        for (let i = 0; i < WAVE_REST_PROJECTION_MAX_ITERS; i++) {
            const next = computeMs + offFn(ts, ts + etaMs);
            const done = Math.abs(next - etaMs) < 60000;
            etaMs = next;
            if (done) break;
        }
    }

    if (!Number.isFinite(etaMs) || etaMs < 0) {
        return historicalFallback('degenerate-remaining');
    }

    return {
        source: 'velocity',
        remainingMs: etaMs,
        absoluteMs: ts + etaMs,
        velocityPctPerMin,
        velocityPctPerHour,
        snapshots: snapshots.length,
        restOffFutureMs: etaMs - computeMs,
    };
}

/**
 * #4450 — Throughput de entrega de la ola: issues cerrados por unidad de tiempo
 * transcurrido, expresado en `issues/día`. Es la "velocidad" en el sentido del
 * issue (throughput de entregas), distinta de `velocityPctPerMin` (pendiente de
 * %/ms que alimenta el ETA de #4449, que NO se toca).
 *
 * Pura y determinística (inyectar `now` para tests). NO lee snapshots ni el FS:
 * el caller (dashboard.js) le pasa `closedCount` (del mismo `computeClosedSet`
 * que la lista) y `waveStartTs` (fecha de inicio de ola / primer snapshot).
 *
 * Robustez (R-3 security / G-UX-3): si el conteo es inválido, la fecha de inicio
 * falta/es futura, o la ventana es no-positiva (división por cero) → devuelve
 * `{ throughputPerDay: null, state: 'insufficient' }` SIN lanzar excepción (no
 * rompe el render del resto del encabezado). El estado distingue:
 *   - `'insufficient'`: sin dato confiable → la vista muestra "sin datos suficientes".
 *   - `'measured'`: ventana válida; `closedCount === 0` es un cero legítimo
 *     (`0.0 issues/día`), no un "sin dato".
 *
 * @param {{closedCount:number, waveStartTs:number, now?:number}} args
 * @returns {{throughputPerDay:number|null, state:'measured'|'insufficient'}}
 */
function calculateWaveThroughput({ closedCount, waveStartTs, now } = {}) {
    const ts = (typeof now === 'number' && Number.isFinite(now)) ? now : Date.now();
    // R-3: guardas de finitud + ventana positiva antes de dividir.
    if (!Number.isInteger(closedCount) || closedCount < 0
        || !Number.isFinite(waveStartTs) || (ts - waveStartTs) <= 0) {
        return { throughputPerDay: null, state: 'insufficient' };
    }
    const days = (ts - waveStartTs) / 86400000;   // ms → días
    return { throughputPerDay: closedCount / days, state: 'measured' };
}

// ─── Exports ──────────────────────────────────────────────────────────────

module.exports = {
    // API pública (CA-1)
    calculateIssueETA,
    calculateOlaETA,
    calculateDecomposedOlaETA,  // #4588 — ETA pipeline-bound vs operador-bound
    calculateWaveVelocityETA,   // #4039 — ETA por velocidad media del conjunto
    calculateWaveThroughput,    // #4450 — throughput de entrega (issues/día)
    analyzeHistoricalMetrics,
    mapSizeToCanonical,
    // Helpers expuestos como API estable
    getIssueSize,
    // Constantes
    DEFAULT_PHASE_TIME_MIN,
    DEFAULT_BY_SIZE,
    DEFAULT_REBOUNCE_RATE,
    SIZE_LABELS,
    CONCURRENCY_DEFAULT,
    ISSUE_LIST_MAX,
    // Helpers internos expuestos sólo para tests
    _internal: {
        percentile,
        insertSorted,
        mean,
        stddev,
        isValidIssueNumber,
        isValidConcurrency,
        _invalidateAnalysisCache,
        _invalidateRoadmapCache,
        _collectMarkers,
        _streamMetricsHistory,
        _streamWaveProgress,
        _offOverlapMs,       // #4734 — solapamiento OFF sobre un rango
        _restWindow,         // #4734 — resolución de ventana de reposo
        _ewma,               // #4734 — suavizado exponencial de slopes
        pipelineRoot,
        metricsHistoryPath,
        waveProgressPath,
        roadmapPath,
        WAVE_MIN_SNAPSHOTS,
        WAVE_MIN_DELTA_MS,
        WAVE_VELOCITY_WINDOW,
        WAVE_VELOCITY_WINDOW_MS,       // #4734 — ventana temporal
        WAVE_VELOCITY_EWMA_ALPHA,      // #4734 — factor EWMA
        WAVE_REST_PROJECTION_MAX_ITERS,
    },
};
