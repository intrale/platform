// =============================================================================
// rewind-e2e-smoke.test.js — Smoke test E2E del rewind (#3416).
// =============================================================================
//
// Cubre dos flujos:
//
// 1. (legacy / unidad pura) Evento ya normalizado → `rewindIssueToPhase` →
//    archivos + audit consistentes. Valida la API interna del módulo.
//
// 2. (integración con #3441) Evento con shape REAL del producer
//    `lib/commander/rechazar-handler.js` → adapter `rewind-event-adapter` →
//    `rewindIssueToPhase`. Reproduce el escenario empírico que la review del
//    PR detectó como roto: si el adapter no traduce, el rewind explota con
//    ALIAS_EMPTY / OPERATOR_ID_REQUIRED / SOURCE_NOT_AUTHORIZED.
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
const { normalizeProducerEvent } = require('../rewind-event-adapter');

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

// -----------------------------------------------------------------------------
// E2E con shape REAL del producer #3441.
//
// Reproduce el escenario que la review del PR detectó como roto: el producer
// `rechazar-handler.js` (mergeado en main, líneas 540-583) escribe payload
// `{issue, fase, fase_resolved, motivo, ts, source: transcribeSource, chat_id, audit_ref}`
// en `.pipeline/rejections/<issue>-<unix-ts>.json`. Sin el adapter este shape
// rompe en tres lugares del consumer (ALIAS_EMPTY, OPERATOR_ID_REQUIRED,
// SOURCE_NOT_AUTHORIZED). El test verifica que con el adapter el flujo cierra.
// -----------------------------------------------------------------------------

test('E2E con shape REAL del producer #3441 (rechazar-handler.js) → adapter → rewind exitoso', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-producer-e2e-'));
    for (const [p, c] of Object.entries(CONFIG.pipelines)) {
        for (const f of c.fases) {
            for (const e of ['pendiente', 'trabajando', 'listo', 'procesado']) {
                fs.mkdirSync(path.join(root, p, f, e), { recursive: true });
            }
        }
    }
    // El producer escribe acá. NO usa subcarpeta pendiente/.
    fs.mkdirSync(path.join(root, 'rejections'), { recursive: true });

    // Issue en desarrollo/aprobacion (mismo escenario que el smoke legacy).
    const srcFile = path.join(root, 'desarrollo', 'aprobacion', 'pendiente', '3416.ux');
    fs.writeFileSync(srcFile, yaml.dump({ issue: 3416, pipeline: 'desarrollo', fase: 'aprobacion' }));

    // Shape REAL del producer (texto). Idéntico al objeto construido en
    // rechazar-handler.js #540-549 cuando llega un mensaje de texto.
    const producerEventText = {
        issue: 3416,
        fase: 'validacion-ux',
        fase_resolved: 'desarrollo/validacion',
        motivo: 'El mockup no respeta la paleta acordada en #3416. Reformulalo con los colores correctos.',
        ts: new Date().toISOString(),
        source: 'text',
        chat_id: 1234567890,
        audit_ref: 'rejections-2026-05-20.jsonl',
    };
    const unixTs = Math.floor(Date.now() / 1000);
    const eventPath = path.join(root, 'rejections', `3416-${unixTs}.json`);
    fs.writeFileSync(eventPath, JSON.stringify(producerEventText, null, 2));

    // Simulamos el brazoRewind: leer + normalizar + invocar rewindIssueToPhase.
    const rawEvent = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    const normalized = normalizeProducerEvent(rawEvent);

    // Verificación crítica: el adapter resuelve los tres mismatches.
    assert.equal(normalized.alias, 'validacion-ux', 'fase → alias');
    assert.equal(normalized.operatorId, '1234567890', 'chat_id → operatorId');
    assert.equal(normalized.source, 'telegram-commander', 'source: text → telegram-commander');

    const result = await rewind.rewindIssueToPhase({
        issue: normalized.issue,
        alias: normalized.alias,
        motivo: normalized.motivo,
        operatorId: normalized.operatorId,
        source: normalized.source,
        config: CONFIG,
        pipelineRoot: root,
        yaml,
    });

    // SIN el adapter, esto habría devuelto:
    //   - {ok:false, code:'SOURCE_NOT_AUTHORIZED'} (source='text')
    //   - o {ok:false, code:'OPERATOR_ID_REQUIRED'} (operatorId=undefined)
    //   - o {ok:false, code:'ALIAS_EMPTY'/...} (alias=undefined)
    //
    // CON el adapter el rewind cierra ok.
    assert.equal(result.ok, true, `rewind con shape del producer debe cerrar OK. result=${JSON.stringify(result)}`);

    // Mismos invariantes que el smoke legacy.
    const targetFile = path.join(root, 'desarrollo', 'validacion', 'pendiente', '3416.ux');
    assert.ok(fs.existsSync(targetFile), 'archivo destino debe existir');
    const targetData = yaml.load(fs.readFileSync(targetFile, 'utf8'));
    assert.equal(targetData.issue, 3416);
    assert.equal(targetData.rebote, true);
    assert.equal(targetData.rechazado_por, '1234567890', 'operatorId stringificado desde chat_id');
    assert.equal(targetData.rechazado_por_skill, 'operator');
    assert.equal(targetData.rechazado_en_fase, 'desarrollo/aprobacion');
    assert.match(targetData.motivo_rechazo, /paleta acordada/);

    // Audit chain válido.
    const auditFile = rewind.rewindAuditFile(root);
    assert.ok(fs.existsSync(auditFile));
    const v = auditLog.verifyChain(auditFile);
    assert.equal(v.ok, true);
});

