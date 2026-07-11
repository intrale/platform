// Tests de .pipeline/lib/operator-allowlist.js (issue #4630).
// Cubren: roles primary/backup, operador desconocido, allowlist cerrada/vacía,
// rechazo de re-delegación por `backup`, normalización fail-closed y el
// singleton default de producción.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../operator-allowlist');
const { createAllowlist, normalizeOperators, ROLES, DEFAULT_OPERATORS } = mod;

const OPERATORS = [
    { id: 'alice', role: 'primary' },
    { id: 'bob', role: 'backup' },
];

test('getOperator devuelve el operador registrado con su rol', () => {
    const al = createAllowlist({ operators: OPERATORS });
    assert.deepEqual(al.getOperator('alice'), { id: 'alice', role: 'primary' });
    assert.deepEqual(al.getOperator('bob'), { id: 'bob', role: 'backup' });
});

test('getOperator devuelve null para operador desconocido (fail-closed)', () => {
    const al = createAllowlist({ operators: OPERATORS });
    assert.equal(al.getOperator('mallory'), null);
    assert.equal(al.getOperator(''), null);
    assert.equal(al.getOperator(undefined), null);
    assert.equal(al.getOperator(123), null);
});

test('isPrimary / isBackup distinguen roles sin fallback permisivo', () => {
    const al = createAllowlist({ operators: OPERATORS });
    assert.equal(al.isPrimary('alice'), true);
    assert.equal(al.isBackup('alice'), false);
    assert.equal(al.isBackup('bob'), true);
    assert.equal(al.isPrimary('bob'), false);
    // Desconocido no es ni primary ni backup.
    assert.equal(al.isPrimary('mallory'), false);
    assert.equal(al.isBackup('mallory'), false);
});

test('assertCanGrant sólo aprueba a un primary', () => {
    const al = createAllowlist({ operators: OPERATORS });
    const r = al.assertCanGrant('alice');
    assert.equal(r.ok, true);
    assert.equal(r.operator.id, 'alice');
});

test('assertCanGrant rechaza a un backup con causa not-primary (no re-delegación)', () => {
    const al = createAllowlist({ operators: OPERATORS });
    const r = al.assertCanGrant('bob');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-primary');
});

test('assertCanGrant rechaza a un operador desconocido con causa unknown-operator', () => {
    const al = createAllowlist({ operators: OPERATORS });
    const r = al.assertCanGrant('mallory');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown-operator');
});

test('allowlist vacía rechaza todo (fail-closed)', () => {
    const al = createAllowlist({ operators: [] });
    assert.equal(al.size(), 0);
    assert.equal(al.getOperator('alice'), null);
    assert.equal(al.assertCanGrant('alice').ok, false);
    assert.equal(al.assertCanGrant('alice').reason, 'unknown-operator');
});

test('normalizeOperators descarta entradas inválidas (fail-closed)', () => {
    const map = normalizeOperators([
        { id: 'ok', role: 'primary' },
        { id: '  spaced  ', role: 'backup' }, // se trimmea
        { id: '', role: 'primary' },          // id vacío → descartado
        { id: 'bad-role', role: 'admin' },     // rol fuera de enum → descartado
        { role: 'primary' },                   // sin id → descartado
        null,                                  // basura → descartada
        'string',                              // basura → descartada
    ]);
    assert.equal(map.size, 2);
    assert.equal(map.get('ok').role, 'primary');
    assert.equal(map.get('spaced').role, 'backup');
    assert.equal(map.has('bad-role'), false);
});

test('ante ids duplicados gana el primer registro', () => {
    const al = createAllowlist({ operators: [
        { id: 'dup', role: 'primary' },
        { id: 'dup', role: 'backup' },
    ] });
    assert.equal(al.getOperator('dup').role, 'primary');
    assert.equal(al.assertCanGrant('dup').ok, true);
});

test('normalizeOperators tolera input no-array', () => {
    assert.equal(normalizeOperators(undefined).size, 0);
    assert.equal(normalizeOperators(null).size, 0);
    assert.equal(normalizeOperators('nope').size, 0);
});

test('list() devuelve copia de la allowlist', () => {
    const al = createAllowlist({ operators: OPERATORS });
    const l = al.list();
    assert.equal(l.length, 2);
    // Mutar la copia no afecta la allowlist interna.
    l.push({ id: 'injected', role: 'primary' });
    assert.equal(al.getOperator('injected'), null);
});

test('ROLES es un enum cerrado con primary y backup', () => {
    assert.deepEqual([...ROLES].sort(), ['backup', 'primary']);
});

test('singleton default de producción registra leitolarreta como primary', () => {
    assert.equal(mod.isPrimary('leitolarreta'), true);
    assert.equal(mod.assertCanGrant('leitolarreta').ok, true);
    // Un desconocido cualquiera falla cerrado en el singleton.
    assert.equal(mod.assertCanGrant('desconocido-x').ok, false);
    assert.equal(mod.assertCanGrant('desconocido-x').reason, 'unknown-operator');
    // DEFAULT_OPERATORS no está vacía y es la fuente del singleton.
    assert.ok(DEFAULT_OPERATORS.some(o => o.id === 'leitolarreta' && o.role === 'primary'));
    assert.ok(mod.listOperators().some(o => o.id === 'leitolarreta'));
    // Ejercitar el resto de los bindings de conveniencia del singleton.
    assert.equal(mod.isBackup('leitolarreta'), false);
    assert.deepEqual(mod.getOperator('leitolarreta'), { id: 'leitolarreta', role: 'primary' });
});
