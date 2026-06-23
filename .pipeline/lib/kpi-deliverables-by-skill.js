// =============================================================================
// kpi-deliverables-by-skill.js — Agregador del KPI "Entregables por skill".
//
// Issue: #3932 (EP3-H6) — "% de fases cerradas con entregable, por skill".
//
// Diseño (receta del arquitecto, consistente con `kpis-data.js`):
//   - DATA-ONLY y testeable en aislamiento. Lee el audit JSONL append-only del
//     notificador de entregables (`.pipeline/audit/deliverable-notifications.jsonl`)
//     y deriva, por skill, { delivered, total, pct, band, partial }.
//   - NO escribe instrumentación nueva: numerador del JSONL, denominador del
//     estado existente (`<pipeline>/<fase>/procesado/<issue>.<skill>`).
//
// Numerador / denominador (decisión PO — opción (a) con fallback (b)):
//   - Numerador  = count(distinct (issue, fase, skill)) con notificación de
//                  entregable en el JSONL, por skill.
//   - Denominador= total de fases CERRADAS por ese skill, contadas desde
//                  `procesado/` del filesystem. Si `procesado/` está vacío/no
//                  disponible para un skill → fallback (b): universo de fases
//                  asignadas al skill en `skills_por_fase` (config.yaml). En ese
//                  caso `partial: true` (dato parcial, no 0, no oculto).
//
// Seguridad (CA-5 / A01-A02 — BLOQUEANTE):
//   - PROYECCIÓN ESTRICTA: el agregador lee de cada línea del JSONL ÚNICAMENTE
//     `issue` / `fase` / `skill` / `pipeline` / `ts`. NUNCA propaga `preview`,
//     `content_hash`, `dropfile`, `attachment_path` al objeto retornado.
//   - PARSING DEFENSIVO (A03): `JSON.parse` por línea dentro de try/catch;
//     líneas malformadas se descartan sin cortar el endpoint. Path FIJO, nunca
//     derivado de query string (anti path-traversal).
//   - WHITELIST: `skill`/`fase` se validan contra `config.yaml`
//     (`deliverable_notifications.skills`, `skills_por_fase`) antes de agregar;
//     valores fuera de whitelist se descartan (no llegan al DOM).
//
// Performance (A04): el JSONL crece (1700+ líneas) → cache TTL ~5min memoizado
// a nivel módulo con invalidación por mtime del archivo. Mitiga lectura
// síncrona ilimitada por request.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Path FIJO del audit JSONL (relativo al repoRoot). NUNCA derivado de input.
const AUDIT_REL_PATH = path.join('.pipeline', 'audit', 'deliverable-notifications.jsonl');

// Bandas de color alineadas a la meta del CA (≥80%).
//   pct >= 80        → verde  (ok)
//   60 <= pct < 80   → amarillo (warn)
//   pct < 60         → rojo   (bad)
const BAND_GREEN = 80;
const BAND_YELLOW = 60;

// Cache 5min con invalidación por mtime del JSONL (req. A04).
const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache = { at: 0, mtime: 0, value: null };

// Para tests: resetea el cache entre casos.
function _resetCache() {
    _cache = { at: 0, mtime: 0, value: null };
}

/**
 * Mapea un porcentaje a su banda de color / severidad.
 * @param {number|null} pct
 * @returns {{ band: string, severity: string }}
 */
function bandFor(pct) {
    if (pct == null || !Number.isFinite(pct)) return { band: 'gris', severity: 'none' };
    if (pct >= BAND_GREEN) return { band: 'verde', severity: 'ok' };
    if (pct >= BAND_YELLOW) return { band: 'amarillo', severity: 'warn' };
    return { band: 'rojo', severity: 'bad' };
}

/**
 * Resuelve el repoRoot a partir de ctx/env, con fallback al árbol del módulo.
 */
function _resolveRepoRoot(ctx) {
    return (ctx && ctx.REPO_ROOT)
        || process.env.PIPELINE_REPO_ROOT
        || process.env.CLAUDE_PROJECT_DIR
        || path.resolve(__dirname, '..', '..');
}

/**
 * Carga el config.yaml (preferimos `ctx.config` ya cargado por el dashboard;
 * fallback a lectura+parseo defensivo). FAIL-OPEN: ante cualquier error
 * devuelve `{}` → whitelists vacías → no se agrega nada (no rompe el endpoint).
 */
