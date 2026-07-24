'use strict';

// Tests de integración del entregable QA en el store (#4512).
// Verifican CA-1/CA-3/CA-6: al materializar el reporte QA vía writeDeliverable
// (como hace el Pulpo al cerrar `qa/verificacion`), el .md queda:
//   - escrito bajo `.pipeline/assets/docs/<issue>/qa-verificacion-<issue>.md`
//   - indexado como `qa::verificacion` en `.pipeline/deliverables/<issue>.json`
//   - levantado por `collectAttachmentsForSkill('qa', ...)` como `document`
// También cubre la excepción "no aplica" (CA-4): entry explícita indexada.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeDeliverable } = require('../write-deliverable');
const { collectAttachmentsForSkill } = require('../skill-deliverable-attachments');
const { readDeliverableIndex } = require('../deliverable-index');
const qaReport = require('../qa-deliverable-report');

function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'qa-deliverable-'));
}

test('el reporte QA aprobado se escribe, indexa como qa::verificacion y se recolecta', () => {
    const root = tmpRoot();
    const issue = 4512;
    const md = qaReport.buildQaReport({
        issue,
        veredicto: 'passed',
        criterios: [{ id: 'CA-1', estado: 'cumple', detalle: 'ok' }],
        entorno: { modo: 'android' },
        defectos: 'ninguno',
        evidencia: `qa/evidence/${issue}/qa-${issue}.mp4`,
    });

    const res = writeDeliverable('qa', issue, {
        fase: 'verificacion', md, sensible: true, pipelineRoot: root,
    });

    // El archivo existe con nombre determinístico phase-scoped.
    assert.ok(res.indexed, 'debe indexarse');
    assert.ok(fs.existsSync(res.path), 'el .md existe en disco');
    assert.ok(
        res.path.replace(/\\/g, '/').endsWith(`.pipeline/assets/docs/${issue}/qa-verificacion-${issue}.md`),
        `path esperado: ${res.path}`,
    );

    // Entry qa/verificacion en el índice, con sensible:true.
    const index = readDeliverableIndex(issue, { pipelineRoot: root });
    const entry = (index.entries || []).find((e) => e.agente === 'qa' && e.fase === 'verificacion');
    assert.ok(entry, `debe existir entry qa::verificacion (entries: ${JSON.stringify(index.entries)})`);
    assert.equal(entry.sensible, true, 'la entry debe marcar sensible:true');
    assert.equal(entry.tipo, 'document');

    // collectAttachmentsForSkill lo levanta como document.
    const attachments = collectAttachmentsForSkill('qa', issue, 'verificacion', { pipelineRoot: root });
    const md0 = attachments.find((a) => a.path.endsWith(`qa-verificacion-${issue}.md`));
    assert.ok(md0, `el .md debe ser recolectado como adjunto (got: ${JSON.stringify(attachments)})`);
    assert.equal(md0.type, 'document');
});

test('el reporte QA rechazado (failed) también queda indexado y recolectable', () => {
    const root = tmpRoot();
    const issue = 777;
    const md = qaReport.buildQaReport({
        issue,
        veredicto: 'failed',
        criterios: [{ id: 'CA-1', estado: 'falla', detalle: 'no navega' }],
        defectos: [{ esperado: 'home', paso: 'login', donde: 'frame.png' }],
    });
    const res = writeDeliverable('qa', issue, {
        fase: 'verificacion', md, sensible: true, pipelineRoot: root,
    });
    assert.ok(fs.existsSync(res.path));
    const attachments = collectAttachmentsForSkill('qa', issue, 'verificacion', { pipelineRoot: root });
    assert.ok(attachments.some((a) => a.path.endsWith(`qa-verificacion-${issue}.md`)));
});

test('la excepción "no aplica" queda como entry explícita en el índice (CA-4)', () => {
    const root = tmpRoot();
    const issue = 321;
    const md = qaReport.buildQaExceptionReport({
        issue,
        motivo: 'Label qa:skipped: cambio de infra sin UI',
        modo: 'qa:skipped',
    });
    const res = writeDeliverable('qa', issue, {
        fase: 'verificacion', md, sensible: true, pipelineRoot: root,
    });
    assert.ok(res.indexed, 'la excepción debe indexarse (no silencio)');

    const index = readDeliverableIndex(issue, { pipelineRoot: root });
    const entry = (index.entries || []).find((e) => e.agente === 'qa' && e.fase === 'verificacion');
    assert.ok(entry, 'entry qa::verificacion presente');

    // El contenido del archivo referencia la excepción, no un veredicto.
    const content = fs.readFileSync(res.path, 'utf8');
    assert.match(content, /QA E2E no aplica/);
    assert.ok(!content.includes('QA E2E passed'));
});
