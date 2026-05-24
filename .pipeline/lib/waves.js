// =============================================================================
// waves.js — Source of truth multi-ola del pipeline V3 (#3489 / Spike #3378).
//
// Esta librería es el reemplazo formal de la planificación multi-ola que hoy
// vive dispersa entre `.partial-pause.json` (allowlist sin historia) y
// `wave-resolver.js` (cascada legacy). Centraliza:
//
//   - Persistencia versionada en `.pipeline/waves.json` con schema 1.0
//     (active_wave + planned_waves + archived_waves + dependencies).
//   - Auditoría de cada cambio (meta.updated_at/by/source/note) + backups
//     timestamped en `.pipeline/archived/waves.<ts>.json` para reconstrucción.
//   - API canónica de 11 métodos públicos que H2-H5 consumirán sin reimplementar
//     IO/parse/validación.
//
// Relación con otros módulos:
//   - `partial-pause.js`  → migration path. Si waves.json no existe, getAllowlist
//                            cae a leer la allowlist de `.partial-pause.json`.
//                            Ningún consumer actual se rompe.
//   - `wave-resolver.js`  → consumer legacy (issue #3502 trackea la migración a
//                            esta librería). NO se modifica acá.
//   - `wave-state.js`     → patrón de TTL cache 2s in-process replicado acá.
//
// Reglas inquebrantables:
//   - Sin red. Sin GitHub API. Solo filesystem propio del pipeline.
//   - No throw a callers, excepto en `addIssueToWave` y `promoteWaveToActive`
//     donde el contrato pide validación explícita (issue ya en otra ola,
//     ola inexistente, shape inválido).
//   - Write atómico (tmp + renameSync) — un crash mid-save no deja waves.json
//     truncado.
//   - Cero dependencias npm — solo `fs` y `path` del core de Node.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = '1.0';
const CACHE_TTL_MS = 2000;

// Cache por pipelineRoot — mismo shape que wave-state.js.
const cache = new Map(); // pipelineRoot → { state, ts }

// ─── Paths ──────────────────────────────────────────────────────────────────

function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.join(__dirname, '..');
}

function wavesFile() { return path.join(pipelineDir(), 'waves.json'); }
function archivedDir() { return path.join(pipelineDir(), 'archived'); }
function partialFile() { return path.join(pipelineDir(), '.partial-pause.json'); }

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normaliza un identificador de issue (acepta number, string, "#123").
 * Devuelve int positivo o null si no es válido.
 * Patrón replicado de `partial-pause.js:42` para consistencia.
 */
function normalizeIssue(issue) {
    // Trim primero, después strip de `#` opcional — toleramos " #123 ".
    const n = Number(String(issue).trim().replace(/^#/, ''));
    return Number.isInteger(n) && n > 0 ? n : null;
}

function nowIso() {
    return new Date().toISOString();
}

function logWarn(msg) {
    // Logger del módulo. console.warn con prefijo — mismo estilo que partial-pause.js.
    // No hay LoggerFactory central en `.pipeline/lib/*.js`; mantenemos esta convención.
    console.warn(`[waves] ${msg}`);
}

function logInfo(msg) {
    console.log(`[waves] ${msg}`);
}

function emptyState() {
    return {
        version: SCHEMA_VERSION,
        meta: {
            created_at: nowIso(),
            updated_at: nowIso(),
            updated_by: 'System',
            source: 'manual',
            note: 'Estado vacío auto-generado (waves.json ausente o corrupto).',
        },
        active_wave: null,
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    };
}

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function readCached(pipelineRoot) {
    const now = Date.now();
    const hit = cache.get(pipelineRoot);
    if (hit && (now - hit.ts) < CACHE_TTL_MS) {
        return deepClone(hit.state);
    }
    return null;
}

function setCached(pipelineRoot, state) {
    cache.set(pipelineRoot, { state: deepClone(state), ts: Date.now() });
}

function readWavesFromDisk(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err && err.code !== 'ENOENT') {
            logWarn(`No se pudo leer ${file}: ${err.message}`);
        }
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            logWarn(`Schema inválido en ${file}: no es objeto. Cayendo a estado vacío.`);
            return null;
        }
        return parsed;
    } catch (err) {
        logWarn(`JSON corrupto en ${file}: ${err.message}. Cayendo a estado vacío.`);
        return null;
    }
}

