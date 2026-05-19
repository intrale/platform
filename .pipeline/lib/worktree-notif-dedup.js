// =============================================================================
// worktree-notif-dedup.js — Dedup persistente de notificaciones Telegram para
// abortos por worktree faltante (issue #2591 CA-4 / security CA-4).
//
// **Por qué persistente y no en memoria**:
//   Si el dedup vive sólo en memoria del pulpo, un restart re-floodea Telegram
//   con el mismo aborto. Filesystem-based hace que el dedup sobreviva restarts
//   (planeados o por crash).
//
// **Path**:
//   `.pipeline/state/notif-dedup-worktree-<issue>-<fase>.txt`
//   Contiene un único timestamp ISO-8601 (no más, no menos).
//
// **TTL default**: 24 horas. Después de eso, asumimos que el operador ya
//   pudo no haber visto la notificación o se le pasó — re-notificamos.
//
// **Atomicidad**:
//   `fs.writeFileSync` en path único por (issue, fase) — sin concurrencia
//   real entre múltiples pulpos sobre el mismo (issue, fase). Si hubiera,
//   gana la última escritura — aceptable para dedup.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_STATE_DIR = path.join(__dirname, '..', 'state');
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Sanea (issue, fase) para construir un filename seguro.
 * - issue: solo dígitos (regex /^\d+$/).
 * - fase:  [a-z][a-z0-9-]{0,30} (mismas reglas que `skill` en config.yaml).
 *
 * Si alguno no matchea, lanza — porque caller previo (pulpo) ya debería
 * haber validado vía resolveExistingWorktree → validateInputs.
 */
function buildDedupPath(issue, fase, stateDir = DEFAULT_STATE_DIR) {
    if (!/^\d+$/.test(String(issue))) {
        throw new Error(`Issue inválido para dedup: "${issue}"`);
    }
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(String(fase))) {
        throw new Error(`Fase inválida para dedup: "${fase}"`);
    }
    return path.join(stateDir, `notif-dedup-worktree-${issue}-${fase}.txt`);
}

/**
 * ¿Debemos notificar? true si:
 *   - No existe archivo de dedup (primera vez), o
 *   - Existe pero su contenido (timestamp) es más viejo que TTL.
 *
 * Si por algún motivo el contenido no parsea como timestamp, asumimos
 * "viejo / corrupto" y re-notificamos. Conservador.
 */
function shouldNotify(issue, fase, opts = {}) {
    const { ttlMs = DEFAULT_TTL_MS, stateDir = DEFAULT_STATE_DIR, fsImpl = fs, now = Date.now() } = opts;
    let dedupPath;
    try {
        dedupPath = buildDedupPath(issue, fase, stateDir);
    } catch {
        // Si el filename es inválido, NO notificamos — preferimos perder la
        // alerta antes que poder escribir un path arbitrario. El caller ya
        // valida arriba pero defensa en profundidad.
        return false;
    }

    try {
        const raw = fsImpl.readFileSync(dedupPath, 'utf8').trim();
        const lastMs = Date.parse(raw);
        if (!Number.isFinite(lastMs)) return true;
        return (now - lastMs) >= ttlMs;
    } catch {
        // ENOENT u otro → no hay dedup previo, notificamos.
        return true;
    }
}

/**
 * Marca como notificado escribiendo el timestamp actual. Best-effort.
 */
function markNotified(issue, fase, opts = {}) {
    const { stateDir = DEFAULT_STATE_DIR, fsImpl = fs, now = Date.now() } = opts;
    let dedupPath;
    try {
        dedupPath = buildDedupPath(issue, fase, stateDir);
    } catch {
        return false;
    }
    try {
        fsImpl.mkdirSync(path.dirname(dedupPath), { recursive: true });
        fsImpl.writeFileSync(dedupPath, new Date(now).toISOString(), { encoding: 'utf8' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Borra el dedup de (issue, fase). Util cuando el issue cambia de fase y
 * queremos que un futuro problema en otra fase notifique sin esperar TTL.
 */
function clearDedup(issue, fase, opts = {}) {
    const { stateDir = DEFAULT_STATE_DIR, fsImpl = fs } = opts;
    let dedupPath;
    try {
        dedupPath = buildDedupPath(issue, fase, stateDir);
    } catch {
        return false;
    }
    try {
        fsImpl.unlinkSync(dedupPath);
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    shouldNotify,
    markNotified,
    clearDedup,
    buildDedupPath,
    DEFAULT_TTL_MS,
    DEFAULT_STATE_DIR,
};
