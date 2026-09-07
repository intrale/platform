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
    gateMeta,
    renderEvidence,
    renderSuggestion,
    renderRowSsr,
    renderEmptyStateSsr,
    renderBandaSsr,
    ORIGENES,
    GATE_KEYS,
    VERDICT_KEYS,
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
    // #6208 · UX §7 — un marker NO se firma desde la bandeja: sin botones de
    // firma, con el link para mirarlo en GitHub. Mejor no ofrecer el botón que
    // ofrecerlo y que el sistema lo rechace (H-UX-6199-3).
    assert.ok(!html.includes('ef-btn-decide'), 'un marker no ofrece botones de firma');
    assert.ok(html.includes('Abrir #1732 en GitHub'));
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

// ===========================================================================
// #6208 — La bandeja muestra los pendientes REALES del depósito del kernel.
// ===========================================================================

const inboxLib = require('../../../lib/gate-signature-inbox.js');

const T0 = Date.parse('2026-08-24T12:00:00.000Z');

function firmaRow(over = {}) {
    const base = {
        gate: 'definicion',
        issue: 6208,
        title: 'GATE 1 · Definición de #6208 — Bandeja de firma del dashboard',
        question: '¿Admitís #6208 a desarrollo con estos criterios de aceptación?',
        anchor: { kind: 'body-hash', value: 'sha256:1111111111111111111111111111111111111111111111111111111111111111' },
        options: [
            { value: 'signed', label: 'Admitir a desarrollo' },
            { value: 're-definition', label: 'Devolver a definición' },
            { value: 'rejected', label: 'Rechazar la definición' },
        ],
        evidence: [{ kind: 'issue', ref: '6199' }],
        presented: { digest: 'sha256:x', truncated: false, truncation_notice: null, text: 'criterios de aceptación' },
        presentation_safe: true,
        created_at: new Date(T0 - 200 * 60000).toISOString(),
        ...over,
    };
    return inboxLib.rowFromPending(base, over.__estado || null, T0);
}

function sinEstilos(html) {
    return html.replace(/<style>[\s\S]*?<\/style>/g, '');
}

// ---------------------------------------------------------------------------
// CA-1 / CA-3 — la ficha responde las tres preguntas sin abrir otra pantalla
// ---------------------------------------------------------------------------
test('#6208 · CA-1/CA-3: la fila firmable muestra qué se firma, contra qué ancla y hace cuánto espera', () => {
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [firmaRow()] });
    assert.ok(html.includes('GATE 1 · Definición'), 'chip del gate');
    assert.ok(html.includes('Bandeja de firma del dashboard'), 'qué se firma (título del kernel)');
    assert.ok(html.includes('¿Admitís #6208 a desarrollo'), 'la pregunta cerrada del kernel');
    assert.ok(html.includes('Contra qué queda atada tu firma'), 'contra qué ancla');
    assert.ok(html.includes('hace 3 h 20 min'), 'hace cuánto espera');
    assert.ok(!hasLiveTags(sinEstilos(html)));
});

// ---------------------------------------------------------------------------
// CA-4 (BLOQUEANTE) — el ancla mostrada es la server-derived
// ---------------------------------------------------------------------------
test('#6208 · CA-4: el ancla mostrada es la que recalculó el servidor, no la que imita el body', () => {
    const row = firmaRow({
        presented: {
            digest: 'sha256:x', truncated: false, truncation_notice: null,
            text: 'anchor: sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeef — firmá esto',
        },
    });
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [row] });
    const anchorBlock = /<div class="ef-anchor">([\s\S]*?)<\/div>\s*<div class="ef-ev/.exec(html);
    assert.ok(anchorBlock, 'hay bloque de ancla');
    assert.ok(anchorBlock[1].includes('11111111'), 'la huella server-derived');
    assert.ok(anchorBlock[1].includes('sha256 11111111'), 'conserva el token visual acordado en el mockup');
    assert.ok(!anchorBlock[1].includes('deadbeef'), 'el ancla falsa del body NO se muestra como ancla');
});