// ─── API pública ────────────────────────────────────────────────────────────

/**
 * Carga waves.json desde disco. Degrada a esqueleto vacío seguro si falla.
 * TTL: 2 segundos in-process (alineado con wave-state.js).
 *
 * @example
 *   const waves = loadWaves();
 *   if (waves.active_wave) console.log(waves.active_wave.name);
 *
 * @returns {Object} waves.json parsed (o esqueleto vacío)
 */
function loadWaves() {
    const root = pipelineDir();
    const cached = readCached(root);
    if (cached) return cached;

    const raw = readWavesFromDisk(wavesFile());
    let state;
    if (!raw) {
        state = emptyState();
    } else {
        // Normalizar campos requeridos para tolerar archivos parcialmente válidos.
        state = {
            version: raw.version || SCHEMA_VERSION,
            meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : emptyState().meta,
            active_wave: raw.active_wave || null,
            planned_waves: Array.isArray(raw.planned_waves) ? raw.planned_waves : [],
            archived_waves: Array.isArray(raw.archived_waves) ? raw.archived_waves : [],
            dependencies: Array.isArray(raw.dependencies) ? raw.dependencies : [],
        };
    }
    setCached(root, state);
    return deepClone(state);
}

/**
 * Lista todas las olas en orden: activa → planificadas → archivadas.
 *
 * @example
 *   for (const w of listWaves()) console.log(`${w.number}: ${w.name}`);
 *
 * @returns {Array<Object>} array de olas con number, name, status, etc.
 */
function listWaves() {
    const state = loadWaves();
    const out = [];
    if (state.active_wave) {
        out.push({ ...state.active_wave, status: 'active' });
    }
    for (const w of state.planned_waves) {
        out.push({ ...w, status: 'planned' });
    }
    for (const w of state.archived_waves) {
        out.push({ ...w, status: 'archived' });
    }
    return out;
}

/**
 * Obtiene la ola activa.
 *
 * @example
 *   const active = getActiveWave();
 *   if (!active) console.log('No hay ola activa');
 *
 * @returns {Object|null} ola activa o null si no hay
 */
function getActiveWave() {
    const state = loadWaves();
    return state.active_wave ? deepClone(state.active_wave) : null;
}

/**
 * Obtiene una ola planificada por número.
 *
 * @example
 *   const wave2 = getPlannedWave(2);
 *
 * @param {number} waveNumber
 * @returns {Object|null}
 */
function getPlannedWave(waveNumber) {
    const state = loadWaves();
    const w = state.planned_waves.find((x) => x.number === waveNumber);
    return w ? deepClone(w) : null;
}

/**
 * Agrega un issue a una ola específica (activa o planificada).
 * Persiste cambios automáticamente con save().
 *
 * Contrato de validación (puede throw):
 *   - issue debe tener shape { number: int positivo, ...campos opcionales }
 *   - waveNumber debe existir en active_wave o planned_waves
 *   - issue.number no puede estar ya en otra ola
 *
 * @example
 *   addIssueToWave(1, { number: 3453, status: 'pending', notes: 'optional' });
 *
 * @param {number} waveNumber
 * @param {Object} issue — { number: int, notes?: string, status?: string }
 * @param {Object} [meta] — { updated_by?: string, source?: string, note?: string }
 * @throws si la ola no existe, shape inválido, o issue duplicado
 */
