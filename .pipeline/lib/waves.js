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
const crypto = require('crypto');

const SCHEMA_VERSION = '1.0';
const CACHE_TTL_MS = 2000;

// #3520 — TTL para considerar un marker `wave-promote.in-progress.json`
// como stale (rollback automático). Configurable vía env para tests.
const DEFAULT_PROMOTE_RECOVERY_TTL_MS = 30 * 1000;

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

// #3520 — markers de la transacción /wave promote (multi-archivo).
function promoteMarkerFile() { return path.join(pipelineDir(), 'wave-promote.in-progress.json'); }
function promoteRecoveringMarkerFile(pid) {
    return path.join(pipelineDir(), `wave-promote.recovering.${pid}.json`);
}
function promoteFailedDir() { return pipelineDir(); }
function listPromoteFailedMarkers() {
    try {
        return fs.readdirSync(pipelineDir())
            .filter((f) => /^wave-promote\.failed\..+\.json$/.test(f))
            .map((f) => path.join(pipelineDir(), f));
    } catch {
        return [];
    }
}

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

// ─── #3520 — Transacción multi-archivo para /wave promote ───────────────────
//
// /wave promote debe actualizar dos archivos en orden:
//   1. waves.json — promueve planned_waves[0] → active_wave
//   2. .partial-pause.json — actualiza allowlist con issues de la nueva ola
//
// Si el proceso muere entre el paso 1 y el paso 2 (OOM, kill -9, restart),
// queda un estado inconsistente: waves.json dice que la ola N+1 está activa
// pero la allowlist sigue apuntando a la ola N. El pulpo procesa con allowlist
// stale → posible reactivación accidental de issues de la ola anterior.
//
// Esta sección implementa:
//   - `promoteWaveAtomic`         — wrapper transaccional (snapshot + apply +
//                                    rollback). Único punto de entrada usado
//                                    por commander-deterministic.handleWavePromote.
//   - `recoverIncompletePromote`  — boot hook invocado por pulpo.js. Detecta
//                                    marker stale (>TTL) y restaura.
//   - `isWavePromoteBlocked`      — gate fail-closed para que el Commander
//                                    rechace /wave promote cuando hay un
//                                    .failed.<ts>.json activo.
//
// Hardening (CA-E1..E4):
//   - Marker file escrito con `wx` + `fsyncSync(fd)` — sino el crash en
//     pagecache es invisible al boot.
//   - Backups vía `copyFileSync` (preserva permisos/owner), nunca writeFileSync.
//   - PID en marker es informativo — la decisión de rollback se basa en
//     mtime + TTL (process.kill(pid, 0) es flaky en Windows).
//   - API pública existente no rompe — funciones nuevas son aditivas.
// ─────────────────────────────────────────────────────────────────────────────

function sha256Buffer(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
    try {
        return sha256Buffer(fs.readFileSync(filePath));
    } catch {
        return null;
    }
}

function nowMs() { return Date.now(); }

function ttlMs() {
    const envVal = Number(process.env.WAVE_PROMOTE_RECOVERY_TTL_MS);
    return Number.isFinite(envVal) && envVal > 0 ? envVal : DEFAULT_PROMOTE_RECOVERY_TTL_MS;
}

/**
 * Escribe el marker file con flag 'wx' (falla si ya existe) + fsync explícito.
 * fsync garantiza que ante un crash inmediato no queda el marker sólo en
 * pagecache (invisible al boot del siguiente pulpo).
 *
 * @param {string} markerPath
 * @param {Object} payload
 */
function writeMarkerFsync(markerPath, payload) {
    const content = JSON.stringify(payload, null, 2);
    // Modo 'wx' — si el marker existe es porque hay otra transacción en curso
    // o un crash previo que no fue recuperado. El caller debe abortar.
    const fd = fs.openSync(markerPath, 'wx', 0o600);
    try {
        fs.writeSync(fd, content);
        try { fs.fsyncSync(fd); } catch { /* fsync puede no estar disponible en algunos FS de test */ }
    } finally {
        try { fs.closeSync(fd); } catch {}
    }
}

