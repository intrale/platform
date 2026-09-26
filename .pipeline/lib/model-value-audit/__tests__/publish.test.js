// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// Tests del puerto `publish(proposal, ctx)` (#7520 CA-26 / SEC-15 / P8).

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const publishMod = require('../publish');

const { createPublisher, ADAPTERS, REASON_NONE, REASON_NO_DISPONIBLE } = publishMod;

const PROPOSAL = { titulo: 'Auditoría de modelos por agente · 2026-08-22 → 2026-09-21', tipo: 'cambio-de-configuracion', accion: 'x', evidencia: { tipo: 'metrica', referencia: 'a'.repeat(64), resumen: 'r' }, beneficio: 'b', costo: { nivel: 'bajo' }, riesgo: { nivel: 'bajo' }, sensible: false };

/** Espía de `require` a nivel Module: registra qué módulos se cargan durante `fn`. */
function conRequireEspia(fn) {
    const cargados = [];
    const original = Module.prototype.require;
    Module.prototype.require = function (spec) {
        cargados.push(spec);
        return original.apply(this, arguments);
    };
    try { return { out: fn(), cargados }; } finally { Module.prototype.require = original; }
}

test('ADAPTERS es el enum cerrado y congelado del schema', () => {
    assert.deepEqual([...ADAPTERS], ['telegram-plain', 'registry', 'none']);
    assert.ok(Object.isFrozen(ADAPTERS));
});

test('CA-26 · none ⇒ ok:true, adaptador_none, sin cargar ningún módulo ni invocar nada', () => {
    const { out, cargados } = conRequireEspia(() => createPublisher({ adapter: 'none' }).publish(PROPOSAL, { logger: () => { throw new Error('no debería loguear'); } }));
    assert.deepEqual(out, { ok: true, reason: REASON_NONE, items: 0, audio: 'no', audioTask: null });
    assert.deepEqual(cargados.filter((s) => /publish-telegram|registry/.test(s)), []);
});

test('CA-26 · telegram-plain ⇒ delega en publish-telegram con el ctx + deps fusionados', () => {
    const llamadas = [];
    const fake = { publish: (p, c) => { llamadas.push({ p, c }); return { ok: true, reason: 'publicado', items: 2, audio: 'no', audioTask: null }; } };
    const pub = createPublisher({ adapter: 'telegram-plain', deps: { telegramModule: () => fake, queueDir: '/tmp/q' } });
    assert.equal(pub.adapter, 'telegram-plain');
    const res = pub.publish(PROPOSAL, { hash8: 'aaaaaaaa', deps: { now: () => 1 } });
    assert.equal(res.ok, true);
    assert.equal(llamadas.length, 1);
    assert.equal(llamadas[0].p, PROPOSAL);
    assert.equal(llamadas[0].c.hash8, 'aaaaaaaa');
    assert.equal(llamadas[0].c.deps.queueDir, '/tmp/q');
    assert.equal(typeof llamadas[0].c.deps.now, 'function');
});

test('CA-26 · telegram-plain sin telegramModule inyectado carga ./publish-telegram real (perezoso)', () => {
    const { cargados } = conRequireEspia(() => createPublisher({ adapter: 'telegram-plain' }));
    assert.deepEqual(cargados.filter((s) => /publish-telegram/.test(s)), [], 'no se carga al crear');
    const pub = createPublisher({ adapter: 'telegram-plain' });
    // Propuesta inválida ⇒ el adaptador real rechaza sin escribir: prueba que se delegó.
    const res = pub.publish({ ...PROPOSAL, titulo: 'corto' }, { deps: { queueDir: '/tmp/nunca', writeDropfile: () => { throw new Error('no debería escribir'); }, fsImpl: { existsSync: () => true } } });
    assert.equal(res.ok, false);
    assert.match(res.reason, /^propuesta_invalida:/);
});

test('SEC-15 · registry sin registryModule ⇒ adaptador_no_disponible, publish-telegram NO invocado, loguea', () => {
    const logs = [];
    const telegram = { publish: () => { throw new Error('no debe degradar a telegram'); } };
    const pub = createPublisher({ adapter: 'registry', deps: { telegramModule: () => telegram } });
    const { out, cargados } = conRequireEspia(() => pub.publish(PROPOSAL, { logger: (m) => logs.push(m) }));
    assert.deepEqual(out, { ok: false, reason: REASON_NO_DISPONIBLE, items: 0, audio: 'no', audioTask: null });
    assert.deepEqual(cargados.filter((s) => /publish-telegram/.test(s)), []);
    assert.ok(logs.some((m) => /registry no disponible/.test(m)));
});

test('SEC-15 · registry con registryModule ⇒ delega en él (preparado para #6807)', () => {
    const llamadas = [];
    const registry = { publish: (p, c) => { llamadas.push({ p, c }); return { ok: true, reason: 'registrado', items: 1, audio: 'no', audioTask: null }; } };
    const res = createPublisher({ adapter: 'registry', deps: { registryModule: registry } }).publish(PROPOSAL, { productor: 'auditor-modelos' });
    assert.equal(res.ok, true);
    assert.equal(res.reason, 'registrado');
    assert.equal(llamadas[0].c.productor, 'auditor-modelos');
});

test('SEC-15 · adaptador fuera del enum ("digest", undefined no-none) ⇒ adaptador_no_disponible sin degradar', () => {
    for (const adapter of ['digest', 'telegram', 'TELEGRAM-PLAIN', '']) {
        const res = createPublisher({ adapter }).publish(PROPOSAL, {});
        assert.equal(res.ok, false, adapter);
        assert.equal(res.reason, REASON_NO_DISPONIBLE, adapter);
    }
    // Sin adapter ⇒ `none` (fail-closed: no se publica).
    assert.equal(createPublisher({}).publish(PROPOSAL, {}).reason, REASON_NONE);
});
