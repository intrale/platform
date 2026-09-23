'use strict';
// =============================================================================
// #7631 — Punto de entrada del gate `authorship`. Es lo ÚNICO que importa
// `delivery.js`.
//
// `evaluateAuthorship` decide y, en el mismo acto, arma las líneas del trailer:
// el mensaje del squash usa exactamente la evaluación que pasó el gate (no una
// segunda lectura que pueda ver otro estado).
//
// Nunca lanza. Cualquier excepción inesperada se trata como `missing`:
// bloquea en `enforce`, avisa en `dry-run`. No existe camino por el que "no
// encontré la firma" termine como aprobado en silencio (CA-6).
// =============================================================================

const trailer = require('./trailer');
const humanDirection = require('./human-direction');
const aiAssisted = require('./ai-assisted');
const rollout = require('./rollout');
const copy = require('./copy');

function isoSeconds(ms) {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function readIdentityMap(config) {
    const sec = config && typeof config === 'object' ? config.authorship : null;
    const map = sec && typeof sec === 'object' ? sec.identity_map : null;
    if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
    const out = {};
    for (const [k, v] of Object.entries(map)) {
        if (/^sha256:[0-9a-f]{64}$/.test(k) && typeof v === 'string') out[k] = v;
    }
    return out;
}

/**
 * @param {object} p
 * @param {number} p.issue
 * @param {string} p.headSha — `snapshot.headRefOid`, el mismo `sha=` del PUT.
 * @param {object|null} p.config — config del pipeline (null ⇒ modo estricto).
 * @param {string|null} [p.prCreatedAt]
 * @param {function} [p.now]
 * @param {string} [p.auditFile]
 * @param {string[]} [p.logFiles]
 * @param {string} [p.markerFile]
 * @param {object} [p.fsImpl]
 * @returns {{decision:'pass'|'block', mode:string, grandfathered:boolean,
 *            humanLine:string|null, aiLine:string|null, reason:string|null,
 *            notice:boolean, warnings:string[]}}
 */
function evaluateAuthorship({
    issue,
    headSha,
    config = null,
    prCreatedAt = null,
    now = () => Date.now(),
    auditFile,
    logFiles,
    markerFile, // undefined ⇒ rollout lo resuelve por llamada (write-target)
    fsImpl,
} = {}) {
    let mode = null;
    try {
        const enforceSeen = rollout.readEnforceSeen(markerFile, fsImpl);
        mode = rollout.resolveAuthorshipMode(config, { prCreatedAt, enforceSeen });
        if (mode.mode === 'enforce' && !enforceSeen) rollout.markEnforceSeen(markerFile, fsImpl);

        if (mode.mode === 'off' || mode.grandfathered) {
            return {
                decision: 'pass', mode: mode.mode, grandfathered: mode.grandfathered,
                humanLine: null, aiLine: null, reason: null, notice: false, warnings: mode.warnings,
            };
        }

        const hdArgs = { issue, headSha, identityMap: readIdentityMap(config), fsImpl };
        if (auditFile) hdArgs.auditFile = auditFile;
        let human = humanDirection.resolveHumanDirection(hdArgs);
        if (!human || typeof human !== 'object') human = { ok: false, reason: 'missing' };

        const aiArgs = { issue, fsImpl };
        if (logFiles) aiArgs.logFiles = logFiles;
        const ai = aiAssisted.resolveAiAssisted(aiArgs);

        let humanLine;
        try {
            humanLine = trailer.formatHumanDirection(human.ok ? human : { ok: false, reason: human.reason, ts: isoSeconds(now()) });
        } catch {
            human = { ok: false, reason: 'missing' };
            humanLine = trailer.formatHumanDirection({ ok: false, reason: 'missing', ts: isoSeconds(now()) });
        }
        let aiLine;
        try { aiLine = trailer.formatAiAssisted(ai); } catch { aiLine = 'unknown'; }

        const reason = human.ok ? null : human.reason;
        const block = !human.ok && mode.mode === 'enforce';
        return {
            decision: block ? 'block' : 'pass',
            mode: mode.mode,
            grandfathered: false,
            humanLine,
            aiLine,
            reason,
            notice: !human.ok && mode.mode === 'dry-run',
            warnings: mode.warnings,
        };
    } catch {
        const m = mode && mode.mode ? mode.mode : (rollout.readEnforceSeen(markerFile, fsImpl) ? 'enforce' : 'dry-run');
        const enforce = m !== 'dry-run';
        return {
            decision: enforce ? 'block' : 'pass',
            mode: m,
            grandfathered: false,
            humanLine: trailer.formatHumanDirection({ ok: false, reason: 'missing', ts: isoSeconds(now()) }),
            aiLine: 'unknown',
            reason: 'missing',
            notice: !enforce,
            warnings: ['evaluación de autoría falló: se trató como missing'],
        };
    }
}

module.exports = {
    evaluateAuthorship,
    trailer,
    humanDirection,
    aiAssisted,
    rollout,
    copy,
};
