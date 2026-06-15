// =============================================================================
// Tests de la ventana Bloqueados extraída a su propio módulo (#3729, padre #3715).
//
// Cubre (contrato del issue + comentario de security + narrativa UX):
//   - Exports canónicos ({ slug, renderBloqueadosSsr, renderBloqueadosClientScript,
//     renderBloqueados }).
//   - Render vacío → empty-state celebratorio (#bloqueados-empty + mini-stats),
//     NO string vacío (decisión UX D5 vs el monolito legacy).
//   - Render con 1 fila normal → datos escapados, IDs estables, severidad correcta.
//   - Matriz XSS canónica 4 × 5 (payloads × superficies de origen externo):
//     tags vivos ausentes, texto escapado presente, atributos title="" no rotos.
//   - Coerción `b.issue`: entradas inválidas descartan la fila; válidas renderizan
//     el número exacto en href/onclick.
//   - recent_events ausente/vacío no rompe; summary_stale → estado loading;
//     reason truncado a 280 chars.
//   - Client script expone handlers needsHuman*/toggleNeedsHumanPanel.
//
// Se ejecuta con: node --test .pipeline/views/dashboard/__tests__/bloqueados.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const bloqueados = require('..' + path.sep + 'bloqueados.js');
const {
    slug,
    renderBloqueadosSsr,
    renderBloqueadosClientScript,
    renderBloqueados,
    safeIssueNumber,
    severityOf,
    prettyReason,
    sortBySeverityAge,
    classifyCta,
    safeBotUsername,
    telegramDeepLink,
} = bloqueados;

// "Ahora" fijo para tests deterministas del tiempo relativo de eventos.
const NOW = Date.parse('2026-06-09T12:00:00Z');
const opts = { nowMs: NOW };

const XSS_PAYLOADS = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '"><svg onload=alert(1)>',
    "'><img src=x onerror=alert(1)>",
];