test('shape del producer (audio) también termina OK tras adapter', async () => {
    // Mismo escenario pero con `source: 'audio'` (whisper-local del operador).
    // Verifica que el adapter trate texto y audio de manera idéntica para el
    // consumer.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-producer-audio-'));
    for (const [p, c] of Object.entries(CONFIG.pipelines)) {
        for (const f of c.fases) {
            for (const e of ['pendiente', 'trabajando', 'listo', 'procesado']) {
                fs.mkdirSync(path.join(root, p, f, e), { recursive: true });
            }
        }
    }
    fs.mkdirSync(path.join(root, 'rejections'), { recursive: true });

    const srcFile = path.join(root, 'desarrollo', 'aprobacion', 'pendiente', '3416.po');
    fs.writeFileSync(srcFile, yaml.dump({ issue: 3416, pipeline: 'desarrollo', fase: 'aprobacion' }));

    const producerEventAudio = {
        issue: 3416,
        fase: 'aprobacion-po',
        fase_resolved: 'desarrollo/aprobacion',
        motivo: 'Falta cubrir el flujo de error de pago.',
        ts: new Date().toISOString(),
        source: 'audio', // ← el producer marca 'audio' cuando llegó voice_path
        chat_id: 9876543210,
        audit_ref: 'rejections-2026-05-20.jsonl',
    };
    const eventPath = path.join(root, 'rejections', `3416-${Math.floor(Date.now() / 1000)}.json`);
    fs.writeFileSync(eventPath, JSON.stringify(producerEventAudio));

    const normalized = normalizeProducerEvent(producerEventAudio);
    assert.equal(normalized.source, 'telegram-commander', 'audio también normaliza a telegram-commander');

    const result = await rewind.rewindIssueToPhase({
        issue: normalized.issue,
        alias: normalized.alias,
        motivo: normalized.motivo,
        operatorId: normalized.operatorId,
        source: normalized.source,
        config: CONFIG,
        pipelineRoot: root,
        yaml,
    });

    assert.equal(result.ok, true, `rewind con audio del producer debe cerrar OK. result=${JSON.stringify(result)}`);
});

test('sin adapter, el shape del producer rompe con SOURCE_NOT_AUTHORIZED (regression guard)', async () => {
    // Guard explícito: si alguien removiera el adapter en el futuro, este test
    // documenta la razón histórica del módulo.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-no-adapter-'));
    for (const [p, c] of Object.entries(CONFIG.pipelines)) {
        for (const f of c.fases) {
            for (const e of ['pendiente', 'trabajando', 'listo', 'procesado']) {
                fs.mkdirSync(path.join(root, p, f, e), { recursive: true });
            }
        }
    }

    // Sin pasar por el adapter — usamos directamente los campos del producer.
    const result = await rewind.rewindIssueToPhase({
        issue: 3416,
        alias: undefined,                  // ← falta porque el producer manda `fase`
        motivo: 'test',
        operatorId: undefined,             // ← falta porque el producer manda `chat_id`
        source: 'text',                    // ← no está en la whitelist del consumer
        config: CONFIG,
        pipelineRoot: root,
        yaml,
    });

    assert.equal(result.ok, false, 'sin adapter el rewind tiene que romper');
    assert.equal(result.code, 'SOURCE_NOT_AUTHORIZED');
});
