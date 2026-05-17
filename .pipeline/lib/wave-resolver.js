// =============================================================================
// wave-resolver.js — Resolver de "ola activa" para el snapshot ejecutivo (#3262).
//
// Responde la pregunta "¿qué issues integran la ola actual?" mirando, en orden
// de prioridad:
//
//   1. `.pipeline/active-wave.json`  → fuente canónica (formato preferido).
//      Schema: { label: "N+5", issues: [3253, 3257, ...], opened_at, source }
//
//   2. `.pipeline/.partial-pause.json`  → fuente actual de hecho. Cuando Leo
//      arranca una ola edita la allowlist; los issues incluidos son la ola.
//      Schema: { allowed_issues: [...], created_at, source }
//
//   3. Fallback: todos los issues con archivos activos en el pipeline.
//      Etiqueta "Ola actual (sin label)" — degradación grácil (CA-15).
//
// La idea de tener `active-wave.json` como esquema separado viene de la
// recomendación de guru en el análisis técnico del issue: hoy hay deriva
// (allowlist, comentarios libres, milestones) y queremos un punto único de
// verdad para "ola actual". Este módulo lo lee si existe pero NO falla si no.
//
// Reglas inquebrantables:
// - Sin red. Sin GitHub API. Solo filesystem propio del pipeline.
// - Sin throw a callers: cualquier excepción de I/O degrada al siguiente nivel.
// - Cero acoplamiento con dashboard.js — recibe el state como parámetro cuando
//   necesita derivar issues activos del filesystem (camino fallback).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// Constantes de pipeline — replicadas localmente para no acoplar con
// dashboard.js (que carga config.yaml y arrastra deps innecesarias).
const PIPELINE_NAMES = ['definicion', 'desarrollo'];
const ACTIVE_STATES = ['pendiente', 'trabajando', 'listo'];

/**
 * Lee `active-wave.json` si existe y es válido.
 *
 * @param {string} pipelineRoot
 * @returns {{label: string, issues: number[], openedAt: string|null, source: string}|null}
 */
function readActiveWaveFile(pipelineRoot) {
    const file = path.join(pipelineRoot, 'active-wave.json');
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const label = typeof parsed.label === 'string' ? parsed.label.trim() : '';
    const issuesRaw = Array.isArray(parsed.issues) ? parsed.issues : [];
    const issues = issuesRaw
        .map((n) => Number(String(n).replace(/^#/, '').trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    if (!label || issues.length === 0) return null;
    return {
        label,
        issues: [...new Set(issues)].sort((a, b) => a - b),
        openedAt: typeof parsed.opened_at === 'string' ? parsed.opened_at : null,
        source: 'active-wave.json',
    };
}

/**
 * Lee `.partial-pause.json` y deriva la "ola actual" desde los issues permitidos.
 *
 * @param {string} pipelineRoot
 * @returns {{label: string, issues: number[], openedAt: string|null, source: string}|null}
 */
function readPartialPauseFile(pipelineRoot) {
    const file = path.join(pipelineRoot, '.partial-pause.json');
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const issuesRaw = Array.isArray(parsed.allowed_issues) ? parsed.allowed_issues : [];
    const issues = issuesRaw
        .map((n) => Number(String(n).replace(/^#/, '').trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    if (issues.length === 0) return null;
    return {
        label: 'Ola actual',
        issues: [...new Set(issues)].sort((a, b) => a - b),
        openedAt: typeof parsed.created_at === 'string' ? parsed.created_at : null,
        source: 'partial-pause.json',
    };
}

/**
 * Fallback: lista todos los issues con archivos activos en pendiente/trabajando/listo.
 *
 * @param {string} pipelineRoot
 * @returns {{label: string, issues: number[], openedAt: null, source: string}}
 */
function collectActiveIssuesFromFs(pipelineRoot) {
    const issues = new Set();
    for (const pipeline of PIPELINE_NAMES) {
        const pipeRoot = path.join(pipelineRoot, pipeline);
        let phases = [];
        try {
            phases = fs.readdirSync(pipeRoot, { withFileTypes: true })
                .filter((d) => d.isDirectory())
                .map((d) => d.name);
        } catch {
            continue;
        }
        for (const phase of phases) {
            for (const state of ACTIVE_STATES) {
                const dir = path.join(pipeRoot, phase, state);
                let files = [];
                try { files = fs.readdirSync(dir); } catch { continue; }
                for (const f of files) {
                    const m = f.match(/^(\d+)\./);
                    if (!m) continue;
                    const n = Number(m[1]);
                    if (Number.isInteger(n) && n > 0) issues.add(n);
                }
            }
        }
    }
    return {
        label: 'Ola actual (sin label)',
        issues: [...issues].sort((a, b) => a - b),
        openedAt: null,
        source: 'fs-fallback',
    };
}

/**
 * Resuelve la ola activa con la cascada de fuentes.
 *
 * @param {object} opts
 * @param {string} opts.pipelineRoot - Path absoluto al directorio `.pipeline`.
 * @returns {{
 *   label: string,
 *   issues: number[],
 *   openedAt: string|null,
 *   source: 'active-wave.json'|'partial-pause.json'|'fs-fallback',
 *   resolved: boolean,
 * }}
 */
function resolveActiveWave(opts) {
    const pipelineRoot = opts && opts.pipelineRoot;
    if (!pipelineRoot) {
        return { label: 'Ola actual (sin label)', issues: [], openedAt: null, source: 'fs-fallback', resolved: false };
    }

    const fromFile = readActiveWaveFile(pipelineRoot);
    if (fromFile) return { ...fromFile, resolved: true };

    const fromPartial = readPartialPauseFile(pipelineRoot);
    if (fromPartial) return { ...fromPartial, resolved: true };

    const fromFs = collectActiveIssuesFromFs(pipelineRoot);
    return { ...fromFs, resolved: fromFs.issues.length > 0 };
}

module.exports = {
    resolveActiveWave,
    // Exports internos para tests
    _internal: {
        readActiveWaveFile,
        readPartialPauseFile,
        collectActiveIssuesFromFs,
    },
};
