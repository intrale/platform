// =============================================================================
// Tests de integración — alcance del fail-closed del sellado de evidencia QA
// (#6495, rebote 3 · R-2).
//
// El hook de sellado del on-exit degrada el veredicto a `rechazado` cuando no
// puede sellar. El review del rebote 3 encontró que ese fail-closed corría para
// TODOS los aprobados, mientras que su gate hermano `validateQaEvidence` retorna
// `[]` temprano para `qaMode ∈ {api, structural}` y para el label `qa:skipped`.
// En esos modos `evidencia` es prosa por contrato del rol (`.pipeline/roles/qa.md`),
// así que el sellado se comía el 22% de las aprobaciones históricas.
//
// `resolveQaEvidenceEnforcement` es la decisión ÚNICA que ahora comparten los dos
// gates. Estos tests fijan que:
//   1. los dos bypass del gate hermano se replican tal cual;
//   2. el modo android sin bypass sigue siendo exigible;
//   3. la fuente de labels sigue siendo EXCLUSIVAMENTE GitHub (R1 #2351);
//   4. reusar la decisión en `validateQaEvidence` da el mismo veredicto que
//      calcularla adentro.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PULPO_NO_AUTOSTART = '1';
const pulpo = require('../pulpo.js');

// Issue inexistente: garantiza que no hay evidencia real en disco, así el único
// camino a "sin hallazgos" es el bypass.
const ISSUE_SIN_EVIDENCIA = 990006495;
const SIN_LABELS = () => ['area:pipeline'];

test('#6495 · structural y api bypassean: ahí `evidencia` es prosa por contrato del rol', () => {
    for (const modo of ['structural', 'api']) {
        const enforcement = pulpo.resolveQaEvidenceEnforcement(
            ISSUE_SIN_EVIDENCIA, { resultado: 'aprobado', modo }, modo, { getLabels: SIN_LABELS },
        );
        assert.equal(enforcement.bypassed, true, `${modo} debería bypassear`);
        assert.equal(enforcement.motivo, `qa-mode-${modo}`);
        assert.ok(enforcement.logLine, `${modo} tiene que dejar línea de auditoría`);
    }
});

test('#6495 · el label qa:skipped bypassea el sellado igual que el gate hermano', () => {
    const enforcement = pulpo.resolveQaEvidenceEnforcement(
        ISSUE_SIN_EVIDENCIA,
        { resultado: 'aprobado', modo: 'android' },
        'android',
        { getLabels: () => ['area:pipeline', 'qa:skipped'] },
    );
    assert.equal(enforcement.bypassed, true);
    assert.equal(enforcement.motivo, 'qa-skipped');
});

test('#6495 · android sin bypass sigue siendo EXIGIBLE: el fail-closed del sellado aplica', () => {
    const enforcement = pulpo.resolveQaEvidenceEnforcement(
        ISSUE_SIN_EVIDENCIA, { resultado: 'aprobado', modo: 'android' }, 'android', { getLabels: SIN_LABELS },
    );
    assert.equal(enforcement.bypassed, false, 'acotar el fail-closed no puede desactivarlo');
    assert.equal(enforcement.motivo, null);
    assert.equal(enforcement.logLine, null);
});

test('#6495 · el modo autoritativo del preflight gana sobre el `modo` del YAML del agente', () => {
    // El agente miente diciendo structural; el preflight determinó android.
    const enforcement = pulpo.resolveQaEvidenceEnforcement(
        ISSUE_SIN_EVIDENCIA,
        { resultado: 'aprobado', modo: 'structural' },
        'android',
        { getLabels: SIN_LABELS },
    );
    assert.equal(enforcement.bypassed, false, 'el YAML del agente no puede comprar el bypass');
});

test('#6495 · un label qa:skipped inyectado en el YAML no compra el bypass del sellado', () => {
    const enforcement = pulpo.resolveQaEvidenceEnforcement(
        ISSUE_SIN_EVIDENCIA,
        { resultado: 'aprobado', modo: 'android', labels: ['qa:skipped'] },
        'android',
        { getLabels: SIN_LABELS },
    );
    assert.equal(enforcement.bypassed, false, 'la fuente de labels es GitHub, no el YAML');
});

test('#6495 · reusar la decisión da el mismo veredicto que calcularla dentro del gate', () => {
    const qaData = { resultado: 'aprobado', modo: 'android' };
    const enforcement = pulpo.resolveQaEvidenceEnforcement(
        ISSUE_SIN_EVIDENCIA, qaData, 'android', { getLabels: SIN_LABELS },
    );

    const conReuso = pulpo.validateQaEvidence(
        ISSUE_SIN_EVIDENCIA, qaData, 'android', { getLabels: SIN_LABELS, enforcement },
    );
    const sinReuso = pulpo.validateQaEvidence(
        ISSUE_SIN_EVIDENCIA, qaData, 'android', { getLabels: SIN_LABELS },
    );
    assert.deepEqual(conReuso, sinReuso);
    assert.ok(sinReuso.length > 0, 'android sin evidencia real tiene que seguir rechazando');

    // Y con bypass, los dos caminos coinciden en "sin hallazgos".
    const bypass = pulpo.resolveQaEvidenceEnforcement(
        ISSUE_SIN_EVIDENCIA, { resultado: 'aprobado', modo: 'structural' }, 'structural', { getLabels: SIN_LABELS },
    );
    assert.deepEqual(
        pulpo.validateQaEvidence(
            ISSUE_SIN_EVIDENCIA, { resultado: 'aprobado', modo: 'structural' }, 'structural',
            { getLabels: SIN_LABELS, enforcement: bypass },
        ),
        [],
    );
});