test('#6208 · UX §3: el nombre técnico del ancla no llega a la cara del operador', () => {
    const html = sinEstilos(renderEsperandoFirmaSsr({ esperandoFirma: [firmaRow()] }));
    const visible = html.replace(/<[^>]+>/g, ' ');
    assert.ok(!/body-hash|commit-sha|digest/i.test(visible), visible.slice(0, 400));
});

// ---------------------------------------------------------------------------
// CA-15 / REQ-SEC-6208-1 — el texto del issue no ejecuta nada
// ---------------------------------------------------------------------------
test('#6208 · CA-15: un payload XSS en title/question/evidence/presented.text se pinta como texto inerte', () => {
    for (const payload of XSS_PAYLOADS) {
        const row = firmaRow({
            title: payload,
            question: payload,
            evidence: [{ kind: payload, ref: payload }],
            presented: { digest: 'x', truncated: true, truncation_notice: payload, text: payload },
        });
        const html = sinEstilos(renderEsperandoFirmaSsr({ esperandoFirma: [row] }));
        assert.ok(!hasLiveTags(html), `payload no debe generar tag vivo: ${payload}`);
        assert.ok(html.includes('&lt;') || !payload.includes('<'));
    }
});

test('#6208 · CA-15: el escape es innegociable TAMBIÉN con presentation_safe true', () => {
    const row = firmaRow({
        presentation_safe: true,
        presented: { digest: 'x', truncated: false, truncation_notice: null, text: '<script>alert(1)</script>' },
    });
    const html = sinEstilos(renderEsperandoFirmaSsr({ esperandoFirma: [row] }));
    assert.ok(!hasLiveTags(html), 'el escape no se saltea por venir marcado como seguro');
});

test('#6208 · REQ-SEC-6208-1: presentation_safe:false muestra el banner y la vista NO re-ejecuta el detector', () => {
    const row = firmaRow({ presentation_safe: false, presentation_alert: 'Firma retenida' });
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [row] });
    assert.ok(html.includes('Ojo: este texto viene del issue y trae marcas raras'));
    // La vista no importa el detector: la señal la trae el pedido.
    const src = require('node:fs').readFileSync(require.resolve('..' + path.sep + 'esperando-firma.js'), 'utf8');
    assert.ok(!src.includes('sanitizeForPresentation'), 'la vista NO invoca el detector');
    assert.ok(!src.includes('detectInjection'));
});

test('#6208 · un pendiente marcado como seguro NO muestra el banner', () => {
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [firmaRow()] });
    assert.ok(!html.includes('Ojo: este texto viene del issue'));
});

// ---------------------------------------------------------------------------
// CA-15 / REQ-SEC-6208-4 — cero interpolación en JS
// ---------------------------------------------------------------------------
test('#6208 · REQ-SEC-6208-4: un gate/verdict hostil no puede inyectarse en el handler del botón', () => {
    const hostil = "');alert(1);//";
    const row = firmaRow({
        gate: 'definicion',
        options: [{ value: hostil, label: 'Malicioso' }, { value: 'signed', label: hostil }],
    });
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [row] });
    // El verdict fuera del enum NO se pinta como botón.
    assert.ok(!html.includes('data-verdict="\');alert(1);//"'));
    assert.ok(!html.includes('alert(1);//"'));
    assert.ok(!/onclick="[^"]*alert\(1\)/.test(html));
    // Y no queda NINGÚN onclick con argumentos interpolados.
    assert.ok(!/onclick="gateSignatureDecide/.test(html));
});

test('#6208 · REQ-SEC-6208-4: no hay onclick de decisión en ninguna fila; se usa data-* + listener delegado', () => {
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [firmaRow()] });
    assert.ok(!/onclick="gateSignatureDecide/.test(html));
    assert.ok(html.includes('data-verdict="signed"'));
    assert.ok(html.includes('data-gate="definicion"'));
    const js = renderEsperandoFirmaClientScript();
    assert.ok(js.includes("addEventListener('click'"), 'listener delegado');
    assert.ok(js.includes('EF_GATES.indexOf(gate) === -1'), 'revalida el gate contra el enum');
    assert.ok(js.includes('EF_VERDICTS.indexOf(verdict) === -1'), 'revalida el verdict contra el enum');
});

