// =============================================================================
// label-mutation-log.js — Marker append-only de mutaciones de labels aplicadas
// (#5863 CA-R3)
//
// PROBLEMA QUE RESUELVE
// ---------------------
// El Pulpo cachea labels por issue durante `LABELS_CACHE_TTL_MS` (10 min). Las
// mutaciones que el propio Pulpo encola las aplica OTRO proceso
// (`servicio-github.js`), así que el Pulpo nunca se entera del momento en que
// el label existe de verdad en GitHub. Invalidar al ENCOLAR (CA-R2) cubre el
// hueco desde el lado del emisor, pero no alcanza: entre el encolado y la
// aplicación efectiva puede pasar cualquier cosa (la orden se descarta por
// stale, el gate la bloquea, `gh` falla) y, al revés, `servicio-github.js`
// también aplica órdenes que no vienen del Pulpo.
//
// Este módulo es el canal de vuelta: `servicio-github.js` registra CADA
// aplicación efectiva y el Pulpo drena el registro en su barrido e invalida los
// issues afectados. Sin polling a GitHub y sin costo de API (CA-R7).
//
// DISEÑO
// ------
//   * APPEND-ONLY (CA-R3, requisito explícito del issue): el escritor usa
//     `fs.appendFileSync` con flag 'a'. NUNCA `writeFileSync` sobre el archivo
//     activo — dos procesos escribiendo con `writeFileSync` se pisan entre sí y
//     perderían mutaciones, que es justo lo que este marker existe para evitar.
//   * El lector avanza por OFFSET de bytes persistido en un cursor aparte. Sólo
//     lee el tramo nuevo, así que el costo por barrido es proporcional a las
//     mutaciones nuevas, no al tamaño del archivo.
//   * Rotación por renombrado cuando el archivo supera el cap. El cursor detecta
//     la rotación porque el archivo quedó MÁS CHICO que su offset y reinicia en
//     0. El renombrado no viola el append-only: el archivo activo nunca se
//     sobrescribe en su lugar.
//   * Fail-safe en ambos extremos: registrar es best-effort (una mutación no
//     puede fallar porque el marker no se pudo escribir) y drenar nunca lanza
//     (un marker corrupto degrada a "no hay nada nuevo", no rompe el barrido).
//     La consecuencia de perder una línea es la de hoy: la caché vence sola a
//     los 10 minutos.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// Cap del archivo activo antes de rotar. 1 MB son ~10k mutaciones: holgado para
// cualquier ola y acotado para que el disco no crezca sin techo.
const MAX_LOG_BYTES = 1024 * 1024;

// Cota de líneas devueltas por drenado. Defensa anti-DoS: un marker inflado no
// puede hacer que un solo barrido invalide (y re-lea) una cantidad ilimitada de
// issues. Lo que exceda queda para el barrido siguiente — el cursor avanza sólo
// hasta lo consumido.
const MAX_DRAIN_LINES = 500;

function logPath(pipelineDir) {
    return path.join(pipelineDir, 'state', 'label-mutations.jsonl');
}

function cursorPath(pipelineDir) {
    return path.join(pipelineDir, 'state', 'label-mutations.cursor.json');
}

/**
 * Registra una mutación de label EFECTIVAMENTE aplicada en GitHub.
 *
 * Se invoca DESPUÉS de que `gh` respondió OK — nunca antes. Una orden
 * descartada por stale o bloqueada por un gate no se registra: el marker
 * describe el estado real de GitHub, no las intenciones del pipeline.
 *
 * @param {object} opts
 * @param {string} opts.pipelineDir  raíz de `.pipeline`.
 * @param {number|string} opts.issue número de issue (o PR, si `target==='pr'`).
 * @param {string} opts.label        label aplicado o removido.
 * @param {'label'|'remove-label'} opts.action
 * @param {string} [opts.target]     'pr' para mutaciones sobre PRs (el Pulpo no
 *                                   cachea labels de PR, así que las ignora al
 *                                   drenar, pero quedan registradas).
 * @returns {boolean} true si se registró.
 */
function recordApplied({ pipelineDir, issue, label, action, target } = {}) {
    try {
        if (!pipelineDir) return false;
        const num = Number(issue);
        if (!Number.isInteger(num) || num <= 0) return false;

        const file = logPath(pipelineDir);
        try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* best-effort */ }

        // Rotar ANTES de escribir para que el archivo activo nunca supere el cap.
        try {
            const st = fs.statSync(file);
            if (st.size >= MAX_LOG_BYTES) {
                try { fs.renameSync(file, `${file}.1`); } catch { /* best-effort */ }
            }
        } catch { /* no existe todavía */ }

        const entry = JSON.stringify({
            issue: num,
            label: typeof label === 'string' ? label.slice(0, 120) : null,
            action: action === 'remove-label' ? 'remove-label' : 'label',
            target: target === 'pr' ? 'pr' : 'issue',
            at: new Date().toISOString(),
        });
        fs.appendFileSync(file, entry + '\n', { encoding: 'utf8', flag: 'a' });
        return true;
    } catch {
        // Best-effort por diseño: el registro es una optimización sobre el TTL.
        return false;
    }
}