function _loadConfig(ctx, repoRoot) {
    if (ctx && ctx.config && typeof ctx.config === 'object') return ctx.config;
    try {
        // eslint-disable-next-line global-require
        const yaml = require('js-yaml'); // safe-by-default (yaml.load)
        const cfgPath = path.join(repoRoot, '.pipeline', 'config.yaml');
        return yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
    } catch {
        return {};
    }
}

/**
 * Construye las whitelists desde el config:
 *   - skillsWhitelist: Set de skills notificables (deliverable_notifications.skills).
 *   - faseWhitelist:   Set de fases válidas (claves de skills_por_fase, todos los pipelines).
 *   - faseUniverseBySkill: Map skill → cantidad de fases en las que el skill aparece
 *                          en `skills_por_fase` (denominador fallback opción b).
 */
function _buildWhitelists(config) {
    const cfg = config || {};
    const dn = (cfg.deliverable_notifications && cfg.deliverable_notifications.skills) || [];
    const skillsWhitelist = new Set(Array.isArray(dn) ? dn.map(String) : []);

    const faseWhitelist = new Set();
    const faseUniverseBySkill = new Map(); // skill → Set de "pipeline/fase"

    const pipelines = (cfg.pipelines && typeof cfg.pipelines === 'object') ? cfg.pipelines : {};
    for (const [pipeName, pipeCfg] of Object.entries(pipelines)) {
        const spf = (pipeCfg && pipeCfg.skills_por_fase && typeof pipeCfg.skills_por_fase === 'object')
            ? pipeCfg.skills_por_fase : {};
        for (const [fase, skillsArr] of Object.entries(spf)) {
            faseWhitelist.add(String(fase));
            if (!Array.isArray(skillsArr)) continue;
            for (const sk of skillsArr) {
                const skill = String(sk);
                if (!faseUniverseBySkill.has(skill)) faseUniverseBySkill.set(skill, new Set());
                faseUniverseBySkill.get(skill).add(`${pipeName}/${fase}`);
            }
        }
    }

    return { skillsWhitelist, faseWhitelist, faseUniverseBySkill };
}

/**
 * Numerador: lee el JSONL línea por línea (parsing defensivo), proyecta SOLO
 * las claves seguras, valida contra whitelists, y deduplica por
 * `(issue, fase, skill)`. Devuelve Map skill → Set de claves distintas.
 *
 * @returns {{ deliveredBySkill: Map<string, Set<string>>, available: boolean }}
 */
function _readNumerator(repoRoot, skillsWhitelist, faseWhitelist) {
    const file = path.join(repoRoot, AUDIT_REL_PATH);
    const deliveredBySkill = new Map(); // skill → Set("<issue>|<fase>")
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return { deliveredBySkill, available: false };
    }
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; } // descarta malformadas
        if (!evt || typeof evt !== 'object') continue;

        // PROYECCIÓN ESTRICTA — sólo estas claves se leen del evento.
        const skill = evt.skill == null ? '' : String(evt.skill);
        const fase = evt.fase == null ? '' : String(evt.fase);
        const issue = evt.issue == null ? '' : String(evt.issue);

        // WHITELIST: descartar skill/fase fuera de catálogo o issue vacío.
        if (!skill || !fase || !issue) continue;
        if (!skillsWhitelist.has(skill)) continue;
        if (!faseWhitelist.has(fase)) continue;

        // DEDUP por (issue, fase, skill).
        if (!deliveredBySkill.has(skill)) deliveredBySkill.set(skill, new Set());
        deliveredBySkill.get(skill).add(`${issue}|${fase}`);
    }
    return { deliveredBySkill, available: true };
}

/**
 * Denominador opción (a): cuenta las fases CERRADAS por skill desde
 * `<pipeline>/<fase>/procesado/<issue>.<skill>` en el filesystem. Deduplica por
 * `(issue, fase, skill)`. Devuelve Map skill → Set de claves distintas.
 */
