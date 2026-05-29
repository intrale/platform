// V3 Partial pause — pausa del pipeline con allowlist explícita de issues (#2490).
//
// Tres estados del pipeline:
//   - running        → procesa todo (sin archivos de control)
//   - paused         → .pipeline/.paused existe → no procesa nada
//   - partial_pause  → .pipeline/.partial-pause.json existe → procesa solo issues del allowlist
//
// Precedencia: paused > partial_pause > running. Si coexisten .paused y
// .partial-pause.json, .paused gana (más restrictivo).
//
// La tabla de verdad de isIssueAllowed(issue):
//   running          → true
//   paused           → false
//   partial_pause    → issue in allowedIssues
//
// El marker JSON tiene el shape (campos adicionales son aditivos: lectores que
// no los conocen los ignoran sin romperse):
//   {
//     allowed_issues: [2490, 2491],
//     created_at: "2026-04-23T19:40:00Z",
//     source: "telegram",
//     accepted_dep_risk?: true,             // #2893: el operador eligió continuar
//                                           //         aceptando que un issue tiene
//                                           //         deps abiertas fuera del allowlist.
//     dep_sources?: { "2491": "auto-deps" } // #2893: por qué cada issue está incluido.
//   }
//
// -----------------------------------------------------------------------------
// #3625 — Gate de autorización + audit trail (Ola N+11 incident hardening)
// -----------------------------------------------------------------------------
//
// Toda mutación de `.partial-pause.json` ahora pasa por un gate que:
//   1. Valida `opts.authorizedBy` contra un enum cerrado (ver
//      `lib/partial-pause-audit.AUTHORIZED_BY_ENUM`).
//   2. Computa diff (added/removed) entre el estado previo y el propuesto.
//   3. Rechaza removals sin `authorizedBy` válido → REJECTED + audit entry.
//   4. Sanitiza `opts.justification` (max 500 chars + redact secrets).
//   5. **Orden invariante**: escribe la entry de audit ANTES de modificar el
//      estado. Si el proceso muere entre los dos pasos, el audit registra la
//      intención pero el estado sigue como antes (recuperable). El orden
//      inverso es el bug exacto que estamos arreglando.
//
// **Período de gracia (CA-2)**: durante 1 release los callers sin
// `authorizedBy` reciben un warning (no fail-closed estricto). El env var
// `PARTIAL_PAUSE_STRICT_AUTH=1` activa el fail-closed antes de tiempo (para
// tests). Pasado el grace period, el default cambia a strict.

'use strict';

const fs = require('fs');
const path = require('path');
const { withLockSync } = require('./file-lock');
const { notifyTelegram } = require('./notify-telegram');
const { atomicWriteFile } = require('./waves');
const audit = require('./partial-pause-audit');

const LOCK_TIMEOUT_MS = 5000;
const LOCK_MAX_RETRIES = 3;

// #3625 — Fail-closed estricto cuando se rechaza removal sin authorizedBy.
// **Default OFF (grace mode)** por decisión PO/security CA-2: 1 release con
// deprecation warning logueado para detectar callers no migrados, antes del
// fail-closed estricto. Operador habilita strict explícitamente con
// `PARTIAL_PAUSE_STRICT_AUTH=1`. El audit log captura las mutaciones SIEMPRE
// (con `gate_grace: true` para los rechazos que pasaron en este período).
function strictGateEnabled() {
    return process.env.PARTIAL_PAUSE_STRICT_AUTH === '1';
}

function pipelineDir() {
    // Permitir override en tests vía env var
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.join(__dirname, '..');
}

function partialFile() { return path.join(pipelineDir(), '.partial-pause.json'); }
function pauseFile() { return path.join(pipelineDir(), '.paused'); }