// ---------------------------------------------------------------------------
// H-UX-6208-3 — un botón por options[] con su label
// ---------------------------------------------------------------------------
test('#6208 · H-UX-6208-3: un botón por opción, con el label del kernel (GATE 1 tiene TRES)', () => {
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [firmaRow()] });
    assert.equal((html.match(/ef-btn-decide/g) || []).length, 3);
    assert.ok(html.includes('Admitir a desarrollo'));
    assert.ok(html.includes('Devolver a definición'));
    assert.ok(html.includes('Rechazar la definición'));
});

test('#6208 · mockup: edad en píldora ámbar a la derecha y referencias issue/pr con numeral', () => {
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [firmaRow({
        evidence: [{ kind: 'issue', ref: '6199' }, { kind: 'pr', ref: '6301' }, { kind: 'run', ref: '4821' }],
    })] });
    const head = /<div class="ef-row-head">([\s\S]*?)<\/div>\s*<div class="ef-title">/.exec(html);
    assert.ok(head, 'la fila conserva su cabecera');
    const info = /<div class="ef-row-info">([\s\S]*?)<\/div>/.exec(head[1]);
    assert.ok(info && !info[1].includes('ef-age'), 'la edad no queda inline junto al issue');
    assert.match(head[1], /ef-row-actions"><span class="ef-age-pill"[^>]*>esperando hace 3 h 20 min<\/span>/);
    assert.match(html, /issue #6199/);
    assert.match(html, /pr #6301/);
    assert.match(html, /run 4821/);
    assert.match(html, /\.ef-age-pill\{[^}]*background:rgba\(210,153,34,\.14\)[^}]*border:1px solid #9E6A03/);
});

test('#6208 · un verdict fuera del enum congelado no genera botón', () => {
    const row = firmaRow({ options: [{ value: 'firmar-todo', label: 'x' }, { value: 'signed', label: 'Admitir' }] });
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [row] });
    assert.equal((html.match(/ef-btn-decide/g) || []).length, 1);
});

test('#6208 · un gate fuera del enum congelado ⇒ la fila NO se pinta como firmable', () => {
    const row = { ...firmaRow(), gate: 'inventado' };
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [row] });
    assert.ok(!html.includes('ef-btn-decide'));
});

// ---------------------------------------------------------------------------
// CA-2 — la ficha se consume, no se reimplementa
// ---------------------------------------------------------------------------
test('#6208 · CA-2: no existe una segunda implementación de la ficha ni del teclado', () => {
    const fsn = require('node:fs');
    const src = fsn.readFileSync(require.resolve('..' + path.sep + 'esperando-firma.js'), 'utf8');
    // El teclado sale de `options[]` del kernel: la vista no declara labels propios.
    assert.ok(!src.includes("'Admitir a desarrollo'"), 'la vista no reimplementa los labels del kernel');
    assert.ok(!src.includes("'Devolver a definición'"));
    assert.ok(!src.includes("'Rechazar la definición'"));
    // Y la redacción de la antigüedad de la ficha no se duplica acá.
    assert.ok(!src.includes("'hace '"), 'la vista no redacta la antigüedad');
});

test('#6208 · R1: gateSignatureDecide está DEFINIDO una sola vez en todo .pipeline/', () => {
    const fsn = require('node:fs');
    const pathn = require('node:path');
    const root = pathn.resolve(__dirname, '..', '..', '..'); // = .pipeline/
    const defs = [];
    (function walk(dir) {
        let entries = [];
        try { entries = fsn.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
            const full = pathn.join(dir, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            if (!e.name.endsWith('.js')) continue;
            const txt = fsn.readFileSync(full, 'utf8');
            const m = txt.match(/function\s+gateSignatureDecide\s*\(/g);
            if (m) defs.push([full, m.length]);
        }
    })(root);
    const total = defs.reduce((a, [, n]) => a + n, 0);
    assert.equal(total, 1, `gateSignatureDecide definido ${total} veces: ${JSON.stringify(defs)}`);
});

// ---------------------------------------------------------------------------
// UX §5 — los tres vacíos
// ---------------------------------------------------------------------------
test('#6208 · UX §5: el vacío LIMPIO es el único verde y trae el chip de lista completa', () => {
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [], esperandoFirmaInbox: { vacio: inboxLib.VACIOS.limpio, banda: null, degraded: false } });
    assert.ok(html.includes('ef-empty-ok'));
    assert.ok(html.includes('Nada esperando tu firma'));
    assert.ok(html.includes('LISTA LEÍDA COMPLETA'));
});

