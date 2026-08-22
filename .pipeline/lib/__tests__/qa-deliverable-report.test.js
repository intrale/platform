'use strict';

// Tests del builder puro del reporte de QA E2E (#4512).
// Cubren CA-2 (contenido mínimo), CA-4 (excepción "no aplica"), CA-UX-1..4
// (veredicto inequívoco, estado por criterio, defectos accionables sin logs
// crudos, motivo donde iría el veredicto).

const test = require('node:test');
const assert = require('node:assert');

const {
    buildQaReport,
    buildQaExceptionReport,
    normalizeVeredicto,
    markFor,
} = require('../qa-deliverable-report');

// -----------------------------------------------------------------------------
// buildQaReport — estructura y secciones
// -----------------------------------------------------------------------------

test('buildQaReport produce las 5 secciones con veredicto en el título (passed)', () => {
    const md = buildQaReport({
        issue: 4512,
        veredicto: 'passed',
        criterios: [{ id: 'CA-1', estado: 'cumple', detalle: 'login navega al home' }],
        entorno: { modo: 'android', backend: 'https://api.example/dev', apk: 'assembleClientDebug' },
        defectos: 'ninguno',
        evidencia: 'qa/evidence/4512/qa-4512.mp4',
        screenshot: 'qa/evidence/4512/qa-4512-final.png',
    });

    // Título con veredicto inequívoco (CA-UX-1).
    assert.ok(md.startsWith('# ✅ QA E2E passed — #4512'), 'título con veredicto passed');
    // Las 5 secciones.
    assert.match(md, /## Criterios PO/);
    assert.match(md, /## Entorno/);
    assert.match(md, /## Defectos/);
    assert.match(md, /## Evidencia/);
    // Estado por criterio individual (CA-UX-2).
    assert.match(md, /✅ \*\*CA-1\*\* — login navega al home/);
    // Entorno.
    assert.match(md, /\*\*Modo:\*\* android/);
    assert.match(md, /\*\*Backend:\*\*/);
    assert.match(md, /\*\*APK\/Flavor:\*\* assembleClientDebug/);
    // Evidencia referenciada.
    assert.match(md, /qa-4512\.mp4/);
    assert.match(md, /qa-4512-final\.png/);
});

test('buildQaReport marca failed en el título cuando el veredicto falla', () => {
    const md = buildQaReport({ issue: 100, veredicto: 'failed', criterios: [] });
    assert.ok(md.startsWith('# ❌ QA E2E failed — #100'), 'título con veredicto failed');
});

test('buildQaReport degrada con defaults legibles ante YAML mínimo', () => {
    const md = buildQaReport({ issue: 7, veredicto: 'passed' });
    assert.match(md, /Criterios no reportados por el agente QA/);
    assert.match(md, /Entorno no reportado por el agente QA/);
    assert.match(md, /_Ninguno\._/);
    assert.match(md, /_Sin evidencia referenciada\._/);
});

test('buildQaReport lista cada criterio con su estado individual', () => {
    const md = buildQaReport({
        issue: 1,
        veredicto: 'failed',
        criterios: [
            { id: 'CA-1', estado: 'cumple', detalle: 'ok' },
            { id: 'CA-2', estado: 'falla', detalle: 'no navega' },
            { id: 'CA-3', estado: 'no-aplica', detalle: 'sin UI' },
        ],
    });
    assert.match(md, /✅ \*\*CA-1\*\*/);
    assert.match(md, /❌ \*\*CA-2\*\* — no navega/);
    assert.match(md, /➖ \*\*CA-3\*\* — sin UI/);
});

test('buildQaReport arma defectos accionables (esperado/pasó/dónde) sin logs crudos', () => {
    const md = buildQaReport({
        issue: 1,
        veredicto: 'failed',
        defectos: [
            { esperado: 'navegar al home', paso: 'queda en login', donde: 'frame-3.png' },
        ],
    });
    assert.match(md, /esperado: navegar al home/);
    assert.match(md, /pasó: queda en login/);
    assert.match(md, /dónde: frame-3\.png/);
});

test('buildQaReport colapsa dumps multilínea a una sola línea (anti-log-crudo)', () => {
    const dump = 'línea1\nlínea2\nlínea3\tstacktrace';
    const md = buildQaReport({ issue: 1, veredicto: 'failed', defectos: dump });
    const defectosSection = md.split('## Defectos')[1].split('## Evidencia')[0];
    assert.ok(!defectosSection.includes('\nlínea2'), 'el dump no debe conservar saltos internos');
    assert.match(defectosSection, /línea1 línea2 línea3/);
});

test('buildQaReport recorta strings largos con elipsis (anti-DoS de contenido)', () => {
    const largo = 'x'.repeat(1000);
    const md = buildQaReport({ issue: 1, veredicto: 'failed', defectos: largo });
    assert.ok(md.includes('…'), 'debe truncar con elipsis');
    assert.ok(!md.includes('x'.repeat(600)), 'no debe volcar el string completo');
});

// -----------------------------------------------------------------------------
// buildQaExceptionReport — CA-4
// -----------------------------------------------------------------------------

test('buildQaExceptionReport pone el motivo donde iría el veredicto (CA-4)', () => {
    const md = buildQaExceptionReport({
        issue: 4512,
        motivo: 'Label qa:skipped: cambio de infra sin UI',
        modo: 'qa:skipped',
    });
    assert.ok(md.startsWith('# ➖ QA E2E no aplica — #4512'), 'título "no aplica"');
    assert.match(md, /\*\*Motivo:\*\* Label qa:skipped/);
    assert.match(md, /\*\*Modo:\*\* qa:skipped/);
    // NO debe leerse como passed/failed.
    assert.ok(!md.includes('QA E2E passed'), 'no debe decir passed');
    assert.ok(!md.includes('QA E2E failed'), 'no debe decir failed');
});

test('buildQaExceptionReport degrada motivo/modo faltantes sin romper', () => {
    const md = buildQaExceptionReport({ issue: 9 });
    assert.match(md, /No se registró un motivo explícito/);
    assert.match(md, /\*\*Modo:\*\* no especificado/);
});

// -----------------------------------------------------------------------------
// helpers puros
// -----------------------------------------------------------------------------

test('normalizeVeredicto mapea alias a passed/failed y default failed', () => {
    assert.equal(normalizeVeredicto('passed'), 'passed');
    assert.equal(normalizeVeredicto('aprobado'), 'passed');
    assert.equal(normalizeVeredicto('failed'), 'failed');
    assert.equal(normalizeVeredicto('rechazado'), 'failed');
    assert.equal(normalizeVeredicto(undefined), 'failed');
    assert.equal(normalizeVeredicto('cualquier-cosa'), 'failed');
});

test('markFor tolera valores libres y cae a no-aplica', () => {
    assert.equal(markFor('cumple'), '✅');
    assert.equal(markFor('falla'), '❌');
    assert.equal(markFor('no-aplica'), '➖');
    assert.equal(markFor('desconocido'), '➖');
});