/**
 * Actualiza un marker existente (sobrescribe). Sin 'wx' porque el archivo
 * ya existe — sólo cambiamos el phase. Mantiene fsync para que el cambio de
 * estado sobreviva un crash inmediato.
 */
function updateMarkerFsync(markerPath, payload) {
    const content = JSON.stringify(payload, null, 2);
    const fd = fs.openSync(markerPath, 'w', 0o600);
    try {
        fs.writeSync(fd, content);
        try { fs.fsyncSync(fd); } catch {}
    } finally {
        try { fs.closeSync(fd); } catch {}
    }
}

/**
 * Crea snapshot de `waves.json` y `.partial-pause.json` en `archived/`.
 * Usa `copyFileSync` (preserva permisos/owner) — nunca writeFileSync para .bak.
 * Devuelve los paths + SHA-256 + flags de existencia previa.
 *
 * @param {string} ts — timestamp string para el sufijo (ya sanitizado para FS).
 * @returns {{
 *   wavesBakPath: string|null, wavesBakSha: string|null, wavesExisted: boolean,
 *   partialBakPath: string|null, partialBakSha: string|null, partialExisted: boolean,
 * }}
 */
function snapshotForTransaction(ts) {
    ensureDir(archivedDir());

    const result = {
        wavesBakPath: null, wavesBakSha: null, wavesExisted: false,
        partialBakPath: null, partialBakSha: null, partialExisted: false,
    };

    // waves.json
    if (fs.existsSync(wavesFile())) {
        const bak = path.join(archivedDir(), `waves-rollback.${ts}.json`);
        fs.copyFileSync(wavesFile(), bak);
        result.wavesBakPath = bak;
        result.wavesBakSha = sha256File(bak);
        result.wavesExisted = true;
    }
    // .partial-pause.json
    if (fs.existsSync(partialFile())) {
        const bak = path.join(archivedDir(), `partial-pause-rollback.${ts}.json`);
        fs.copyFileSync(partialFile(), bak);
        result.partialBakPath = bak;
        result.partialBakSha = sha256File(bak);
        result.partialExisted = true;
    }
    return result;
}

/**
 * Restaura ambos archivos desde los snapshots indicados por el marker.
 * Si el marker indica que un archivo no existía antes, lo borra (rollback a
 * estado pre-existente).
 *
 * Valida SHA-256 antes de restaurar (fail-closed si hay mismatch o .bak ausente).
 *
 * @param {Object} marker
 * @returns {{
 *   ok: boolean, reason?: string,
 *   wavesRestored: boolean, partialRestored: boolean,
 * }}
 */
function restoreFromSnapshots(marker) {
    const out = { ok: false, wavesRestored: false, partialRestored: false };

    // Validar SHAs antes de restaurar — fail-closed.
    if (marker.waves_bak_path) {
        if (!fs.existsSync(marker.waves_bak_path)) {
            out.reason = `waves backup ausente: ${marker.waves_bak_path}`;
            return out;
        }
        const currentSha = sha256File(marker.waves_bak_path);
        if (currentSha !== marker.waves_bak_sha) {
            out.reason = `SHA mismatch en waves backup (esperado ${marker.waves_bak_sha}, leído ${currentSha})`;
            return out;
        }
        // Parse defensivo — si el .bak no parsea, no escribimos basura.
        try { JSON.parse(fs.readFileSync(marker.waves_bak_path, 'utf8')); } catch (e) {
            out.reason = `JSON corrupto en waves backup: ${e.message}`;
            return out;
        }
    }
    if (marker.partial_bak_path) {
        if (!fs.existsSync(marker.partial_bak_path)) {
            out.reason = `partial backup ausente: ${marker.partial_bak_path}`;
            return out;
        }
        const currentSha = sha256File(marker.partial_bak_path);
        if (currentSha !== marker.partial_bak_sha) {
            out.reason = `SHA mismatch en partial backup (esperado ${marker.partial_bak_sha}, leído ${currentSha})`;
            return out;
        }
        try { JSON.parse(fs.readFileSync(marker.partial_bak_path, 'utf8')); } catch (e) {
            out.reason = `JSON corrupto en partial backup: ${e.message}`;
            return out;
        }
    }

    // Restaurar waves.json
    if (marker.waves_bak_path) {
        const tmp = wavesFile() + '.recover.tmp';
        try {
            fs.copyFileSync(marker.waves_bak_path, tmp);
            fs.renameSync(tmp, wavesFile());
            out.wavesRestored = true;
        } catch (err) {
            try { fs.unlinkSync(tmp); } catch {}
            out.reason = `Error restaurando waves.json: ${err.message}`;
            return out;
        }
    } else if (marker.waves_existed === false) {
        // No existía antes — si por algún motivo existe ahora, borrarlo.
        try {
            if (fs.existsSync(wavesFile())) fs.unlinkSync(wavesFile());
            out.wavesRestored = true;
        } catch (err) {
            out.reason = `Error eliminando waves.json (rollback a pre-existencia): ${err.message}`;
            return out;
        }
    }

    // Restaurar .partial-pause.json
    if (marker.partial_bak_path) {
        const tmp = partialFile() + '.recover.tmp';
        try {
            fs.copyFileSync(marker.partial_bak_path, tmp);
            fs.renameSync(tmp, partialFile());
            out.partialRestored = true;
        } catch (err) {
            try { fs.unlinkSync(tmp); } catch {}
            out.reason = `Error restaurando .partial-pause.json: ${err.message}`;
            return out;
        }
    } else if (marker.partial_existed === false) {
        try {
            if (fs.existsSync(partialFile())) fs.unlinkSync(partialFile());
            out.partialRestored = true;
        } catch (err) {
            out.reason = `Error eliminando .partial-pause.json (rollback a pre-existencia): ${err.message}`;
            return out;
        }
    }

    out.ok = true;
    return out;
}

