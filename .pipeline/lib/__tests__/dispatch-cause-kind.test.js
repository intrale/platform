// =============================================================================
// dispatch-cause-kind.test.js — Brazo de RECOLECCIÓN del watchdog (#5400 rev-1).
//
// Por qué existe: esta traducción (enum de causa de despacho → `kind` del
// watchdog) decide qué causas pueden silenciar la alarma. Si se equivoca, el
// watchdog calla cuando debería hablar y lo único observable es la AUSENCIA de
// un mensaje. Vivía enterrada en pulpo.js sin un solo test (hallazgo rev-1).
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const dck = require('../dispatch-cause-kind');
const dc = require('../dispatch-cause');
const wd = require('../wave-stall-watchdog');

test('cada causa de despacho conocida se traduce a un kind del watchdog', () => {
    const esperado = {
        [dc.CAUSAS.HALT_HUMANO]: 'human-halt',
        [dc.CAUSAS.MODO_OLA]: 'wave-empty',
        [dc.CAUSAS.SIN_AGENTES]: 'concurrency-limit',
        [dc.CAUSAS.VENTANA_HORARIA]: 'priority-window',
        [dc.CAUSAS.REST_MODE]: 'night-window',
        [dc.CAUSAS.COOLDOWN]: 'cooldown',
        [dc.CAUSAS.BLOQUEO_DEPENDENCIA]: 'blocked-dependencies',
        [dc.CAUSAS.DEADLOCK]: 'deadlock',
        [dc.CAUSAS.CB_INFRA]: 'cb-infra',
        [dc.CAUSAS.PRESION_RECURSOS]: 'resource-pressure',
        [dc.CAUSAS.DISCO_LLENO]: 'disk-pressure',
    };
    assert.deepEqual({ ...dck.DISPATCH_CAUSE_TO_WATCHDOG_KIND }, esperado);
});

test('el enum de causas está cubierto entero salvo la anomalía (fail-closed)', () => {
    // Una causa nueva sin mapear no rompe nada (cae a "sin causa" ⇒ dispara),
    // pero el aviso saldría sin nombre concreto y eso viola CA-2. Este test es
    // el recordatorio de mapearla.
    const sinMapear = Object.values(dc.CAUSAS)
        .filter((c) => c !== dc.CAUSAS.ANOMALIA)
        .filter((c) => !dck.DISPATCH_CAUSE_TO_WATCHDOG_KIND[c]);
    assert.deepEqual(sinMapear, [], `causas sin traducir: ${sinMapear.join(', ')}`);
});

test('cada kind traducido tiene un nombre legible en el catálogo del watchdog', () => {
    // Cohesión entre los dos módulos: si un kind no tiene label, el operador
    // recibe un slug crudo en el aviso.
    for (const kind of Object.values(dck.DISPATCH_CAUSE_TO_WATCHDOG_KIND)) {
        assert.ok(wd.CAUSE_LABELS[kind], `el kind '${kind}' no tiene label en CAUSE_LABELS`);
    }
});

test('la ANOMALÍA jamás silencia la alarma (SEC-1)', () => {
    // "No sé por qué no despacho" es el caso en que MÁS hace falta avisar.
    assert.equal(dck.causeFromArtifact({ causa: dc.CAUSAS.ANOMALIA, ts: 1000 }), null);
    assert.equal(dck.DISPATCH_CAUSE_TO_WATCHDOG_KIND[dc.CAUSAS.ANOMALIA], undefined);
});

test('un enum desconocido tampoco silencia (fail-closed ante causa nueva)', () => {
    assert.equal(dck.causeFromArtifact({ causa: 'causa_del_futuro', ts: 1000 }), null);
});

test('un artifact ausente, vacío o basura devuelve null sin lanzar', () => {
    for (const entrada of [null, undefined, {}, 'texto', 42, [], { causa: '' }, { causa: null }]) {
        assert.equal(dck.causeFromArtifact(entrada), null, `entrada ${JSON.stringify(entrada)}`);
    }
});

test('una causa mapeada se declara con su kind, legible y con el inicio de la causa', () => {
    const out = dck.causeFromArtifact({ causa: dc.CAUSAS.COOLDOWN, ts: 12345 });
    assert.deepEqual(out, {
        declared: true,
        kind: 'cooldown',
        readable: true,
        sinceTs: 12345,
        authorDeclared: null,
    });
    // Y el watchdog la acepta como causa válida (contrato entre los dos módulos).
    assert.equal(wd.isCauseValid(out, 99999), true);
});

test('un ts ilegible no invalida la causa: queda en null (el reloj es el del despacho)', () => {
    const out = dck.causeFromArtifact({ causa: dc.CAUSAS.MODO_OLA, ts: 'ayer' });
    assert.equal(out.kind, 'wave-empty');
    assert.equal(out.sinceTs, null);
    assert.equal(wd.isCauseValid(out, 1), true);
});

test('la autoría NUNCA se infiere del artifact (SEC-2)', () => {
    // El artifact no registra quién declaró la causa. Inventar un responsable es
    // peor que admitir que no consta.
    const out = dck.causeFromArtifact({ causa: dc.CAUSAS.HALT_HUMANO, ts: 1, autor: 'leitolarreta' });
    assert.equal(out.authorDeclared, null);
});
