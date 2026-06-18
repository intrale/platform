// =============================================================================
// wave-resolver.js — Resolver de "ola activa" para el snapshot ejecutivo.
//
// Responde la pregunta "¿qué issues integran la ola actual?" delegando en la
// source-of-truth canónica `lib/waves.js` (issue #3502) y degradando con
// gracia si esa fuente no tiene una ola activa poblada.
//
// Cascada de fuentes (en orden de prioridad):
//
//   1. `lib/waves.js` → `waves.getActiveWave()` lee `.pipeline/waves.json`
//      con TTL cache 2s. Es la única fuente canónica desde #3489 / H1.
//      → source: 'waves.json'.
//
//   2. `.pipeline/.partial-pause.json` → fuente legacy de hecho mientras
//      `waves.json` no esté poblado. Migration path heredado del diseño
//      original; se mantiene para compatibilidad operativa.
//      Schema: { allowed_issues: [...], created_at, source }
//      → source: 'partial-pause.json'.
//
//   3. Fallback: todos los issues con archivos activos en el pipeline.
//      Etiqueta "Ola actual (sin label)" — degradación grácil (CA-15).
//      → source: 'fs-fallback'.
//
// Reglas inquebrantables:
// - Sin red. Sin GitHub API. Solo filesystem propio del pipeline.
// - Sin throw a callers: cualquier excepción de I/O degrada al siguiente nivel.
// - Cero acoplamiento con dashboard.js — recibe el state como parámetro cuando
//   necesita derivar issues activos del filesystem (camino fallback).
// - Shape externo PRESERVADO: { label, issues, openedAt, source, resolved }.
//   `wave-snapshot.js` y `wave-renderer.js` consumen este shape sin cambios.
//
// Histórico:
//   - Pre-#3502: la cascada arrancaba con `active-wave.json` (archivo que
//     NUNCA existió en disco real) y caía a `.partial-pause.json`. Esa función
//     muerta (`readActiveWaveFile`) fue eliminada en #3502.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const waves = require('./waves');

// Constantes de pipeline — replicadas localmente para no acoplar con
// dashboard.js (que carga config.yaml y arrastra deps innecesarias).
const PIPELINE_NAMES = ['definicion', 'desarrollo'];
const ACTIVE_STATES = ['pendiente', 'trabajando', 'listo'];

/**
 * Normaliza un identificador de issue tolerando AMBOS shapes que aparecen en
 * el wild (CA-4 — normalizador defensivo por schema drift de `waves.json`):
 *
 *   - { number: 3501 }       ← shape canónico esperado por `lib/waves.js`.
 *   - 3501                   ← shape "flat" del `waves.json` real en disco hoy.
 *   - "#3501" / " 3501 "     ← strings con/sin prefijo o whitespace.
 *
 * Devuelve int positivo o null si no es válido.
 *
 * @param {*} value
 * @returns {number|null}
 */
