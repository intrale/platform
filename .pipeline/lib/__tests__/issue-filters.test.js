'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseFilters, serializeFilters, hasActiveFilters } = require('../issue-filters');

const ALLOW = {
    estados: ['pendiente', 'trabajando', 'listo'],
    fases: ['dev', 'build', 'verificacion'],
    skills: ['pipeline-dev', 'qa', 'backend-dev'],
};

test('SEC-1: filtro de enum válido se conserva', () => {
    const f = parseFilters('estado=trabajando&fase=dev&skill=qa', ALLOW);
    assert.strictEqual(f.estado, 'trabajando');
    assert.strictEqual(f.fase, 'dev');
    assert.strictEqual(f.skill, 'qa');
});

test('SEC-1: filtro fuera del allowlist se descarta (no se refleja)', () => {
    const f = parseFilters('estado=<script>alert(1)</script>&skill=hacker', ALLOW);
    assert.strictEqual(f.estado, '');
    assert.strictEqual(f.skill, '');
});

test('SEC-1: q malicioso no rompe el parse y se devuelve como texto recortado', () => {
    const payload = '"><img src=x onerror=alert(1)>';
    const f = parseFilters('q=' + encodeURIComponent(payload), ALLOW);
    // El valor se devuelve crudo (el escape lo hace el consumidor antes del DOM),
    // pero el parse no debe lanzar ni reflejar enums.
    assert.strictEqual(f.q, payload);
    assert.strictEqual(f.estado, '');
});

test('q se recorta a la longitud máxima', () => {
    const long = 'a'.repeat(500);
    const f = parseFilters('q=' + long, ALLOW);
    assert.strictEqual(f.q.length, 120);
});

test('acepta URLSearchParams además de string', () => {
    const sp = new URLSearchParams('estado=listo');
    const f = parseFilters(sp, ALLOW);
    assert.strictEqual(f.estado, 'listo');
});

test('acepta objeto plano', () => {
    const f = parseFilters({ estado: 'pendiente', fase: 'inventada' }, ALLOW);
    assert.strictEqual(f.estado, 'pendiente');
    assert.strictEqual(f.fase, '');
});

test('serializeFilters emite sólo claves con valor, orden estable', () => {
    const qs = serializeFilters({ skill: 'qa', estado: 'trabajando', q: 'foo' });
    assert.strictEqual(qs, 'estado=trabajando&skill=qa&q=foo');
});

test('serializeFilters omite vacíos', () => {
    assert.strictEqual(serializeFilters({ estado: '', fase: '', skill: '', q: '' }), '');
});

test('round-trip serialize → parse es estable', () => {
    const original = { estado: 'trabajando', fase: 'dev', skill: 'qa', q: 'algo' };
    const qs = serializeFilters(original);
    const back = parseFilters(qs, ALLOW);
    assert.deepStrictEqual(back, original);
});

test('round-trip con valor inválido: serialize lo emite pero parse lo descarta', () => {
    // Un atacante que arme la URL a mano: el enum inválido no sobrevive el parse.
    const qs = 'estado=trabajando&skill=evil';
    const back = parseFilters(qs, ALLOW);
    assert.strictEqual(back.estado, 'trabajando');
    assert.strictEqual(back.skill, '');
});

test('serializeFilters escapa caracteres especiales en q', () => {
    const qs = serializeFilters({ q: 'a&b=c' });
    assert.ok(qs.startsWith('q='));
    assert.ok(!qs.includes('&b='), 'el & del valor debe ir percent-encoded');
});

test('hasActiveFilters detecta correctamente', () => {
    assert.strictEqual(hasActiveFilters({ estado: '', fase: '', skill: '', q: '' }), false);
    assert.strictEqual(hasActiveFilters({ estado: 'trabajando' }), true);
    assert.strictEqual(hasActiveFilters({ q: 'x' }), true);
});
