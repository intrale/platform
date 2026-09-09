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

/** Exit codes del CLI (#5215). 0 = medido; !=0 = el numero impreso NO es una medicion. */
const EXIT_NO_MEDIDO = 2;
const EXIT_NO_PERSISTIDO = 3;

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
 * Cuenta los lectores directos NO instrumentados y reporta si pudo medir.
 *
 * Nunca devuelve paths: el resultado viaja a `.pipeline/secrets-health.json`,
 * y aunque ese archivo es gitignored, el criterio de #5245 es que la metrica
 * sea numerica y nada mas (el repo es publico). Por la misma razon `error`
 * lleva la causa tecnica del fallo de `git`, jamas contenido de un archivo.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {function} [opts.spawnImpl] inyectable para tests
 * @param {object}   [opts.fsImpl]    inyectable para tests
 * @param {function} [opts.onError]   destino del diagnostico (default: stderr)
 * @returns {{count: number, measured: boolean, error: (string|null)}}
 *          `measured:false` ⇒ `count:-1` ("no medido"), que NO es cero.
 */
function measureUninstrumentedReaders({ cwd = REPO_ROOT, spawnImpl, fsImpl = fs, onError } = {}) {
    const report = typeof onError === 'function'
        ? onError
        : (msg) => { try { process.stderr.write(msg); } catch { /* stderr cerrado */ } };

    let files;
    try {
        files = listTrackedCodeFiles({ cwd, spawnImpl });
    } catch (err) {
        // Sin `git ls-files` no hay denominador. Se devuelve -1 ("no medido"),
        // que es un numero distinto de cero y por lo tanto NO habilita el corte.
        //
        // #5215: este `catch` degradaba EN SILENCIO. La falla real fue ENOBUFS
        // por el `maxBuffer` de 1 MB que `spawnSync` usa por default, invisible
        // durante semanas porque el CLI imprimia "-1" y salia con codigo 0.
        // Un censo no medido tiene que decir POR QUE no midio.
        const causa = (err && err.message) ? err.message : String(err);
        report('[secrets-census] censo NO MEDIDO (git ls-files fallo): ' + causa + '\n');
        return { count: -1, measured: false, error: causa };
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
    return { count, measured: true, error: null };
}

/**
 * Fachada historica: devuelve solo el numero. `-1` sigue significando
 * "no medido" (ver `measureUninstrumentedReaders`).
 *
 * @param {object} [opts] mismas opciones que `measureUninstrumentedReaders`
 * @returns {number}
 */
function countUninstrumentedReaders(opts = {}) {
    return measureUninstrumentedReaders(opts).count;
}

module.exports = {
    countUninstrumentedReaders,
    measureUninstrumentedReaders,
    listTrackedCodeFiles,
    REPO_ROOT,
};

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

if (require.main === module) {
    const medicion = measureUninstrumentedReaders();
    process.stdout.write(medicion.count + '\n');

    if (!medicion.measured) {
        // #5215: un censo no medido NO puede parecerse a un censo en cero. El CLI
        // sale distinto de cero para que ningun script de rollout tome el "-1"
        // por bueno y encienda `PIPELINE_SECRETS_GUARD_STRICT` sobre una base sin
        // medir. Tampoco se persiste: un `-1` en el JSON de salud es una
        // no-medicion disfrazada de metrica.
        process.stderr.write('[secrets-census] no se persiste el resultado: la medicion fallo\n');
        process.exitCode = EXIT_NO_MEDIDO;
    } else if (process.argv.includes('--write')) {
        // Require diferido: el CLI es la unica rama que necesita el guard.
        const guard = require('./secrets-guard');
        const res = guard.flushCounters({
            uninstrumentedReaders: medicion.count,
            counters: guard.getCounters(),
        });
        process.stdout.write(res.ok
            ? 'persistido en ' + res.path + ' (migration.uninstrumented_readers=' + medicion.count + ')\n'
            : 'no se pudo persistir: ' + res.error + '\n');
        if (!res.ok) process.exitCode = EXIT_NO_PERSISTIDO;
    }
}