/**
 * Promueve una ola planificada a activa **atómicamente** junto con la
 * actualización del allowlist en `.partial-pause.json`.
 *
 * Garantías:
 *   - Si crashea entre los dos writes, el boot del próximo pulpo
 *     (vía `recoverIncompletePromote`) restaura ambos archivos al estado
 *     pre-promote.
 *   - Si la segunda escritura falla con excepción, el catch local restaura
 *     ambos archivos inmediatamente.
 *   - Marker file `wave-promote.in-progress.json` se escribe con fsync
 *     ANTES de tocar ninguno de los dos archivos productivos.
 *
 * Errores:
 *   - Lanza si la ola planificada no existe (misma semántica que
 *     `promoteWaveToActive`).
 *   - Lanza si ya existe un marker `wave-promote.in-progress.json` (otra
 *     transacción activa o crash no recuperado).
 *   - Lanza si hay un `wave-promote.failed.<ts>.json` activo (fail-closed:
 *     /wave promote queda bloqueado hasta intervención manual).
 *
 * @param {number} waveNumber
 * @param {Object} [metadata] — { updated_by?, source?, note? }
 * @returns {{
 *   oldWaveNumber: number|null,
 *   newWaveNumber: number,
 *   newWaveName: string,
 *   newAllowlist: number[],
 *   prevAllowlist: number[],
 *   added: number[],
 *   removed: number[],
 *   snapshotPaths: { waves: string|null, partial: string|null },
 * }}
 */
