'use strict';

// Tests SSR de la vista Ops rediseñada (EP8-H7 #3960).
// node --test .pipeline/views/dashboard/ops-render.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const ops = require('./ops');

const baseState = () => ({
    procesos: {
        pulpo: { pid: '9512', alive: true, uptime: 190000000 },
        listener: { pid: '10244', alive: true, uptime: 172800000 },
        'svc-drive': { pid: null, alive: false },
        'svc-github': { pid: '11820', alive: true, uptime: 172800000 },
        dashboard: { pid: '1', alive: true, uptime: 3600000 },
    },
    servicios: {},
    infraHealth: { ok: true },
    qaEnv: { emulator: true },
    qaRemote: { active: true },
    telegramHealth: { ok: true },
});

test('renderOps produce un grafo jerárquico con conectores (CA-5)', () => {
    const html = ops.renderOps(baseState(), {});
    assert.ok(html.includes('ops-topo'), 'tiene el contenedor de topología');
    assert.ok(html.includes('ops-topo-root'), 'tiene capa raíz (pulpo)');
    assert.ok(html.includes('ops-topo-services'), 'tiene capa de servicios');
    assert.ok(html.includes('ops-topo-bus'), 'tiene conectores');
    assert.ok(html.includes('data-node="pulpo"'), 'nodo pulpo presente');
});

test('nodo caído usa dual-encoding (borde + ícono ic-health-dead + texto), no solo color', () => {
    const html = ops.nodeCardSsr('svc-drive', { pid: null, alive: false }, {});
    assert.ok(html.includes('is-dead'), 'clase is-dead (borde rojo)');
    assert.ok(html.includes('ic-health-dead'), 'ícono de caído');
    assert.ok(/caído/i.test(html), 'label textual de caído');
    assert.ok(html.includes('data-deadlabel'), 'placeholder para "caído hace N m" client-side');
});

test('nodo vivo muestra PID + uptime ("desde cuándo" sano, CA-1)', () => {
    const html = ops.nodeCardSsr('pulpo', { pid: '9512', alive: true, uptime: 190000000 }, {});
    assert.ok(html.includes('is-alive'));
    assert.ok(html.includes('PID 9512'));
    assert.ok(/\dd \d+h|\dh \d+m/.test(html), 'muestra uptime formateado');
    assert.ok(html.includes('ops-node-dot alive'), 'punto verde');
});

test('el panel de detalle, confirm-modal y la acción restart están presentes', () => {
    const html = ops.renderOps(baseState(), {});
    assert.ok(html.includes('ops-detail'), 'panel de detalle');
    assert.ok(html.includes('inConfirm'), 'confirm-modal embebido (CA-3)');
    assert.ok(html.includes("action:'restart'"), 'POST restart en el cliente');
    assert.ok(html.includes('/logs/stream/'), 'log inline SSE (CA-2)');
    assert.ok(html.includes('ops-recon-spark'), 'sparkline del reconciler (CA-4)');
});

test('el último error y motivos runtime pasan por sanitizeRuntime (REQ-SEC-H7-1/6)', () => {
    const state = baseState();
    state.telegramHealth = { ok: false, lastError: { description: 'fallo token=AKIAIOSFODNN7EXAMPLE', code: 'X', source: 'api' }, updatedAt: '2026-06-20' };
    const html = ops.renderOps(state, {});
    assert.ok(!html.includes('AKIAIOSFODNN7EXAMPLE'), 'el secret del banner queda redactado');
});

test('render inerte visible si el state es inválido (REQ-SEC-7)', () => {
    const html = ops.renderOps(null, {});
    assert.ok(html.includes('Ventana Ops no disponible'));
    assert.ok(html.length > 100, 'no es string vacío');
});

test('QA environment se renderiza como pills con dual-encoding', () => {
    const html = ops.renderQaPillsSsr({ qaEnv: { emulator: true }, qaRemote: { active: true }, infraHealth: { ok: false }, telegramHealth: { ok: true } });
    assert.ok(html.includes('ops-qa-pill'));
    assert.ok(html.includes('data-health="bad"'), 'infra caída en rojo');
    assert.ok(html.includes('ic-health-dead') || html.includes('ic-ok'), 'íconos de estado, no solo color');
});
