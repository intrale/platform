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
// El marker JSON tiene el shape:
//   { allowed_issues: [2490, 2491], created_at: "2026-04-23T19:40:00Z", source: "telegram" }

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
        return {
            allowed_issues: allowed,
            created_at: parsed.created_at || null,
            source: parsed.source || null,
        };
    } catch {
        return null;
    }
}

/**
 * Estado actual del pipeline.
 * @returns {{mode: 'running'|'paused'|'partial_pause', allowedIssues: number[], createdAt: string|null, source: string|null}}
 */
function getPipelineMode() {
    if (fs.existsSync(pauseFile())) {
        return { mode: 'paused', allowedIssues: [], createdAt: null, source: null };
    }
    const partial = readPartialFile();
    if (partial && partial.allowed_issues.length > 0) {
        return {
            mode: 'partial_pause',
            allowedIssues: partial.allowed_issues,
            createdAt: partial.created_at,
            source: partial.source,
        };
    }
    return { mode: 'running', allowedIssues: [], createdAt: null, source: null };
}

/**
 * Determina si un issue puede procesarse según el estado actual.
 * @param {number|string} issue
 * @returns {boolean}
 */
function isIssueAllowed(issue) {
    const n = normalizeIssue(issue);
    if (!n) return false;
    const state = getPipelineMode();
    if (state.mode === 'paused') return false;
    if (state.mode === 'running') return true;
    return state.allowedIssues.includes(n);
}

/**
 * Activa la pausa parcial con un allowlist de issues.
 * Lista vacía → elimina el marker (equivalente a clear).
 * @param {Array<number|string>} issues
 * @param {{source?: string}} [opts]
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
    fs.writeFileSync(partialFile(), JSON.stringify(data, null, 2));
    return {
        ok: true,
        allowedIssues: unique,
        msg: `Pausa parcial activa — allowed: ${unique.map(i => `#${i}`).join(', ')}`,
    };
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
    setPartialPause,
    clearPartialPause,
    resumeAll,
    _paths: () => ({ PARTIAL_FILE: partialFile(), PAUSE_FILE: pauseFile() }),
};