function addIssueToWave(waveNumber, issue, meta = {}) {
    if (!issue || typeof issue !== 'object') {
        throw new Error('addIssueToWave: issue debe ser un objeto { number, ... }');
    }
    const n = normalizeIssue(issue.number);
    if (!n) {
        throw new Error(`addIssueToWave: issue.number inválido (${issue.number})`);
    }

    const state = loadWaves();

    // Verificar conflicto en otras olas.
    const allWaves = [state.active_wave, ...state.planned_waves].filter(Boolean);
    for (const w of allWaves) {
        if (w.number === waveNumber) continue;
        const has = Array.isArray(w.issues) && w.issues.some((i) => normalizeIssue(i.number) === n);
        if (has) {
            throw new Error(`addIssueToWave: issue #${n} ya está en ola ${w.number} (${w.name || ''})`);
        }
    }

    // Localizar ola destino.
    let target = null;
    if (state.active_wave && state.active_wave.number === waveNumber) {
        target = state.active_wave;
    } else {
        target = state.planned_waves.find((x) => x.number === waveNumber);
    }
    if (!target) {
        throw new Error(`addIssueToWave: ola ${waveNumber} no existe`);
    }

    if (!Array.isArray(target.issues)) target.issues = [];
    // No duplicar dentro de la misma ola.
    if (target.issues.some((i) => normalizeIssue(i.number) === n)) {
        logInfo(`Issue #${n} ya estaba en ola ${waveNumber} — no-op.`);
        return;
    }

    const issueEntry = { number: n };
    if (typeof issue.status === 'string') issueEntry.status = issue.status;
    if (typeof issue.notes === 'string') issueEntry.notes = issue.notes;
    target.issues.push(issueEntry);

    logInfo(`Issue #${n} agregado a ola ${waveNumber}.`);
    saveState(state, {
        updated_by: meta.updated_by || 'System',
        source: meta.source || 'manual',
        note: meta.note || `add issue #${n} → wave ${waveNumber}`,
    });
}

/**
 * Promueve una ola planificada a activa. La ola activa anterior (si existe)
 * pasa a archived_waves con métricas de cierre.
 *
 * @example
 *   promoteWaveToActive(2, { updated_by: 'Commander', note: 'cierre N+8' });
 *
 * @param {number} waveNumber
 * @param {Object} [metadata] — { updated_by?: string, source?: string, note?: string }
 * @throws si la ola planificada no existe
 */
function promoteWaveToActive(waveNumber, metadata = {}) {
    const state = loadWaves();
    const idx = state.planned_waves.findIndex((x) => x.number === waveNumber);
    if (idx < 0) {
        throw new Error(`promoteWaveToActive: ola planificada ${waveNumber} no existe`);
    }

    // Archivar la activa previa (si la hay) con métricas.
    if (state.active_wave) {
        const prev = state.active_wave;
        const issues = Array.isArray(prev.issues) ? prev.issues : [];
        const completed = issues.filter((i) => i.status === 'completed').length;
        const failed = issues.filter((i) => i.status === 'failed' || i.status === 'blocked').length;
        let durationDays = null;
        if (typeof prev.started_at === 'string') {
            const startedMs = Date.parse(prev.started_at);
            if (Number.isFinite(startedMs)) {
                durationDays = Math.max(0, Math.round((Date.now() - startedMs) / 86400000));
            }
        }
        state.archived_waves.push({
            number: prev.number,
            name: prev.name || `Ola ${prev.number}`,
            goal: prev.goal || null,
            closed_at: nowIso(),
            issues_completed: completed,
            issues_failed: failed,
            actual_duration_days: durationDays,
        });
        logInfo(`Ola ${prev.number} archivada (completed=${completed}, failed=${failed}).`);
    }

    // Promover la planificada.
    const next = state.planned_waves[idx];
    state.planned_waves.splice(idx, 1);
    next.started_at = nowIso();
    state.active_wave = next;

    logInfo(`Ola ${waveNumber} promovida a activa.`);
    saveState(state, {
        updated_by: metadata.updated_by || 'System',
        source: metadata.source || 'manual',
        note: metadata.note || `promote wave ${waveNumber} → active`,
    });
}

