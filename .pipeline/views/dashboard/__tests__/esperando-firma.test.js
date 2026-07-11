// =============================================================================
// Tests de la vista esperando-firma.js — bandeja "Esperando tu firma" (#4580).
//
// Cubre el contrato del issue:
//   - CA-1: la bandeja lista los pendientes con su artefacto (issue, origen,
//     phase, evidencia, sugerencia).
//   - CA-4 / REQ-SEC-4580-2 (BLOQUEANTE · Stored XSS): un payload `<script>` en
//     la evidencia/sugerencia se pinta como TEXTO INERTE (tag literal ausente).
//   - Empty-state claro cuando no hay pendientes (no error, no panel roto).
//   - Coerción de issue: entradas inválidas descartan la fila.
//   - El client script expone los handlers POST + CSRF (REQ-SEC-4580-1) y NO
//     ofrece disparador GET mutante.
//
// Se ejecuta con: node --test .pipeline/views/dashboard/__tests__/esperando-firma.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const view = require('..' + path.sep + 'esperando-firma.js');
const {
    slug,
    renderEsperandoFirmaSsr,
    renderEsperandoFirmaClientScript,
    safeIssueNumber,
    origenMeta,
    renderEvidence,
    renderSuggestion,
} = view;

const XSS_PAYLOADS = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '"><svg onload=alert(1)>',
    "'><img src=x onerror=alert(1)>",
];

// La propiedad de seguridad: el `<` del payload se neutraliza a `&lt;`, así que
// un tag LITERAL vivo no puede aparecer (la vista no usa esos tags en su markup).
function hasLiveTags(html) {
    return /<script\b/i.test(html) || /<img\b/i.test(html) || /<svg\b/i.test(html);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
test('exporta el contrato canónico', () => {
    assert.equal(slug, 'esperando-firma');
    assert.equal(typeof renderEsperandoFirmaSsr, 'function');
    assert.equal(typeof renderEsperandoFirmaClientScript, 'function');
});

// ---------------------------------------------------------------------------
// Empty-state (CA-1)
// ---------------------------------------------------------------------------
test('render vacío → empty-state claro, no panel roto (CA-1)', () => {
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [] });
    assert.ok(html.includes('esperando-firma-panel'));
    assert.ok(html.includes('esperando-firma-empty'));
    assert.ok(html.includes('Nada esperando tu firma'));
    assert.ok(!hasLiveTags(html));
});

test('render sin state no rompe', () => {
    const html = renderEsperandoFirmaSsr({});
    assert.ok(html.includes('esperando-firma-empty'));
});

// ---------------------------------------------------------------------------
// CA-1 — lista pendientes con su artefacto
// ---------------------------------------------------------------------------
test('lista cada pendiente con issue, origen, evidencia y sugerencia (CA-1)', () => {
    const html = renderEsperandoFirmaSsr({
        esperandoFirma: [
            {
                issue: 1732, origen: 'waiting-operator-def', gate: 'GATE 0',
                phase: 'criterios', pipeline: 'desarrollo', skill: 'po',
                evidencia: [{ agente: 'security', fase: 'verificacion', tipo: 'document', artefacto: 'report.md', sensible: true }],
                sugerencia: { verbo: 'revisar', total: 3, solo_humanos: 1, items: [] },
                waiting_since: '2026-07-10T00:00:00Z', age_hours: 5,
            },
        ],
    });
    // issue + link
    assert.ok(html.includes('#1732'));
    assert.ok(html.includes('issues/1732'));
    // origen (dual-encoding: label textual presente)
    assert.ok(html.includes('GATE 1 · Definición'));
    // evidencia con su artefacto
    assert.ok(html.includes('report.md'));
    assert.ok(html.includes('security'));
    // sugerencia inline (verbo)
    assert.ok(html.includes('SUGIERE REVISAR'));
    // acciones aprobar/rechazar
    assert.ok(html.includes("gateSignatureDecide(1732, 'aprobar')"));
    assert.ok(html.includes("gateSignatureDecide(1732, 'rechazar')"));
    // badge de conteo
    assert.ok(html.includes('esperando-firma-list'));
});

