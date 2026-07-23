'use strict';

// Tests del módulo de la "ola en una sola línea" (EP8-H3 · #3956).
// Cubren los requisitos de seguridad bloqueantes (CA-8 escaping, CA-9 links
// seguros, CA-10 sin datos sensibles) y la lógica de las dos etapas terminales
// (CA-5 No ingresados, CA-6 Finalizados) con sus degradaciones.

const { test } = require('node:test');
const assert = require('node:assert');

const lib = require('../lib/pipeline-lane-line');

const GH = (n) => `https://github.com/intrale/platform/issues/${n}`;

// ── CA-9 · safeGithubHref ────────────────────────────────────────────────────

test('safeGithubHref acepta URLs https de github.com', () => {
    assert.equal(
        lib.safeGithubHref('https://github.com/intrale/platform/pull/4028'),
        'https://github.com/intrale/platform/pull/4028',
    );
    assert.equal(
        lib.safeGithubHref('https://github.com/intrale/platform/issues/3958'),
        'https://github.com/intrale/platform/issues/3958',
    );
});

test('safeGithubHref rechaza esquemas peligrosos y hosts ajenos', () => {
    assert.equal(lib.safeGithubHref('javascript:alert(1)'), null);
    assert.equal(lib.safeGithubHref('data:text/html,<script>alert(1)</script>'), null);
    assert.equal(lib.safeGithubHref('http://github.com/x'), null, 'http plano rechazado');
    assert.equal(lib.safeGithubHref('https://evil.com/github.com'), null);
    assert.equal(lib.safeGithubHref('https://github.com.attacker.io/x'), null);
    assert.equal(lib.safeGithubHref(''), null);
    assert.equal(lib.safeGithubHref(null), null);
    assert.equal(lib.safeGithubHref('no-soy-una-url'), null);
});

// ── CA-8 · escaping ──────────────────────────────────────────────────────────

