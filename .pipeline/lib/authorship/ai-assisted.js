'use strict';
// =============================================================================
// #7631 — Generación asistida por IA desde el REGISTRO del pipeline
// (CA-5 · CA-8 de #7593 · SEC-G · riesgos 1-3 del guru).
//
// Fuente: los `session:start` de `.claude/activity-log.archive.jsonl` y
// `.claude/activity-log.jsonl` (en ese orden, que es el cronológico). NUNCA el
// `Co-Authored-By` que el LLM escribe en sus commits: eso es autoreporte.
//
// Alcance de la afirmación (S5): el trailer declara lo que dice el REGISTRO,
// que hoy es el modelo configurado para la sesión, no necesariamente el
// efectivo (#7638). Es consistencia con el registro, no autenticidad.
// =============================================================================

const path = require('path');

// P1 — Sólo los roles que generan código. Congelado en código.
const GENERATOR_ROLES = Object.freeze(['backend-dev', 'android-dev', 'pipeline-dev', 'web-dev']);

// Proveedor registrado en `session:start` → launcher del catálogo validado.
const PROVIDER_TO_LAUNCHER = Object.freeze({
    anthropic: 'claude',
    claude: 'claude',
    codex: 'codex',
    'openai-codex': 'codex',
    openai: 'codex',
    antigravity: 'antigravity',
});

// Allowlist de modelos conocidos por proveedor. Se DERIVA del catálogo ya
// validado del pipeline (`ALLOWED_MODELS_BY_LAUNCHER`) para no mantener una
// segunda lista que diverja; si el catálogo no carga, queda vacía y todo sale
// `unknown` (fail-closed: nunca se afirma un modelo sin poder validarlo).
const MODEL_ALLOWLIST = (() => {
    let catalog = {};
    try { catalog = require('../agent-models-validate').ALLOWED_MODELS_BY_LAUNCHER || {}; } catch { catalog = {}; }
    const out = {};
    for (const launcher of ['claude', 'codex', 'antigravity']) {
        out[launcher] = Object.freeze(Array.isArray(catalog[launcher]) ? [...catalog[launcher]] : []);
    }
    return Object.freeze(out);
})();

// El activity-log vive en el repo PRINCIPAL (no en el worktree del agente):
// se toma la misma ruta que usa el escritor (`traceability.LOG_FILE`, que
// resuelve el git common dir). Si no carga, cae al repo relativo a este archivo.
function defaultLogFiles() {
    let live;
    try { live = require('../traceability').LOG_FILE; } catch { live = null; }
    if (typeof live !== 'string' || !live) live = path.join(path.resolve(__dirname, '..', '..', '..'), '.claude', 'activity-log.jsonl');
    return [path.join(path.dirname(live), 'activity-log.archive.jsonl'), live];
}

// Tope de lectura por archivo (cola). El activity-log vivo rota; el archive
// puede crecer, y sólo interesan las corridas recientes del issue.
const READ_TAIL_BYTES = 8 * 1024 * 1024;

function readTail(file, _fs) {
    try {
        if (!_fs.existsSync(file)) return '';
        const stat = _fs.statSync(file);
        if (!stat || !stat.size) return '';
        if (stat.size <= READ_TAIL_BYTES || typeof _fs.openSync !== 'function') {
            return _fs.readFileSync(file, 'utf8');
        }
        const fd = _fs.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(READ_TAIL_BYTES);
            _fs.readSync(fd, buf, 0, READ_TAIL_BYTES, stat.size - READ_TAIL_BYTES);
            const raw = buf.toString('utf8');
            // La primera línea quedó cortada por el tail: se descarta.
            return raw.slice(raw.indexOf('\n') + 1);
        } finally { _fs.closeSync(fd); }
    } catch { return ''; }
}

function isAllowed(provider, model) {
    const launcher = PROVIDER_TO_LAUNCHER[provider];
    if (!launcher) return false;
    const list = MODEL_ALLOWLIST[launcher] || [];
    return list.includes(model);
}

/**
 * @param {object} p
 * @param {number} p.issue
 * @param {string[]} [p.logFiles] — en orden cronológico (archive primero).
 * @param {object} [p.fsImpl]
 * @returns {Array<{provider:string, model:string, role:string}>|'unknown'}
 */
function resolveAiAssisted({ issue, logFiles = defaultLogFiles(), fsImpl } = {}) {
    const _fs = fsImpl || require('fs');
    const n = Number(issue);
    if (!Number.isInteger(n) || n <= 0) return 'unknown';

    const lastByRole = {};
    for (const file of Array.isArray(logFiles) ? logFiles : []) {
        const raw = readTail(file, _fs);
        if (!raw) continue;
        for (const line of raw.split('\n')) {
            if (!line || line[0] !== '{') continue;
            let evt;
            try { evt = JSON.parse(line); } catch { continue; }
            if (!evt || evt.event !== 'session:start') continue;
            if (Number(evt.issue) !== n) continue;
            if (!GENERATOR_ROLES.includes(evt.skill)) continue;
            if (evt.provider === 'deterministic' || evt.model === 'deterministic') continue;
            lastByRole[evt.skill] = evt; // la última de cada rol gana
        }
    }

    const roles = Object.keys(lastByRole).sort();
    if (!roles.length) return 'unknown';
    return roles.map((role) => {
        const evt = lastByRole[role];
        const provider = typeof evt.provider === 'string' ? evt.provider : '';
        const model = typeof evt.model === 'string' ? evt.model : '';
        if (!isAllowed(provider, model)) return { provider: 'unknown', model: 'unknown', role };
        return { provider, model, role };
    });
}

module.exports = {
    resolveAiAssisted,
    GENERATOR_ROLES,
    MODEL_ALLOWLIST,
    PROVIDER_TO_LAUNCHER,
    defaultLogFiles,
};
