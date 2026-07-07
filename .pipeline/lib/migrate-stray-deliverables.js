'use strict';

// =============================================================================
// migrate-stray-deliverables.js — Migración one-shot de índices stray (#4504)
//
// El bug histórico de `pipelineRoot` (write-deliverable.js reenviaba el repo root
// al índice, que lo interpreta como dir `.pipeline`) dejó índices de entregables
// en `<repo>/deliverables/<issue>.json` en vez del canónico
// `<repo>/.pipeline/deliverables/<issue>.json`. Este helper los reubica.
//
// Reglas:
//   - Merge por clave `agente::fase` (misma clave de upsert): las entries
//     PREEXISTENTES del canónico NUNCA se pierden (canonical gana en conflicto);
//     del stray sólo se agregan las claves que faltan. Así `4502.json` (existe en
//     ambos lados con fases distintas) queda con la unión de ambas.
//   - Idempotente: si no existe el dir stray, no hace nada. Corre N veces = 1.
//   - Atomic write (temp + rename) del índice canónico.
//   - Borra el dir stray completo al final.
//
// Doctrina: docs/pipeline/entregables-multimedia-por-agente.md
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Clave de upsert del índice (misma que deliverable-index.js). */
function entryKey(e) {
    return `${e.agente}::${e.fase}`;
}

/** Lee un índice JSON; devuelve null si no existe o está corrupto. */
function safeReadIndex(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
            return parsed;
        }
    } catch {
        /* corrupto → tratamos como ausente */
    }
    return null;
}

/** Escribe el índice de forma atómica (temp + rename). */
function atomicWriteIndex(file, data) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(
        dir,
        `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
    );
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

/**
 * Migra los índices stray de `<repoRoot>/deliverables/` al canónico
 * `<repoRoot>/.pipeline/deliverables/`, mergeando por clave `agente::fase` sin
 * perder entries preexistentes del canónico. Borra el dir stray al final.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] - root del repo (default process.cwd()).
 * @returns {{moved:string[], merged:string[], skipped:string[], removedStrayDir:boolean}}
 */
function migrateStrayDeliverables(opts = {}) {
    const repoRoot =
        typeof opts.repoRoot === 'string' && opts.repoRoot.length > 0
            ? opts.repoRoot
            : process.cwd();
    const strayDir = path.join(repoRoot, 'deliverables');
    const canonicalDir = path.join(repoRoot, '.pipeline', 'deliverables');
    const report = { moved: [], merged: [], skipped: [], removedStrayDir: false };

    let strayFiles;
    try {
        strayFiles = fs.readdirSync(strayDir).filter((f) => /^\d+\.json$/.test(f));
    } catch {
        // No hay dir stray → nada que migrar (idempotente).
        return report;
    }

    for (const fname of strayFiles) {
        const strayPath = path.join(strayDir, fname);
        const stray = safeReadIndex(strayPath);
        if (!stray) {
            report.skipped.push(fname);
            continue;
        }
        const canonicalPath = path.join(canonicalDir, fname);
        const canonical = safeReadIndex(canonicalPath);

        if (!canonical) {
            // No hay canónico → mover directo (el stray pasa a ser canónico).
            atomicWriteIndex(canonicalPath, stray);
            report.moved.push(fname);
            continue;
        }

        // Merge por clave: canónico primero (preexistente nunca se pierde), luego
        // se agregan sólo las claves del stray que faltan.
        const byKey = new Map();
        for (const e of canonical.entries) byKey.set(entryKey(e), e);
        for (const e of stray.entries) {
            const k = entryKey(e);
            if (!byKey.has(k)) byKey.set(k, e);
        }
        atomicWriteIndex(canonicalPath, {
            issue: canonical.issue,
            entries: Array.from(byKey.values()),
        });
        report.merged.push(fname);
    }

    // Borrar el dir stray completo. En la próxima corrida readdirSync tira → no-op.
    fs.rmSync(strayDir, { recursive: true, force: true });
    report.removedStrayDir = true;
    return report;
}

module.exports = { migrateStrayDeliverables, entryKey, safeReadIndex };

// CLI one-shot: `node .pipeline/lib/migrate-stray-deliverables.js`
if (require.main === module) {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const report = migrateStrayDeliverables({ repoRoot });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
}