function promoteWaveAtomic(waveNumber, metadata = {}) {
    // Gate fail-closed: si hay .failed.* activo, abortamos sin intentar.
    const failedMarkers = listPromoteFailedMarkers();
    if (failedMarkers.length > 0) {
        const names = failedMarkers.map((p) => path.basename(p)).join(', ');
        throw new Error(
            `wave-promote bloqueado por fail-closed marker(s): ${names}. ` +
            `Inspeccioná y borrá manualmente para destrabar.`
        );
    }

    // Gate de doble-transacción: si hay marker in-progress vivo, otra
    // promoción está en curso o hubo un crash. El recovery boot-time es el
    // único habilitado a tocar ese marker.
    if (fs.existsSync(promoteMarkerFile())) {
        throw new Error(
            `wave-promote ya tiene una transacción en curso (${promoteMarkerFile()}). ` +
            `Esperá al boot recovery o borrá el marker manualmente si sabés que es stale.`
        );
    }

    invalidateCache();
    const state = loadWaves();
    const idx = state.planned_waves.findIndex((x) => x.number === waveNumber);
    if (idx < 0) {
        throw new Error(`promoteWaveAtomic: ola planificada ${waveNumber} no existe`);
    }
    const oldWaveNumber = state.active_wave ? state.active_wave.number : null;
    const newWave = state.planned_waves[idx];
    const newWaveName = newWave.name || `Ola ${waveNumber}`;

    // Snapshot allowlist previa (para diff added/removed en CA-D1).
    let prevAllowlist = [];
    try {
        if (fs.existsSync(partialFile())) {
            const parsed = JSON.parse(fs.readFileSync(partialFile(), 'utf8'));
            prevAllowlist = Array.isArray(parsed.allowed_issues)
                ? parsed.allowed_issues.map(normalizeIssue).filter(Boolean)
                : [];
        }
    } catch { /* defensivo: si no parsea, prev queda vacío */ }

    // 1. Snapshot atómico de ambos archivos.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const snap = snapshotForTransaction(ts);

    // 2. Marker con fsync ANTES de tocar producción.
    const markerPayload = {
        started_at: new Date().toISOString(),
        pid: process.pid,
        phase: 'snapshot',
        wave_number_from: oldWaveNumber,
        wave_number_to: waveNumber,
        waves_bak_path: snap.wavesBakPath,
        waves_bak_sha: snap.wavesBakSha,
        waves_existed: snap.wavesExisted,
        partial_bak_path: snap.partialBakPath,
        partial_bak_sha: snap.partialBakSha,
        partial_existed: snap.partialExisted,
    };
    try {
        writeMarkerFsync(promoteMarkerFile(), markerPayload);
    } catch (err) {
        // Si el marker no se pudo crear (ej. EEXIST race), abortamos limpio.
        throw new Error(`No pude crear marker transaccional: ${err.message}`);
    }

    // 3. Apply transaccional.
    let newAllowlist = [];
    try {
        // Phase: writing — registramos antes de tocar waves.json.
        updateMarkerFsync(promoteMarkerFile(), { ...markerPayload, phase: 'writing' });

        // Paso 1: promover en waves.json.
        promoteWaveToActive(waveNumber, {
            updated_by: metadata.updated_by || 'System',
            source: metadata.source || 'wave-promote-atomic',
            note: metadata.note || `promote wave ${waveNumber} → active (atomic)`,
        });
        invalidateCache();

        // Paso 2: aplicar allowlist nueva.
        newAllowlist = getAllowlist();
        const partialPause = require('./partial-pause');
        partialPause.setPartialPauseAtomic(newAllowlist, {
            source: metadata.source || 'wave-promote-atomic',
        });
    } catch (err) {
        // Rollback inmediato: ambos archivos vuelven al snapshot.
        logWarn(`promoteWaveAtomic falló mid-transaction: ${err.message}. Restaurando snapshots.`);
        const restore = restoreFromSnapshots(markerPayload);
        if (!restore.ok) {
            // Rollback inline falló — escribir .failed.<ts> y dejar marker para forensics.
            const failedPath = path.join(promoteFailedDir(), `wave-promote.failed.${ts}.json`);
            try {
                fs.writeFileSync(failedPath, JSON.stringify({
                    failed_at: new Date().toISOString(),
                    reason: `inline-rollback-failed: ${restore.reason}`,
                    original_error: err.message,
                    marker: markerPayload,
                }, null, 2));
            } catch { /* best-effort */ }
            throw new Error(
                `Rollback inline FALLÓ tras error original "${err.message}". ` +
                `Razón rollback: ${restore.reason}. ` +
                `Marker conservado + .failed escrito en ${failedPath}.`
            );
        }
        // Cleanup marker (rollback OK) + propagar excepción original.
        try { fs.unlinkSync(promoteMarkerFile()); } catch {}
        throw err;
    }

    // 4. Commit final: marker phase=done → unlink. Snapshots .bak los conservamos
    //    sólo durante la transacción; el archived/waves.<ts>.json que genera
    //    saveState() ya provee el backup permanente para forensics.
    try {
        updateMarkerFsync(promoteMarkerFile(), { ...markerPayload, phase: 'done' });
    } catch { /* si no se puede sellar phase=done, igual borramos abajo */ }
    try { fs.unlinkSync(promoteMarkerFile()); } catch {}
    // Borramos los .bak temporales: ya cerramos exitosamente.
    if (snap.wavesBakPath && fs.existsSync(snap.wavesBakPath)) {
        try { fs.unlinkSync(snap.wavesBakPath); } catch {}
    }
    if (snap.partialBakPath && fs.existsSync(snap.partialBakPath)) {
        try { fs.unlinkSync(snap.partialBakPath); } catch {}
    }

    // Diff added/removed para el mensaje UX (CA-D1).
    const prevSet = new Set(prevAllowlist);
    const newSet = new Set(newAllowlist);
    const added = [...newSet].filter((x) => !prevSet.has(x));
    const removed = [...prevSet].filter((x) => !newSet.has(x));

    return {
        oldWaveNumber,
        newWaveNumber: waveNumber,
        newWaveName,
        newAllowlist,
        prevAllowlist,
        added,
        removed,
        snapshotPaths: { waves: snap.wavesBakPath, partial: snap.partialBakPath },
    };
}