function _readDenominatorFs(repoRoot, config, skillsWhitelist) {
    const cfg = config || {};
    const closedBySkill = new Map(); // skill → Set("<issue>|<fase>")
    const pipelines = (cfg.pipelines && typeof cfg.pipelines === 'object') ? cfg.pipelines : {};

    for (const [pipeName, pipeCfg] of Object.entries(pipelines)) {
        const fases = Array.isArray(pipeCfg && pipeCfg.fases) ? pipeCfg.fases : [];
        for (const fase of fases) {
            const dir = path.join(repoRoot, '.pipeline', String(pipeName), String(fase), 'procesado');
            let entries;
            try { entries = fs.readdirSync(dir); } catch { continue; }
            for (const name of entries) {
                // Formato esperado: "<issue>.<skill>". El skill puede contener
                // guiones (pipeline-dev) pero no puntos → split por el PRIMER punto.
                const dot = name.indexOf('.');
                if (dot <= 0 || dot >= name.length - 1) continue;
                const issue = name.slice(0, dot);
                const skill = name.slice(dot + 1);
                if (!/^\d+$/.test(issue)) continue; // sólo issues numéricos
                if (!skillsWhitelist.has(skill)) continue;
                if (!closedBySkill.has(skill)) closedBySkill.set(skill, new Set());
                closedBySkill.get(skill).add(`${issue}|${String(fase)}`);
            }
        }
    }
    return closedBySkill;
}

/**
 * Agregador principal. Devuelve SÓLO agregados numéricos por skill — sin
 * ninguna clave sensible del JSONL (CA-5).
 *
 * @param {object} [ctx] — { REPO_ROOT?, config? }.
 * @returns {{
 *   skills: Array<{ skill, delivered, total, pct, band, severity, partial }>,
 *   meta: { numeratorAvailable: boolean, generatedAt: string }
 * }}
 */
function getDeliverablesBySkill(ctx) {
    const repoRoot = _resolveRepoRoot(ctx);
    const file = path.join(repoRoot, AUDIT_REL_PATH);

    // Cache 5min con invalidación por mtime del JSONL.
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { mtime = 0; }
    const now = Date.now();
    if (_cache.value && (now - _cache.at) < CACHE_TTL_MS && _cache.mtime === mtime) {
        return _cache.value;
    }

    const config = _loadConfig(ctx, repoRoot);
    const { skillsWhitelist, faseWhitelist, faseUniverseBySkill } = _buildWhitelists(config);

    const { deliveredBySkill, available } = _readNumerator(repoRoot, skillsWhitelist, faseWhitelist);
    const closedBySkill = _readDenominatorFs(repoRoot, config, skillsWhitelist);

    // Unión de skills: whitelist completa (CA-1 "por cada skill con entregable
    // definido") + cualquiera con datos. Iteramos la whitelist para no ocultar
    // skills sin cierres todavía (UX G-UX-4: total=0 → "—", no 0% rojo).
    const allSkills = new Set([
        ...skillsWhitelist,
        ...deliveredBySkill.keys(),
        ...closedBySkill.keys(),
    ]);

    const skills = [];
    for (const skill of allSkills) {
        const delivered = deliveredBySkill.has(skill) ? deliveredBySkill.get(skill).size : 0;
        const fsClosed = closedBySkill.has(skill) ? closedBySkill.get(skill).size : 0;

        let total = fsClosed;
        let partial = false;

        if (fsClosed === 0) {
            // Fallback (b): denominador = universo de fases asignadas al skill.
            const universe = faseUniverseBySkill.has(skill) ? faseUniverseBySkill.get(skill).size : 0;
            if (universe > 0) {
                total = universe;
                partial = true;
            } else {
                total = 0; // sin cierres y sin universo → "—" en la vista.
            }
        } else if (delivered > fsClosed) {
            // Divergencia: el JSONL tiene más entregables que cierres en
            // procesado/ (p.ej. procesado limpiado). Dato parcial, no inflamos.
            partial = true;
        }

        let pct = null;
        if (total > 0) {
            pct = Math.round((delivered / total) * 100);
            if (pct > 100) pct = 100; // clamp defensivo ante divergencia.
            if (pct < 0) pct = 0;
        }

        const { band, severity } = bandFor(pct);
        skills.push({ skill, delivered, total, pct, band, severity, partial });
    }

    // Orden por accionabilidad (UX G-UX-3): peores primero. `pct=null` (sin
    // cierres) al final. Desempate alfabético.
    skills.sort((a, b) => {
        const pa = a.pct == null ? Infinity : a.pct;
        const pb = b.pct == null ? Infinity : b.pct;
        if (pa !== pb) return pa - pb;
        return a.skill.localeCompare(b.skill);
    });

    const result = {
        skills,
        meta: {
            numeratorAvailable: available,
            generatedAt: new Date(now).toISOString(),
        },
    };

    _cache = { at: now, mtime, value: result };
    return result;
}

module.exports = {
    getDeliverablesBySkill,
    bandFor,
    _resetCache,
    // exportados para tests unitarios aislados:
    _buildWhitelists,
    _readNumerator,
    _readDenominatorFs,
    BAND_GREEN,
    BAND_YELLOW,
};
