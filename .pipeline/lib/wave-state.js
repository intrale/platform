// =============================================================================
// wave-state.js — Builder mínimo de pipeline state para el snapshot ejecutivo (#3262).
//
// Replica la lógica de `dashboard.getPipelineState()` que el handler `/wave`
// necesita, sin importar `dashboard.js` (que arranca un HTTP server al hacer
// require — side effect que no podemos disparar desde el commander singleton).
//
// Lo que produce es un subset compatible con lo que consume `buildWaveSnapshot`:
//   - state.issueMatrix[id] = {
//       fases: { "<pipeline>/<fase>": [{ skill, estado, pipeline, fase, startedAt, durationMs }, ...] },
//       faseActual: "<pipeline>/<fase>"|null,
//       estadoActual: 'pendiente'|'trabajando'|'listo'|null,
//       title: string,                    // best-effort desde .issue-title-cache.json
//       labels: string[],                 // best-effort desde cache
//       bounces: number,
//       staleMin: number,
//       rebote: boolean,
//       motivo_rechazo: string|null,
//     }
//   - state.etaAverages = { "<fase>/<skill>": { avgMs }, "<fase>": { avgMs } }
//   - state.allFases = [{ pipeline, fase }, ...] — orden canónico del lifecycle
//
// Para performance (CA-16): TTL cache 2 segundos in-process. Si /wave se llama
// dos veces seguidas, el segundo reusa el primer scan.
//
// Reglas:
// - No throw a callers — degrada a state vacío si el filesystem es inaccesible.
// - No depende de config.yaml — el lifecycle es la constante LIFECYCLE_FULL.
// - No depende de dashboard.js, dashboard-routes.js, ni de SSE/HTTP.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// Mismo orden canónico que LIFECYCLE_FULL en wave-snapshot.js — replicado
// localmente para no introducir dependencias circulares.
const ALL_FASES = [
    { pipeline: 'definicion', fase: 'analisis' },
    { pipeline: 'definicion', fase: 'criterios' },
    { pipeline: 'definicion', fase: 'sizing' },
    { pipeline: 'desarrollo', fase: 'validacion' },
    { pipeline: 'desarrollo', fase: 'dev' },
    { pipeline: 'desarrollo', fase: 'build' },
    { pipeline: 'desarrollo', fase: 'verificacion' },
    { pipeline: 'desarrollo', fase: 'linteo' },
    { pipeline: 'desarrollo', fase: 'aprobacion' },
    { pipeline: 'desarrollo', fase: 'entrega' },
];
const ALL_STATES = ['pendiente', 'trabajando', 'listo', 'procesado'];
const ETA_MIN_MS = 5000;            // descartar < 5s
const ETA_MAX_MS = 4 * 3600 * 1000; // descartar > 4h

// Cache por pipelineRoot.
const stateCache = new Map(); // pipelineRoot → { state, ts }
const CACHE_TTL_MS = 2000;

function listFiles(dir) {
    try { return fs.readdirSync(dir); } catch { return []; }
}

function safeStat(p) {
    try { return fs.statSync(p); } catch { return null; }
}