/**
 * Boot hook invocado por `pulpo.js` ANTES de procesar issues.
 *
 * Comportamiento:
 *   - Si no hay marker → no-op (no había transacción interrumpida).
 *   - Si hay marker fresco (<TTL) → log info, no actúa (otro pulpo o
 *     transacción legítima en curso).
 *   - Si hay marker stale (>TTL) → intenta lockear con rename atómico
 *     a `wave-promote.recovering.<pid>.json`. Si pierde la carrera
 *     (ENOENT al renombrar porque otro proceso ya lo hizo) → no actúa.
 *   - Tras lock, valida SHAs y restaura ambos archivos. Si falla la
 *     validación → escribe `wave-promote.failed.<ts>.json` y CONSERVA
 *     marker + bak (fail-closed). El Commander bloquea /wave promote
 *     hasta intervención manual.
 *   - Si restaura OK → renombra los `.bak` a `.recovered.<ts>.json`
 *     (forensics — no borrar evidence de rollback automático). Borra
 *     marker.
 *
 * **Idempotente**: ejecutar N veces produce el mismo resultado.
 *
 * @returns {{
 *   action: 'noop'|'in_progress'|'recovered'|'failed'|'lock_lost',
 *   reason?: string,
 *   markerPath?: string,
 *   wavesRestored?: boolean,
 *   partialRestored?: boolean,
 *   recoveredPaths?: { waves: string|null, partial: string|null },
 *   failedMarkerPath?: string,
 *   originalMarker?: Object,
 * }}
 */