/**
 * Allowlist de issues procesables por el pipeline desde la ola activa.
 * Filtra issues con status `completed`. Compatible con consumers de
 * `.partial-pause.json` (return: number[]).
 *
 * Backward compat: si waves.json no tiene ola activa con issues, cae a leer
 * `.partial-pause.json` (migration path).
 *
 * @example
 *   const allowed = getAllowlist();
 *   // → [3451, 3452, 3453]
 *
 * @returns {number[]} números de issue
 */
function getAllowlist() {
    const active = getActiveWave();
    if (active && Array.isArray(active.issues) && active.issues.length > 0) {
        return active.issues
            .filter((i) => i.status !== 'completed')
            .map((i) => normalizeIssue(i.number))
            .filter(Boolean);
    }
    // Fallback a .partial-pause.json para no romper consumers durante la transición.
    try {
        const raw = fs.readFileSync(partialFile(), 'utf8');
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed.allowed_issues) ? parsed.allowed_issues : [];
        return arr.map(normalizeIssue).filter(Boolean);
    } catch {
        return [];
    }
}

/**
 * Obtiene los issues que bloquean al dado, según `dependencies[]`.
 *
 * @example
 *   const blockers = getBlockingIssues(3452);
 *   // → [3451]
 *
 * @param {number} issueNumber
 * @returns {number[]}
 */
function getBlockingIssues(issueNumber) {
    const n = normalizeIssue(issueNumber);
    if (!n) return [];
    const state = loadWaves();
    return state.dependencies
        .filter((d) => normalizeIssue(d.blocked) === n)
        .map((d) => normalizeIssue(d.blocker))
        .filter(Boolean);
}

/**
 * Horizonte de planificación: ola activa + N olas planificadas.
 *
 * @example
 *   const horizon = getHorizon(3);
 *   // → [activa, planned[0], planned[1], planned[2]]
 *
 * @param {number} [N=5]
 * @returns {Array<Object>}
 */
function getHorizon(N) {
    const limit = Number.isInteger(N) && N > 0 ? N : 5;
    const state = loadWaves();
    const out = [];
    if (state.active_wave) out.push({ ...state.active_wave, status: 'active' });
    for (const w of state.planned_waves.slice(0, limit)) {
        out.push({ ...w, status: 'planned' });
    }
    return out;
}

/**
 * Valida el schema de waves.json. Nunca lanza excepción.
 *
 * @example
 *   if (!validate()) console.warn('schema inválido');
 *
 * @returns {boolean} true si schema válido, false + log si hay errores
 */
function validate() {
    // validate() debe inspeccionar el contenido REAL del disco, no la versión
    // normalizada que loadWaves() devuelve (loadWaves tolera y rellena defaults).
    // Si waves.json no existe, validamos el esqueleto vacío (siempre válido).
    const raw = readWavesFromDisk(wavesFile()) || emptyState();
    const errors = [];
    if (raw.version !== SCHEMA_VERSION) {
        errors.push(`version esperada ${SCHEMA_VERSION}, recibida ${raw.version}`);
    }
    if (!raw.meta || typeof raw.meta !== 'object') {
        errors.push('meta ausente o no-objeto');
    }
    if (raw.active_wave !== null && raw.active_wave !== undefined && typeof raw.active_wave !== 'object') {
        errors.push('active_wave debe ser objeto o null');
    }
    if (raw.planned_waves !== undefined && !Array.isArray(raw.planned_waves)) {
        errors.push('planned_waves debe ser array');
    }
    if (raw.archived_waves !== undefined && !Array.isArray(raw.archived_waves)) {
        errors.push('archived_waves debe ser array');
    }
    if (raw.dependencies !== undefined && !Array.isArray(raw.dependencies)) {
        errors.push('dependencies debe ser array');
    }
    // Cruzar duplicados de issue entre olas activas/planificadas — solo si los
    // tipos son arrays válidos (sino ya reportamos error de schema arriba).
    const seen = new Map(); // issueNumber → waveNumber
    const plannedSafe = Array.isArray(raw.planned_waves) ? raw.planned_waves : [];
    const activeSafe = raw.active_wave && typeof raw.active_wave === 'object' ? [raw.active_wave] : [];
    const allActive = [...activeSafe, ...plannedSafe];
    for (const w of allActive) {
        if (!Array.isArray(w.issues)) continue;
        for (const i of w.issues) {
            const n = normalizeIssue(i && i.number);
            if (!n) continue;
            if (seen.has(n)) {
                errors.push(`issue #${n} duplicado en olas ${seen.get(n)} y ${w.number}`);
            } else {
                seen.set(n, w.number);
            }
        }
    }
    if (errors.length > 0) {
        logWarn(`validate(): ${errors.length} error(es) — ${errors.join('; ')}`);
        return false;
    }
    return true;
}

