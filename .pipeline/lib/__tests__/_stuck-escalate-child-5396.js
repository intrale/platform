// =============================================================================
// _stuck-escalate-child-5396.js — worker del test de #5396.
//
// `human-block.js` resolvía su dir desde `traceability.REPO_ROOT` al cargar; desde
// #7456 resuelve por llamada vía `PIPELINE_DIR_OVERRIDE` (write-target). Para
// ejercitar el escalado real contra un FS de mentira (y NO contra el `.pipeline`
// de producción) hay que hacerlo en un proceso aparte con esa env var apuntando
// al tmpdir. De ahí este worker.
//
// Uso: node _stuck-escalate-child-5396.js <tmpRoot>   → imprime JSON por stdout.
// El prefijo `_` lo excluye del descubrimiento de `node --test`.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const tmpRoot = process.argv[2];
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };

try {
    const trace = require('../traceability');

    // GUARDA DURA (riesgo #3): si `REPO_ROOT` no resolvió al tmpdir, ABORTAR sin
    // escribir nada. Un fallo acá con el root de producción plantaría un marker
    // real en `.pipeline/` — el test debe fallar ruidoso, nunca ensuciar.
    if (path.resolve(trace.REPO_ROOT) !== path.resolve(tmpRoot)) {
        out({ ok: false, error: `REPO_ROOT divergente: ${trace.REPO_ROOT} != ${tmpRoot}` });
    }

    const humanBlock = require('../human-block');
    // #7456: human-block resuelve por llamada vía write-target (PIPELINE_DIR_OVERRIDE).
    // Misma guarda dura sobre la raíz que el módulo va a usar DE VERDAD para escribir.
    const rootHb = path.resolve(humanBlock.markersRoot());
    if (rootHb !== path.resolve(tmpRoot, '.pipeline')) {
        out({ ok: false, error: `REPO_ROOT divergente (markersRoot): ${rootHb} != ${path.join(tmpRoot, '.pipeline')}` });
    }
    const { buildStuckReconcilerDeps } = require('../stuck-reconciler-deps');

    const PIPELINE = path.join(tmpRoot, '.pipeline');
    const config = {
        pipelines: {
            desarrollo: {
                fases: ['dev', 'verificacion'],
                skills_por_fase: { verificacion: ['qa', 'tester'] },
            },
        },
    };

    const deps = buildStuckReconcilerDeps({
        config, PIPELINE, ROOT: tmpRoot,
        pauseFile: path.join(PIPELINE, '.paused'),
        ppMode: { mode: 'partial_pause', allowedIssues: [5209] },
        nowMs: Date.now(),
        deps: { log: () => { } },
    });

    // Escalado real: planta el marker + encola el label vía `reportHumanBlock`.
    deps.escalate(5209, 'ambigüedad (rechazo/cancelado/corrupto)', {
        pipeline: 'desarrollo', fase: 'verificacion',
    });

    const listoDir = path.join(PIPELINE, 'desarrollo', 'verificacion', 'listo');
    const blockedDir = path.join(PIPELINE, 'desarrollo', 'verificacion', 'bloqueado-humano');
    const colaDir = path.join(PIPELINE, 'servicios', 'github', 'pendiente');
    const rd = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

    out({
        ok: true,
        // #5396 rev-1 — El test deriva de acá el skill que `escalate` DEBE elegir
        // para el marker, en vez de hardcodearlo. Es la misma lista que valida el
        // invariante skill∈fase de `pulpo.js`.
        skillsPorFase: config.pipelines.desarrollo.skills_por_fase.verificacion,
        listo: rd(listoDir),
        listoContenido: (() => {
            try { return fs.readFileSync(path.join(listoDir, '5209.qa'), 'utf8'); } catch { return null; }
        })(),
        bloqueados: rd(blockedDir),
        cola: rd(colaDir),
        // `listBlockedIssues()` es lo que `servicio-reconciler` usa para armar
        // `blockedByIssue` y saltear el issue en `reconcileLabelToFilesystem`.
        listBlocked: humanBlock.listBlockedIssues().map((b) => ({
            issue: b.issue, skill: b.skill, phase: b.phase, pipeline: b.pipeline,
        })),
        // Segunda pasada: el escalado debe ser idempotente (no duplica marker).
        segundaPasada: (() => {
            deps.escalate(5209, 'ambigüedad (rechazo/cancelado/corrupto)', {
                pipeline: 'desarrollo', fase: 'verificacion',
            });
            return { bloqueados: rd(blockedDir), listo: rd(listoDir) };
        })(),
        // El dedupe ahora ve el marker → el tick siguiente se calla.
        hasNeedsHumanTrasEscalar: deps.hasNeedsHuman(5209),
    });
} catch (e) {
    out({ ok: false, error: String((e && e.stack) || e) });
}