function normalizeIssueNumber(value) {
    // Pattern defensivo `i.number ?? i` — flagged por guru en el análisis.
    const raw = (value && typeof value === 'object') ? value.number : value;
    if (raw === null || raw === undefined) return null;
    const n = Number(String(raw).trim().replace(/^#/, ''));
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Calcula el `pipelineDir` que `lib/waves.js` resolvería internamente.
 *
 * `waves.js` usa `PIPELINE_DIR_OVERRIDE` (si está definida) o `__dirname/..`
 * dentro de `.pipeline/lib/`. Como este resolver vive en el mismo directorio,
 * `path.resolve(__dirname, '..')` coincide con el cálculo de waves.js cuando
 * no hay override. Esto nos permite saber si necesitamos hacer override
 * temporal del env var (caso típico: tests con pipelineRoot en tmp dir).
 *
 * @returns {string} path absoluto al directorio `.pipeline`
 */
function effectiveWavesPipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

/**
 * Lee la ola activa delegando en `lib/waves.js` (source-of-truth canónica).
 *
 * Si `pipelineRoot` no coincide con el directorio que `lib/waves.js` resolvería
 * internamente, se hace override temporal de `PIPELINE_DIR_OVERRIDE` para
 * forzar a `waves.js` a leer el `waves.json` del root pedido (caso típico:
 * tests con tmp dirs). El override se restaura en `finally` y se invalida la
 * cache antes y después para no contaminar otros consumers.
 *
 * En producción `pipelineRoot` coincide naturalmente con `pipelineDir()` de
 * waves.js, así que el override es no-op y la cache TTL 2s se hereda (CA-9).
 *
 * @param {string} pipelineRoot
 * @returns {{label: string, issues: number[], openedAt: string|null, source: 'waves.json'}|null}
 */
function readFromWavesJson(pipelineRoot) {
    const wavesDir = effectiveWavesPipelineDir();
    const needsOverride = path.resolve(pipelineRoot) !== path.resolve(wavesDir);
    const prevOverride = process.env.PIPELINE_DIR_OVERRIDE;

    if (needsOverride) {
        process.env.PIPELINE_DIR_OVERRIDE = pipelineRoot;
        waves.invalidateCache();
    }

    let active;
    try {
        active = waves.getActiveWave();
    } catch {
        active = null;
    } finally {
        if (needsOverride) {
            if (prevOverride === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
            else process.env.PIPELINE_DIR_OVERRIDE = prevOverride;
            waves.invalidateCache();
        }
    }

    if (!active || !Array.isArray(active.issues) || active.issues.length === 0) {
        return null;
    }

    // CA-4 — normalizador defensivo: tolera issues como int planos o {number}.
    const issues = active.issues
        .map(normalizeIssueNumber)
        .filter(Boolean);
    if (issues.length === 0) return null;

    const nameTrim = typeof active.name === 'string' ? active.name.trim() : '';
    const label = nameTrim
        || (active.number != null ? `Ola ${active.number}` : 'Ola actual');
    const openedAt = typeof active.started_at === 'string' ? active.started_at : null;

    return {
        label,
        issues: [...new Set(issues)].sort((a, b) => a - b),
        openedAt,
        source: 'waves.json',
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
        .map(normalizeIssueNumber)
        .filter(Boolean);
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
 * Resuelve el mapa de dependencias parent→children desde `.partial-pause.json`
 * (#4075). Las dependencias de un issue bloqueado se modelan en
 * `authorization_ttls`, donde cada entrada `<childId>: { parent: <parentId> }`
 * expresa que `childId` fue autorizado a la ola POR ser dependencia de
 * `parentId`. Invertimos esa relación para responder "¿qué issues bloquean a
 * #parentId?" → la lista de sus children.
 *
 * Fuente de verdad real (no hardcodeo): el mismo archivo que la allowlist usa
 * para autorizar issues recursivamente (recursive-deps). Si el archivo no
 * existe / no parsea / no tiene `authorization_ttls`, devuelve `{}` (fallback
 * grácil → el renderer mantiene el motivo genérico).
 *
 * @param {object} opts
 * @param {string} opts.pipelineRoot - Path absoluto al directorio `.pipeline`.
 * @returns {Object<number, number[]>} mapa parentId → [childId, ...] ordenado asc.
 */
function resolveBlockDependencies(opts) {
    const pipelineRoot = opts && opts.pipelineRoot;
    if (!pipelineRoot) return {};
    const file = path.join(pipelineRoot, '.partial-pause.json');
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object') return {};
    const ttls = parsed.authorization_ttls && typeof parsed.authorization_ttls === 'object'
        ? parsed.authorization_ttls
        : {};
    const map = {};
    for (const [childKey, info] of Object.entries(ttls)) {
        const child = normalizeIssueNumber(childKey);
        const parent = info && typeof info === 'object' ? normalizeIssueNumber(info.parent) : null;
        if (child === null || parent === null) continue;
        if (!map[parent]) map[parent] = [];
        if (!map[parent].includes(child)) map[parent].push(child);
    }
    for (const k of Object.keys(map)) map[k].sort((a, b) => a - b);
    return map;
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
 *   source: 'waves.json'|'partial-pause.json'|'fs-fallback',
 *   resolved: boolean,
 * }}
 */
function resolveActiveWave(opts) {
    const pipelineRoot = opts && opts.pipelineRoot;
    if (!pipelineRoot) {
        return { label: 'Ola actual (sin label)', issues: [], openedAt: null, source: 'fs-fallback', resolved: false };
    }

    const fromWaves = readFromWavesJson(pipelineRoot);
    if (fromWaves) return { ...fromWaves, resolved: true };

    const fromPartial = readPartialPauseFile(pipelineRoot);
    if (fromPartial) return { ...fromPartial, resolved: true };

    const fromFs = collectActiveIssuesFromFs(pipelineRoot);
    return { ...fromFs, resolved: fromFs.issues.length > 0 };
}

// =============================================================================
// resolveWaveForIssue — lookup issue→ola multi-lista (issue #4019).
//
// A diferencia de `resolveActiveWave` (que solo resuelve la ola ACTIVA), este
// helper escanea las TRES listas de `waves.json` (`active_wave`,
// `planned_waves`, `archived_waves`) y devuelve la ola que contiene al issue.
// Necesario para notificar la entrega de un issue que ya cayó a una ola
// archivada (su PR mergeado cierra vía `Closes #`, pero la ola pudo rotar).
//
// Reglas:
// - Sin red, solo filesystem (delega en `lib/waves.js::loadWaves`, fuente
//   canónica con cache TTL — mismo override de `PIPELINE_DIR_OVERRIDE` que
//   `readFromWavesJson` para soportar tests con tmp dirs).
// - `normalizeIssueNumber` castea cada issue a int positivo y descarta `null`
//   (defensa security CA-6: los issues de `waves.json` son editables a mano).
// - Devuelve `null` si el issue no pertenece a ninguna ola (CA-4: la
//   notificación se comporta como hoy, sin sección de avance).
// - Sin throw a callers: cualquier excepción de I/O degrada a `null`.
// =============================================================================

/**
 * Lee el documento completo de `waves.json` delegando en `lib/waves.js`
 * (fuente canónica) respetando el override temporal de `PIPELINE_DIR_OVERRIDE`
 * — mismo patrón que `readFromWavesJson` — para que los tests con tmp dirs
 * funcionen y producción herede la cache TTL.
 *
 * @param {string} pipelineRoot
 * @returns {{active_wave: object|null, planned_waves: object[], archived_waves: object[]}|null}
 */
function readWavesDoc(pipelineRoot) {
    const wavesDir = effectiveWavesPipelineDir();
    const needsOverride = path.resolve(pipelineRoot) !== path.resolve(wavesDir);
    const prevOverride = process.env.PIPELINE_DIR_OVERRIDE;

    if (needsOverride) {
        process.env.PIPELINE_DIR_OVERRIDE = pipelineRoot;
        waves.invalidateCache();
    }

    let doc = null;
    try {
        doc = waves.loadWaves();
    } catch {
        doc = null;
    } finally {
        if (needsOverride) {
            if (prevOverride === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
            else process.env.PIPELINE_DIR_OVERRIDE = prevOverride;
            waves.invalidateCache();
        }
    }

    return (doc && typeof doc === 'object') ? doc : null;
}

/**
 * Resuelve la ola a la que pertenece un issue escaneando active+planned+archived.
 *
 * @param {number|string|object} issueNumber - acepta `3501`, `"#3501"`, `{number}`.
 * @param {object} opts
 * @param {string} opts.pipelineRoot - Path absoluto al directorio `.pipeline`.
 * @returns {{number: number|null, name: string, issues: number[]}|null}
 *          La ola con sus issues normalizados a int, o `null` si no pertenece a
 *          ninguna (o si falta `pipelineRoot` / `waves.json` no es legible).
 */
function resolveWaveForIssue(issueNumber, opts) {
    const target = normalizeIssueNumber(issueNumber);
    if (target === null) return null;

    const pipelineRoot = opts && opts.pipelineRoot;
    if (!pipelineRoot) return null;

    const doc = readWavesDoc(pipelineRoot);
    if (!doc) return null;

    const allWaves = [
        doc.active_wave,
        ...(Array.isArray(doc.planned_waves) ? doc.planned_waves : []),
        ...(Array.isArray(doc.archived_waves) ? doc.archived_waves : []),
    ].filter(Boolean);

    for (const w of allWaves) {
        const nums = (Array.isArray(w.issues) ? w.issues : [])
            .map(normalizeIssueNumber)
            .filter((n) => n !== null);
        if (nums.includes(target)) {
            const nameTrim = typeof w.name === 'string' ? w.name.trim() : '';
            return {
                number: Number.isInteger(w.number) ? w.number : null,
                name: nameTrim,
                issues: [...new Set(nums)].sort((a, b) => a - b),
            };
        }
    }
    return null;
}

module.exports = {
    resolveActiveWave,
    resolveWaveForIssue,
    resolveBlockDependencies,
    // Exports internos para tests
    _internal: {
        readFromWavesJson,
        readPartialPauseFile,
        collectActiveIssuesFromFs,
        normalizeIssueNumber,
        effectiveWavesPipelineDir,
        readWavesDoc,
    },
};
