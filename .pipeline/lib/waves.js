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
const { withLockSync } = require('./file-lock');
const { notifyTelegram } = require('./notify-telegram');
const { redactSecretValue } = require('./redact');

const SCHEMA_VERSION = '1.0';
const CACHE_TTL_MS = 2000;

// ─── #4370 — Integridad, tipos estrictos y retención del estado ──────────────
// Campo top-level donde se persiste el hash de integridad canónico del estado
// (CA-4/SEC-3). Se omite del propio cómputo para evitar recursión.
const INTEGRITY_FIELD = 'integrity_hash';

// CA-6/SEC-5 — retención de backups en archived/. Conservamos los N más
// recientes por familia; el resto se rota (borra) con log. Configurable por env
// para tests.
const ARCHIVED_BACKUPS_KEEP = (() => {
    const v = Number(process.env.WAVES_ARCHIVED_KEEP);
    return Number.isInteger(v) && v > 0 ? v : 20;
})();

// CA-6/SEC-5 — límites anti-OOM al validar un estado potencialmente hostil
// (restore/boot de un waves.json que un atacante podría inflar).
const MAX_WAVES_PER_BUCKET = 500;         // planned_waves / archived_waves
const MAX_ISSUES_PER_WAVE = 2000;
const MAX_FREE_STRING_LEN = 20000;        // name/goal/note/source/updated_by/status/notes
const MAX_STATE_BYTES = 5 * 1024 * 1024;  // 5MB — waves.json real ≈ 3KB

// CA-3/SEC-2 — nombres de backup aceptados en restore desde un marker. El
// snapshot transaccional (`snapshotForTransaction`) genera exactamente estas dos
// familias; cualquier otro nombre se rechaza fail-closed.
const BACKUP_NAME_WHITELIST = /^(waves-rollback|partial-pause-rollback)\.[0-9A-Za-z._\-]+\.json$/;

// #3520 — TTL para considerar un marker `wave-promote.in-progress.json`
// como stale (rollback automático). Configurable vía env para tests.
const DEFAULT_PROMOTE_RECOVERY_TTL_MS = 30 * 1000;

// Reintentos para rename en Windows ante EPERM/EBUSY (antivirus, indexer, etc.)
const RENAME_MAX_RETRIES = 3;
const RENAME_RETRY_BACKOFF_MS = 50;

// Lock acquisition: 5s timeout, 3 retries con jitter.
const LOCK_TIMEOUT_MS = 5000;
const LOCK_MAX_RETRIES = 3;

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

// CA-7: validar que archived/ resuelva dentro de .pipeline/ — defensa en
// profundidad ante symlink traversal.
function assertArchivedDirSafe() {
    const root = path.resolve(pipelineDir());
    const target = path.resolve(archivedDir());
    if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error(`archived/ resuelve fuera de pipelineDir: ${target} ∉ ${root}`);
    }
    if (fs.existsSync(target)) {
        let real;
        try { real = fs.realpathSync(target); } catch { real = target; }
        if (real !== root && !real.startsWith(root + path.sep)) {
            throw new Error(`archived/ symlink apunta fuera de pipelineDir: ${real} ∉ ${root}`);
        }
    }
}

/**
 * Write atómico con fsync y reintentos en Windows (CA-1, CA-2 shared helper).
 * Exportado para que partial-pause.js use la misma implementación (DRY).
 */
function atomicWriteFile(targetPath, data) {
    const tmp = targetPath + '.tmp';
    let wroteTmp = false;
    try {
        fs.writeFileSync(tmp, data);
        wroteTmp = true;
        const fd = fs.openSync(tmp, 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }

        let attempt = 0;
        let lastErr = null;
        while (attempt < RENAME_MAX_RETRIES) {
            try {
                fs.renameSync(tmp, targetPath);
                wroteTmp = false;
                return;
            } catch (err) {
                lastErr = err;
                const code = err && err.code;
                if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
                    attempt++;
                    const deadline = Date.now() + RENAME_RETRY_BACKOFF_MS;
                    while (Date.now() < deadline) { /* spin defensivo */ }
                    continue;
                }
                throw err;
            }
        }
        throw lastErr || new Error('rename agotó reintentos sin error específico');
    } finally {
        if (wroteTmp) {
            try { fs.unlinkSync(tmp); } catch {}
        }
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

    // CA-3 + lost-update fix: el read-modify-write completo debe correr bajo
    // lock, no solo el write. Antes, dos procesos podían loadWaves() del
    // mismo estado base, mutar en memoria, y el segundo saveState() pisaba
    // al primero. La reentrancia de withLockSync hace que el saveState
    // interno comparta este mismo lock sin re-adquirir.
    return withLockSync(wavesFile(), () => addIssueToWaveLocked(waveNumber, issue, n, meta), {
        component: 'waves-lock',
        timeoutMs: LOCK_TIMEOUT_MS,
        maxRetries: LOCK_MAX_RETRIES,
        notify: notifyTelegram,
    });
}