function recoverIncompletePromote() {
    const markerPath = promoteMarkerFile();
    if (!fs.existsSync(markerPath)) {
        return { action: 'noop' };
    }

    // mtime check para decidir si actuamos.
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(markerPath).mtimeMs; } catch { /* defensivo */ }
    const ageMs = nowMs() - mtimeMs;
    if (ageMs < ttlMs()) {
        return {
            action: 'in_progress',
            reason: `marker fresco (age=${Math.round(ageMs)}ms < TTL=${ttlMs()}ms)`,
            markerPath,
        };
    }

    // Lock atómico vía rename: el primero gana.
    const recoveringPath = promoteRecoveringMarkerFile(process.pid);
    try {
        fs.renameSync(markerPath, recoveringPath);
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            // Otro pulpo ya nos ganó la carrera y se llevó el marker.
            return { action: 'lock_lost', reason: 'rename ENOENT — otro proceso ya capturó el marker' };
        }
        // Otro tipo de error — registramos pero no rompemos el boot.
        logWarn(`recoverIncompletePromote: lock falló: ${err.message}`);
        return { action: 'lock_lost', reason: err.message };
    }

    // Leer marker desde el recovering path.
    let marker;
    try {
        marker = JSON.parse(fs.readFileSync(recoveringPath, 'utf8'));
    } catch (err) {
        // Marker corrupto — fail-closed.
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const failedPath = path.join(promoteFailedDir(), `wave-promote.failed.${ts}.json`);
        try {
            fs.writeFileSync(failedPath, JSON.stringify({
                failed_at: new Date().toISOString(),
                reason: `marker corrupto: ${err.message}`,
                marker_path: recoveringPath,
            }, null, 2));
        } catch {}
        logWarn(`recoverIncompletePromote: marker corrupto, escribí ${failedPath}`);
        return { action: 'failed', reason: `marker corrupto: ${err.message}`, failedMarkerPath: failedPath };
    }

    // Restaurar (fail-closed con SHA + parse validation).
    const restore = restoreFromSnapshots(marker);
    if (!restore.ok) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const failedPath = path.join(promoteFailedDir(), `wave-promote.failed.${ts}.json`);
        try {
            fs.writeFileSync(failedPath, JSON.stringify({
                failed_at: new Date().toISOString(),
                reason: restore.reason,
                marker,
            }, null, 2));
        } catch {}
        // CONSERVAR marker (renombrado a recovering) + bak para forensics.
        // No borramos nada — el operador necesita inspeccionar.
        logWarn(
            `recoverIncompletePromote: fail-closed. ${restore.reason}. ` +
            `Marker conservado en ${recoveringPath}. Failed marker: ${failedPath}.`
        );
        return {
            action: 'failed',
            reason: restore.reason,
            failedMarkerPath: failedPath,
            originalMarker: marker,
            markerPath: recoveringPath,
        };
    }

    // Rollback OK — preservar evidence renombrando los .bak a .recovered.<ts>.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const recoveredPaths = { waves: null, partial: null };
    if (marker.waves_bak_path && fs.existsSync(marker.waves_bak_path)) {
        const dest = path.join(archivedDir(), `waves.recovered.${ts}.json`);
        try {
            fs.renameSync(marker.waves_bak_path, dest);
            recoveredPaths.waves = dest;
        } catch (err) {
            logWarn(`No pude renombrar ${marker.waves_bak_path} → ${dest}: ${err.message}`);
        }
    }
    if (marker.partial_bak_path && fs.existsSync(marker.partial_bak_path)) {
        const dest = path.join(archivedDir(), `partial-pause.recovered.${ts}.json`);
        try {
            fs.renameSync(marker.partial_bak_path, dest);
            recoveredPaths.partial = dest;
        } catch (err) {
            logWarn(`No pude renombrar ${marker.partial_bak_path} → ${dest}: ${err.message}`);
        }
    }

    // Cleanup marker recovering — ya cumplió.
    try { fs.unlinkSync(recoveringPath); } catch {}

    // Cache invalidation: el state cambió.
    invalidateCache();

    logWarn(
        `[recovery] /wave promote crashed at ${marker.started_at} (wave ${marker.wave_number_from} → ${marker.wave_number_to}), ` +
        `restaurado desde snapshot. waves=${restore.wavesRestored} partial=${restore.partialRestored}.`
    );

    return {
        action: 'recovered',
        markerPath,
        wavesRestored: restore.wavesRestored,
        partialRestored: restore.partialRestored,
        recoveredPaths,
        originalMarker: marker,
    };
}

/**
 * Indica si /wave promote está bloqueado por fail-closed.
 * El Commander consulta esto antes de invocar promoteWaveAtomic para emitir
 * el mensaje de bloqueo con instrucciones (CA-C3 + CA-D3).
 *
 * @returns {{ blocked: boolean, markers: string[] }}
 */
function isWavePromoteBlocked() {
    const markers = listPromoteFailedMarkers();
    return { blocked: markers.length > 0, markers };
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
    // #3520 — transacción multi-archivo
    promoteWaveAtomic,
    recoverIncompletePromote,
    isWavePromoteBlocked,
    // Constantes públicas
    SCHEMA_VERSION,
    CACHE_TTL_MS,
    // Helpers expuestos para tests
    _paths: () => ({
        WAVES_FILE: wavesFile(),
        ARCHIVED_DIR: archivedDir(),
        PARTIAL_FILE: partialFile(),
        PROMOTE_MARKER_FILE: promoteMarkerFile(),
    }),
    _internal: {
        normalizeIssue,
        emptyState,
        saveState,
        // #3520 helpers visibles a tests para inyectar crashes / inspeccionar.
        snapshotForTransaction,
        restoreFromSnapshots,
        writeMarkerFsync,
        updateMarkerFsync,
        listPromoteFailedMarkers,
    },
};