test('#6208 · UX §5 / H-UX-6208-1: el vacío DEGRADADO no es verde y no dice que esté todo firmado', () => {
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [], esperandoFirmaInbox: { vacio: inboxLib.VACIOS.degradado, banda: null, degraded: true } });
    assert.ok(html.includes('ef-empty-warn'));
    assert.ok(!html.includes('ef-empty-ok'));
    assert.ok(html.includes('No pude leer la lista de firmas pendientes'));
    assert.ok(html.includes('no quiere decir que esté todo firmado'));
});

test('#6208 · UX §5: la banda de ilegibles va ARRIBA y CONVIVE con las filas', () => {
    const html = renderEsperandoFirmaSsr({
        esperandoFirma: [firmaRow()],
        esperandoFirmaInbox: { vacio: null, banda: inboxLib.bandaCorrupta(2, 1), degraded: false },
    });
    assert.ok(html.includes('Hay 2 pedidos que no pude leer'));
    assert.ok(html.includes('esperando-firma-list'), 'las filas siguen ahí');
    assert.ok(html.indexOf('ef-banda') < html.indexOf('esperando-firma-list'), 'la banda va arriba de la lista');
});

test('#6208 · retro-compat: sin metadatos del read model el vacío sigue siendo el limpio', () => {
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [] });
    assert.ok(html.includes('Nada esperando tu firma'));
});

// ---------------------------------------------------------------------------
// CA-10 / D-4 — los estados intermedios, sin nombrar un medio que no existe
// ---------------------------------------------------------------------------
test('#6208 · CA-10: la fila decidida NO se marca resuelta — sigue visible con su estado', () => {
    const row = firmaRow({ __estado: { estado: 'encolado', verdict: 'signed', carrier: null, at: T0 - 30000 } });
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [row] });
    assert.ok(html.includes('Anotada tu decisión — falta confirmarla'));
    assert.ok(html.includes('esperando-firma-row-6208'), 'la fila sigue visible');
    // Botones deshabilitados, NO ocultos (UX §6).
    assert.equal((html.match(/ef-btn-decide/g) || []).length, 3);
    assert.ok(html.includes('disabled'));
    assert.ok(html.includes('ef-btn-chosen'), 'se ve QUÉ elegiste');
    assert.ok(!html.includes('Firmado'), 'nunca "Firmado" antes de que el kernel confirme');
});

test('#6208 · D-4: el estado encolado NO nombra Telegram mientras no haya carrier', () => {
    const row = firmaRow({ __estado: { estado: 'encolado', verdict: 'signed', carrier: null, at: T0 - 30000 } });
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [row] });
    assert.ok(!/telegram/i.test(html), 'grep del literal Telegram en el render del estado encolado: cero');
    const js = renderEsperandoFirmaClientScript();
    assert.ok(!/telegram/i.test(js), 'tampoco en el copy del cliente');
});

test('#6208 · D-4: el estado despachado nombra el medio que devolvió el carrier, no un literal', () => {
    const row = firmaRow({ __estado: { estado: 'despachado', verdict: 'signed', carrier: 'signal', at: T0 - 10000 } });
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [row] });
    assert.ok(html.includes('Te lo mandé a signal'));
});

test('#6208 · H-UX-6208-5: el client script ya no recarga la página a ciegas', () => {
    const js = renderEsperandoFirmaClientScript();
    assert.ok(!js.includes('location.reload()'), 'el resultado se comunica en la fila, no recargando');
    assert.ok(js.includes('efSetEstado'), 'hay actualización en la fila');
    assert.ok(!js.includes("alert('Error firmando"), 'ningún msg crudo del servidor a pantalla');
    assert.ok(js.includes('textContent'), 'el estado se pinta como texto inerte');
    assert.ok(!/\.innerHTML\s*=/.test(js), 'nunca asignación de innerHTML crudo');
});