function addIssueToWaveLocked(waveNumber, issue, n, meta) {
    // CA-4: invalidar cache ANTES de leer. Garantiza que veamos el último
    // commit en disco sin depender de que el caller se acordara de hacerlo.
    invalidateCache();
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
 * Desasocia un issue de una ola PLANIFICADA. Sigue el patrón canónico
 * `fn()`+`fnLocked()` de `addIssueToWave`: el read-modify-write completo corre
 * bajo `withLockSync` (reentrante — el `saveState` interno comparte el lock).
 *
 * Política A04 (#4377 CA-2 / REQ-SEC-3): se RECHAZA desasociar sobre la ola
 * ACTIVA. Tocar la activa dispararía un re-sync de la allowlist (dep #4350,
 * fuera de scope). El enforcement vive acá, en el código — el chip
 * `ic-shield-lock` de UX es solo señalización cosmética, no defensa.
 *
 * Idempotencia (CA-2): si el issue no pertenece a la ola, es no-op sin escritura
 * espuria (no `saveState`).
 *
 * @example
 *   removeIssueFromWave(2, 3460, { updated_by: 'Commander', note: 'mal asignado' });
 *
 * @param {number} waveNumber — number de la ola planificada destino.
 * @param {number|string} issueNumber — issue a remover (tolera "#123" / " 123 ").
 * @param {Object} [meta] — { updated_by?: string, source?: string, note?: string }
 * @throws si `issueNumber` es inválido, la ola es la activa, o la ola no existe.
 */
function removeIssueFromWave(waveNumber, issueNumber, meta = {}) {
    const n = normalizeIssue(issueNumber);
    if (!n) {
        throw new Error(`removeIssueFromWave: issue.number inválido (${issueNumber})`);
    }
    return withLockSync(wavesFile(), () => removeIssueFromWaveLocked(waveNumber, n, meta), {
        component: 'waves-lock',
        timeoutMs: LOCK_TIMEOUT_MS,
        maxRetries: LOCK_MAX_RETRIES,
        notify: notifyTelegram,
    });
}

function removeIssueFromWaveLocked(waveNumber, n, meta) {
    // CA-7: invalidar cache ANTES de leer para ver el último commit en disco.
    invalidateCache();
    const state = loadWaves();

    // Política A04 (REQ-SEC-3): rechazar si el target es la ola ACTIVA.
    if (state.active_wave && state.active_wave.number === waveNumber) {
        throw new Error(`removeIssueFromWave: no se permite desasociar sobre la ola activa (${waveNumber}). Solo olas planificadas.`);
    }

    const target = (state.planned_waves || []).find((w) => w.number === waveNumber);
    if (!target) {
        throw new Error(`removeIssueFromWave: ola planificada ${waveNumber} no existe`);
    }

    // No-op idempotente (CA-2): el issue no está en la ola → sin saveState.
    if (!Array.isArray(target.issues) || !target.issues.some((i) => normalizeIssue(i.number) === n)) {
        logInfo(`Issue #${n} no está en ola ${waveNumber} — no-op idempotente.`);
        return;
    }

    target.issues = target.issues.filter((i) => normalizeIssue(i.number) !== n);
    logInfo(`Issue #${n} removido de ola ${waveNumber}.`);
    saveState(state, {
        updated_by: meta.updated_by || 'System',
        source: meta.source || 'manual',
        note: meta.note || `remove issue #${n} ← wave ${waveNumber}`,
    });
}

/**
 * Reordena las olas PLANIFICADAS según `newOrder` (lista de `number`). Sólo
 * permuta el orden del array `planned_waves`; el `number` (identidad) de cada
 * ola queda intacto — cambia el orden de PROCESAMIENTO, no la identidad.
 *
 * Validación estricta ANTES de mutar (CA-3 + REQ-SEC-1/2): `newOrder` debe ser
 * un array de enteros ≥1 (cierra prototype pollution — un array de primitivos
 * no lleva `__proto__`/`constructor` como claves) y una PERMUTACIÓN EXACTA del
 * multiset de `number` actuales: mismo largo, sin duplicados, sin faltantes,
 * sin `number` inexistentes. Cualquier input que no sea permutación se rechaza
 * sin persistir (nada de escritura parcial).
 *
 * @example
 *   reorderPlannedWaves([3, 2], { updated_by: 'Planner', note: 'priorizar N+9' });
 *
 * @param {number[]} newOrder — permutación exacta de los `number` planificados.
 * @param {Object} [meta] — { updated_by?: string, source?: string, note?: string }
 * @throws si `newOrder` no es array de enteros ≥1 o no es permutación exacta.
 */
function reorderPlannedWaves(newOrder, meta = {}) {
    return withLockSync(wavesFile(), () => reorderPlannedWavesLocked(newOrder, meta), {
        component: 'waves-lock',
        timeoutMs: LOCK_TIMEOUT_MS,
        maxRetries: LOCK_MAX_RETRIES,
        notify: notifyTelegram,
    });
}

function reorderPlannedWavesLocked(newOrder, meta) {
    // CA-7: leer el último commit en disco.
    invalidateCache();
    const state = loadWaves();

    // Tipo estricto (REQ-SEC-2): array de enteros ≥1. Rechaza no-array, floats,
    // negativos, NaN y strings. Un array de enteros no puede vehicular
    // prototype pollution (las claves peligrosas viajan en objetos, no acá).
    if (!Array.isArray(newOrder) || !newOrder.every((x) => Number.isInteger(x) && x >= 1)) {
        throw new Error('reorderPlannedWaves: newOrder debe ser un array de enteros ≥ 1');
    }

    const current = (state.planned_waves || []).map((w) => w.number);

    // Permutación exacta: mismo multiset, sin duplicados, sin faltantes,
    // sin `number` inexistentes. Comparamos ordenados + sin duplicados.
    const sortedA = [...current].sort((a, b) => a - b);
    const sortedB = [...newOrder].sort((a, b) => a - b);
    const isPerm = sortedA.length === sortedB.length
        && sortedA.every((v, i) => v === sortedB[i])
        && new Set(newOrder).size === newOrder.length;
    if (!isPerm) {
        throw new Error(`reorderPlannedWaves: newOrder no es permutación exacta de ${JSON.stringify(current)} (recibido ${JSON.stringify(newOrder)})`);
    }

    // Permutar SOLO el orden del array; `number` (identidad) intacto.
    state.planned_waves = newOrder.map((num) => state.planned_waves.find((w) => w.number === num));
    logInfo(`Olas planificadas reordenadas: ${JSON.stringify(current)} → ${JSON.stringify(newOrder)}.`);
    saveState(state, {
        updated_by: meta.updated_by || 'System',
        source: meta.source || 'manual',
        note: meta.note || `reorder planned waves ${JSON.stringify(current)} → ${JSON.stringify(newOrder)}`,
    });
}

/**
 * Promueve una ola planificada a activa. La ola activa anterior (si existe)
 * pasa a archived_waves con métricas de cierre.
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
    // Read-modify-write completo bajo lock (mismo fix que addIssueToWave).
    return withLockSync(wavesFile(), () => promoteWaveToActiveLocked(waveNumber, metadata), {
        component: 'waves-lock',
        timeoutMs: LOCK_TIMEOUT_MS,
        maxRetries: LOCK_MAX_RETRIES,
        notify: notifyTelegram,
    });
}

function promoteWaveToActiveLocked(waveNumber, metadata) {
    // CA-4: invalidar cache ANTES de leer (idem addIssueToWave).
    invalidateCache();
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

// ─── #3738 — Creación atómica de ola planificada ────────────────────────────
//
// `createPlannedWave` es el único punto de entrada para crear una ola
// planificada con N issues de una sola vez (lo consume el wizard "Crear nueva
// ola" del Dashboard V3). A diferencia de `addIssueToWave` (agrega a ola
// existente) y `promoteWaveAtomic` (planificada → activa), acá se materializa
// una `planned_waves[]` nueva con validación estricta de shape, bounds y
// duplicados, bajo el mismo `withLockSync(wavesFile())` que el resto de las
// mutaciones — la serialización con `/wave promote` y `addIssueToWave` ya queda
// garantizada (R4 del análisis de seguridad de #3738).
//
// Bounds de `concurrency_max` se leen de `config.yaml` (`waves.max_concurrency`),
// NUNCA del body del request (req 6/security). `window_minutes ∈ [5, 1440]` y
// `name` NFC ≤ 80 chars. La persistencia usa `saveState` → tmp+fsync+rename
// atómico + backup en `archived/` + validación schema strict pre-write.

// Defaults de los bounds (el techo de concurrencia se sobreescribe con
// `config.yaml` → `waves.max_concurrency` si está presente).
const WAVE_MAX_CONCURRENCY_DEFAULT = 10;
const WAVE_WINDOW_MIN_MINUTES = 5;
const WAVE_WINDOW_MAX_MINUTES = 1440;
const WAVE_NAME_MAX_LEN = 80;

function mkWavesError(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
}

/**
 * Lee el techo de concurrencia admisible desde `config.yaml`
 * (`waves.max_concurrency`). Defensa en profundidad: este valor SIEMPRE viene
 * del config server-side, jamás del request. Si el config no existe o no trae
 * la clave, cae al default seguro. Lazy-require de js-yaml con fallback para no
 * romper waves.js si la dependencia no estuviera disponible.
 *
 * @returns {number} techo de concurrencia (>=1)
 */
function readWaveMaxConcurrency() {
    try {
        // eslint-disable-next-line global-require
        const yaml = require('js-yaml');
        const cfgPath = path.join(pipelineDir(), 'config.yaml');
        const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
        const m = cfg.waves && cfg.waves.max_concurrency;
        if (Number.isInteger(m) && m >= 1) return m;
    } catch {
        // config ausente / yaml no disponible → default seguro.
    }
    return WAVE_MAX_CONCURRENCY_DEFAULT;
}

/**
 * Crea una ola planificada nueva con N issues de forma atómica.
 *
 * Contrato de validación (puede throw con `err.code`):
 *   - `name`: string NFC, 1..80 chars tras trim. Único en planned/active/archived
 *     (case-insensitive NFC) → si no, `EWAVES_DUPLICATE_NAME`.
 *   - `issues`: array no vacío de int>0 (o `{number}`), únicos dentro del array.
 *     Shape inválido → `EWAVES_SHAPE`. Algún issue ya en active/planned →
 *     `EWAVES_DUPLICATE_ISSUE`.
 *   - `concurrency_max`: int en [1, MAX_CONFIGURED] (de config.yaml) → si no,
 *     `EWAVES_BOUNDS`.
 *   - `window_minutes`: int en [5, 1440] → si no, `EWAVES_BOUNDS`.
 *
 * @example
 *   createPlannedWave(
 *     { name: 'Ola N+9', issues: [3801, 3802], concurrency_max: 3, window_minutes: 60 },
 *     { updated_by: 'operator-local', source: 'dashboard:wizard:ola' });
 *
 * @param {Object} spec — { name, goal?, issues, concurrency_max, window_minutes }
 * @param {Object} [meta] — { updated_by?, source?, note? }
 * @returns {{ waveNumber:number, wave:Object }}
 * @throws Error con `code` EWAVES_SHAPE | EWAVES_BOUNDS | EWAVES_DUPLICATE_NAME | EWAVES_DUPLICATE_ISSUE
 */
function createPlannedWave(spec, meta = {}) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        throw mkWavesError('createPlannedWave: spec debe ser objeto { name, issues, concurrency_max, window_minutes }', 'EWAVES_SHAPE');
    }

    // --- name ---
    const name = String(spec.name == null ? '' : spec.name).normalize('NFC').trim();
    if (name.length === 0 || name.length > WAVE_NAME_MAX_LEN) {
        throw mkWavesError(`createPlannedWave: name inválido (1..${WAVE_NAME_MAX_LEN} chars NFC)`, 'EWAVES_SHAPE');
    }
    if (name.indexOf('\x00') >= 0) {
        throw mkWavesError('createPlannedWave: name contiene byte NUL', 'EWAVES_SHAPE');
    }

    // --- issues: normalizar a int>0 únicos ---
    const rawIssues = Array.isArray(spec.issues) ? spec.issues : null;
    if (!rawIssues || rawIssues.length === 0) {
        throw mkWavesError('createPlannedWave: issues debe ser array no vacío', 'EWAVES_SHAPE');
    }
    const nums = [];
    for (const it of rawIssues) {
        const candidate = (it && typeof it === 'object') ? it.number : it;
        const n = normalizeIssue(candidate);
        if (!n) {
            throw mkWavesError(`createPlannedWave: issue inválido (${JSON.stringify(it)})`, 'EWAVES_SHAPE');
        }
        if (nums.includes(n)) {
            throw mkWavesError(`createPlannedWave: issue #${n} duplicado en el array`, 'EWAVES_SHAPE');
        }
        nums.push(n);
    }

    // --- bounds (techo desde config.yaml, NUNCA del body) ---
    const maxConcurrency = readWaveMaxConcurrency();
    const conc = spec.concurrency_max;
    if (!Number.isInteger(conc) || conc < 1 || conc > maxConcurrency) {
        throw mkWavesError(`createPlannedWave: concurrency_max fuera de rango [1, ${maxConcurrency}]`, 'EWAVES_BOUNDS');
    }
    const win = spec.window_minutes;
    if (!Number.isInteger(win) || win < WAVE_WINDOW_MIN_MINUTES || win > WAVE_WINDOW_MAX_MINUTES) {
        throw mkWavesError(`createPlannedWave: window_minutes fuera de rango [${WAVE_WINDOW_MIN_MINUTES}, ${WAVE_WINDOW_MAX_MINUTES}]`, 'EWAVES_BOUNDS');
    }

    const goal = typeof spec.goal === 'string' && spec.goal.trim().length > 0
        ? spec.goal.normalize('NFC').trim()
        : null;

    return withLockSync(
        wavesFile(),
        () => createPlannedWaveLocked({ name, nums, conc, win, goal }, meta),
        {
            component: 'waves-lock',
            timeoutMs: LOCK_TIMEOUT_MS,
            maxRetries: LOCK_MAX_RETRIES,
            notify: notifyTelegram,
        },
    );
}

