'use strict';

/**
 * self-check.js — Helper compartido para validar que un skill determinístico
 * carga y sus piezas críticas funcionan, sin tocar GitHub, gradle ni el filesystem
 * de issues.
 *
 * Uso típico (al final del entry point del skill, antes del main()):
 *
 *   if (process.argv.includes('--self-check')) {
 *       const { runSelfCheck } = require('./lib/self-check');
 *       runSelfCheck('tester', [
 *           { name: 'parseArgs vacío', fn: () => parseArgs(['node', 'tester.js']) },
 *           { name: 'kover-parser carga', fn: () => require('./lib/kover-parser') },
 *           // ...
 *       ]);
 *       return;
 *   }
 *
 * Cada check es un objeto { name, fn }. fn puede ser sync o async; cualquier
 * excepción cuenta como falla. Exit 0 si todos pasan, 1 si alguno falla.
 *
 * Diseñado para ser invocado por smoke-test.js post-restart: si un PR a
 * `.pipeline/` rompe la carga de un skill, el self-check falla, smoke-test
 * falla, restart.js dispara rollback.js al tag pipeline-stable.
 */

async function runSelfCheck(skillName, checks) {
    const startedAt = Date.now();
    let passed = 0;
    const failed = [];

    process.stdout.write(`[self-check ${skillName}] iniciando ${checks.length} chequeos\n`);

    for (const check of checks) {
        const checkStart = Date.now();
        try {
            const result = check.fn();
            if (result && typeof result.then === 'function') {
                await result;
            }
            const ms = Date.now() - checkStart;
            process.stdout.write(`  OK  ${check.name} (${ms}ms)\n`);
            passed++;
        } catch (e) {
            const ms = Date.now() - checkStart;
            const msg = (e && (e.stack || e.message)) || String(e);
            process.stdout.write(`  FAIL ${check.name} (${ms}ms)\n    ${msg.split('\n').slice(0, 3).join('\n    ')}\n`);
            failed.push({ name: check.name, error: msg });
        }
    }

    const totalMs = Date.now() - startedAt;
    if (failed.length === 0) {
        process.stdout.write(`[self-check ${skillName}] OK · ${passed}/${checks.length} en ${totalMs}ms\n`);
        process.exit(0);
    } else {
        process.stdout.write(`[self-check ${skillName}] FAIL · ${failed.length}/${checks.length} fallidos en ${totalMs}ms\n`);
        process.exit(1);
    }
}

module.exports = { runSelfCheck };