test('escForHtml escapa < > & comillas (cuerpo y atributo)', () => {
    assert.equal(
        lib.escForHtml('<script>alert("x")</script>'),
        '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    assert.equal(lib.escForHtml("it's a 'test'"), 'it&#39;s a &#39;test&#39;');
    assert.equal(lib.escForHtml(null), '');
});

test('escapePopupValue neutraliza el XSS de motivo de rebote', () => {
    const motivo = `<img src=x onerror="alert(1)">comilla'`;
    const out = lib.escapePopupValue(motivo);
    assert.ok(!out.includes('<img'), 'no debe quedar markup vivo');
    assert.ok(out.includes('&lt;img'), 'debe quedar escapado');
    assert.ok(!out.includes("'"), 'comilla simple escapada');
});

// ── CA-6 · finalizadoMeta ────────────────────────────────────────────────────

test('finalizadoMeta devuelve fecha + link con PR mergeado válido', () => {
    const meta = lib.finalizadoMeta({
        mergedAt: '2026-06-11T13:00:00Z',
        url: 'https://github.com/intrale/platform/pull/4028',
        state: 'MERGED',
    });
    assert.ok(meta.hasLink, 'debe tener link');
    assert.equal(meta.href, 'https://github.com/intrale/platform/pull/4028');
    assert.ok(meta.dateLabel && /2026/.test(meta.dateLabel), 'fecha formateada');
});

test('finalizadoMeta degrada a sin-link si el fetch falló', () => {
    const meta = lib.finalizadoMeta({ error: true, reason: 'non_zero_exit' });
    assert.equal(meta.hasLink, false);
    assert.equal(meta.href, null);
});

test('finalizadoMeta degrada a sin-link con URL no-github', () => {
    const meta = lib.finalizadoMeta({
        mergedAt: '2026-06-11T13:00:00Z',
        url: 'https://evil.com/pull/1',
    });
    assert.equal(meta.hasLink, false);
    assert.equal(meta.href, null);
    // pero la fecha sí se conserva (degradación parcial)
    assert.ok(meta.dateLabel);
});

test('finalizadoMeta tolera prInfo null', () => {
    const meta = lib.finalizadoMeta(null);
    assert.deepEqual(meta, { dateLabel: null, href: null, hasLink: false });
});

// ── CA-5 · buildNotEnteredCards ──────────────────────────────────────────────

test('buildNotEnteredCards lista issues de la ola sin work-file ni cerrar', () => {
    const out = lib.buildNotEnteredCards({
        waveIssues: [100, 101, 102, 103],
        matrix: { '101': { faseActual: 'definicion/analisis' } }, // ya en flujo
        blockedBy: { '100': [3958] },
        titles: {
            '100': { title: 'Issue bloqueado', state: 'OPEN' },
            '102': { title: 'Issue en cola', state: 'OPEN' },
            '103': { title: 'Issue cerrado', state: 'CLOSED' }, // finalizado → excluido
        },
        ghIssueUrl: GH,
    });
    // 101 está en matrix (excluido), 103 cerrado (excluido) → quedan 100 y 102.
    assert.equal(out.count, 2);
    const issues = out.cards.map((c) => c.issue);
    assert.deepEqual(issues, ['100', '102']);
});

test('buildNotEnteredCards muestra link al bloqueante con esquema github (CA-5/CA-9)', () => {
    const out = lib.buildNotEnteredCards({
        waveIssues: [100],
        matrix: {},
        blockedBy: { '100': [3958] },
        titles: { '100': { title: 'Bloqueado', state: 'OPEN' } },
        ghIssueUrl: GH,
    });
    const html = out.cards[0].html;
    assert.ok(html.includes('Bloqueado por'), 'motivo deps');
    assert.ok(
        html.includes('href="https://github.com/intrale/platform/issues/3958"'),
        'link al bloqueante validado',
    );
    assert.ok(html.includes('rel="noopener noreferrer"'), 'link seguro');
});

test('buildNotEnteredCards degrada a "esperando slot" sin deps (CA-5)', () => {
    const out = lib.buildNotEnteredCards({
        waveIssues: [200],
        matrix: {},
        blockedBy: {},
        titles: { '200': { title: 'Sin deps', state: 'OPEN' } },
        ghIssueUrl: GH,
    });
    const html = out.cards[0].html;
    assert.ok(html.includes('Esperando slot'), 'degradación a slot');
    assert.ok(html.includes('pos. 1'), 'posición en cola');
});

test('buildNotEnteredCards escapa títulos maliciosos (CA-8)', () => {
    const out = lib.buildNotEnteredCards({
        waveIssues: [300],
        matrix: {},
        blockedBy: {},
        titles: { '300': { title: '<script>alert(1)</script>', state: 'OPEN' } },
        ghIssueUrl: GH,
    });
    const html = out.cards[0].html;
    assert.ok(!html.includes('<script>alert(1)</script>'), 'sin markup vivo');
    assert.ok(html.includes('&lt;script&gt;'), 'título escapado');
});

test('buildNotEnteredCards no expone datos sensibles más allá de issue/título/motivo/links (CA-10)', () => {
    const out = lib.buildNotEnteredCards({
        waveIssues: [400],
        matrix: {},
        blockedBy: {},
        titles: {
            '400': {
                title: 'Issue',
                state: 'OPEN',
                // campos sensibles simulados que NO deben filtrarse al HTML
                token: 'ghp_SECRETTOKEN',
                path: 'C:/Users/Administrator/.claude/secrets/credentials.json',
            },
        },
        ghIssueUrl: GH,
    });
    const html = out.cards[0].html;
    assert.ok(!html.includes('ghp_SECRETTOKEN'), 'no filtra token');
    assert.ok(!html.includes('credentials.json'), 'no filtra paths sensibles');
});

test('buildNotEnteredCards tolera ola vacía / entradas inválidas', () => {
    assert.equal(lib.buildNotEnteredCards({ waveIssues: [], matrix: {}, blockedBy: {}, titles: {}, ghIssueUrl: GH }).count, 0);
    const out = lib.buildNotEnteredCards({
        waveIssues: [0, -1, 'abc', null, 500],
        matrix: {},
        blockedBy: {},
        titles: { '500': { title: 'ok', state: 'OPEN' } },
        ghIssueUrl: GH,
    });
    assert.equal(out.count, 1);
});
