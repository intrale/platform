// =============================================================================
// secrets-census.js — censo ejecutable de LECTORES DIRECTOS no instrumentados
// (#5245, D-6 / R22).
//
// Por que existe
// --------------
// `in_repo_reads` (el numerador que cuenta `secrets-guard.js`) solo puede contar
// las lecturas que pasan por `assertSecretOrigin`. Esta historia instrumenta 2
// call sites. Si la condicion de corte fuera `in_repo_reads === 0` a secas, el
// contador podria marcar cero con decenas de lectores directos intactos, y ese
// cero es lo unico que autorizaria a encender `PIPELINE_SECRETS_GUARD_STRICT`.
// Un control que reporta verde sobre un estado roto suprime la atencion.
//
// Este modulo calcula el DENOMINADOR: cuantos archivos de codigo trackeados
// leen `telegram-config.json` con `readFileSync` SIN pasar por el chokepoint
// (`telegram-secrets.js`) ni por `telegram-client.js`.
//
// Se calcula EN EL MOMENTO, nunca hardcodeado: entre el analisis de `security`
// (46) y la revalidacion de `guru` 14 dias despues (50) se sumaron 4 lectores
// nuevos. Un numero hardcodeado los habria vuelto invisibles.
//
// Equivalente ejecutable del comando validado en el issue:
//
//   git ls-files | grep -E '\.(js|cjs|mjs)$' | xargs grep -lE 'telegram-config\.json' \
//     | xargs grep -lE 'readFileSync' \
//     | xargs grep -Ln "require(.*telegram-client\|telegram-secrets" | wc -l
//
// Uso CLI:
//   node .pipeline/lib/secrets-census.js            # imprime el numero
//   node .pipeline/lib/secrets-census.js --write    # ademas lo persiste en
//                                                   # .pipeline/secrets-health.json
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { gitSpawn } = require('./worktree-resolver');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const CODE_FILE_RE = /\.(js|cjs|mjs)$/i;
const MENTIONS_CONFIG_RE = /telegram-config\.json/;
const READS_FILE_RE = /readFileSync/;
/** Ya pasa por el chokepoint o por el cliente que lo usa: esta instrumentado. */
const INSTRUMENTED_RE = /require\([^)]*telegram-(client|secrets)/;

/**
 * Archivos de codigo trackeados por git. Se usa `git ls-files` (no un walk del
 * filesystem) para no contar `node_modules/`, worktrees anidados ni artefactos.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {function} [opts.spawnImpl] inyectable para tests
 * @returns {string[]} paths relativos
 */
function listTrackedCodeFiles({ cwd = REPO_ROOT, spawnImpl } = {}) {
    const out = gitSpawn(['ls-files'], { cwd, spawnImpl });
    return String(out || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && CODE_FILE_RE.test(line));
}

/**
 * Cuenta los lectores directos NO instrumentados.
 *
 * Nunca devuelve paths: el resultado viaja a `.pipeline/secrets-health.json`,
 * y aunque ese archivo es gitignored, el criterio de #5245 es que la metrica
 * sea numerica y nada mas (el repo es publico).
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {function} [opts.spawnImpl] inyectable para tests
 * @param {object}   [opts.fsImpl]    inyectable para tests
 * @returns {number}
 */
function countUninstrumentedReaders({ cwd = REPO_ROOT, spawnImpl, fsImpl = fs } = {}) {
    let files;
    try {
        files = listTrackedCodeFiles({ cwd, spawnImpl });
    } catch {
        // Sin `git ls-files` no hay denominador. Se devuelve -1 ("no medido"),
        // que es un numero distinto de cero y por lo tanto NO habilita el corte.
        return -1;
    }

    let count = 0;
    for (const rel of files) {
        let source;
        try {
            source = fsImpl.readFileSync(path.join(cwd, rel), 'utf8');
        } catch {
            continue; // archivo trackeado pero ausente en el working tree
        }
        if (!MENTIONS_CONFIG_RE.test(source)) continue;
        if (!READS_FILE_RE.test(source)) continue;
        if (INSTRUMENTED_RE.test(source)) continue;
        count += 1;
    }
    return count;
}

module.exports = {
    countUninstrumentedReaders,
    listTrackedCodeFiles,
    REPO_ROOT,
};

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

if (require.main === module) {
    const total = countUninstrumentedReaders();
    if (process.argv.includes('--write')) {
        // Require diferido: el CLI es la unica rama que necesita el guard.
        const guard = require('./secrets-guard');
        const res = guard.flushCounters({ uninstrumentedReaders: total, counters: guard.getCounters() });
        process.stdout.write(`${total}\n`);
        process.stdout.write(res.ok
            ? `persistido en ${res.path} (migration.uninstrumented_readers=${total})\n`
            : `no se pudo persistir: ${res.error}\n`);
    } else {
        process.stdout.write(`${total}\n`);
    }
}