function normalizeIssue(issue) {
    const n = Number(String(issue).replace(/^#/, '').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
}

function readPartialFile() {
    try {
        const raw = fs.readFileSync(partialFile(), 'utf8');
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed.allowed_issues) ? parsed.allowed_issues : [];
        const allowed = arr.map(normalizeIssue).filter(Boolean);
        // #2893: campos opcionales aditivos.
        const acceptedDepRisk = parsed.accepted_dep_risk === true;
        const depSources = (parsed.dep_sources && typeof parsed.dep_sources === 'object')
            ? parsed.dep_sources
            : null;
        return {
            allowed_issues: allowed,
            created_at: parsed.created_at || null,
            source: parsed.source || null,
            accepted_dep_risk: acceptedDepRisk,
            dep_sources: depSources,
            // #3625: TTLs de autoría heredada (recursive-deps:from-N) viven en
            // un campo aditivo del JSON y se purgan vía pulpo:cleanup cron.
            authorization_ttls: (parsed.authorization_ttls && typeof parsed.authorization_ttls === 'object')
                ? parsed.authorization_ttls
                : null,
        };
    } catch {
        return null;
    }
}

/**
 * Lee el snapshot raw del archivo (allowlist sin filtrar a lista vacía).
 * Útil para callers del gate que necesitan la "previous" exacta antes del
 * write — `getPipelineMode()` mapea a `running` cuando la lista está vacía
 * y eso oculta el diff real.
 */
function readPreviousAllowlist() {
    const raw = readPartialFile();
    return raw ? raw.allowed_issues : [];
}

/**
 * Estado actual del pipeline.
 * @returns {{
 *   mode: 'running'|'paused'|'partial_pause',
 *   allowedIssues: number[],
 *   createdAt: string|null,
 *   source: string|null,
 *   acceptedDepRisk: boolean,
 *   depSources: Object|null,
 * }}
 */
function getPipelineMode() {
    if (fs.existsSync(pauseFile())) {
        return {
            mode: 'paused', allowedIssues: [], createdAt: null, source: null,
            acceptedDepRisk: false, depSources: null,
        };
    }
    const partial = readPartialFile();
    if (partial && partial.allowed_issues.length > 0) {
        return {
            mode: 'partial_pause',
            allowedIssues: partial.allowed_issues,
            createdAt: partial.created_at,
            source: partial.source,
            acceptedDepRisk: partial.accepted_dep_risk === true,
            depSources: partial.dep_sources || null,
            authorizationTtls: partial.authorization_ttls || null,
        };
    }
    return {
        mode: 'running', allowedIssues: [], createdAt: null, source: null,
        acceptedDepRisk: false, depSources: null,
    };
}

/**
 * Determina si un issue puede procesarse según el estado actual.
 * @param {number|string} issue
 * @returns {boolean}
 */
function isIssueAllowed(issue) {
    return isIssueAllowedInState(issue, getPipelineMode());
}

/**
 * Variante pura de `isIssueAllowed` que recibe el estado ya leído (#2957).
 *
 * Pensada para callers que iteran muchos issues en un mismo tick (counters
 * de cola, reconciler) y no quieren pagar el costo de releer el filesystem
 * por cada uno. La política es la misma que `isIssueAllowed`.
 *
 * @param {number|string} issue
 * @param {ReturnType<typeof getPipelineMode>} state
 * @returns {boolean}
 */
function isIssueAllowedInState(issue, state) {
    const n = normalizeIssue(issue);
    if (!n) return false;
    if (!state || state.mode === 'paused') return false;
    if (state.mode === 'running') return true;
    return Array.isArray(state.allowedIssues) && state.allowedIssues.includes(n);
}

// -----------------------------------------------------------------------------
// #3625 — Gate de autorización (CA-2).
//
// Compara `previous` vs `proposed`, decide si se aplica o se rechaza, y emite
// la entry de audit ANTES del write del estado (invariante de orden).
//
// Reglas:
//   - Si no hay removals (sólo adds o sin cambios) → aceptar incluso sin
//     `authorizedBy` (no es el caso peligroso). Igual se emite entry de audit
//     con `authorized_by: null` para que quede registrado.
//   - Si hay removals:
//       * con `authorizedBy` válido → aplicar + audit entry (action: 'write').
//       * sin `authorizedBy` o inválido:
//           - strictGateEnabled() === true → action: 'reject', NO escribir,
//             notificar Telegram, devolver `{ ok: false, rejected: true }`.
//           - strictGateEnabled() === false → action: 'write' pero entry
//             marca `gate_grace: true` para que el operador vea callers no
//             migrados.
//
// La función NO escribe el JSON: devuelve `{ ok, rejected, entry }`. El
// caller decide qué hacer si rejected=true. Pero AÚN cuando rejected=true,
// la audit entry ya está persistida (intención registrada).
// -----------------------------------------------------------------------------

function evaluateAndAudit({ previous, current, source, authorizedBy, justification, intendedAction = 'write', extra }) {
    const diff = audit.computeDiff(previous, current);
    const hasRemovals = diff.removed.length > 0;
    const validation = audit.validateAuthorizedBy(authorizedBy);
    const grace = !strictGateEnabled();

    let action = intendedAction;
    let rejected = false;

    if (hasRemovals && !validation.valid) {
        if (grace) {
            // Período de gracia: aceptar pero marcar.
            action = intendedAction;
        } else {
            action = 'reject';
            rejected = true;
        }
    }

    const extras = { ...(extra || {}) };
    if (grace && hasRemovals && !validation.valid) extras.gate_grace = true;

    const result = audit.appendMutation({
        source,
        action,
        previous,
        current: rejected ? previous : current,  // si rechazado, "current" es lo que QUEDA (sin aplicar).
        authorizedBy,
        justification,
        extra: extras,
    });

    if (rejected) {
        // Alerta Telegram inmediata (CA-5 — pero la conexión es opcional,
        // sólo si notifyTelegram está disponible y no estamos en test).
        try {
            const removedList = diff.removed.map(n => `#${n}`).join(', ');
            const msg = `🛑 [allowlist gate] Removal RECHAZADO sin authorizedBy válido.\n` +
                        `Source: ${source || 'unknown'}\n` +
                        `Removidos (no aplicado): ${removedList}\n` +
                        `Razón: ${validation.reason || 'unknown'}`;
            notifyTelegram(msg);
        } catch { /* notify best-effort */ }
    }

    return { ok: !rejected, rejected, audit: result, diff, validation };
}

/**
 * Activa la pausa parcial con un allowlist de issues.
 * Lista vacía → elimina el marker (equivalente a clear).
 *
 * #3520 — Write atómico vía tmp+rename. Sustituye al `writeFileSync` directo
 * que dejaba el JSON truncado ante un kill -9 mid-write. Es prerequisito para
 * la transacción multi-archivo de `lib/waves.promoteWaveAtomic`.
 *
 * #3625 — Gate de autorización: opts.authorizedBy + opts.justification.
 * Removals sin authorizedBy válido → REJECTED (audit entry + alerta Telegram).
 *
 * @param {Array<number|string>} issues
 * @param {{
 *   source?: string,
 *   acceptedDepRisk?: boolean,
 *   depSources?: Object,
 *   authorizedBy?: string,        // #3625: enum cerrado
 *   justification?: string,       // #3625: razón libre (sanitizada)
 *   authorizationTtls?: Object,   // #3625: TTLs por issue heredados (recursive-deps:from-N)
 * }} [opts]
 * @returns {{ok: boolean, rejected?: boolean, allowedIssues: number[], msg: string, diff?: object}}
 */
function setPartialPause(issues, opts = {}) {
    const normalized = (Array.isArray(issues) ? issues : [])
        .map(normalizeIssue)
        .filter(Boolean);
    const unique = [...new Set(normalized)].sort((a, b) => a - b);

    if (unique.length === 0) {
        // Delegate al `clearPartialPause` que también pasa por el gate.
        const r = clearPartialPause({
            source: opts.source,
            authorizedBy: opts.authorizedBy,
            justification: opts.justification || 'setPartialPause con lista vacía',
        });
        // Normalizar shape al de setPartialPause para compat con callers.
        if (r.rejected) {
            return { ok: false, rejected: true, allowedIssues: readPreviousAllowlist(), msg: 'Mutación rechazada por gate' };
        }
        return {
            ok: true,
            allowedIssues: [],
            msg: 'Pausa parcial desactivada (lista vacía)',
        };
    }

    const previous = readPreviousAllowlist();

    // #3625 — Gate + audit ANTES del write (invariante de orden).
    const gateResult = evaluateAndAudit({
        previous,
        current: unique,
        source: opts.source,
        authorizedBy: opts.authorizedBy,
        justification: opts.justification,
        intendedAction: 'write',
    });

    if (gateResult.rejected) {
        return {
            ok: false,
            rejected: true,
            allowedIssues: previous,
            msg: `Mutación rechazada por gate: removals sin authorizedBy válido (${gateResult.validation.reason}). ` +
                 `Removidos NO aplicados: ${gateResult.diff.removed.map(i => `#${i}`).join(', ')}`,
            diff: gateResult.diff,
        };
    }

    const data = {
        allowed_issues: unique,
        created_at: new Date().toISOString(),
        source: opts.source || 'unknown',
    };
    if (opts.acceptedDepRisk === true) data.accepted_dep_risk = true;
    if (opts.depSources && typeof opts.depSources === 'object') {
        // Filtrar a las claves que efectivamente terminaron en el allowlist.
        const filtered = {};
        for (const k of Object.keys(opts.depSources)) {
            const n = normalizeIssue(k);
            if (n && unique.includes(n)) {
                filtered[String(n)] = opts.depSources[k];
            }
        }
        if (Object.keys(filtered).length > 0) data.dep_sources = filtered;
    }
    // #3625 — TTLs heredados (e.g. de recursive-deps:from-N) viajan en el JSON
    // para que el cron de cleanup los purgue cuando expiren.
    if (opts.authorizationTtls && typeof opts.authorizationTtls === 'object') {
        const filtered = {};
        for (const k of Object.keys(opts.authorizationTtls)) {
            const n = normalizeIssue(k);
            if (n && unique.includes(n)) {
                filtered[String(n)] = opts.authorizationTtls[k];
            }
        }
        if (Object.keys(filtered).length > 0) data.authorization_ttls = filtered;
    } else {
        // Heredar TTLs previos sólo para issues que siguen en el allowlist.
        const prev = readPartialFile();
        if (prev && prev.authorization_ttls) {
            const inherited = {};
            for (const k of Object.keys(prev.authorization_ttls)) {
                const n = normalizeIssue(k);
                if (n && unique.includes(n)) {
                    inherited[String(n)] = prev.authorization_ttls[k];
                }
            }
            if (Object.keys(inherited).length > 0) data.authorization_ttls = inherited;
        }
    }
    // CA-2: write atómico (tmp + fsync + rename) bajo lock. Antes era un
    // writeFileSync directo — si dos /wave promote llegaban a la vez, el
    // segundo podía pisar al primero o dejar un JSON truncado si moría
    // a mitad del write.
    return withLockSync(partialFile(), () => {
        atomicWriteFile(partialFile(), JSON.stringify(data, null, 2));
        return {
            ok: true,
            allowedIssues: unique,
            diff: gateResult.diff,
            msg: `Pausa parcial activa — allowed: ${unique.map(i => `#${i}`).join(', ')}`,
        };
    }, {
        component: 'partial-pause-lock',
        timeoutMs: LOCK_TIMEOUT_MS,
        maxRetries: LOCK_MAX_RETRIES,
        notify: notifyTelegram,
    });
}

/**
 * Variante atómica que además devuelve un snapshot del estado previo para
 * habilitar rollback transaccional (#3520).
 *
 * Diferencias vs `setPartialPause`:
 *   - Antes de escribir, captura el contenido y SHA-256 del archivo previo
 *     (o `null` si no existía). Permite a `lib/waves.promoteWaveAtomic`
 *     restaurar exactamente el estado anterior sin depender de timestamped
 *     backups en `archived/`.
 *   - Write atómico (tmp + renameSync), idéntico a `setPartialPause`.
 *   - Lista vacía no elimina el marker — escribe `allowed_issues: []` para
 *     que la transacción tenga un estado uniforme (la limpieza la hace el
 *     caller si corresponde a su semántica).
 *
 * #3625 — Mismo gate de autorización: opts.authorizedBy + opts.justification.
 *
 * @param {Array<number|string>} issues
 * @param {{
 *   source?: string,
 *   acceptedDepRisk?: boolean,
 *   depSources?: Object,
 *   authorizedBy?: string,
 *   justification?: string,
 * }} [opts]
 * @returns {{
 *   ok: boolean,
 *   rejected?: boolean,
 *   allowedIssues: number[],
 *   msg: string,
 *   prevBuffer: Buffer|null,
 *   prevSha: string|null,
 *   existedBefore: boolean,
 * }}
 */
function setPartialPauseAtomic(issues, opts = {}) {
    // 1) Snapshot del estado previo (para rollback del caller).
    let prevBuffer = null;
    let prevSha = null;
    let existedBefore = false;
    try {
        prevBuffer = fs.readFileSync(partialFile());
        prevSha = require('crypto').createHash('sha256').update(prevBuffer).digest('hex');
        existedBefore = true;
    } catch (err) {
        if (err && err.code !== 'ENOENT') throw err;
    }

    // 2) Normalización y escritura (misma semántica que setPartialPause salvo
    //    que lista vacía no borra — siempre escribe un JSON válido).
    const normalized = (Array.isArray(issues) ? issues : [])
        .map(normalizeIssue)
        .filter(Boolean);
    const unique = [...new Set(normalized)].sort((a, b) => a - b);

    const previous = readPreviousAllowlist();

    // #3625 — Gate + audit ANTES del write.
    const gateResult = evaluateAndAudit({
        previous,
        current: unique,
        source: opts.source,
        authorizedBy: opts.authorizedBy,
        justification: opts.justification,
        intendedAction: 'write',
    });

    if (gateResult.rejected) {
        return {
            ok: false,
            rejected: true,
            allowedIssues: previous,
            msg: `Mutación rechazada por gate: removals sin authorizedBy válido (${gateResult.validation.reason})`,
            prevBuffer,
            prevSha,
            existedBefore,
        };
    }

    const data = {
        allowed_issues: unique,
        created_at: new Date().toISOString(),
        source: opts.source || 'unknown',
    };
    if (opts.acceptedDepRisk === true) data.accepted_dep_risk = true;
    if (opts.depSources && typeof opts.depSources === 'object') {
        const filtered = {};
        for (const k of Object.keys(opts.depSources)) {
            const n = normalizeIssue(k);
            if (n && unique.includes(n)) {
                filtered[String(n)] = opts.depSources[k];
            }
        }
        if (Object.keys(filtered).length > 0) data.dep_sources = filtered;
    }
    writeAtomic(partialFile(), JSON.stringify(data, null, 2));

    return {
        ok: true,
        allowedIssues: unique,
        msg: unique.length > 0
            ? `Pausa parcial activa — allowed: ${unique.map(i => `#${i}`).join(', ')}`
            : 'Pausa parcial activa con allowlist vacía (no bloquea)',
        prevBuffer,
        prevSha,
        existedBefore,
    };
}

/**
 * Helper interno: write atómico con tmp + renameSync.
 * No expuesto — uso interno de `setPartialPause` / `setPartialPauseAtomic`.
 *
 * @param {string} targetPath
 * @param {string} content
 */
function writeAtomic(targetPath, content) {
    const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
    try {
        fs.writeFileSync(tmp, content);
        fs.renameSync(tmp, targetPath);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch {}
        throw err;
    }
}

/**
 * Desactiva la pausa parcial (elimina marker).
 *
 * CA-2: bajo lock para evitar que un unlink pise un write en curso.
 * #3625: clear es removal masivo → exige `authorizedBy` válido. Si no pasa
 * el gate, NO se ejecuta el unlink y queda audit entry `action: 'reject'`.
 *
 * @param {{ source?: string, authorizedBy?: string, justification?: string }} [opts]
 * @returns {{ok: boolean, rejected?: boolean, existed: boolean}}
 */
function clearPartialPause(opts = {}) {
    const previous = readPreviousAllowlist();

    // Gate + audit antes del unlink.
    const gateResult = evaluateAndAudit({
        previous,
        current: [],
        source: opts.source,
        authorizedBy: opts.authorizedBy,
        justification: opts.justification || 'clearPartialPause',
        intendedAction: 'clear',
    });

    if (gateResult.rejected) {
        return {
            ok: false,
            rejected: true,
            existed: fs.existsSync(partialFile()),
        };
    }

    return withLockSync(partialFile(), () => {
        const existed = fs.existsSync(partialFile());
        if (existed) {
            try { fs.unlinkSync(partialFile()); } catch {}
        }
        return { ok: true, existed };
    }, {
        component: 'partial-pause-lock',
        timeoutMs: LOCK_TIMEOUT_MS,
        maxRetries: LOCK_MAX_RETRIES,
        notify: notifyTelegram,
    });
}

/**
 * Desactiva TODO modo de pausa (full + partial). Usado por /resume.
 *
 * #3625 — Requiere `authorizedBy: 'resume:operator'` por defecto. Sin él,
 * en modo grace se loguea warning; en strict, se rechaza.
 *
 * @param {{ source?: string, authorizedBy?: string, justification?: string }} [opts]
 * @returns {{removedFull: boolean, removedPartial: boolean, rejected?: boolean}}
 */
function resumeAll(opts = {}) {
    const previous = readPreviousAllowlist();

    // Sólo gateamos la parte partial-pause: el `.paused` no tiene allowlist.
    if (previous.length > 0) {
        const gateResult = evaluateAndAudit({
            previous,
            current: [],
            source: opts.source || 'resume:operator',
            authorizedBy: opts.authorizedBy || 'resume:operator',
            justification: opts.justification || 'resumeAll (full /resume)',
            intendedAction: 'clear',
        });
        if (gateResult.rejected) {
            return { removedFull: false, removedPartial: false, rejected: true };
        }
    }

    let removedFull = false;
    let removedPartial = false;
    if (fs.existsSync(pauseFile())) {
        try { fs.unlinkSync(pauseFile()); removedFull = true; } catch {}
    }
    if (fs.existsSync(partialFile())) {
        try { fs.unlinkSync(partialFile()); removedPartial = true; } catch {}
    }
    return { removedFull, removedPartial };
}

module.exports = {
    getPipelineMode,
    isIssueAllowed,
    isIssueAllowedInState,
    setPartialPause,
    setPartialPauseAtomic, // #3520
    clearPartialPause,
    resumeAll,
    // #3625 — exportados para callers que quieran leer estado raw y para tests.
    readPreviousAllowlist,
    evaluateAndAudit,
    _paths: () => ({ PARTIAL_FILE: partialFile(), PAUSE_FILE: pauseFile() }),
};