test('#6208 · el POST lleva el gate (contrato multi-gate, misma ruta)', () => {
    const js = renderEsperandoFirmaClientScript();
    assert.ok(js.includes('gate: gate'));
    assert.ok(js.includes('/api/gate-signature/decide'));
    assert.ok(!js.includes('/api/aprobaciones'), 'no se crean rutas nuevas (H-3 / CA-13)');
});

// ---------------------------------------------------------------------------
// UX §7 — la fila que no se firma desde acá
// ---------------------------------------------------------------------------
test('#6208 · UX §7: origen fuera del enum ⇒ sin botones de firma, con link a GitHub', () => {
    const marker = inboxLib.rowFromMarker({
        issue: 4321, origen: 'gate3', gate: 'GATE 3', phase: 'dev', pipeline: 'desarrollo',
        skill: 'android-dev', evidencia: [], sugerencia: null, age_hours: 2,
    });
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [marker] });
    assert.ok(!html.includes('ef-btn-decide'));
    assert.ok(html.includes('Abrir #4321 en GitHub'));
    assert.ok(html.includes('Esto no se firma desde la bandeja'));
    assert.ok(html.includes('No te pongo un botón de firmar que el sistema va a rechazar'));
    assert.ok(html.includes('GATE 3 · Acción autónoma'));
});

test('#6208 · rebote rev-2: dos gates del mismo issue conservan identidad DOM independiente', () => {
    const definicion = firmaRow({ gate: 'definicion' });
    const aceptacion = firmaRow({
        gate: 'aceptacion',
        options: [
            { value: 'signed', label: 'Aceptar entrega' },
            { value: 'rejected', label: 'Rechazar entrega' },
        ],
    });
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [definicion, aceptacion] });
    assert.equal((html.match(/id="esperando-firma-row-6208-definicion"/g) || []).length, 1);
    assert.equal((html.match(/id="esperando-firma-row-6208-aceptacion"/g) || []).length, 1);
    assert.equal((html.match(/id="esperando-firma-estado-6208-definicion"/g) || []).length, 1);
    assert.equal((html.match(/id="esperando-firma-estado-6208-aceptacion"/g) || []).length, 1);

    const js = renderEsperandoFirmaClientScript();
    assert.ok(js.includes('efRow(issueNum, gate)'));
    assert.ok(js.includes('efDisableRow(issueNum, gate)'));
    assert.ok(js.includes('efEnableRow(issueNum, gate)'));
    assert.ok(js.includes('efSetEstado(issueNum, gate,'));
    assert.ok(js.includes('efMarkChosen(issueNum, gate, verdict)'));
});

test('#6208 · el enum de la vista espeja el del kernel', () => {
    const channel = require('../../../lib/approval-channel.js');
    assert.deepEqual([...GATE_KEYS].sort(), Object.keys(channel.GATES).sort());
    const todos = new Set();
    for (const g of Object.values(channel.GATES)) g.verdicts.forEach(v => todos.add(v));
    assert.deepEqual([...VERDICT_KEYS].sort(), [...todos].sort());
    assert.equal(gateMeta('definicion').label, 'GATE 1 · Definición');
    assert.equal(gateMeta('aceptacion').label, 'GATE 2 · Aceptación');
    assert.equal(gateMeta('../evil'), null);
});

test('#6208 · D-3: la tabla ORIGENES de la vista NO se toca (waiting-operator-def ya decía GATE 1)', () => {
    assert.equal(ORIGENES['waiting-operator-def'].label, 'GATE 1 · Definición');
});

// ---------------------------------------------------------------------------
// #6208 rev2 — el aviso de "índice incompleto" también cuando HAY filas.
//
// `meta.vacio` es null en cuanto hay una fila y `meta.banda` es null cuando no
// hubo corruptos concretos: con esas dos solas, `degraded:true` + una fila se
// renderizaba como una bandeja normal, sin ninguna señal, y `alert` no se
// pintaba en ningún camino. La vista repone la banda desde el copy del read
// model (no lo redacta) para cubrir también a los callers que arman el `meta` a
// mano — el fallback de `dashboard.js` manda `banda: null`.
// ---------------------------------------------------------------------------
const BANDA_DIV = '<div class="ef-banda"';

