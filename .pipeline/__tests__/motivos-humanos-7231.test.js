// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// motivos-humanos-7231.test.js — #7231 (paquete con #7232)
//
// El filtro `motivosHumanos` del barrido del Pulpo (`pulpo.js`, rama #2549)
// sólo entraba por la heurística textual `isHumanBlockReason(motivo)`. El hint
// estructurado `rebote_categoria: human_block` se usaba únicamente como
// excepción para que missing-tests no lo pisara, nunca como señal POSITIVA.
// Resultado en #5570: guru declaró el hint, el texto no matcheó ningún patrón
// y el issue rebotó a dev y se relanzó en bucle.
//
// El predicado ahora vive en `reboteClassifier.esMotivoHumano` y se testea
// acá con el YAML real de #5570 (`desarrollo/validacion/procesado/5570.guru`).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const reboteClassifier = require('../lib/rebote-classifier');
const humanBlock = require('../lib/human-block');
const triggers = require('../lib/human-block-triggers');

// YAML literal de #5570 (recortado al contrato: los campos que consume el barrido).
const YAML_5570 = `
issue: 5570
fase: validacion
pipeline: desarrollo
resultado: rechazado
gravedad: grave
rebote_categoria: human_block
question: '¿Cerrás #5570 con recommendation:rejected a favor de #7227, o reescribís título/cuerpo/criterios con el alcance de #7227 y lo re-encolás desde analisis?'
motivo: |
  La historia llegó a desarrollo sin decisión humana y con la premisa técnica refutada.
  No hay contexto técnico válido ni criterios de aceptación para implementar.

  (1) Cómo llegó a Ready — los tres rechazos de definición (security, architect, planner)
      se promovieron porque fase_rechazo: null no tiene rama de escalado (#7228).

  Decisión humana requerida: cerrar #5570 con recommendation:rejected y triar #7227, o
  reescribir el issue con el alcance de #7227 y re-encolar desde analisis.
`;

// Construye el `m` tal como lo arma el barrido (`motivosClasificados`), sin
// montar el Pulpo: motivo crudo + hint + veredicto de `classifyRebote`.
function motivoClasificadoDesdeYaml(txt, { skill = 'guru' } = {}) {
    const r = yaml.load(txt);
    const m = {
        skill,
        motivo: r.motivo || '',
        rebote_categoria: r.rebote_categoria || null,
        depende_de: Array.isArray(r.depende_de) ? r.depende_de : null,
    };
    m.veredicto = reboteClassifier.classifyRebote({
        motivo: m.motivo,
        skill: m.skill,
        rebote_categoria: m.rebote_categoria,
        dependsOn: m.depende_de,
    });
    return m;
}

test('#7231: el motivo de #5570 NO matchea la heuristica textual (precondicion del bug)', () => {
    const m = motivoClasificadoDesdeYaml(YAML_5570);
    assert.equal(humanBlock.isHumanBlockReason(m.motivo), false,
        'si esto pasa a true, el test deja de reproducir el bug, pero el fix sigue siendo necesario');
    assert.equal(m.veredicto.category, 'human_block', 'classifyRebote SI respeta el hint (#3229)');
});

test('#7231 CA-10: el YAML de #5570 (hint human_block + motivo sin frase magica) entra en motivosHumanos', () => {
    const m = motivoClasificadoDesdeYaml(YAML_5570);
    assert.equal(reboteClassifier.esMotivoHumano(m, new Set()), true);
});

test('#7231 CA-10: el hint entra aunque el motivo mencione tests faltantes (la senal deliberada se respeta)', () => {
    const m = {
        skill: 'review',
        motivo: 'Faltan tests para la funcionalidad nueva; ademas hay que decidir si se mantiene el endpoint.',
        rebote_categoria: 'human_block',
        veredicto: { category: 'human_block' },
    };
    assert.equal(reboteClassifier.isMissingTestsReason(m.motivo), true);
    assert.equal(reboteClassifier.esMotivoHumano(m, new Set()), true);
});

test('#7231 CA-10: mecanicoResueltos (#4767) conserva precedencia sobre el hint', () => {
    const m = motivoClasificadoDesdeYaml(YAML_5570);
    assert.equal(reboteClassifier.esMotivoHumano(m, new Set([m])), false,
        'un bloqueo mecanico ya resuelto por el carril paralelo NO escala a humano');
});

test('#7231: sin hint, la heuristica textual sigue vigente (no regresion)', () => {
    const conFrase = {
        skill: 'po',
        motivo: 'No corresponde que lo decida el agente: requiere una decisión del operador sobre el alcance.',
        rebote_categoria: null,
        veredicto: reboteClassifier.classifyRebote({ motivo: 'requiere una decisión del operador sobre el alcance.', skill: 'po' }),
    };
    assert.equal(humanBlock.isHumanBlockReason(conFrase.motivo), true);
    assert.equal(reboteClassifier.esMotivoHumano(conFrase, new Set()), true);

    const sinNada = {
        skill: 'review',
        motivo: 'El test de login falla en la linea 42; corregir el mock.',
        rebote_categoria: null,
        veredicto: { category: 'code' },
    };
    assert.equal(reboteClassifier.esMotivoHumano(sinNada, new Set()), false);
});

test('#7231: sin hint, missing-tests (#4223) le gana a la heuristica textual', () => {
    const m = {
        skill: 'review',
        motivo: 'Faltan tests para la funcionalidad nueva. Nota: el label needs-human se agrupa por aprobación humana en el mensaje.',
        rebote_categoria: null,
        veredicto: { category: 'code' },
    };
    assert.equal(reboteClassifier.esMotivoHumano(m, new Set()), false);
});

test('#7231: un hint distinto de human_block no entra por si solo', () => {
    const m = { skill: 'guru', motivo: 'Depende de #1234 abierto.', rebote_categoria: 'dependency_block', veredicto: { category: 'dependency_block' } };
    assert.equal(reboteClassifier.esMotivoHumano(m, new Set()), false);
    assert.equal(reboteClassifier.esMotivoHumano(null, new Set()), false);
    assert.equal(reboteClassifier.esMotivoHumano({ motivo: '' }, undefined), false);
});

test('#7231 CA-10: guru forma parte de DECISION_SKILLS', () => {
    assert.ok(triggers.DECISION_SKILLS.includes('guru'));
    const v = triggers.detectDecisionRequestBlock({
        skill: 'guru', issue: 5570,
        motivo: 'Requiere una decisión del operador: cerrar o reescribir el issue.',
    });
    assert.ok(v);
    assert.equal(v.trigger, triggers.TRIGGERS.DECISION_REQUESTED);
});

test('#7231 CA-10: pulpo.js consume esMotivoHumano en el filtro motivosHumanos', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'pulpo.js'), 'utf8');
    assert.match(src, /const motivosHumanos = motivosClasificados\.filter\(\s*m => reboteClassifier\.esMotivoHumano\(m, mecanicoResueltos\)/);
});
