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

// Límites de duración válida por marker (mismo criterio que dashboard.js).
const MIN_VALID_DURATION_MS = 5000;          // <5s = probablemente run espurio
const MAX_VALID_DURATION_MS = 4 * 3600 * 1000; // >4h = probablemente abandono

// Cache TTL del análisis histórico (sigue el patrón de waves.js).
const ANALYSIS_CACHE_TTL_MS = 30 * 1000;

// ─── Paths (con override por env para tests) ───────────────────────────────

function pipelineRoot() {
    if (process.env.PIPELINE_ROOT_OVERRIDE) return process.env.PIPELINE_ROOT_OVERRIDE;
    // .pipeline/lib/eta-wave.js → root = ../..
    return path.join(__dirname, '..', '..');
}

function pipelineDir() { return path.join(pipelineRoot(), '.pipeline'); }
function metricsHistoryPath() { return path.join(pipelineDir(), 'metrics-history.jsonl'); }
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

function _listProcessedFiles(faseDir) {
    const out = [];
    for (const estado of ['procesado', 'listo']) {
        const dir = path.join(faseDir, estado);
        let names = [];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const name of names) {
            if (!name || name.startsWith('.') || name.startsWith('_')) continue;
            out.push({ dir, name });
        }
    }
    return out;
}

function _hasRejectionMarker(filePath) {
    // Lee el archivo y busca `resultado: rechazado` al inicio de línea.
    // Lectura sincrónica de archivos pequeños del pipeline (no del JSONL).
    try {
        const txt = fs.readFileSync(filePath, 'utf8');
        return /^[ \t]*resultado[ \t]*:[ \t]*rechazado\b/m.test(txt);
    } catch {
        return false;
    }
}

function _collectMarkers() {
    const root = pipelineDir();
    const perIssue = {};   // issueNumber → { totalMs, fases:{fase:ms}, rejected:bool }
    const perFase = {};    // fase → [ms]
    let totalProcessed = 0;
    let totalRejected = 0;

    let pipelineDirs = [];
    try {
        pipelineDirs = fs.readdirSync(root, { withFileTypes: true })
            .filter((d) => d.isDirectory() && (d.name === 'desarrollo' || d.name === 'definicion'))
            .map((d) => path.join(root, d.name));
    } catch {
        return { perIssue, perFase, totalProcessed, totalRejected };
    }

    for (const pdir of pipelineDirs) {
        let faseNames = [];
        try {
            faseNames = fs.readdirSync(pdir, { withFileTypes: true })
                .filter((d) => d.isDirectory())
                .map((d) => d.name);
        } catch { continue; }

        for (const fase of faseNames) {
            const faseDir = path.join(pdir, fase);
            const files = _listProcessedFiles(faseDir);
            for (const { dir, name } of files) {
                const fullPath = path.join(dir, name);
                let st;
                try { st = fs.statSync(fullPath); } catch { continue; }
                const dur = st.ctimeMs - st.birthtimeMs;
                if (!Number.isFinite(dur) || dur <= MIN_VALID_DURATION_MS || dur > MAX_VALID_DURATION_MS) continue;

                const issueStr = name.split('.')[0];
                const issue = Number(issueStr);
                if (!Number.isInteger(issue) || issue <= 0) continue;

                totalProcessed++;
                if (!perIssue[issue]) perIssue[issue] = { totalMs: 0, fases: {}, rejected: false };
                perIssue[issue].totalMs += dur;
                perIssue[issue].fases[fase] = (perIssue[issue].fases[fase] || 0) + dur;
                if (!perFase[fase]) perFase[fase] = [];
                perFase[fase].push(dur);

                if (_hasRejectionMarker(fullPath)) {
                    perIssue[issue].rejected = true;
                    totalRejected++;
                }
            }
        }
    }

    return { perIssue, perFase, totalProcessed, totalRejected };
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

// ─── Exports ──────────────────────────────────────────────────────────────

module.exports = {
    // API pública (CA-1)
    calculateIssueETA,
    calculateOlaETA,
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
        pipelineRoot,
        metricsHistoryPath,
        roadmapPath,
    },
};