function markerRowG3(over = {}) {
    return {
        kind: 'marker', issue: 4321, origen: 'gate3', gateLabel: 'GATE 3', firmable: false,
        titulo: 'Esperando decisión del operador', edad: 'hace 2 h', severidad: 'info',
        ...over,
    };
}

test('#6208 rev2 · degraded CON filas y banda:null ⇒ la vista igual pinta el aviso arriba de la lista', () => {
    const html = renderEsperandoFirmaSsr({
        esperandoFirma: [markerRowG3()],
        // Exactamente la forma que arma `dashboard.js` en su camino de fallback.
        esperandoFirmaInbox: {
            degraded: true,
            alert: 'No pude leer el depósito entero: índice incompleto.',
            corruptCount: 0, visibleCount: 1, firmables: 0,
            vacio: null, banda: null,
        },
    });

    // OJO: `ef-banda` a secas tambien aparece en el <style> del panel, asi que
    // la asercion tiene que ir contra el DIV, no contra la clase.
    assert.ok(html.includes(BANDA_DIV), 'con el índice incompleto SIEMPRE hay señal');
    assert.ok(html.includes('esperando-firma-list'), 'las filas siguen ahí');
    assert.ok(html.indexOf(BANDA_DIV) < html.indexOf('esperando-firma-list'), 'la banda va arriba de la lista');
    assert.ok(html.includes('índice incompleto'), 'el alert del kernel se pinta');
    assert.ok(!html.includes('Nada esperando tu firma'), 'jamás el verde de "está todo firmado"');
});

test('#6208 rev2 · lista completa CON filas ⇒ sin banda (el aviso no se vuelve ruido de fondo)', () => {
    const html = renderEsperandoFirmaSsr({
        esperandoFirma: [firmaRow()],
        esperandoFirmaInbox: { degraded: false, alert: null, corruptCount: 0, vacio: null, banda: null },
    });
    assert.ok(!html.includes(BANDA_DIV));
});

test('#6208 rev2 · degraded SIN filas sigue mostrando el vacío ámbar, sin banda duplicada', () => {
    const inboxLib2 = require('../../../lib/gate-signature-inbox.js');
    const html = renderEsperandoFirmaSsr({
        esperandoFirma: [],
        esperandoFirmaInbox: { degraded: true, alert: 'x', corruptCount: 0, vacio: inboxLib2.VACIOS.degradado, banda: null },
    });
    assert.ok(html.includes('No pude leer la lista de firmas pendientes'));
    assert.ok(!html.includes(BANDA_DIV), 'el empty-state ya lo dice: no se repite');
});

test('#6208 rev2 · REQ-SEC-6208-1: un alert hostil del depósito se pinta como texto inerte', () => {
    const html = renderEsperandoFirmaSsr({
        esperandoFirma: [markerRowG3()],
        esperandoFirmaInbox: {
            degraded: true,
            alert: '<img src=x onerror=alert(1)>"><script>fetch("/api/gate-signature/decide")</script>',
            corruptCount: 0, visibleCount: 1, firmables: 0, vacio: null, banda: null,
        },
    });

    const banda = html.slice(html.indexOf(BANDA_DIV), html.indexOf('<div class="ef-list"'));
    assert.ok(banda, 'la banda se renderizo');
    // Ningun TAG se materializa dentro de la banda: el payload queda como texto.
    assert.ok(!banda.includes('<script'), 'ningún script se materializa');
    assert.ok(!banda.includes('<img'), 'ningún tag se materializa');
    assert.ok(!/<[a-z]+[^>]*\son[a-z]+=/i.test(banda), 'ningún handler inline se materializa');
    // Y se ve escapado (las palabras siguen ahi a proposito: es texto inerte).
    assert.ok(banda.includes('&lt;img'), 'se ve como texto escapado');
    assert.ok(banda.includes('&lt;script&gt;'), 'el script se ve como texto escapado');
});