// Detecta tags vivos provenientes de dato externo. La propiedad de seguridad es
// que el `<` del payload se neutraliza a `&lt;`, así que un `<script`/`<img`/
// `<svg` LITERAL no puede aparecer (la fila no usa esos tags en su markup
// propio). `onerror=`/`onload=` como texto escapado son inertes (su `<` ya fue
// neutralizado), por eso basta con chequear la apertura de tag literal.
function hasLiveTags(html) {
    return /<script\b/i.test(html)
        || /<img\b/i.test(html)
        || /<svg\b/i.test(html);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

test('exports canónicos del módulo Bloqueados', () => {
    assert.equal(slug, 'bloqueados');
    assert.equal(typeof renderBloqueadosSsr, 'function');
    assert.equal(typeof renderBloqueadosClientScript, 'function');
    assert.equal(typeof renderBloqueados, 'function');
    assert.equal(typeof safeIssueNumber, 'function');
    assert.equal(typeof severityOf, 'function');
});

// ---------------------------------------------------------------------------
// Render vacío — empty-state celebratorio (CA-G1 / D5)
// ---------------------------------------------------------------------------

test('render vacío emite empty-state celebratorio con mini-stats', () => {
    const html = renderBloqueadosSsr({ bloqueados: [] }, opts);
    assert.match(html, /id="view-content"/);
    assert.match(html, /data-slug="bloqueados"/);
    assert.match(html, /v3-bloqueados-view/);
    assert.match(html, /id="bloqueados-empty"/);
    assert.match(html, /SLA promedio/);
    assert.match(html, /Resueltos hoy/);
    // NO debe contener filas.
    assert.doesNotMatch(html, /id="bloqueados-row-/);
    assert.ok(!hasLiveTags(html));
});

test('state.bloqueados undefined/null cae al empty-state sin romper', () => {
    assert.match(renderBloqueadosSsr({}, opts), /id="bloqueados-empty"/);
    assert.match(renderBloqueadosSsr(null, opts), /id="bloqueados-empty"/);
    assert.match(renderBloqueadosSsr(undefined, opts), /id="bloqueados-empty"/);
});

test('mini-stats usa valores del state cuando existen', () => {
    const html = renderBloqueadosSsr({ bloqueados: [], bloqueadosStats: { avgSla: '2h 14min', resolvedToday: 7 } }, opts);
    assert.match(html, /2h 14min/);
    assert.match(html, />7</);
});

// ---------------------------------------------------------------------------
// Render con 1 fila normal (CA-G1)
// ---------------------------------------------------------------------------

test('render con 1 fila normal: IDs estables, severidad y datos escapados', () => {
    const html = renderBloqueadosSsr({
        bloqueados: [{
            issue: 2891, title: 'Issue de prueba', skill: 'ux', phase: 'validacion',
            age_hours: 29, reason: 'motivo del bloqueo',
            recent_events: [{ when: '2026-06-08T12:00:00Z', author: 'leito', preview: 'comentario' }],
        }],
    }, opts);
    assert.match(html, /id="bloqueados-row-2891"/);
    assert.match(html, /v3-bloqueados-sev-danger/); // 29h ≥ 24h
    assert.match(html, /v3-bloqueados-row/);
    assert.match(html, /href="https:\/\/github\.com\/intrale\/platform\/issues\/2891"/);
    assert.match(html, /needsHumanReactivate\(2891\)/);
    assert.match(html, /needsHumanDismiss\(2891\)/);
    assert.match(html, /Issue de prueba/);
    assert.match(html, /motivo del bloqueo/);
    assert.match(html, /Actividad reciente/);
    // Header con badge de cantidad.
    assert.match(html, /Necesitan intervención humana/);
    assert.ok(!hasLiveTags(html));
});

test('umbrales de severidad: info < 4h, warning 4-24h, danger ≥ 24h', () => {
    assert.equal(severityOf(0.5), 'info');
    assert.equal(severityOf(3.9), 'info');
    assert.equal(severityOf(4), 'warning');
    assert.equal(severityOf(23.9), 'warning');
    assert.equal(severityOf(24), 'danger');
    assert.equal(severityOf(100), 'danger');
    const fresh = renderBloqueadosSsr({ bloqueados: [{ issue: 1, age_hours: 1 }] }, opts);
    assert.match(fresh, /v3-bloqueados-sev-info/);
    const warn = renderBloqueadosSsr({ bloqueados: [{ issue: 1, age_hours: 10 }] }, opts);
    assert.match(warn, /v3-bloqueados-sev-warning/);
});

// ---------------------------------------------------------------------------
// Matriz XSS canónica 4 × 5 (CA-D1 + security)
// ---------------------------------------------------------------------------

test('matriz XSS 4×5: ningún payload produce tags vivos y el texto se escapa', () => {
    const surfaces = ['title', 'reason', 'summary', 'eventAuthor', 'eventPreview'];
    for (const payload of XSS_PAYLOADS) {
        for (const surface of surfaces) {
            const b = { issue: 1234, age_hours: 5 };
            if (surface === 'title') b.title = payload;
            if (surface === 'reason') b.reason = payload;
            if (surface === 'summary') b.summary = payload;
            if (surface === 'eventAuthor') b.recent_events = [{ when: '2026-06-08T12:00:00Z', author: payload, preview: 'ok' }];
            if (surface === 'eventPreview') b.recent_events = [{ when: '2026-06-08T12:00:00Z', author: 'ok', preview: payload }];

            const html = renderBloqueadosSsr({ bloqueados: [b] }, opts);
            assert.ok(!hasLiveTags(html), `payload ${payload} en ${surface} produjo tags vivos`);
            // El dato llegó escapado (al menos uno de los marcadores canónicos).
            assert.ok(
                html.includes('&lt;') || html.includes('&quot;') || html.includes('&#39;'),
                `payload ${payload} en ${surface} no aparece escapado`,
            );
        }
    }
});

test('título con comilla doble no rompe el atributo title=""', () => {
    const html = renderBloqueadosSsr({
        bloqueados: [{ issue: 7, age_hours: 1, title: '"><svg onload=alert(1)>' }],
    }, opts);
    // Todos los atributos title="..." están bien delimitados (sin comillas
    // internas sin escapar que rompan el parseo).
    const titleAttrs = html.match(/title="[^"]*"/g) || [];
    // El payload con comilla doble NO debe haber partido un atributo dejando
    // un `<svg` vivo fuera de comillas.
    assert.ok(!hasLiveTags(html));
    assert.ok(titleAttrs.length >= 1);
});

// ---------------------------------------------------------------------------
// Coerción b.issue (CA-D2)
// ---------------------------------------------------------------------------

test('coerción b.issue: entradas inválidas descartan la fila', () => {
    const invalid = ['1) alert(1) //', '<script>', null, '', 0, -5, '3.14', 'abc', NaN];
    for (const bad of invalid) {
        const html = renderBloqueadosSsr({ bloqueados: [{ issue: bad, age_hours: 1, title: 'x' }] }, opts);
        // Sin filas válidas → empty-state, sin row.
        assert.doesNotMatch(html, /id="bloqueados-row-/, `issue inválido ${JSON.stringify(bad)} no descartó la fila`);
    }
});

test('coerción b.issue: entradas válidas renderizan el número exacto', () => {
    for (const good of [1, '2', 99999]) {
        const n = Number(good);
        const html = renderBloqueadosSsr({ bloqueados: [{ issue: good, age_hours: 1, title: 'x' }] }, opts);
        assert.match(html, new RegExp('id="bloqueados-row-' + n + '"'));
        assert.match(html, new RegExp('needsHumanReactivate\\(' + n + '\\)'));
        assert.match(html, new RegExp('issues/' + n + '"'));
    }
});

test('safeIssueNumber: contrato directo', () => {
    assert.equal(safeIssueNumber(5), 5);
    assert.equal(safeIssueNumber('42'), 42);
    assert.equal(safeIssueNumber(0), null);
    assert.equal(safeIssueNumber(-1), null);
    assert.equal(safeIssueNumber('3.14'), null);
    assert.equal(safeIssueNumber('<script>'), null);
    assert.equal(safeIssueNumber(null), null);
});

// ---------------------------------------------------------------------------
// Estados especiales (CA-G1)
// ---------------------------------------------------------------------------

test('recent_events ausente o vacío no genera el bloque de actividad', () => {
    const noEvents = renderBloqueadosSsr({ bloqueados: [{ issue: 1, age_hours: 1 }] }, opts);
    assert.doesNotMatch(noEvents, /Actividad reciente/);
    const emptyEvents = renderBloqueadosSsr({ bloqueados: [{ issue: 1, age_hours: 1, recent_events: [] }] }, opts);
    assert.doesNotMatch(emptyEvents, /Actividad reciente/);
});

test('summary_stale sin summary renderiza estado loading', () => {
    const html = renderBloqueadosSsr({ bloqueados: [{ issue: 1, age_hours: 1, summary_stale: true }] }, opts);
    assert.match(html, /Cargando resumen funcional/);
    assert.match(html, /needs-human-summary-loading/);
});

test('reason se trunca a 280 chars con elipsis', () => {
    const longReason = 'a'.repeat(400);
    const html = renderBloqueadosSsr({ bloqueados: [{ issue: 1, age_hours: 1, reason: longReason }] }, opts);
    assert.match(html, /a{280}…/);
    assert.doesNotMatch(html, /a{281}/);
});

// ---------------------------------------------------------------------------
// Client script + documento completo
// ---------------------------------------------------------------------------

test('client script expone handlers needsHuman* y toggleNeedsHumanPanel', () => {
    const js = renderBloqueadosClientScript();
    assert.match(js, /window\.needsHumanReactivate/);
    assert.match(js, /window\.needsHumanDismiss/);
    assert.match(js, /window\.toggleNeedsHumanPanel/);
    assert.match(js, /\/api\/needs-human\//);
    // #3953 — los handlers adjuntan CSRF vía nhCsrfHeaders() (helper ahora
    // centralizado en FETCH_CLIENT_JS, inyectado en el documento completo).
    assert.match(js, /nhCsrfHeaders\(\)/);
});

test('#3953 el documento completo inyecta el wrapper fetch y la lectura de csrf-token', () => {
    const doc = renderBloqueados({ bloqueados: [] }, opts);
    // El wrapper único de fetch (CA-2) y la lectura de <meta name="csrf-token">
    // (R2) viven ahora en FETCH_CLIENT_JS, inyectado en el <script> de la página.
    assert.match(doc, /csrf-token/);
    assert.match(doc, /function fetchJson\(url, opts\)/);
    assert.match(doc, /inConfirm/); // framework de modal de confirmación (CA-3)
});

test('renderBloqueados emite documento SSR completo con shell V3', () => {
    const doc = renderBloqueados({ bloqueados: [] }, opts);
    assert.match(doc, /<!DOCTYPE html>/);
    assert.match(doc, /<title>Intrale · Bloqueados<\/title>/);
    assert.match(doc, /data-slug="bloqueados"/);
    assert.match(doc, /window\.needsHumanReactivate/);
});

// ---------------------------------------------------------------------------
// CA-2 — prettyReason (motivo pretty-print, nunca JSON crudo)
// ---------------------------------------------------------------------------

test('prettyReason deja el texto plano intacto', () => {
    assert.equal(prettyReason('motivo simple sin json'), 'motivo simple sin json');
    assert.equal(prettyReason(''), '');
    assert.equal(prettyReason(null), '');
});

test('prettyReason traduce formas JSON conocidas a español legible', () => {
    assert.equal(prettyReason('{"dependency_block":3953}'), 'Bloqueado por dependencia: #3953');
    assert.equal(prettyReason('{"rebote_categoria":"infra","motivo":"build roto"}'), 'Rebote (infra): build roto');
    assert.match(prettyReason('{"motivo_rechazo":"falta cobertura","rechazado_en_fase":"verificacion"}'), /Rechazado en verificacion: falta cobertura/);
});

test('prettyReason cae al texto plano con JSON malformado o no-objeto', () => {
    assert.equal(prettyReason('{no es json}'), '{no es json}');
    assert.equal(prettyReason('[1,2,3]'), '[1,2,3]'); // array → no es objeto traducible
    assert.equal(prettyReason('{"x":'), '{"x":');
});

test('prettyReason nunca emite < o > sin escapar y resiste prototype-pollution', () => {
    // El helper devuelve texto plano (el escape ocurre en el render). Verificamos
    // que el render completo no produzca tags vivos con un reason JSON hostil.
    const html = renderBloqueadosSsr({
        bloqueados: [{ issue: 9, age_hours: 1, reason: '{"x":"<script>alert(1)</script>"}' }],
    }, opts);
    assert.ok(!hasLiveTags(html));
    assert.match(html, /x: /); // se tradujo a forma genérica clave: valor
    // __proto__ no contamina el prototipo al parsear/recorrer.
    prettyReason('{"__proto__":{"polluted":true}}');
    assert.equal({}.polluted, undefined);
    const html2 = renderBloqueadosSsr({
        bloqueados: [{ issue: 9, age_hours: 1, reason: '{"__proto__":{"polluted":true}}' }],
    }, opts);
    assert.ok(!hasLiveTags(html2));
    assert.equal({}.polluted, undefined);
});

test('CA-2 el reason JSON crudo nunca aparece literal en el HTML', () => {
    const html = renderBloqueadosSsr({
        bloqueados: [{ issue: 9, age_hours: 1, reason: '{"dependency_block":3953}' }],
    }, opts);
    assert.match(html, /Bloqueado por dependencia: #3953/);
    assert.doesNotMatch(html, /\{&quot;dependency_block/);
});

// ---------------------------------------------------------------------------
// CA-1 — sortBySeverityAge + filtros/búsqueda
// ---------------------------------------------------------------------------

test('sortBySeverityAge ordena danger→warning→info, tie-break edad desc', () => {
    const input = [
        { issue: 1, age_hours: 2 },   // info
        { issue: 2, age_hours: 30 },  // danger
        { issue: 3, age_hours: 10 },  // warning
        { issue: 4, age_hours: 50 },  // danger (más viejo)
    ];
    const out = sortBySeverityAge(input);
    assert.deepEqual(out.map(b => b.issue), [4, 2, 3, 1]);
    // No muta el input original.
    assert.equal(input[0].issue, 1);
});

test('CA-1 el render aplica el orden severidad×edad a las filas', () => {
    const html = renderBloqueadosSsr({
        bloqueados: [
            { issue: 11, age_hours: 1, title: 'fresco' },
            { issue: 22, age_hours: 40, title: 'critico' },
        ],
    }, opts);
    // La fila danger (#22) aparece antes que la info (#11) en el HTML.
    assert.ok(html.indexOf('bloqueados-row-22') < html.indexOf('bloqueados-row-11'));
});

test('CA-1 filterbar SSR presente con controles y datasets en las filas', () => {
    const html = renderBloqueadosSsr({
        bloqueados: [{ issue: 5, age_hours: 5, skill: 'ux', phase: 'validacion' }],
    }, opts);
    assert.match(html, /id="bloqueados-filterbar"/);
    assert.match(html, /id="bloqueados-search"/);
    assert.match(html, /id="bloqueados-filter-sev"/);
    assert.match(html, /data-skill="ux"/);
    assert.match(html, /data-phase="validacion"/);
});

test('CA-1 handlers de filtro filtran por dataset/textContent sin reconstruir innerHTML', () => {
    const js = renderBloqueadosClientScript();
    assert.match(js, /function bloqueadosApplyFilters/);
    assert.match(js, /getAttribute\('data-severity'\)/);
    assert.match(js, /textContent/);
    // No debe asignar innerHTML desde el término de búsqueda (anti DOM injection).
    assert.doesNotMatch(js, /innerHTML\s*=/);
    assert.match(js, /window\.bloqueadosApplyFilters/);
    assert.match(js, /window\.bloqueadosClearFilters/);
});

// ---------------------------------------------------------------------------
// CA-3 — deep-link Telegram (cuando aplica)
// ---------------------------------------------------------------------------

test('safeBotUsername valida el charset de Telegram', () => {
    assert.equal(safeBotUsername('intrale_bot'), 'intrale_bot');
    assert.equal(safeBotUsername(' intrale_bot '), 'intrale_bot');
    assert.equal(safeBotUsername('ab'), null);            // < 5 chars
    assert.equal(safeBotUsername('con-guion'), null);     // guion no permitido
    assert.equal(safeBotUsername('a'.repeat(33)), null);  // > 32 chars
    assert.equal(safeBotUsername(null), null);
});

test('telegramDeepLink construye URL válida o null', () => {
    assert.equal(telegramDeepLink(123, 'intrale_bot'), 'https://t.me/intrale_bot?start=unblock_123');
    assert.equal(telegramDeepLink(123, 'x'), null);       // username inválido
    assert.equal(telegramDeepLink(0, 'intrale_bot'), null); // issue inválido
});

test('CA-3 deep-link ausente sin bot_username, presente y bien formado con username válido', () => {
    const sin = renderBloqueadosSsr({ bloqueados: [{ issue: 7, age_hours: 1 }] }, opts);
    assert.doesNotMatch(sin, /t\.me/);
    const con = renderBloqueadosSsr({
        bloqueados: [{ issue: 7, age_hours: 1 }], telegramBotUsername: 'intrale_bot',
    }, opts);
    assert.match(con, /href="https:\/\/t\.me\/intrale_bot\?start=unblock_7"/);
    assert.match(con, /rel="noopener noreferrer"/);
});

test('CA-3 username inválido en el state no renderiza deep-link', () => {
    const html = renderBloqueadosSsr({
        bloqueados: [{ issue: 7, age_hours: 1 }], telegramBotUsername: 'bad-handle!',
    }, opts);
    assert.doesNotMatch(html, /t\.me/);
});

test('CA-3 el bot_token NUNCA aparece en el HTML renderizado', () => {
    // Defensa: aunque alguien pase un token por error en un campo, no se filtra.
    const html = renderBloqueadosSsr({
        bloqueados: [{ issue: 7, age_hours: 1 }],
        telegramBotUsername: 'intrale_bot',
    }, opts);
    assert.doesNotMatch(html, /bot_token/);
    assert.doesNotMatch(html, /\d{8,10}:[A-Za-z0-9_-]{35}/); // shape de token de Telegram
});

// ---------------------------------------------------------------------------
// CA-4 — header stats
// ---------------------------------------------------------------------------

test('CA-4 header stats renderiza valores o "—" sin romper', () => {
    const conDatos = renderBloqueadosSsr({
        bloqueados: [{ issue: 1, age_hours: 5 }],
        bloqueadosStats: { avgSla: '4h 12m', resolvedToday: 3 },
    }, opts);
    assert.match(conDatos, /v3-bloqueados-headstats/);
    assert.match(conDatos, /4h 12m/);
    assert.match(conDatos, />3</);
    const sinDatos = renderBloqueadosSsr({ bloqueados: [{ issue: 1, age_hours: 5 }] }, opts);
    assert.match(sinDatos, /v3-bloqueados-headstats/);
    assert.match(sinDatos, /—/);
});

// ---------------------------------------------------------------------------
// CA-5 — CTA primario explícito
// ---------------------------------------------------------------------------

test('classifyCta clasifica Aprobar/Reintentar/Responder de forma determinística', () => {
    assert.equal(classifyCta({ labels: ['tipo:recomendacion'] }).kind, 'approve');
    assert.equal(classifyCta({ reason: 'esperando aprobación del PO' }).kind, 'approve');
    assert.equal(classifyCta({ reason: '{"dependency_block":3953}' }).kind, 'retry');
    assert.equal(classifyCta({ reason: 'circuit breaker: 3 rebotes' }).kind, 'retry');
    assert.equal(classifyCta({ reason: 'build roto en backend' }).kind, 'retry');
    // Default seguro: pregunta textual sin clasificación → Responder.
    assert.equal(classifyCta({ question: '¿qué color usamos para el botón?' }).kind, 'respond');
    assert.equal(classifyCta({}).kind, 'respond');
});

test('CA-5 cada fila expone exactamente un CTA primario con su verbo', () => {
    const html = renderBloqueadosSsr({
        bloqueados: [{ issue: 8, age_hours: 5, reason: 'build roto' }],
    }, opts);
    assert.match(html, /v3-bloqueados-cta-retry/);
    assert.match(html, /needsHumanCta\(8, 'retry'\)/);
    // Un solo CTA primario por fila.
    assert.equal((html.match(/v3-bloqueados-cta /g) || []).length, 1);
});

test('CA-5 los CTA state-changing reusan CSRF y modal de confirmación', () => {
    const js = renderBloqueadosClientScript();
    assert.match(js, /function needsHumanCta/);
    assert.match(js, /inConfirm/);
    assert.match(js, /nhCsrfHeaders\(\)/);
    assert.match(js, /window\.needsHumanCta/);
});