function createPlannedWaveLocked({ name, nums, conc, win, goal }, meta) {
    // CA-4 (mismo patrón que addIssueToWave/promoteWaveToActive): invalidar cache
    // ANTES de leer para ver el último commit en disco (anti-TOCTOU contra
    // mutaciones concurrentes de otra ruta sobre waves.json).
    invalidateCache();
    const state = loadWaves();

    // Nombre único en planned/active/archived (NFC, case-insensitive).
    const nameKey = name.normalize('NFC').toLowerCase();
    const named = [state.active_wave, ...state.planned_waves, ...state.archived_waves].filter(Boolean);
    for (const w of named) {
        if (w.name && String(w.name).normalize('NFC').toLowerCase() === nameKey) {
            throw mkWavesError(`createPlannedWave: ya existe una ola con nombre "${name}" (ola ${w.number})`, 'EWAVES_DUPLICATE_NAME');
        }
    }

    // Ningún issue puede estar ya en active_wave ni en otra planned_waves[*].
    const activeAndPlanned = [state.active_wave, ...state.planned_waves].filter(Boolean);
    for (const w of activeAndPlanned) {
        if (!Array.isArray(w.issues)) continue;
        for (const i of w.issues) {
            const existing = normalizeIssue(i.number);
            if (existing && nums.includes(existing)) {
                throw mkWavesError(`createPlannedWave: issue #${existing} ya está en ola ${w.number} (${w.name || ''})`, 'EWAVES_DUPLICATE_ISSUE');
            }
        }
    }

    // Siguiente número de ola: max(todos) + 1.
    const allNumbers = named
        .map((w) => Number(w.number))
        .filter((x) => Number.isFinite(x));
    const nextNumber = (allNumbers.length ? Math.max(...allNumbers) : 0) + 1;

    const wave = {
        number: nextNumber,
        name,
        goal,
        concurrency_max: conc,
        window_minutes: win,
        issues: nums.map((n) => ({ number: n, status: 'pending' })),
    };
    state.planned_waves.push(wave);

    logInfo(`Ola planificada ${nextNumber} ("${name}") creada con ${nums.length} issue(s).`);
    saveState(state, {
        updated_by: meta.updated_by || 'System',
        source: meta.source || 'manual',
        note: meta.note || `create planned wave ${nextNumber} (${name})`,
    });

    return { waveNumber: nextNumber, wave: deepClone(wave) };
}

