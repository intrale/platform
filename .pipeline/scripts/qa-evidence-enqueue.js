#!/usr/bin/env node
// =============================================================================
// qa-evidence-enqueue.js (CLI) — #6145
// =============================================================================
//
// Encola el descriptor de evidencia QA estructural en la cola canónica del
// servicio Drive. Es el ÚNICO camino que debe usar el rol `qa`: escribir el
// JSON a mano con un path relativo lo deja varado en el worktree del agente,
// donde `servicio-drive.js` nunca lo mira (ver cabecera de
// `.pipeline/lib/qa-evidence-enqueue.js`).
//
//   $ node .pipeline/scripts/qa-evidence-enqueue.js \
//       --issue 6145 --verdict aprobado --passed 7 --total 7 \
//       --head "$(git rev-parse HEAD)"
//
// Flags:
//   --issue N            (obligatorio) número de issue
//   --verdict V          (obligatorio) aprobado | rechazado
//   --mode M             structural (default) | android | api
//   --passed N           criterios cumplidos
//   --total N            criterios totales
//   --head SHA           commit sobre el que se corrió el QA
//   --file PATH          override del artefacto de evidencia
//                        (default structural: qa/evidence/<issue>/qa-<issue>-structural.md)
//                        (default android/api: qa/evidence/<issue>/qa-<issue>.mp4)
//   --title TXT          título del issue
//   --description TXT    descripción para la metadata de Drive
//   --motivo TXT         motivo, obligatorio en la práctica si verdict=rechazado
//   --criterios-fallidos CA-1,CA-7
//   --narrator N         edge | openai (sólo modo android)
//   --rejection-pdf P    path relativo al PDF de rejection-report
//   --rescue             además, rescata descriptores varados en worktrees
//
// Sale 0 si encoló, 1 si no. Imprime el resultado como JSON en stdout para que
// el agente pueda pegarlo textualmente como evidencia.
//
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const lib = require('../lib/qa-evidence-enqueue');

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { out._.push(a); continue; }
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            out[key] = true;
        } else {
            out[key] = next;
            i++;
        }
    }
    return out;
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    const fields = {
        issue: args.issue,
        verdict: args.verdict,
        mode: typeof args.mode === 'string' ? args.mode : undefined,
        passed: args.passed,
        total: args.total,
        head: args.head,
        file: typeof args.file === 'string' ? args.file : undefined,
        title: typeof args.title === 'string' ? args.title : undefined,
        motivo: typeof args.motivo === 'string' ? args.motivo : undefined,
        description: typeof args.description === 'string' ? args.description : undefined,
        narrator: typeof args.narrator === 'string' ? args.narrator : undefined,
        rejectionPdf: typeof args['rejection-pdf'] === 'string' ? args['rejection-pdf'] : undefined,
        criteriosFallidos: typeof args['criterios-fallidos'] === 'string'
            ? args['criterios-fallidos'].split(',').map((s) => s.trim()).filter(Boolean)
            : undefined,
    };

    const result = lib.enqueueStructuralEvidence(fields, { env: process.env });

    const salida = {
        ok: result.ok,
        descriptor: result.name,
        queueDir: result.queueDir,
        errors: result.errors,
    };

    // Aviso NO bloqueante: el markdown de evidencia se resuelve contra el repo
    // canónico (que es donde lo va a buscar el servicio). Si el QA lo escribió
    // sólo en su worktree, el descriptor llega pero el archivo no.
    if (result.ok && result.descriptor) {
        try {
            const repoRoot = lib.resolveRepoRoot(process.env, {});
            const evidencia = path.resolve(repoRoot, result.descriptor.file);
            salida.evidenciaEnRepoCanonico = fs.existsSync(evidencia);
            salida.evidenciaPath = evidencia;
            if (!salida.evidenciaEnRepoCanonico) {
                salida.aviso = 'el artefacto de evidencia NO existe en el repo canónico; '
                    + 'copialo antes de que se pode el worktree';
            }
        } catch (_) { /* best-effort */ }
    }

    if (args.rescue) {
        salida.rescate = lib.rescueStrandedDescriptors({ env: process.env });
    }

    process.stdout.write(JSON.stringify(salida, null, 2) + '\n');
    process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { parseArgs };
