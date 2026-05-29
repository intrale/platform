// Tests del renderer del widget de Audit trail · Allowlist mutations (#3625 CA-5).
// Cubre los 4 estados visuales (A/B/C/D) + empty state + XSS escape +
// truncamiento + marker [REDACTED].
//
// Spec: .pipeline/assets/mockups/narrativa-allowlist-audit-trail.md

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const renderer = require('../audit-trail-renderer');

test('renderRows con array vacío devuelve fila empty con copy explicativo', () => {
    const html = renderer.renderRows([]);
    assert.match(html, /class="ppa-empty"/);
    assert.match(html, /Sin mutaciones registradas todavía/);
    assert.match(html, /colspan="6"/);
});

test('renderRows con null o undefined devuelve empty (defensivo)', () => {
    assert.match(renderer.renderRows(null), /ppa-empty/);
    assert.match(renderer.renderRows(undefined), /ppa-empty/);
    assert.match(renderer.renderRows('no es array'), /ppa-empty/);
});

test('Estado A (humano) — clase ppa-row-A + pill humano + chip verde architect-approved', () => {
    const entry = {
        timestamp: '2026-05-29T15:30:00Z',
        source: 'commander:leo',
        action: 'write',
        authorized_by: 'commander:leo',
        justification: 'Autoriza issue de marketing',
        diff: { added: [3140], removed: [] },
        visual: 'human',
        backfill: false,
    };
    const html = renderer.renderRows([entry]);
    assert.match(html, /class="ppa-row-A"/);
    assert.match(html, /data-visual="human"/);
    assert.match(html, /ppa-pill-human/);
    assert.match(html, /ppa-pill-success/);
    assert.match(html, /ic-architect-approved/);
    assert.match(html, /commander:leo/);
    assert.match(html, /\+ \[#3140\]/);
});

test('Estado B (subsistema) — clase ppa-row-B + pill máquina + chip azul shield-lock', () => {
    const entry = {
        timestamp: '2026-05-29T15:35:00Z',
        source: 'planner-split:auto',
        action: 'write',
        authorized_by: 'planner-split:auto',
        justification: 'Auto-promote hijo #3641 del split de #3625',
        diff: { added: [3641], removed: [] },
        visual: 'subsystem',
        backfill: false,
    };
    const html = renderer.renderRows([entry]);
    assert.match(html, /class="ppa-row-B"/);
    assert.match(html, /data-visual="subsystem"/);
    assert.match(html, /ppa-pill-machine/);
    assert.match(html, /ppa-pill-info/);
    assert.match(html, /ic-estado-partial-pause/);
    assert.match(html, /planner-split:auto/);
});

test('Estado C (rejected) — clase ppa-row-C + microcopy REJECTED + diff "propuesto, no aplicado"', () => {
    const entry = {
        timestamp: '2026-05-29T15:40:00Z',
        source: 'unknown:script',
        action: 'reject',
        authorized_by: null,
        justification: 'removal sin autoria',
        diff: { added: [], removed: [3559, 3605] },
        visual: 'rejected',
        backfill: false,
    };
    const html = renderer.renderRows([entry]);
    assert.match(html, /class="ppa-row-C"/);
    assert.match(html, /data-visual="rejected"/);
    assert.match(html, /ppa-pill-danger/);
    assert.match(html, /ic-architect-rejected/);
    assert.match(html, /null · gate REJECTED/);
    assert.match(html, /REJECTED por gate · CA-2 enum cerrado/);
    assert.match(html, /propuesto, no aplicado/);
    assert.match(html, /ppa-diff-rem-rejected/);
    assert.match(html, /- \[#3559, #3605\]/);
});

test('Estado D (unauthorized + backfill) — microcopy "Backfill preexistente" + tag BACKFILL', () => {
    const entry = {
        timestamp: '2026-05-29T09:39:00Z',
        source: 'unknown',
        action: 'backfill',
        authorized_by: null,
        justification: 'Recuperación incidente 09:39 BA (#3625)',
        diff: { added: [3617], removed: [] },
        visual: 'unauthorized',
        backfill: true,
    };
    const html = renderer.renderRows([entry]);
    assert.match(html, /class="ppa-row-D"/);
    assert.match(html, /data-visual="unauthorized"/);
    assert.match(html, /ppa-pill-warning/);
    assert.match(html, /ic-health-warn/);
    assert.match(html, /null · BACKFILL/);
    assert.match(html, /Backfill · entry preexistente al gate/);
});

test('Estado D (unauthorized SIN backfill) — microcopy "Bypass detectado · revisar urgente"', () => {
    const entry = {
        timestamp: '2026-05-29T15:45:00Z',
        source: 'unknown:script',
        action: 'write',
        authorized_by: null,
        justification: 'pid 1234 escribió sin auth',
        diff: { added: [3700], removed: [] },
        visual: 'unauthorized',
        backfill: false,
    };
    const html = renderer.renderRows([entry]);
    assert.match(html, /class="ppa-row-D"/);
    assert.match(html, /Bypass detectado · revisar urgente/);
    // No menciona "preexistente al gate" (caso backfill)
    assert.doesNotMatch(html, /preexistente al gate/);
    // Tag muestra solo "null" (sin sufijo BACKFILL)
    assert.match(html, /<span>null<\/span>/);
});

test('XSS escape — source con <script> queda escapado en HTML', () => {
    const entry = {
        timestamp: '2026-05-29T15:50:00Z',
        source: '<script>alert(1)</script>',
        action: 'write',
        authorized_by: 'commander:leo',
        justification: 'inocuo',
        diff: { added: [1], removed: [] },
        visual: 'human',
    };
    const html = renderer.renderRows([entry]);
    // No debe aparecer la etiqueta cruda en el HTML final
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    // Sí debe aparecer escapada
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('XSS escape — authorized_by con comillas dobles queda escapado', () => {
    const entry = {
        timestamp: '2026-05-29T15:55:00Z',
        source: 'commander:leo',
        action: 'write',
        authorized_by: 'leo" onclick="evil()',
        justification: 'inocuo',
        diff: { added: [1], removed: [] },
        visual: 'human',
    };
    const html = renderer.renderRows([entry]);
    assert.doesNotMatch(html, /onclick="evil/);
    assert.match(html, /&quot;/);
});

test('Truncamiento — justification_truncated agrega marker " …"', () => {
    const entry = {
        timestamp: '2026-05-29T16:00:00Z',
        source: 'commander:leo',
        action: 'write',
        authorized_by: 'commander:leo',
        justification: 'una justificación muy larga que se cortó a 80 chars (esto está truncado)',
        justification_truncated: true,
        diff: { added: [1], removed: [] },
        visual: 'human',
    };
    const html = renderer.renderRows([entry]);
    // El marker " …" debe estar presente
    assert.match(html, / …/);
});

test('Redacción — justification_redacted aplica clase ppa-just-redacted', () => {
    const entry = {
        timestamp: '2026-05-29T16:05:00Z',
        source: 'commander:leo',
        action: 'write',
        authorized_by: 'commander:leo',
        justification: '[REDACTED] secret eliminado',
        justification_redacted: true,
        diff: { added: [1], removed: [] },
        visual: 'human',
    };
    const html = renderer.renderRows([entry]);
    assert.match(html, /class="ppa-just ppa-just-redacted"/);
    assert.match(html, /\[REDACTED\]/);
});

test('Sin justification — render dash, no string vacío', () => {
    const entry = {
        timestamp: '2026-05-29T16:10:00Z',
        source: 'commander:leo',
        action: 'write',
        authorized_by: 'commander:leo',
        justification: '',
        diff: { added: [1], removed: [] },
        visual: 'human',
    };
    const html = renderer.renderRows([entry]);
    assert.match(html, /<span class="ppa-diff-rem">—<\/span>/);
});

test('Diff vacío (sin adds ni removes) — render dash', () => {
    const entry = {
        timestamp: '2026-05-29T16:15:00Z',
        source: 'commander:leo',
        action: 'write',
        authorized_by: 'commander:leo',
        justification: 'inocuo',
        diff: { added: [], removed: [] },
        visual: 'human',
    };
    const html = renderer.renderRows([entry]);
    // Al menos una celda de diff debe mostrar el dash
    assert.match(html, /ppa-diff-rem">—/);
});

test('Multiples entries — output concatenado, una <tr> por entry', () => {
    const entries = [
        { timestamp: '2026-05-29T15:30:00Z', source: 'commander:leo', action: 'write', authorized_by: 'commander:leo', diff: { added: [1], removed: [] }, visual: 'human' },
        { timestamp: '2026-05-29T15:35:00Z', source: 'planner-split:auto', action: 'write', authorized_by: 'planner-split:auto', diff: { added: [2], removed: [] }, visual: 'subsystem' },
        { timestamp: '2026-05-29T15:40:00Z', source: 'unknown:script', action: 'reject', authorized_by: null, diff: { added: [], removed: [3] }, visual: 'rejected' },
    ];
    const html = renderer.renderRows(entries);
    const trCount = (html.match(/<tr /g) || []).length;
    assert.equal(trCount, 3);
    // Las tres clases A/B/C deben aparecer
    assert.match(html, /ppa-row-A/);
    assert.match(html, /ppa-row-B/);
    assert.match(html, /ppa-row-C/);
});

test('Entry sin timestamp válido — render dash en columna Cuándo', () => {
    const entry = {
        timestamp: 'no-es-iso',
        source: 'commander:leo',
        action: 'write',
        authorized_by: 'commander:leo',
        justification: 'inocuo',
        diff: { added: [1], removed: [] },
        visual: 'human',
    };
    const html = renderer.renderRows([entry]);
    assert.match(html, /<span class="ppa-when" title="">/);
    assert.match(html, />—<\/span>/);
});

test('renderIcon expone <use href="#ic-NAME"> con aria-label cuando label dado', () => {
    const html = renderer._renderIcon('test-name', 'descripción');
    assert.match(html, /<use href="#ic-test-name"\/>/);
    assert.match(html, /aria-label="descripción"/);
    assert.match(html, /role="img"/);
});

test('renderIcon sin label usa aria-hidden="true"', () => {
    const html = renderer._renderIcon('test-name');
    assert.match(html, /aria-hidden="true"/);
});

test('escapeHtml cubre los 5 caracteres XSS-relevantes', () => {
    assert.equal(renderer._escapeHtml('& < > " \''), '&amp; &lt; &gt; &quot; &#39;');
});