/**
 * Lee el tramo NUEVO del marker y devuelve los issues cuya caché hay que
 * invalidar. Avanza el cursor sólo hasta lo efectivamente consumido.
 *
 * @param {object} opts
 * @param {string} opts.pipelineDir
 * @returns {{ issues: number[], consumed: number, rotated: boolean }}
 */
function drainNewIssues({ pipelineDir } = {}) {
    const empty = { issues: [], consumed: 0, rotated: false };
    try {
        if (!pipelineDir) return empty;
        const file = logPath(pipelineDir);

        let stat;
        try { stat = fs.statSync(file); } catch { return empty; }
        const size = stat.size;

        let offset = 0;
        let cursorFileId = null;
        try {
            const cur = JSON.parse(fs.readFileSync(cursorPath(pipelineDir), 'utf8'));
            if (Number.isInteger(cur.offset) && cur.offset >= 0) offset = cur.offset;
            if (typeof cur.file_id === 'string' && cur.file_id) cursorFileId = cur.file_id;
        } catch { /* sin cursor previo → desde el principio */ }

        // La identidad cambia ante rename+archivo nuevo incluso cuando el archivo
        // nuevo tiene exactamente el mismo tamaño que el anterior. Comparar sólo
        // `offset > size` dejaba ese caso mudo para siempre.
        const fileId = `${String(stat.dev)}:${String(stat.ino)}`;
        const identityChanged = cursorFileId !== null && cursorFileId !== fileId;

        // El archivo cambió de identidad o encogió respecto del cursor ⇒ rotó
        // (o alguien lo truncó). Releer desde 0 es seguro e idempotente.
        // Releer desde 0 es seguro: invalidar de más sólo cuesta un `gh` extra.
        const rotated = identityChanged || offset > size;
        if (rotated) offset = 0;
        if (offset === size) return { issues: [], consumed: 0, rotated };

        const fd = fs.openSync(file, 'r');
        let raw;
        try {
            const len = size - offset;
            const buf = Buffer.allocUnsafe(len);
            const read = fs.readSync(fd, buf, 0, len, offset);
            raw = buf.slice(0, read).toString('utf8');
        } finally {
            try { fs.closeSync(fd); } catch { /* best-effort */ }
        }

        // La última línea puede estar a medio escribir (otro proceso appendeando
        // en este mismo instante). Se deja para el próximo drenado: el cursor
        // avanza sólo hasta el último '\n' consumido.
        const lastNl = raw.lastIndexOf('\n');
        if (lastNl < 0) return { issues: [], consumed: 0, rotated };
        const complete = raw.slice(0, lastNl + 1);

        const lines = complete.split('\n').filter(Boolean);
        const capped = lines.slice(0, MAX_DRAIN_LINES);
        // Si recortamos por el cap, el cursor avanza SOLO por lo consumido.
        const consumedBytes = capped.length === lines.length
            ? Buffer.byteLength(complete, 'utf8')
            : Buffer.byteLength(capped.join('\n') + '\n', 'utf8');

        const issues = [];
        for (const line of capped) {
            try {
                const e = JSON.parse(line);
                // Los labels de PR no viven en `issueLabelsCache` del Pulpo.
                if (e && e.target === 'pr') continue;
                if (Number.isInteger(e && e.issue) && e.issue > 0 && !issues.includes(e.issue)) {
                    issues.push(e.issue);
                }
            } catch { /* línea corrupta: se saltea, el cursor igual avanza */ }
        }

        const newOffset = offset + consumedBytes;
        try {
            fs.mkdirSync(path.dirname(cursorPath(pipelineDir)), { recursive: true });
            fs.writeFileSync(
                cursorPath(pipelineDir),
                JSON.stringify({ offset: newOffset, file_id: fileId, updated_at: new Date().toISOString() }),
            );
        } catch { /* si el cursor no persiste, el próximo drenado repite: idempotente */ }

        return { issues, consumed: capped.length, rotated };
    } catch {
        return empty;
    }
}

module.exports = {
    recordApplied,
    drainNewIssues,
    logPath,
    cursorPath,
    MAX_LOG_BYTES,
    MAX_DRAIN_LINES,
};
