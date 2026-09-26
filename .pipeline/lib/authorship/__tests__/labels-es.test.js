// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';
// #7633 — Diccionario único de copy U2/U3 (CA-1).

const test = require('node:test');
const assert = require('node:assert');

const L = require('../labels-es');
const { REASONS, DIRECTION_KINDS } = require('../trailer');
const { REASON_COPY } = require('../copy');

test('copy U2 exacto de los tipos de decisión', () => {
    assert.deepStrictEqual({ ...L.DECISION_LABELS }, {
        gate2: 'Firmó la aceptación del código',
        gate1: 'Firmó la definición de la tarea',
        approval: 'Aprobó por el canal de firma',
        none: 'Sin firma registrada',
    });
    for (const k of DIRECTION_KINDS) assert.ok(L.DECISION_LABELS[k], `falta copy de ${k}`);
});

test('copy U2 exacto de los roles', () => {
    for (const r of ['backend-dev', 'pipeline-dev', 'android-dev', 'web-dev']) {
        assert.strictEqual(L.roleLabel(r), 'escribió el código');
    }
    assert.strictEqual(L.roleLabel('review'), 'revisó el código');
    assert.strictEqual(L.roleLabel('tester'), 'ejecutó las pruebas');
    assert.strictEqual(L.roleLabel('qa'), 'probó el funcionamiento');
    assert.strictEqual(L.roleLabel('security'), 'revisó la seguridad');
});

test('rol desconocido ⇒ asistió (<rol>), sin escapar en el diccionario', () => {
    assert.strictEqual(L.roleLabel('foo'), 'asistió (foo)');
    assert.strictEqual(L.roleLabel('<x>'), 'asistió (<x>)');
    assert.strictEqual(L.roleLabel(undefined), 'asistió ()');
    assert.strictEqual(L.roleLabel('toString'), 'asistió (toString)');
});

test('estados U3 con ícono y texto', () => {
    assert.strictEqual(L.STATE_LABELS.signed, '✔ Dirección humana firmada');
    assert.strictEqual(L.STATE_LABELS.unsigned, '⚠ Sin firma registrada');
    assert.strictEqual(L.STATE_LABELS.invalid, '✖ Trailer inválido');
});

test('todo motivo (REASONS del trailer + propios del export) tiene copy no vacío', () => {
    for (const r of [...REASONS, ...L.EXPORT_REASONS]) {
        assert.ok(typeof L.UNSIGNED_REASONS[r] === 'string' && L.UNSIGNED_REASONS[r].length > 10, `sin copy: ${r}`);
    }
    for (const r of REASONS) assert.strictEqual(L.UNSIGNED_REASONS[r], REASON_COPY[r], 'no se duplica el copy de copy.js');
    assert.ok(L.EXPORT_REASONS.includes('unrecognized'));
});

test('unsignedReasonText nunca devuelve vacío', () => {
    assert.strictEqual(L.unsignedReasonText('dry-run'), 'Se integró mientras la verificación estaba en modo de prueba.');
    assert.strictEqual(L.unsignedReasonText('pre-go-live', { goLiveDateText: '23/09/2026' }),
        'Cambio anterior a la entrada en vigencia del registro de firma (23/09/2026).');
    assert.ok(L.unsignedReasonText('pre-go-live').includes('fecha no configurada'));
    assert.strictEqual(L.unsignedReasonText('???'), L.UNSIGNED_REASONS.unrecognized);
});

test('proveedor y decisión con fallback', () => {
    assert.strictEqual(L.providerLabel('anthropic'), 'Anthropic');
    assert.strictEqual(L.providerLabel('openai'), 'OpenAI');
    assert.strictEqual(L.providerLabel('otro'), 'otro');
    assert.strictEqual(L.providerLabel(null), '');
    assert.strictEqual(L.decisionLabel('gate1'), 'Firmó la definición de la tarea');
    assert.strictEqual(L.decisionLabel('x'), 'Sin firma registrada');
});

test('leyenda literal de "qué no prueba"', () => {
    assert.strictEqual(`${L.LEGEND.before}${L.LEGEND.code}${L.LEGEND.after}`,
        'Esta constancia verifica la consistencia de los registros en main; no prueba por sí sola la autenticidad de la firma.');
});

test('los diccionarios están congelados', () => {
    for (const o of [L.DECISION_LABELS, L.ROLE_LABELS, L.STATE_LABELS, L.UNSIGNED_REASONS, L.WHO_LABELS, L.LEGEND]) {
        assert.ok(Object.isFrozen(o));
    }
});
