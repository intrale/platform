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
//   Contiene JSON `{ ts: <ISO-8601|null>, skills: [<skill>…] }` (#5421 CA-9).
//   `ts` es el momento de la ÚLTIMA notificación enviada (null = registrado
//   pero todavía no notificado). `skills` son los skills afectados por
//   escaladas del mismo (issue, fase), para que la única alerta que sale los
//   liste a todos.
//
//   **Retrocompatible**: el formato viejo era un timestamp ISO plano y hay
//   archivos así vivos en `state/`. La lectura los acepta (`skills: []`) — si
//   los tratara como corruptos, re-floodearía Telegram al primer deploy.
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
 * Tope de skills acumulados por (issue, fase). Sólo para que el archivo y el
 * texto de la alerta no crezcan sin límite ante un loop patológico.
 */
const MAX_SKILLS = 20;

/** Misma forma que `fase`/`skill` en config.yaml. */
const SKILL_RE = /^[a-z][a-z0-9-]{0,30}$/;

/**
 * Lee el archivo de dedup y lo normaliza a `{ ts, skills }` (#5421 CA-9).
 *
 * **Retrocompatible a propósito**: el formato viejo era un timestamp ISO plano
 * y hay archivos así vivos en `state/`. Si el contenido parsea como ISO plano
 * se devuelve `{ ts: <ese ISO>, skills: [] }`. Si se tratara como corrupto,
 * `shouldNotify` daría `true` para todos y re-floodearíamos Telegram.
 *
 * Contenido ilegible/corrupto → `{ ts: null, skills: [] }` (conservador: se
 * vuelve a notificar).
 */
function readEntry(dedupPath, fsImpl) {
    let raw;
    try {
        raw = String(fsImpl.readFileSync(dedupPath, 'utf8')).trim();
    } catch {
        return { ts: null, skills: [] };
    }
    if (!raw) return { ts: null, skills: [] };

    // Formato nuevo: JSON `{ ts, skills }`.
    if (raw.startsWith('{')) {
        try {
            const parsed = JSON.parse(raw);
            const ts = typeof parsed.ts === 'string' && Number.isFinite(Date.parse(parsed.ts))
                ? parsed.ts
                : null;
            const skills = Array.isArray(parsed.skills)
                ? parsed.skills.filter((s) => typeof s === 'string' && SKILL_RE.test(s))
                : [];
            return { ts, skills };
        } catch {
            return { ts: null, skills: [] };
        }
    }

    // Formato legacy: timestamp ISO plano.
    return { ts: Number.isFinite(Date.parse(raw)) ? raw : null, skills: [] };
}

/** Escribe el entry normalizado. Best-effort. */
function writeEntry(dedupPath, entry, fsImpl) {
    try {
        fsImpl.mkdirSync(path.dirname(dedupPath), { recursive: true });
        fsImpl.writeFileSync(
            dedupPath,
            JSON.stringify({ ts: entry.ts, skills: entry.skills }),
            { encoding: 'utf8' },
        );
        return true;
    } catch {
        return false;
    }
}

/**
 * ¿Debemos notificar? true si:
 *   - No existe archivo de dedup (primera vez), o
 *   - Existe pero su timestamp de notificación es más viejo que TTL, o
 *   - Existe pero todavía no se notificó nunca (`ts: null` — el archivo lo creó
 *     `recordSkill`, que registra el skill afectado SIN marcar notificado).
 *
 * Si el contenido no parsea, asumimos "viejo / corrupto" y re-notificamos.
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

    const { ts } = readEntry(dedupPath, fsImpl);
    const lastMs = ts == null ? NaN : Date.parse(ts);
    if (!Number.isFinite(lastMs)) return true;
    return (now - lastMs) >= ttlMs;
}

/**
 * Marca como notificado escribiendo el timestamp actual. Best-effort.
 * Preserva los skills ya registrados por `recordSkill`.
 */
function markNotified(issue, fase, opts = {}) {
    const { stateDir = DEFAULT_STATE_DIR, fsImpl = fs, now = Date.now() } = opts;
    let dedupPath;
    try {
        dedupPath = buildDedupPath(issue, fase, stateDir);
    } catch {
        return false;
    }
    const prev = readEntry(dedupPath, fsImpl);
    return writeEntry(dedupPath, { ts: new Date(now).toISOString(), skills: prev.skills }, fsImpl);
}

/**
 * Registra que `skill` quedó afectado por una escalada de (issue, fase),
 * SIN marcar como notificado (#5421 CA-9).
 *
 * Esa separación es la que hace que funcione: el pulpo llama a `recordSkill`
 * ANTES de `shouldNotify`, así la única alerta que sale puede listar todos los
 * skills afectados. Si `recordSkill` tocara el `ts`, se comería la primera
 * notificación.
 *
 * @returns {boolean} true si quedó registrado (o ya estaba).
 */
function recordSkill(issue, fase, skill, opts = {}) {
    const { stateDir = DEFAULT_STATE_DIR, fsImpl = fs } = opts;
    if (!SKILL_RE.test(String(skill || ''))) return false;
    let dedupPath;
    try {
        dedupPath = buildDedupPath(issue, fase, stateDir);
    } catch {
        return false;
    }
    const entry = readEntry(dedupPath, fsImpl);
    if (entry.skills.includes(skill)) return true;
    if (entry.skills.length >= MAX_SKILLS) return false;
    entry.skills.push(skill);
    return writeEntry(dedupPath, entry, fsImpl);
}

/**
 * Skills registrados para (issue, fase). `[]` si no hay ninguno o si el
 * archivo es del formato legacy (timestamp plano sin skills).
 */
function readSkills(issue, fase, opts = {}) {
    const { stateDir = DEFAULT_STATE_DIR, fsImpl = fs } = opts;
    let dedupPath;
    try {
        dedupPath = buildDedupPath(issue, fase, stateDir);
    } catch {
        return [];
    }
    return readEntry(dedupPath, fsImpl).skills;
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
    recordSkill,
    readSkills,
    DEFAULT_TTL_MS,
    DEFAULT_STATE_DIR,
    MAX_SKILLS,
};
