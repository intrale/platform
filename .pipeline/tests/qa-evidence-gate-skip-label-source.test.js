// =============================================================================
// Tests de integración — validateQaEvidence + bypass `qa:skipped` (Issue #3956)
//
// SEGURIDAD (R1 #2351): la decisión de bypassear la evidencia audiovisual por el
// label `qa:skipped` DEBE resolverse EXCLUSIVAMENTE contra los labels reales del
// issue en GitHub, NUNCA contra `qaData.labels` (YAML escribible por el agente).
//
// Estos tests fijan ese contrato a nivel del gate `validateQaEvidence` (pulpo.js),
// inyectando `getLabels` para simular el estado autoritativo de GitHub:
//
//   1. YAML del agente con labels:['qa:skipped'] pero GitHub SIN el label
//      → NO bypassea (rechaza por falta de evidencia). Caso de ataque.
//   2. GitHub CON el label qa:skipped → bypassea legítimamente.
//   3. Ni GitHub ni YAML tienen el label → no bypassea (comportamiento normal).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PULPO_NO_AUTOSTART = '1';
const pulpo = require('../pulpo.js');

// Issue inexistente: garantiza que NO hay evidencia (.mp4/PNG) en disco, de modo
// que el único camino a "OK" sea el bypass por label.
const ISSUE_SIN_EVIDENCIA = 990003956;

test('#3956 · YAML con labels:[qa:skipped] NO bypassea si GitHub no tiene el label (anti-injection)', () => {
    const qaData = {
        resultado: 'aprobado',
        // Input escribible por el agente: intenta inyectar el label para saltear el gate.
        labels: ['qa:skipped'],
    };
    // GitHub (autoritativo) NO tiene qa:skipped.
    const getLabels = () => ['area:dashboard', 'app:client'];

    const issues = pulpo.validateQaEvidence(
        ISSUE_SIN_EVIDENCIA, qaData, 'android', { getLabels },
    );
    assert.ok(
        issues.length > 0,
        'el gate NO debe bypassear con el label inyectado en el YAML del agente',
    );
});

test('#3956 · GitHub con qa:skipped SÍ bypassea (label legítimo, sin evidencia requerida)', () => {
    const qaData = { resultado: 'aprobado' };
    const getLabels = () => ['area:dashboard', 'qa:skipped'];

    const issues = pulpo.validateQaEvidence(
        ISSUE_SIN_EVIDENCIA, qaData, 'android', { getLabels },
    );
    assert.deepEqual(
        issues, [],
        'con el label real en GitHub el gate debe saltear la evidencia audiovisual',
    );
});

test('#3956 · sin qa:skipped en ninguna fuente → exige evidencia (comportamiento normal)', () => {
    const qaData = { resultado: 'aprobado', labels: [] };
    const getLabels = () => ['area:dashboard', 'app:client'];

    const issues = pulpo.validateQaEvidence(
        ISSUE_SIN_EVIDENCIA, qaData, 'android', { getLabels },
    );
    assert.ok(issues.length > 0, 'sin label qa:skipped debe seguir exigiendo evidencia');
});

test('#3956 · el YAML del agente se ignora aún si GitHub tampoco tiene el label (defensa en profundidad)', () => {
    // Variante explícita del caso de ataque: el YAML trae el label en formato
    // objeto {name}, GitHub no lo tiene. Igual NO debe bypassear.
    const qaData = { resultado: 'aprobado', labels: [{ name: 'qa:skipped' }] };
    const getLabels = () => ['bug'];

    const issues = pulpo.validateQaEvidence(
        ISSUE_SIN_EVIDENCIA, qaData, 'android', { getLabels },
    );
    assert.ok(issues.length > 0, 'el formato objeto del YAML tampoco debe bypassear el gate');
});
