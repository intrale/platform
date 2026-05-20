// =============================================================================
// rewind-e2e-smoke.test.js — Smoke test E2E del rewind (#3416).
// =============================================================================
//
// Simula el flujo completo:
//   1. Crear .pipeline/eventos/pipeline-rejection/pendiente/<ts>-<issue>.json
//      con un evento bien formado.
//   2. Llamar a `rewindIssueToPhase` directamente con el sandbox.
//   3. Verificar:
//      - Archivo movido a pendiente/ destino con YAML correcto.
//      - .reason.json adjunto con campos esperados.
//      - rewinds.jsonl tiene entry con chain válido.
//      - commentBody con marker y fenced.
//
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const yaml = require('js-yaml');

const rewind = require('../pipeline-rewind');
const auditLog = require('../audit-log');

const CONFIG = Object.freeze({
    pipelines: {
        definicion: {
            fases: ['analisis', 'criterios', 'sizing'],
            skills_por_fase: {
                analisis: ['guru', 'security'],
                criterios: ['po', 'ux'],
                sizing: ['planner'],
            },
        },
        desarrollo: {
            fases: ['validacion', 'dev', 'build', 'verificacion', 'aprobacion', 'entrega'],
            skills_por_fase: {
                validacion: ['po', 'ux', 'guru'],
                dev: ['pipeline-dev'],
                build: ['build'],
                verificacion: ['tester'],
                aprobacion: ['review', 'po', 'ux'],
                entrega: ['delivery'],
            },
        },
    },
});

test('E2E smoke: evento del Commander → rewind ejecutado → archivos y audit consistentes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-e2e-'));
    // Sandbox.
    for (const [p, c] of Object.entries(CONFIG.pipelines)) {
        for (const f of c.fases) {
            for (const e of ['pendiente', 'trabajando', 'listo', 'procesado']) {
                fs.mkdirSync(path.join(root, p, f, e), { recursive: true });
            }
        }
    }
    fs.mkdirSync(path.join(root, 'eventos', 'pipeline-rejection', 'pendiente'), { recursive: true });
    fs.mkdirSync(path.join(root, 'eventos', 'pipeline-rejection', 'listo'), { recursive: true });

    // Issue en desarrollo/aprobacion.
    const srcFile = path.join(root, 'desarrollo', 'aprobacion', 'pendiente', '3416.ux');
    fs.writeFileSync(srcFile, yaml.dump({ issue: 3416, pipeline: 'desarrollo', fase: 'aprobacion' }));

    // Evento del Commander.
    const event = {
        issue: 3416,
        alias: 'validacion-ux',
        motivo: 'El mockup del paso 2 no respeta el spacing del design system.',
        operatorId: 'leitolarreta',
        source: 'telegram-commander',
        timestamp: new Date().toISOString(),
    };
    const eventPath = path.join(root, 'eventos', 'pipeline-rejection', 'pendiente', `${Date.now()}-3416.json`);
    fs.writeFileSync(eventPath, JSON.stringify(event));

    // Ejecutar rewind.
    const result = await rewind.rewindIssueToPhase({
        ...event,
        config: CONFIG,
        pipelineRoot: root,
        yaml,
    });

    assert.equal(result.ok, true, JSON.stringify(result));

    // Verificaciones empíricas.
    const targetFile = path.join(root, 'desarrollo', 'validacion', 'pendiente', '3416.ux');
    assert.ok(fs.existsSync(targetFile), 'archivo destino debe existir');
    const targetData = yaml.load(fs.readFileSync(targetFile, 'utf8'));
    assert.equal(targetData.issue, 3416);
    assert.equal(targetData.rebote, true);
    assert.equal(targetData.rechazado_por, 'leitolarreta');
    assert.equal(targetData.rechazado_por_skill, 'operator');
    assert.equal(targetData.rechazado_en_fase, 'desarrollo/aprobacion');
    assert.match(targetData.motivo_rechazo, /spacing del design system/);

    // .reason.json adjunto.
    const reasonFile = targetFile + '.reason.json';
    assert.ok(fs.existsSync(reasonFile));
    const reason = JSON.parse(fs.readFileSync(reasonFile, 'utf8'));
    assert.equal(reason.operatorId, 'leitolarreta');
    assert.equal(reason.source, 'operator-rejection');

    // Archivo origen movido.
    assert.equal(fs.existsSync(srcFile), false);

    // Audit log con chain integrity.
    const auditFile = rewind.rewindAuditFile(root);
    assert.ok(fs.existsSync(auditFile));
    const v = auditLog.verifyChain(auditFile);
    assert.equal(v.ok, true);
    assert.equal(v.entriesChecked, 1);

    // Comentario GitHub bien formado.
    assert.match(result.commentBody, /<!-- rejection-event -->/);
    assert.match(result.commentBody, /Skill destino.*ux/);
    assert.match(result.commentBody, /Operador.*leitolarreta/);
    assert.match(result.commentBody, /```\nEl mockup del paso 2/);
});
