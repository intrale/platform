'use strict';

// =============================================================================
// Tests de los componentes SSR compartidos del dashboard V3 — EP8-H0 (#3953).
//
// Cubre:
//   - renderStatusBadge: cada variante (ok/warn/bad/info) emite ÍCONO + TEXTO
//     (CA-4), el href del <use> sale de la allowlist (R4) y una severidad
//     desconocida cae a 'info' sin reflejar el valor crudo (anti SVG-injection).
//   - renderKpiCard: preserva el id invariante del DOM morphing y el id del
//     valor; escapa datos; aplica clase de severidad.
//   - renderAgentPill: skill + #issue saneado + badge de severidad.
//   - Escape XSS: payloads en label/value quedan neutralizados.
//   - Sincronización con el sprite: ic-ok/ic-warn/ic-bad/ic-info existen.
//
// Ejecutar: node --test .pipeline/tests/dashboard-components.test.js
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    SEVERITY_ICON,
    SEVERITIES,
    normalizeSeverity,
    renderStatusBadge,
    renderKpiCard,
    renderAgentPill,
} = require('../views/dashboard/components.js');

const SPRITE_PATH = path.resolve(__dirname, '..', 'assets', 'icons', 'sprite.svg');

// ---------------------------------------------------------------------------
// renderStatusBadge — ícono + texto, allowlist
// ---------------------------------------------------------------------------

test('renderStatusBadge emite ícono Y texto en cada variante (CA-4)', () => {
    for (const sev of SEVERITIES) {
        const html = renderStatusBadge({ severity: sev, label: 'Estado ' + sev });
        // Ícono (del sprite, vía allowlist)
        assert.match(html, new RegExp(`<use href="#${SEVERITY_ICON[sev]}"`), `${sev}: debe usar el ícono de la allowlist`);
        // Texto legible (nunca solo color)
        assert.match(html, /<span class="status-txt">Estado /, `${sev}: debe incluir texto`);
        assert.match(html, new RegExp(`status-${sev}`), `${sev}: debe llevar la clase de severidad`);
        assert.match(html, /role="status"/);
    }
});

test('renderStatusBadge cae a "info" ante severidad desconocida y no refleja el valor crudo (R4)', () => {
    const html = renderStatusBadge({ severity: '"><script>alert(1)</script>', label: 'x' });
    assert.match(html, /class="status-badge status-info"/);
    assert.match(html, /<use href="#ic-info"/);
    // El valor crudo de severidad nunca aparece en el HTML.
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /alert\(1\)/);
});

test('renderStatusBadge escapa el label (anti-XSS, R1)', () => {
    const payload = '<img src=x onerror="fetch(\'/api/kill-agent\',{method:\'POST\'})">';
    const html = renderStatusBadge({ severity: 'bad', label: payload });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
});

test('normalizeSeverity respeta la allowlist', () => {
    assert.equal(normalizeSeverity('ok'), 'ok');
    assert.equal(normalizeSeverity('warn'), 'warn');
    assert.equal(normalizeSeverity('bad'), 'bad');
    assert.equal(normalizeSeverity('info'), 'info');
    assert.equal(normalizeSeverity('nope'), 'info');
    assert.equal(normalizeSeverity(undefined), 'info');
});

// ---------------------------------------------------------------------------
// renderKpiCard — preserva ids invariantes del DOM morphing
// ---------------------------------------------------------------------------

test('renderKpiCard preserva el id del contenedor y del valor (DOM morphing)', () => {
    const html = renderKpiCard({
        id: 'kpi-prs', valueId: 'kpi-prs-value', icon: '✅',
        label: 'PRs · 7d', sub: 'mergeados', title: 'tooltip',
    });
    assert.match(html, /<div class="kpi-card" id="kpi-prs"/);
    assert.match(html, /<span class="kpi-value" id="kpi-prs-value">…<\/span>/);
    assert.match(html, /<span class="kpi-label">PRs · 7d<\/span>/);
    assert.match(html, /<span class="kpi-sub">mergeados<\/span>/);
    assert.match(html, /title="tooltip"/);
});