// #3616 — Dedupe del aviso "allowlist vacío" por boot del proceso. El módulo
// se carga una sola vez por pulpo, así que un flag in-memory alcanza para
// evitar spam Telegram cuando varios callers llaman a getAllowlist() en el
// mismo boot. Se resetea explícitamente en tests.
let _emptyAllowlistAlertedThisBoot = false;
function _resetEmptyAllowlistDedupeForTests() {
    _emptyAllowlistAlertedThisBoot = false;
}

/**
 * Allowlist de issues procesables por el pipeline desde la ola activa.
 * Filtra issues con status `completed`. Compatible con consumers de
 * `.partial-pause.json` (return: number[]).
 *
 * #3616 — **Sin fallback silencioso** a `.partial-pause.json`. Si waves.json
 * no tiene ola activa con issues, devuelve `[]` explícito + emite alerta
 * Telegram dedupada por boot (UNA sola vez por proceso). El init
 * `init-waves-from-partial.js` corre antes en `pulpo.js:boot()` y siembra
 * waves.json desde la allowlist operativa, así que en operación normal este
 * código sólo devuelve `[]` cuando realmente no hay planificación.
 *
 * El mensaje Telegram NO incluye contenido raw del filesystem (security req 3):
 * sólo el evento y la sugerencia accionable.
 *
 * @example
 *   const allowed = getAllowlist();
 *   // → [3451, 3452, 3453]  (ola activa)
 *   // → []                  (sin ola activa)
 *
 * @returns {number[]} números de issue
 */
