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

'use strict';

const fs = require('fs');
const path = require('path');

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
        };
    } catch {
        return null;
    }
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

/**
 * Activa la pausa parcial con un allowlist de issues.
 * Lista vacía → elimina el marker (equivalente a clear).
 *
 * #3520 — Write atómico vía tmp+rename. Sustituye al `writeFileSync` directo
 * que dejaba el JSON truncado ante un kill -9 mid-write. Es prerequisito para
 * la transacción multi-archivo de `lib/waves.promoteWaveAtomic`.
 *
 * @param {Array<number|string>} issues
 * @param {{
 *   source?: string,
 *   acceptedDepRisk?: boolean,
 *   depSources?: Object,
 * }} [opts]
 * @returns {{ok: boolean, allowedIssues: number[], msg: string}}
 */
function setPartialPause(issues, opts = {}) {
    const normalized = (Array.isArray(issues) ? issues : [])
        .map(normalizeIssue)
        .filter(Boolean);
    const unique = [...new Set(normalized)].sort((a, b) => a - b);

    if (unique.length === 0) {
        clearPartialPause();
        return { ok: true, allowedIssues: [], msg: 'Pausa parcial desactivada (lista vacía)' };
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
    writeAtomic(partialFile(), JSON.stringify(data, null, 2));
    return {
        ok: true,
        allowedIssues: unique,
        msg: `Pausa parcial activa — allowed: ${unique.map(i => `#${i}`).join(', ')}`,
    };
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
 * @param {Array<number|string>} issues
 * @param {{source?: string, acceptedDepRisk?: boolean, depSources?: Object}} [opts]
 * @returns {{
 *   ok: boolean,
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
 * @returns {{ok: boolean, existed: boolean}}
 */
function clearPartialPause() {
    const existed = fs.existsSync(partialFile());
    if (existed) {
        try { fs.unlinkSync(partialFile()); } catch {}
    }
    return { ok: true, existed };
}

/**
 * Desactiva TODO modo de pausa (full + partial). Usado por /resume.
 * @returns {{removedFull: boolean, removedPartial: boolean}}
 */
function resumeAll() {
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
    _paths: () => ({ PARTIAL_FILE: partialFile(), PAUSE_FILE: pauseFile() }),
};