test('renderKpiCard aplica clase de severidad ok/warn/bad (info se ignora)', () => {
    assert.match(renderKpiCard({ id: 'k', label: 'l', severity: 'warn' }), /class="kpi-card kpi-warn"/);
    assert.match(renderKpiCard({ id: 'k', label: 'l', severity: 'bad' }), /class="kpi-card kpi-bad"/);
    assert.match(renderKpiCard({ id: 'k', label: 'l', severity: 'ok' }), /class="kpi-card kpi-ok"/);
    // info no agrega clase (estado neutro, igual que hoy)
    assert.match(renderKpiCard({ id: 'k', label: 'l', severity: 'info' }), /class="kpi-card"/);
});

test('renderKpiCard escapa value/label/sub (anti-XSS)', () => {
    const html = renderKpiCard({ id: 'k', label: '<b>L</b>', value: '<i>V</i>', sub: '<u>S</u>' });
    assert.doesNotMatch(html, /<b>|<i>|<u>/);
    assert.match(html, /&lt;b&gt;L&lt;\/b&gt;/);
});

test('renderKpiCard usa "…" como valor por defecto', () => {
    const html = renderKpiCard({ id: 'k', valueId: 'k-value', label: 'l' });
    assert.match(html, /<span class="kpi-value" id="k-value">…<\/span>/);
});

// ---------------------------------------------------------------------------
// renderAgentPill — skill + issue saneado + severidad
// ---------------------------------------------------------------------------

test('renderAgentPill muestra skill y #issue saneado', () => {
    const html = renderAgentPill({ skill: 'pipeline-dev', issue: 1732, severity: 'ok', label: 'activo' });
    assert.match(html, /<span class="agent-pill"/);
    assert.match(html, /agent-pill-skill agent-pill-skill-pipelinedev/);
    assert.match(html, />pipeline-dev<\/span>/);
    assert.match(html, /<span class="agent-pill-issue">#1732<\/span>/);
    // severidad con label → badge ícono + texto
    assert.match(html, /<use href="#ic-ok"/);
    assert.match(html, /status-txt">activo/);
});

test('renderAgentPill ignora issue no entero (>0) y no refleja basura', () => {
    const html = renderAgentPill({ skill: 'guru', issue: '5; rm -rf' });
    assert.doesNotMatch(html, /agent-pill-issue/);
    assert.doesNotMatch(html, /rm -rf/);
});

test('renderAgentPill escapa el skill (anti-XSS)', () => {
    const html = renderAgentPill({ skill: '<img src=x onerror=1>' });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
});

test('renderAgentPill sin label muestra punto de severidad con aria-label', () => {
    const html = renderAgentPill({ skill: 'qa', severity: 'warn' });
    assert.match(html, /aria-label="severidad warn"/);
    assert.match(html, /<use href="#ic-warn"/);
});

// ---------------------------------------------------------------------------
// Sincronización con sprite.svg (CA-4.1 — los íconos de severidad existen)
// ---------------------------------------------------------------------------

test('cada ícono de SEVERITY_ICON existe como <symbol> en sprite.svg (CA-4.1)', () => {
    const sprite = fs.readFileSync(SPRITE_PATH, 'utf8');
    for (const sev of SEVERITIES) {
        const id = SEVERITY_ICON[sev];
        assert.match(sprite, new RegExp(`<symbol[^>]*\\bid="${id}"`), `Falta <symbol id="${id}"> en sprite.svg`);
    }
});

test('el HTML de los componentes no contiene <script>, onclick ni javascript:', () => {
    const samples = [
        renderStatusBadge({ severity: 'ok', label: 'ok' }),
        renderKpiCard({ id: 'k', label: 'l' }),
        renderAgentPill({ skill: 's', issue: 1, severity: 'info', label: 'x' }),
    ];
    for (const html of samples) {
        assert.doesNotMatch(html, /<script\b/i);
        assert.doesNotMatch(html, /\bonclick=/i);
        assert.doesNotMatch(html, /\bjavascript:/i);
    }
});