function safeReadYaml(filepath) {
    // Parser MUY mínimo: solo extraemos los campos clave que necesitamos
    // (resultado, motivo, rebote, motivo_rechazo). No usamos js-yaml para
    // evitar deps; el contrato del pipeline lo cubre.
    let raw;
    try { raw = fs.readFileSync(filepath, 'utf8'); } catch { return {}; }
    const out = {};
    const reFields = [
        ['resultado', /^resultado:\s*(.+?)\s*$/m],
        ['motivo', /^motivo:\s*(.+?)\s*$/m],
        ['rebote', /^rebote:\s*(true|false)\s*$/m],
        ['motivo_rechazo', /^motivo_rechazo:\s*(.+?)\s*$/m],
    ];
    for (const [k, re] of reFields) {
        const m = raw.match(re);
        if (m) out[k] = k === 'rebote' ? m[1] === 'true' : m[1].replace(/^["']|["']$/g, '');
    }
    return out;
}

// Artifacts auxiliares: detección centralizada en `lib/marker-artifact.js`
// (#3638 CA-F-1).
const { isMarkerArtifact } = require('./marker-artifact');

function loadTitleCache(pipelineRoot) {
    const file = path.join(pipelineRoot, '.issue-title-cache.json');
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

/**
 * Construye el state mínimo necesario para el snapshot.
 *
 * @param {object} opts
 * @param {string} opts.pipelineRoot
 * @param {number} [opts.now]
 * @returns {{
 *   issueMatrix: object,
 *   etaAverages: object,
 *   allFases: Array,
 * }}
 */
function buildWaveState(opts) {
    const options = opts || {};
    const pipelineRoot = options.pipelineRoot;
    if (!pipelineRoot) return { issueMatrix: {}, etaAverages: {}, allFases: ALL_FASES };

    const now = typeof options.now === 'number' ? options.now : Date.now();
    const issueMatrix = {};

    for (const { pipeline, fase } of ALL_FASES) {
        const baseDir = path.join(pipelineRoot, pipeline, fase);
        for (const estado of ALL_STATES) {
            const dir = path.join(baseDir, estado);
            for (const f of listFiles(dir)) {
                if (isMarkerArtifact(f)) continue;
                if (!/^\d+\./.test(f)) continue;
                const dot = f.indexOf('.');
                const issueId = f.slice(0, dot);
                const skill = f.slice(dot + 1);

                if (!issueMatrix[issueId]) {
                    issueMatrix[issueId] = {
                        pipelines: new Set(),
                        fases: {},
                        faseActual: null,
                        estadoActual: null,
                        title: '',
                        labels: [],
                        bounces: 0,
                        staleMin: 0,
                        rebote: false,
                        motivo_rechazo: null,
                    };
                }
                issueMatrix[issueId].pipelines.add(pipeline);

                const faseKey = `${pipeline}/${fase}`;
                if (!issueMatrix[issueId].fases[faseKey]) issueMatrix[issueId].fases[faseKey] = [];

                const filepath = path.join(dir, f);
                const stat = safeStat(filepath);
                const entry = { skill, estado, pipeline, fase };
                if (stat) {
                    entry.startedAt = stat.ctimeMs;
                    entry.updatedAt = stat.mtimeMs;
                    const tStart = Math.min(stat.ctimeMs, stat.birthtimeMs || stat.ctimeMs);
                    entry.durationMs = (estado === 'trabajando')
                        ? Math.max(0, now - tStart)
                        : Math.abs(stat.mtimeMs - tStart);
                    entry.ageMin = Math.round((now - stat.mtimeMs) / 60000);
                }

                // Resultado/motivo (para detectar rechazos / contar bounces).
                if (estado === 'listo' || estado === 'procesado') {
                    const yaml = safeReadYaml(filepath);
                    if (yaml.resultado) entry.resultado = yaml.resultado;
                    if (yaml.motivo) entry.motivo = yaml.motivo;
                }
                if (estado === 'pendiente' || estado === 'trabajando') {
                    const yaml = safeReadYaml(filepath);
                    if (yaml.rebote || yaml.motivo_rechazo) {
                        entry.rebote = true;
                        entry.motivo_rechazo = yaml.motivo_rechazo || null;
                    }
                }

                issueMatrix[issueId].fases[faseKey].push(entry);

                // Selección de faseActual: priorizar `trabajando`, sino la
                // fase con mayor índice del lifecycle.
                if (estado !== 'procesado') {
                    const prevEstado = issueMatrix[issueId].estadoActual;
                    if (!prevEstado || prevEstado !== 'trabajando' || estado === 'trabajando') {
                        issueMatrix[issueId].faseActual = faseKey;
                        issueMatrix[issueId].estadoActual = estado;
                    }
                }
            }
        }
    }

    // Enriquecer con cache de títulos/labels (best-effort).
    const titleCache = loadTitleCache(pipelineRoot);
    for (const [id, data] of Object.entries(issueMatrix)) {
        data.pipelines = [...data.pipelines];
        const cached = titleCache[id] || {};
        data.title = cached.title || '';
        const rawLabels = Array.isArray(cached.labels) ? cached.labels : [];
        // Normalizar: tolerar tanto strings como objetos {name}.
        data.labels = rawLabels.map((l) => (typeof l === 'string' ? l : (l && l.name) || '')).filter(Boolean);

        // bounces = entradas con resultado distinto a aprobado.
        let bounces = 0;
        for (const entries of Object.values(data.fases)) {
            for (const e of entries) {
                if (e.resultado && e.resultado !== 'aprobado') bounces += 1;
            }
        }
        data.bounces = bounces;

        // staleMin del entry trabajando actual.
        if (data.estadoActual === 'trabajando' && data.faseActual) {
            const entries = data.fases[data.faseActual] || [];
            const working = entries.find((e) => e.estado === 'trabajando');
            if (working) data.staleMin = working.ageMin || 0;
        }

        // rebote/motivo_rechazo del entry pendiente/trabajando.
        for (const entries of Object.values(data.fases)) {
            const reboteEntry = entries.find((e) => (e.estado === 'pendiente' || e.estado === 'trabajando') && e.rebote);
            if (reboteEntry) {
                data.rebote = true;
                data.motivo_rechazo = reboteEntry.motivo_rechazo || null;
                break;
            }
        }
    }

    // ETA averages: ctime - birthtime sobre procesado/listo.
    const etaAverages = {};
    for (const { pipeline, fase } of ALL_FASES) {
        for (const sub of ['procesado', 'listo']) {
            const dir = path.join(pipelineRoot, pipeline, fase, sub);
            for (const f of listFiles(dir)) {
                if (isMarkerArtifact(f)) continue;
                if (!/^\d+\./.test(f)) continue;
                const skill = f.slice(f.indexOf('.') + 1);
                const st = safeStat(path.join(dir, f));
                if (!st) continue;
                const dur = st.ctimeMs - st.birthtimeMs;
                if (dur <= ETA_MIN_MS || dur > ETA_MAX_MS) continue;
                const key = `${fase}/${skill}`;
                if (!etaAverages[key]) etaAverages[key] = { total: 0, count: 0 };
                etaAverages[key].total += dur;
                etaAverages[key].count += 1;
            }
        }
    }
    // Promedios + agregado por fase.
    for (const [key, data] of Object.entries(etaAverages)) {
        data.avgMs = Math.round(data.total / data.count);
        const fase = key.split('/')[0];
        if (!etaAverages[fase]) etaAverages[fase] = { total: 0, count: 0 };
        etaAverages[fase].total += data.total;
        etaAverages[fase].count += data.count;
    }
    for (const [key, data] of Object.entries(etaAverages)) {
        if (!key.includes('/')) data.avgMs = Math.round(data.total / data.count);
    }

    // #3262 — exponer la title cache cruda para que el snapshot pueda enriquecer
    // labels de issues que NO aparecen en la matriz (ej. issues recién admitidos
    // sin archivos todavía, o cerrados que ya pasaron por entrega).
    return { issueMatrix, etaAverages, allFases: ALL_FASES, issueTitles: titleCache };
}

/**
 * Variante cacheada con TTL 2s.
 */
function getCachedWaveState(opts) {
    const pipelineRoot = opts && opts.pipelineRoot;
    if (!pipelineRoot) return buildWaveState(opts);
    const now = Date.now();
    const cached = stateCache.get(pipelineRoot);
    if (cached && (now - cached.ts) < CACHE_TTL_MS) return cached.state;
    const state = buildWaveState(opts);
    stateCache.set(pipelineRoot, { state, ts: now });
    return state;
}

/**
 * Invalida la cache — útil para tests.
 */
function clearCache() {
    stateCache.clear();
}

module.exports = {
    buildWaveState,
    getCachedWaveState,
    clearCache,
    ALL_FASES,
    CACHE_TTL_MS,
};