function getAllowlist() {
    const active = getActiveWave();
    if (active && Array.isArray(active.issues) && active.issues.length > 0) {
        const issues = active.issues
            .filter((i) => i.status !== 'completed')
            .map((i) => normalizeIssue(i.number))
            .filter(Boolean);
        return issues;
    }
    // Sin ola activa con issues → allowlist vacía explícita. Alertar UNA vez
    // por boot para que el operador vea el problema en Telegram sin spam.
    if (!_emptyAllowlistAlertedThisBoot) {
        _emptyAllowlistAlertedThisBoot = true;
        try {
            notifyTelegram({
                level: 'warn',
                component: 'waves-allowlist',
                message: 'Pipeline sin ola activa — allowlist vacía',
                detail: 'No hay issues pendientes en waves.json. Si esperás algo en marcha, ' +
                    'iniciá con `/wave promote N+X` o revisá con `/wave status`.',
                action: 'Verificá planificación: `/wave status` o inspeccioná .pipeline/waves.json',
            });
        } catch (err) {
            logWarn(`alerta "allowlist vacío" falló: ${err.message}`);
        }
    }
    return [];
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
 *
 * Concurrencia: usa `withLock` sobre waves.json para serializar writes
 * destructivos del Commander. El lock se libera siempre en finally (CA-3).
 *
 * Integridad: el merge meta + read-modify-write se hace bajo el lock, con
 * re-read del disco para evitar last-write-wins basado en TTL cache stale
 * (security gap #c — Optimistic Concurrency Control vía re-load).
 *
 * Atomicidad: tmp + fsync + rename con retry EPERM/EBUSY en Windows (CA-1).
 *
 * Schema validation: el state que se persiste pasa por `validateStateStrict`
 * primero. Un state corrupto NO se escribe nunca (CA-5).
 */
function saveState(state, metadata = {}) {
    // CA-3: sync porque los callers existentes (addIssueToWave,
    // promoteWaveToActive y el commander) no esperan Promise. Cambiar a async
    // sería breaking. withLockSync usa busy-wait corto durante el jitter, lo
    // cual es aceptable para la frecuencia de escrituras destructivas (humano
    // por Telegram, no path caliente).
    return withLockSync(wavesFile(), () => saveStateLocked(state, metadata), {
        component: 'waves-lock',
        timeoutMs: LOCK_TIMEOUT_MS,
        maxRetries: LOCK_MAX_RETRIES,
        notify: notifyTelegram,
    });
}

function saveStateLocked(state, metadata = {}) {
    if (!state.meta) state.meta = {};
    state.meta.updated_at = nowIso();
    if (metadata.updated_by) state.meta.updated_by = metadata.updated_by;
    // CA-6/SEC-5 — redacción defensiva de secretos en campos libres provenientes
    // de Telegram (note/source). `redactSecretValue` sólo toca tokens que
    // parecen secretos (regex por proveedor + alta entropía) — texto normal
    // ("add issue #123 → wave 5") queda intacto.
    if (metadata.source) state.meta.source = redactSecretValue(String(metadata.source));
    if (metadata.note) state.meta.note = redactSecretValue(String(metadata.note));
    if (!state.meta.created_at) state.meta.created_at = state.meta.updated_at;

    // CA-5: validar shape ANTES de persistir. Un state inválido se rechaza
    // con excepción + alerta — preferimos perder el write a corromper disco.
    const validationErrors = validateStateStrict(state, { source: 'pre-write' });
    if (validationErrors.length > 0) {
        const msg = `waves.json: shape inválida pre-write — ${validationErrors.join('; ')}`;
        try {
            notifyTelegram({
                level: 'error',
                component: 'waves-schema',
                message: 'shape inválida detectada pre-write',
                detail: validationErrors.join('; '),
                action: 'Pipeline en modo human-block. Revisá el state antes de re-disparar el write.',
                diag: `jq . ${wavesFile()}.tmp 2>/dev/null || cat ${wavesFile()}.tmp`,
            });
        } catch {}
        const e = new Error(msg);
        e.code = 'EWAVES_SCHEMA';
        throw e;
    }

    // CA-7: validar archived/ antes de tocarlo (defensa symlink traversal).
    try { assertArchivedDirSafe(); } catch (err) {
        logWarn(`assertArchivedDirSafe falló: ${err.message}. Continuando sin backup.`);
    }

    // Backup ANTES de sobreescribir (si existe waves.json previo).
    try {
        if (fs.existsSync(wavesFile())) {
            ensureDir(archivedDir());
            // ts viene exclusivamente de state.meta.updated_at (derivado de
            // Date.now() vía nowIso) — security req: nunca de input externo.
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

    // CA-4/SEC-3 — sellar el estado con el hash de integridad canónico (omitiendo
    // el propio campo). Se computa DESPUÉS de la validación y del backup, sobre el
    // shape final que se persiste. Migración (CA-9): un waves.json legacy sin hash
    // queda sellado en este primer save.
    state[INTEGRITY_FIELD] = computeIntegrityHash(state);

    // Write atómico vía helper compartido (CA-1: tmp + fsync + rename + retry).
    try {
        atomicWriteFile(wavesFile(), JSON.stringify(state, null, 2));
    } catch (err) {
        logWarn(`Error escribiendo waves.json: ${err.message}`);
        throw err;
    }

    // Invalidar cache post-save.
    invalidateCache();
    logInfo(`waves.json persistido (updated_by=${state.meta.updated_by}, source=${state.meta.source}).`);

    // CA-6/SEC-5 — rotar backups fuera de transacción (best-effort). No corre si
    // hay un promote in-progress (rotateArchivedBackups lo detecta y se abstiene).
    try {
        rotateArchivedBackups();
    } catch (err) {
        logWarn(`[rotación] falló (no bloqueante): ${err.message}`);
    }
}

/**
 * Validación estricta de shape (CA-5). Devuelve array de errores.
 * Si hay 0 errores → state válido. Si hay > 0 → caller decide (excepción
 * vs degradación). Esta función NUNCA tira ni auto-repara.
 *
 * Comparado con `validate()` (legacy boolean + log), esta variante:
 *   - Es pura (no escribe a console).
 *   - Devuelve errores detallados accionables.
 *   - Es la base de la verificación pre-write y post-load strict.
 */
function isValidFreeString(v) {
    return typeof v === 'string' && v.length <= MAX_FREE_STRING_LEN;
}

/**
 * CA-5/SEC-4 — valida un objeto ola: tipos de campos libres (string) e
 * `issue.number` como entero positivo. Los campos libres fluyen a sinks
 * (dashboard=XSS, Telegram=markdown injection) e `issue.number` dispara trabajo
 * automático del pipeline — deben tener tipo estricto.
 */
function validateWaveObject(w, ctx, errors) {
    if (!w || typeof w !== 'object') {
        errors.push(`${ctx} debe ser objeto`);
        return;
    }
    // null se tolera como "ausente" (la producción setea `goal: prev.goal || null`).
    for (const f of ['name', 'goal', 'note', 'updated_by', 'source']) {
        if (w[f] !== undefined && w[f] !== null && !isValidFreeString(w[f])) {
            errors.push(`${ctx}.${f} debe ser string ≤${MAX_FREE_STRING_LEN} chars`);
        }
    }
    if (w.issues !== undefined && w.issues !== null) {
        if (!Array.isArray(w.issues)) {
            errors.push(`${ctx}.issues debe ser array`);
        } else {
            if (w.issues.length > MAX_ISSUES_PER_WAVE) {
                errors.push(`${ctx}.issues excede el límite (${w.issues.length} > ${MAX_ISSUES_PER_WAVE})`);
            }
            w.issues.forEach((iss, k) => {
                if (!iss || typeof iss !== 'object') {
                    errors.push(`${ctx}.issues[${k}] debe ser objeto`);
                    return;
                }
                if (!Number.isInteger(iss.number) || iss.number <= 0) {
                    errors.push(`${ctx}.issues[${k}].number debe ser entero positivo (recibido: ${JSON.stringify(iss.number)})`);
                }
                for (const f of ['status', 'notes']) {
                    if (iss[f] !== undefined && iss[f] !== null && !isValidFreeString(iss[f])) {
                        errors.push(`${ctx}.issues[${k}].${f} debe ser string ≤${MAX_FREE_STRING_LEN} chars`);
                    }
                }
            });
        }
    }
}

function validateStateStrict(raw, opts = {}) {
    const errors = [];
    if (!raw || typeof raw !== 'object') {
        errors.push('state debe ser objeto');
        return errors;
    }
    // CA-6/SEC-5 — cota de tamaño total anti-OOM (defensa ante un waves.json
    // hostil enorme en el load de arranque/restore). Se corta temprano para no
    // recorrer algo gigante.
    try {
        const bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
        if (bytes > MAX_STATE_BYTES) {
            errors.push(`state excede el límite de tamaño (${bytes} > ${MAX_STATE_BYTES} bytes)`);
            return errors;
        }
    } catch { /* ciclos u otros no-JSON: se detectan por los checks de tipo abajo */ }

    if (raw.version !== SCHEMA_VERSION) {
        errors.push(`version esperada ${SCHEMA_VERSION}, recibida ${JSON.stringify(raw.version)}`);
    }
    // CA-4 — integrity_hash, si está presente, debe ser SHA-256 hex de 64 chars.
    if (raw[INTEGRITY_FIELD] !== undefined
        && (typeof raw[INTEGRITY_FIELD] !== 'string' || !/^[0-9a-f]{64}$/.test(raw[INTEGRITY_FIELD]))) {
        errors.push('integrity_hash debe ser SHA-256 hex de 64 chars');
    }
    if (!raw.meta || typeof raw.meta !== 'object') {
        errors.push('meta ausente o no-objeto');
    } else {
        // meta.updated_at debe ser ISO parseable.
        if (typeof raw.meta.updated_at !== 'string' || !Number.isFinite(Date.parse(raw.meta.updated_at))) {
            errors.push(`meta.updated_at no es ISO string parseable (recibido: ${JSON.stringify(raw.meta.updated_at)})`);
        }
        // CA-5/SEC-4 — campos libres de meta deben ser string (null se tolera).
        for (const f of ['updated_by', 'source', 'note']) {
            if (raw.meta[f] !== undefined && raw.meta[f] !== null && !isValidFreeString(raw.meta[f])) {
                errors.push(`meta.${f} debe ser string ≤${MAX_FREE_STRING_LEN} chars`);
            }
        }
    }
    if (raw.active_wave !== null && raw.active_wave !== undefined && typeof raw.active_wave !== 'object') {
        errors.push(`active_wave debe ser objeto o null, recibido: ${typeof raw.active_wave}`);
    }
    if (raw.active_wave && typeof raw.active_wave === 'object') {
        validateWaveObject(raw.active_wave, 'active_wave', errors);
    }
    if (raw.planned_waves !== undefined && !Array.isArray(raw.planned_waves)) {
        errors.push('planned_waves debe ser array');
    } else if (Array.isArray(raw.planned_waves)) {
        if (raw.planned_waves.length > MAX_WAVES_PER_BUCKET) {
            errors.push(`planned_waves excede el límite (${raw.planned_waves.length} > ${MAX_WAVES_PER_BUCKET})`);
        }
        raw.planned_waves.forEach((w, k) => validateWaveObject(w, `planned_waves[${k}]`, errors));
    }
    if (raw.archived_waves !== undefined && !Array.isArray(raw.archived_waves)) {
        errors.push('archived_waves debe ser array');
    } else if (Array.isArray(raw.archived_waves)) {
        if (raw.archived_waves.length > MAX_WAVES_PER_BUCKET) {
            errors.push(`archived_waves excede el límite (${raw.archived_waves.length} > ${MAX_WAVES_PER_BUCKET})`);
        }
        raw.archived_waves.forEach((w, k) => validateWaveObject(w, `archived_waves[${k}]`, errors));
    }
    if (raw.dependencies !== undefined && !Array.isArray(raw.dependencies)) {
        errors.push('dependencies debe ser array');
    }
    return errors;
}

/**
 * Variante strict de loadWaves (CA-5). Lee el DISCO sin tolerancia: si el
 * shape no matchea, tira excepción + emite alerta Telegram. NO normaliza
 * defaults silenciosamente (eso lo hace loadWaves legacy, intencionalmente
 * permisivo para los consumers existentes).
 *
 * Use case: cualquier código nuevo (CA-6 desync detector, futuros consumers)
 * debería preferir esta variante. El callsite de loadWaves legacy queda
 * intacto para no romper consumers.
 *
 * @throws Error con code='EWAVES_SCHEMA' si el shape es inválido.
 */
function loadStateStrict() {
    const file = wavesFile();
    if (!fs.existsSync(file)) {
        // Sin archivo → estado vacío válido. NO alertar (caso normal en startup
        // fresco, no es corrupción).
        return emptyState();
    }
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        const msg = `waves.json: no se pudo leer (${err.message})`;
        try {
            notifyTelegram({
                level: 'error',
                component: 'waves-schema',
                message: 'read falló sobre waves.json',
                detail: err.message,
                action: 'Verificá permisos/espacio en disco. Pipeline en modo human-block.',
                diag: `ls -la ${file} && df -h`,
            });
        } catch {}
        const e = new Error(msg);
        e.code = 'EWAVES_READ';
        throw e;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        const msg = `waves.json: JSON inválido (${err.message})`;
        try {
            notifyTelegram({
                level: 'error',
                component: 'waves-schema',
                message: 'JSON corrupto en waves.json',
                detail: err.message,
                action: 'Pipeline en modo human-block. Revisá el archivo o restaurá desde archived/.',
                diag: `cat ${file}`,
            });
        } catch {}
        const e = new Error(msg);
        e.code = 'EWAVES_JSON';
        throw e;
    }
    const errors = validateStateStrict(parsed, { source: 'post-load' });
    if (errors.length > 0) {
        try {
            notifyTelegram({
                level: 'error',
                component: 'waves-schema',
                message: 'shape inválida tras load',
                detail: errors.join('; '),
                action: 'Pipeline en modo human-block. Revisá el archivo antes de continuar.',
                diag: `jq . ${file}`,
            });
        } catch {}
        const e = new Error(`waves.json: shape inválida — ${errors.join('; ')}`);
        e.code = 'EWAVES_SCHEMA';
        e.errors = errors;
        throw e;
    }
    // CA-4/SEC-3 — verificar hash de integridad. `missing` = estado legacy
    // pre-#4370 (se sella en el próximo save, CA-9): se tolera. `mismatch` =
    // corrupción silenciosa o tampering schema-válido → fail-closed human-block.
    const integrity = verifyIntegrityHash(parsed);
    if (integrity.status === 'mismatch') {
        try {
            notifyTelegram({
                level: 'error',
                component: 'waves-integrity',
                message: 'integrity_hash mismatch en waves.json',
                detail: `esperado ${integrity.expected}, recomputado ${integrity.actual}`,
                action: 'Pipeline en modo human-block. El estado fue alterado fuera del flujo normal (corrupción o tampering). Restaurá desde archived/ o revisá manualmente.',
                diag: `jq . ${file}`,
            });
        } catch {}
        const e = new Error(`waves.json: integrity_hash mismatch (esperado ${integrity.expected}, actual ${integrity.actual})`);
        e.code = 'EWAVES_INTEGRITY';
        throw e;
    }
    return parsed;
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

// ─── #4370 — Hash de integridad canónico (CA-4/SEC-3) ────────────────────────

/**
 * Serialización canónica determinística: claves de objeto ordenadas
 * recursivamente. Garantiza que el hash de integridad sea estable aunque el
 * orden de claves del JSON persistido cambie (ej. read-modify-write que reordena).
 * No maneja ciclos (el estado nunca los tiene) ni valores no-JSON.
 */
function canonicalStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return '[' + value.map(canonicalStringify).join(',') + ']';
    }
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

/**
 * Computa el hash de integridad SHA-256 del estado, OMITIENDO el propio campo
 * `integrity_hash` para evitar recursión (CA-4). Devuelve hex de 64 chars.
 */
function computeIntegrityHash(state) {
    const clone = {};
    for (const k of Object.keys(state)) {
        if (k === INTEGRITY_FIELD) continue;
        clone[k] = state[k];
    }
    return sha256Buffer(Buffer.from(canonicalStringify(clone), 'utf8'));
}

/**
 * Verifica el hash de integridad persistido contra el estado cargado.
 * Nunca tira. Devuelve:
 *   - { status: 'missing' }              → estado legacy sin hash (CA-9: tolerar).
 *   - { status: 'ok' }                   → hash coincide.
 *   - { status: 'mismatch', expected, actual } → corrupción/tampering.
 */
function verifyIntegrityHash(state) {
    const stored = state && typeof state === 'object' ? state[INTEGRITY_FIELD] : undefined;
    if (stored === undefined || stored === null) {
        return { status: 'missing' };
    }
    const actual = computeIntegrityHash(state);
    return actual === stored
        ? { status: 'ok' }
        : { status: 'mismatch', expected: stored, actual };
}

/**
 * CA-4 — carga defensiva del estado activo y verifica el hash de integridad SIN
 * tirar excepción. Pensado para el boot del pulpo: devuelve un status
 * estructurado para log/alerta sin poner el pipeline fuera de servicio.
 *
 * @returns {{ status: 'absent'|'unreadable'|'schema_invalid'|'missing'|'ok'|'mismatch',
 *             error?: string, errors?: string[], expected?: string, actual?: string }}
 */
function checkStateIntegrity() {
    const file = wavesFile();
    if (!fs.existsSync(file)) return { status: 'absent' };
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return { status: 'unreadable', error: e.message };
    }
    const schemaErrors = validateStateStrict(parsed, { source: 'boot' });
    if (schemaErrors.length > 0) return { status: 'schema_invalid', errors: schemaErrors };
    return verifyIntegrityHash(parsed);
}

/**
 * CA-7/SEC-6 — expone el lock de waves.json para que el boot del pulpo envuelva
 * la recuperación bajo el MISMO lock que las escrituras (TOCTOU). Reentrante:
 * el `saveState` interno de un restore comparte este lock.
 */
function withWavesLock(fn) {
    return withLockSync(wavesFile(), fn, {
        component: 'waves-lock',
        timeoutMs: LOCK_TIMEOUT_MS,
        maxRetries: LOCK_MAX_RETRIES,
        notify: notifyTelegram,
    });
}

/**
 * CA-3/SEC-2 — un backup referenciado por un marker debe resolver DENTRO de
 * `archived/` y matchear la whitelist de nombre. Defensa ante un marker hostil
 * cuyo `*_bak_path` apunte fuera (el SHA no protege si el atacante controla el
 * marker completo). Devuelve el path real resuelto o tira.
 */
function assertBackupPathSafe(bakPath) {
    const base = path.resolve(archivedDir());
    let real;
    try {
        real = fs.realpathSync(bakPath);
    } catch (err) {
        throw new Error(`backup path no resoluble: ${bakPath} (${err.message})`);
    }
    if (real !== base && !real.startsWith(base + path.sep)) {
        throw new Error(`backup path fuera de archived/: ${real} ∉ ${base}`);
    }
    if (!BACKUP_NAME_WHITELIST.test(path.basename(real))) {
        throw new Error(`backup name no matchea whitelist: ${path.basename(real)}`);
    }
    return real;
}

/**
 * CA-6/SEC-5 — conserva los `keep` backups más recientes por familia en
 * `archived/` y borra el resto, logueando cada descarte. NO toca backups
 * referenciados por un marker de promote en vuelo (evita romper un restore en
 * curso). Best-effort: nunca tira; si el marker no parsea, es conservador y no
 * rota nada.
 *
 * @param {number} [keep=ARCHIVED_BACKUPS_KEEP]
 * @returns {{ rotated: string[], kept: number, skipped?: string }}
 */
function rotateArchivedBackups(keep = ARCHIVED_BACKUPS_KEEP) {
    const dir = archivedDir();
    let entries;
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return { rotated: [], kept: keep };
    }

    // Backups referenciados por un marker in-progress: intocables.
    const inFlight = new Set();
    try {
        if (fs.existsSync(promoteMarkerFile())) {
            const m = JSON.parse(fs.readFileSync(promoteMarkerFile(), 'utf8'));
            if (m && m.waves_bak_path) inFlight.add(path.basename(m.waves_bak_path));
            if (m && m.partial_bak_path) inFlight.add(path.basename(m.partial_bak_path));
        }
    } catch {
        // Marker presente pero ilegible → no rotamos (podría referenciar un bak vivo).
        return { rotated: [], kept: keep, skipped: 'marker-unparseable' };
    }

    const families = [
        /^waves\.[^\\/]+\.json$/,               // backups de saveStateLocked
        /^waves-rollback\.[^\\/]+\.json$/,       // snapshot transaccional
        /^partial-pause-rollback\.[^\\/]+\.json$/,
    ];
    const rotated = [];
    for (const fam of families) {
        const matched = entries.filter((f) => fam.test(f) && !inFlight.has(f));
        const withMtime = matched.map((f) => {
            let mtime = 0;
            try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch {}
            return { f, mtime };
        }).sort((a, b) => b.mtime - a.mtime); // más nuevo primero
        for (const { f, mtime } of withMtime.slice(keep)) {
            try {
                fs.unlinkSync(path.join(dir, f));
                rotated.push(f);
                logInfo(`[rotación] descartado backup ${f} (mtime ${new Date(mtime).toISOString()}) — excede retención KEEP=${keep}.`);
            } catch (err) {
                logWarn(`[rotación] no pude borrar ${f}: ${err.message}`);
            }
        }
    }
    return { rotated, kept: keep };
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

    // Validar SHAs + contención de path + shape antes de restaurar — fail-closed.
    if (marker.waves_bak_path) {
        // CA-3/SEC-2 — el SHA no protege si el atacante controla el marker
        // completo (puede fijar path externo + su hash). Resolver realpath y
        // exigir contención en archived/ + whitelist de nombre ANTES de leer.
        let safePath;
        try {
            safePath = assertBackupPathSafe(marker.waves_bak_path);
        } catch (e) {
            out.reason = `waves backup rechazado por contención de path (CA-3): ${e.message}`;
            return out;
        }
        if (!fs.existsSync(safePath)) {
            out.reason = `waves backup ausente: ${safePath}`;
            return out;
        }
        const currentSha = sha256File(safePath);
        if (currentSha !== marker.waves_bak_sha) {
            out.reason = `SHA mismatch en waves backup (esperado ${marker.waves_bak_sha}, leído ${currentSha})`;
            return out;
        }
        // CA-2/SEC-1 — parsear una vez y correr validateStateStrict ANTES de
        // promover. Un .bak parseable pero con shape inválido/hostil NO se
        // promueve nunca (fail-closed): dejamos el estado activo intacto.
        let parsedWaves;
        try {
            parsedWaves = JSON.parse(fs.readFileSync(safePath, 'utf8'));
        } catch (e) {
            out.reason = `JSON corrupto en waves backup: ${e.message}`;
            return out;
        }
        const shapeErrors = validateStateStrict(parsedWaves, { source: 'restore' });
        if (shapeErrors.length > 0) {
            out.reason = `waves backup con shape inválido — no se promueve (CA-2): ${shapeErrors.join('; ')}`;
            return out;
        }
        // Usar el path resuelto y contenido para el copy posterior.
        marker.waves_bak_path = safePath;
    }
    if (marker.partial_bak_path) {
        // CA-3/SEC-2 — misma contención para el backup de la allowlist. NO se
        // corre validateStateStrict acá (schema distinto: allowlist, no waves).
        let safePath;
        try {
            safePath = assertBackupPathSafe(marker.partial_bak_path);
        } catch (e) {
            out.reason = `partial backup rechazado por contención de path (CA-3): ${e.message}`;
            return out;
        }
        if (!fs.existsSync(safePath)) {
            out.reason = `partial backup ausente: ${safePath}`;
            return out;
        }
        const currentSha = sha256File(safePath);
        if (currentSha !== marker.partial_bak_sha) {
            out.reason = `SHA mismatch en partial backup (esperado ${marker.partial_bak_sha}, leído ${currentSha})`;
            return out;
        }
        try { JSON.parse(fs.readFileSync(safePath, 'utf8')); } catch (e) {
            out.reason = `JSON corrupto en partial backup: ${e.message}`;
            return out;
        }
        marker.partial_bak_path = safePath;
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
 * @param {Object} [metadata] — { updated_by?, source?, note?, expandedIssues? }
 *   `expandedIssues` (#4350, opcional): set ya expandido (hijos/deps recursivos)
 *   y filtrado de cerrados que el caller computó FUERA de waves.js (el walk y
 *   el predicado isClosed viven en el pulpo/commander, nunca acá). Si viene, es
 *   autoritativo para la allowlist; si no, se usa getAllowlist().
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
        // #3625 — Pasar authorizedBy: 'wave-promote' para que el gate de
        // partial-pause acepte los removals que provoca la rotación de olas.
        //
        // #4350 — Si el caller (pulpo/commander) ya computó el set EXPANDIDO
        // (hijos/deps recursivos) y FILTRADO de cerrados, lo pasa por
        // `metadata.expandedIssues` y es AUTORITATIVO. waves.js NO hace el walk
        // ni consulta GitHub (regla inquebrantable "sin red / sin GitHub API,
        // solo filesystem propio"): confía en el set ya resuelto. Si no viene,
        // cae al comportamiento histórico (getAllowlist = issues abiertos de la
        // ola sin filtrar cierre en GitHub ni deps recursivos).
        if (Array.isArray(metadata.expandedIssues)) {
            const expanded = metadata.expandedIssues.map(normalizeIssue).filter(Boolean);
            newAllowlist = [...new Set(expanded)].sort((a, b) => a - b);
        } else {
            newAllowlist = getAllowlist();
        }
        const partialPause = require('./partial-pause');
        // #4030 — Recuperar metadata real de la ola recién promovida para que
        // sobreviva al seeder tras un /restart. Reutilizamos la misma fuente que
        // ya expone active_wave (no duplicamos lógica de naming). Best-effort:
        // si no podemos leerla, el seeder cae a su fallback genérico.
        let waveMetaForPartial = {};
        try {
            const activeNow = loadWaves().active_wave;
            if (activeNow && Number.isInteger(activeNow.number)) {
                waveMetaForPartial = {
                    waveNumber: activeNow.number,
                    waveName: activeNow.name || '',
                    waveGoal: activeNow.goal || '',
                };
            }
        } catch { /* defensivo: degradar al fallback del seeder */ }
        partialPause.setPartialPauseAtomic(newAllowlist, {
            source: metadata.source || 'wave-promote-atomic',
            authorizedBy: 'wave-promote',
            justification: metadata.note || `promote wave ${waveNumber} → active (atomic)`,
            ...waveMetaForPartial,
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
    removeIssueFromWave,
    reorderPlannedWaves,
    promoteWaveToActive,
    createPlannedWave,
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
    // CA-5: variantes strict que tiran si el shape rompe.
    loadStateStrict,
    validateStateStrict,
    // #4370 — integridad, retención y lock del boot.
    checkStateIntegrity,
    verifyIntegrityHash,
    computeIntegrityHash,
    rotateArchivedBackups,
    withWavesLock,
    // CA-1: helper de write atómico reusable por partial-pause.js.
    atomicWriteFile,
    // #3738 — bounds de creación de olas planificadas.
    readWaveMaxConcurrency,
    WAVE_WINDOW_MIN_MINUTES,
    WAVE_WINDOW_MAX_MINUTES,
    WAVE_NAME_MAX_LEN,
    WAVE_MAX_CONCURRENCY_DEFAULT,
    // Constantes públicas
    SCHEMA_VERSION,
    CACHE_TTL_MS,
    LOCK_TIMEOUT_MS,
    LOCK_MAX_RETRIES,
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
        assertArchivedDirSafe,
        // #4370 — helpers de integridad/restore expuestos a tests.
        assertBackupPathSafe,
        canonicalStringify,
        computeIntegrityHash,
        verifyIntegrityHash,
        rotateArchivedBackups,
        // #3616 — reset del dedupe in-memory de la alerta "allowlist vacío".
        _resetEmptyAllowlistDedupeForTests,
    },
};