/**
 * Persiste waves.json a disco con auditoría + backup atómico.
 *
 * Atomicidad: escribe a `waves.json.tmp` y luego renameSync.
 * Backup: snapshot timestamped en `.pipeline/archived/waves.<ts>.json`.
 *
 * @example
 *   save({ note: 'cierre manual', updated_by: 'Commander', source: 'telegram' });
 *
 * @param {Object} [metadata] — { note?: string, updated_by?: string, source?: string }
 */
function save(metadata = {}) {
    const state = loadWaves();
    saveState(state, metadata);
}

/**
 * Variante interna: persiste un state ya construido (evita re-load).
 */
function saveState(state, metadata = {}) {
    if (!state.meta) state.meta = {};
    state.meta.updated_at = nowIso();
    if (metadata.updated_by) state.meta.updated_by = metadata.updated_by;
    if (metadata.source) state.meta.source = metadata.source;
    if (metadata.note) state.meta.note = metadata.note;
    if (!state.meta.created_at) state.meta.created_at = state.meta.updated_at;

    // Backup ANTES de sobreescribir (si existe waves.json previo).
    try {
        if (fs.existsSync(wavesFile())) {
            ensureDir(archivedDir());
            const ts = state.meta.updated_at.replace(/[:.]/g, '-');
            const backup = path.join(archivedDir(), `waves.${ts}.json`);
            try {
                fs.copyFileSync(wavesFile(), backup);
            } catch (err) {
                logWarn(`No se pudo crear backup ${backup}: ${err.message}`);
            }
        }
    } catch (err) {
        logWarn(`Error preparando backup: ${err.message}`);
    }

    // Write atómico: tmp + renameSync.
    const tmp = wavesFile() + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, wavesFile());
    } catch (err) {
        logWarn(`Error escribiendo waves.json: ${err.message}`);
        try { fs.unlinkSync(tmp); } catch {}
        throw err;
    }

    // Invalidar cache post-save.
    invalidateCache();
    logInfo(`waves.json persistido (updated_by=${state.meta.updated_by}, source=${state.meta.source}).`);
}

/**
 * Invalida la cache in-process. Útil cuando otro proceso modifica waves.json.
 *
 * @example
 *   invalidateCache();
 *   const fresh = loadWaves();
 */
function invalidateCache() {
    cache.clear();
}

module.exports = {
    // API pública
    loadWaves,
    listWaves,
    getActiveWave,
    getPlannedWave,
    addIssueToWave,
    promoteWaveToActive,
    getAllowlist,
    getBlockingIssues,
    getHorizon,
    validate,
    save,
    invalidateCache,
    // Constantes públicas
    SCHEMA_VERSION,
    CACHE_TTL_MS,
    // Helpers expuestos para tests
    _paths: () => ({
        WAVES_FILE: wavesFile(),
        ARCHIVED_DIR: archivedDir(),
        PARTIAL_FILE: partialFile(),
    }),
    _internal: {
        normalizeIssue,
        emptyState,
        saveState,
    },
};