test('los tres orígenes muestran su etiqueta de gate (dual-encoding)', () => {
    assert.equal(origenMeta('waiting-operator-def').label, 'GATE 1 · Definición');
    assert.equal(origenMeta('waiting-operator-acc').label, 'GATE 2 · Aceptación');
    assert.equal(origenMeta('gate3').label, 'GATE 3 · Acción autónoma');
    assert.ok(origenMeta('desconocido').label); // no rompe con origen inesperado
});

// ---------------------------------------------------------------------------
// CA-4 / REQ-SEC-4580-2 — escape de evidencia (Stored XSS)
// ---------------------------------------------------------------------------
test('payload <script> en la evidencia se pinta como texto inerte (REQ-SEC-4580-2)', () => {
    for (const payload of XSS_PAYLOADS) {
        const html = renderEsperandoFirmaSsr({
            esperandoFirma: [
                {
                    issue: 4580, origen: 'waiting-operator-acc',
                    phase: 'aprobacion', pipeline: 'desarrollo', skill: 'architect',
                    evidencia: [{ agente: payload, fase: payload, tipo: payload, artefacto: payload, motivo: payload }],
                    sugerencia: null,
                    waiting_since: '2026-07-10T00:00:00Z', age_hours: 1,
                },
            ],
        });
        assert.ok(!hasLiveTags(html), `payload no debe generar tag vivo: ${payload}`);
        // El texto escapado del script sí aparece (inerte).
        assert.ok(html.includes('&lt;') || !payload.includes('<'), `el < del payload debe neutralizarse: ${payload}`);
    }
});

test('renderEvidence escapa y no emite tags vivos', () => {
    const html = renderEvidence([{ agente: '<script>x</script>', artefacto: '<img src=x onerror=alert(1)>' }]);
    assert.ok(!hasLiveTags(html));
});

test('renderSuggestion sin sugerencia → nota neutra (no score inventado)', () => {
    const html = renderSuggestion(null);
    assert.ok(html.includes('Sin sugerencia disponible'));
    assert.ok(!hasLiveTags(html));
});

// ---------------------------------------------------------------------------
// Coerción de issue
// ---------------------------------------------------------------------------
test('safeIssueNumber coacciona estrictamente', () => {
    assert.equal(safeIssueNumber(1732), 1732);
    assert.equal(safeIssueNumber('1732'), 1732);
    assert.equal(safeIssueNumber(0), null);
    assert.equal(safeIssueNumber(-3), null);
    assert.equal(safeIssueNumber('abc'), null);
    assert.equal(safeIssueNumber(1.5), null);
});

test('fila con issue inválido se descarta del render', () => {
    const html = renderEsperandoFirmaSsr({
        esperandoFirma: [
            { issue: 'abc', origen: 'gate3', phase: 'x', pipeline: 'y', skill: 'z', evidencia: [], sugerencia: null, waiting_since: '', age_hours: 1 },
        ],
    });
    // Todas las filas descartadas → cae al empty-state.
    assert.ok(html.includes('esperando-firma-empty'));
});

// ---------------------------------------------------------------------------
// REQ-SEC-4580-1 — client script POST + CSRF, sin GET mutante
// ---------------------------------------------------------------------------
test('el client script usa POST + X-CSRF-Token y NO ofrece GET mutante (REQ-SEC-4580-1)', () => {
    const js = renderEsperandoFirmaClientScript();
    assert.ok(js.includes('gateSignatureDecide'));
    assert.ok(js.includes('/api/gate-signature/csrf-token'));
    assert.ok(js.includes('/api/gate-signature/decide'));
    assert.ok(js.includes("method: 'POST'"));
    assert.ok(js.includes("'X-CSRF-Token'"));
    // No debe pedir la decisión por GET.
    assert.ok(!/gate-signature\/decide[^']*method:\s*'GET'/.test(js));
});
