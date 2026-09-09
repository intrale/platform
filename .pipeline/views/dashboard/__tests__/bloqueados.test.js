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
    classifyMotivo,
    groupByMotivo,
    deriveBanner,
    renderMissionBanner,
    renderMizpaBrandBar,
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
// #4238 — Marco común de ventanas MIZPÁ en BLOQUEADOS (cabecera de ola común,
// reutilizando el helper compartido renderMissionBanner de la HOME, sin
// duplicar markup). El marco va en el orden ① marca → ② ola → ③ nav → ④ propio.
// ---------------------------------------------------------------------------

test('#4238 el documento standalone trae la cabecera de ola común (② del marco)', () => {
    const doc = renderBloqueados({ bloqueados: [] }, opts);
    // Cabecera de ola común (helper compartido de la HOME): tag OLA, métricas y
    // bloque AVANCE con leyenda de puntitos.
    assert.match(doc, /<section class="mz-mission"/);
    assert.match(doc, /id="mission-wave-num"/);
    assert.match(doc, /id="mission-vel-value"/);     // 🚀 velocidad
    assert.match(doc, /id="mission-delivered-value"/); // 📦 entregados
    assert.match(doc, /id="mission-avance-pct"/);    // bloque AVANCE
    assert.match(doc, /id="mission-leg-blocked"/);   // leyenda de puntitos (bloq.)
});

test('#4238 el marco respeta el orden ① marca → ② ola → ③ nav → ④ contenido', () => {
    const doc = renderBloqueados({
        bloqueados: [{ issue: 4101, age_hours: 30, skill: 'po', phase: 'validacion', reason: 'go/no-go', recent_events: [] }],
    }, opts);
    const closeHeader = doc.indexOf('</header>');
    const mission = doc.indexOf('<section class="mz-mission"');
    const nav = doc.indexOf('<nav', closeHeader);   // primer <nav real tras el header
    const content = doc.indexOf('id="view-content"');
    assert.ok(closeHeader > -1 && mission > -1 && nav > -1 && content > -1, 'todos los bloques presentes');
    assert.ok(closeHeader < mission, '② ola va después del header ①');
    assert.ok(mission < nav, '③ nav va después de ② ola');
    assert.ok(nav < content, '④ contenido va después de la nav ③');
});

test('#4238 la cabecera de ola común se hidrata desde /api/dash/waves (tick presente)', () => {
    const doc = renderBloqueados({ bloqueados: [] }, opts);
    assert.match(doc, /tickBloqueadosMission/);
    assert.match(doc, /\/api\/dash\/waves/);
});

test('#4238 NO se duplica la cabecera de ola en el fragmento embebido (home monolito)', () => {
    // El fragmento embebido en la HOME no debe repetir la cabecera de ola: la
    // HOME ya la renderiza en su cuerpo. Solo el documento standalone la trae.
    const frag = renderBloqueadosSsr({
        bloqueados: [{ issue: 4101, age_hours: 5, recent_events: [] }],
    }, opts);
    assert.ok(!frag.includes('<section class="mz-mission"'), 'el fragmento no incluye la cabecera de ola común');
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

// ---------------------------------------------------------------------------
// #5689 — classifyCta usa el discriminador único `isRecommendationIssue()`
// en vez del inline, con `CTA_APPROVE_RE` OR-eado como fallback (CA-C2 del PO).
// ---------------------------------------------------------------------------

test('#5689 classifyCta reconoce source:recommendation (el inline lo ignoraba)', () => {
    assert.equal(classifyCta({ labels: ['source:recommendation'] }).kind, 'approve');
});

test('#5689 classifyCta acepta labels en forma [{name}] además de [string]', () => {
    // `gh issue list --json labels` devuelve objetos; varias partes del pipeline
    // ya los aplanaron. El helper normaliza ambas formas.
    assert.equal(classifyCta({ labels: [{ name: 'tipo:recomendacion' }] }).kind, 'approve');
});

test('#5689 R9 — recommendation:approved deja de clasificar como Aprobar por label', () => {
    // Delta ESPERADO y correcto, no regresión: ya fue aprobado, no hay nada que
    // aprobar. Sin texto que matchee `CTA_APPROVE_RE` cae al default seguro.
    const r = classifyCta({ labels: ['tipo:recomendacion', 'recommendation:approved'], reason: 'build roto' });
    assert.notEqual(r.kind, 'approve');
    assert.equal(r.kind, 'retry');
});

test('#5689 CA-C2 — CTA_APPROVE_RE sigue OR-eado como fallback de texto', () => {
    // Sin ningún label de recomendación, el heurístico de texto debe seguir vivo.
    assert.equal(classifyCta({ labels: [], reason: 'esperando aprobación' }).kind, 'approve');
});

test('#5689 classifyCta no lanza con labels basura', () => {
    assert.equal(classifyCta({ labels: null }).kind, 'respond');
    assert.equal(classifyCta({ labels: 'tipo:recomendacion' }).kind, 'respond');
    assert.equal(classifyCta({ labels: [null, 42, {}] }).kind, 'respond');
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

// ---------------------------------------------------------------------------
// #4193 (Ola 7.1) — Rediseño integral MIZPÁ (centro de decisiones)
// ---------------------------------------------------------------------------

test('#4193 exports del rediseño MIZPÁ presentes', () => {
    assert.equal(typeof classifyMotivo, 'function');
    assert.equal(typeof groupByMotivo, 'function');
    assert.equal(typeof deriveBanner, 'function');
    assert.equal(typeof renderMissionBanner, 'function');
    assert.equal(typeof renderMizpaBrandBar, 'function');
});

test('#4193 classifyMotivo clasifica el motivo real de forma determinística', () => {
    assert.equal(classifyMotivo({ reason: '{"dependency_block":4189}' }).key, 'dependencias');
    assert.equal(classifyMotivo({ reason: 'depende de #4189' }).key, 'dependencias');
    assert.equal(classifyMotivo({ reason: 'circuit breaker: 3 rebotes', labels: ['needs-human'] }).key, 'circuit');
    assert.equal(classifyMotivo({ reason: 'rebote desde verificacion' }).key, 'rebote');
    assert.equal(classifyMotivo({ reason: '{"motivo_rechazo":"falla"}' }).key, 'rebote');
    assert.equal(classifyMotivo({ reason: 'esperando definición de criterios', labels: ['needs-definition'] }).key, 'definicion');
    assert.equal(classifyMotivo({ question: '¿qué color usamos?' }).key, 'humano');
    assert.equal(classifyMotivo({}).key, 'humano');
});

test('#4193 groupByMotivo agrupa, ordena por rank y nunca pierde filas', () => {
    const list = [
        { issue: 1, age_hours: 2, question: '¿color?' },           // humano
        { issue: 2, age_hours: 3, reason: 'depende de #9' },        // dependencias
        { issue: 3, age_hours: 4, reason: 'rebote' },               // rebote
        { issue: 4, age_hours: 5, reason: 'depende de #8' },        // dependencias
    ];
    const groups = groupByMotivo(list);
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    assert.equal(total, 4); // nunca trunca
    // dependencias (rank 4) antes que rebote (rank 3) antes que humano (rank 1).
    assert.deepEqual(groups.map(g => g.motivo.key), ['dependencias', 'rebote', 'humano']);
    assert.equal(groups[0].items.length, 2);
});

test('#4193 banner de misión: contador, el que más espera, SLA superado y métricas', () => {
    const html = renderBloqueadosSsr({
        bloqueados: [
            { issue: 100, age_hours: 40, title: 'el más viejo', reason: 'rebote' },
            { issue: 101, age_hours: 2, question: '¿color?' },
        ],
        bloqueadosStats: { avgSla: '3h 10m', resolvedToday: 4 },
    }, opts);
    assert.match(html, /id="bloqueados-mission"/);
    assert.match(html, /REQUIEREN TU/);
    assert.match(html, /EL QUE MÁS ESPERA/);
    assert.match(html, /#100/);             // el más viejo
    assert.match(html, /SLA superado/);     // 40h ≥ 24h
    assert.match(html, /Rebotes activos/);
    assert.match(html, /3h 10m/);
    assert.ok(!hasLiveTags(html));
});

test('#4193 deriveBanner deriva rebotes activos de la lista en vivo', () => {
    const b = deriveBanner([
        { issue: 1, age_hours: 5, reason: 'rebote' },
        { issue: 2, age_hours: 6, reason: 'circuit breaker', labels: ['needs-human'] },
        { issue: 3, age_hours: 1, question: '¿color?' },
    ], { avgSla: '1h', resolvedToday: 2 }, NOW);
    assert.equal(b.count, 3);
    assert.equal(b.rebotesActivos, 2);
    assert.equal(b.oldest.issue, 2);          // 6h es el más viejo
    assert.equal(b.avgSla, '1h');
    assert.equal(b.resolvedToday, '2');
});

test('#4193 banner NO aparece en el empty-state', () => {
    const html = renderBloqueadosSsr({ bloqueados: [] }, opts);
    assert.doesNotMatch(html, /id="bloqueados-mission"/);
    assert.match(html, /id="bloqueados-empty"/);
});

test('#4193 cada bloqueo ofrece las acciones: destrabar, ver issue y ver logs', () => {
    const html = renderBloqueadosSsr({
        bloqueados: [{ issue: 555, age_hours: 5, reason: 'rebote' }],
    }, opts);
    assert.match(html, /needsHumanReactivate\(555\)/);                 // destrabar/override
    assert.match(html, /Destrabar/);
    assert.match(html, /href="https:\/\/github\.com\/intrale\/platform\/issues\/555"/); // ver issue
    assert.match(html, /href="\/historial\?q=555"/);                  // ver logs
    assert.ok(!hasLiveTags(html));
});

test('#4193 los bloqueos se agrupan por motivo con su decisión esperada', () => {
    const html = renderBloqueadosSsr({
        bloqueados: [
            { issue: 10, age_hours: 5, reason: 'depende de #9' },
            { issue: 11, age_hours: 3, reason: 'rebote' },
        ],
    }, opts);
    assert.match(html, /v3-bloqueados-group/);
    assert.match(html, /Esperando dependencias/);
    assert.match(html, /Rebotado por una fase/);
    assert.match(html, /v3-bloqueados-group-decision/);
});

test('#4193 nunca trunca: 30 bloqueos producen 30 filas (sin "+X más")', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ issue: 1000 + i, age_hours: i + 1, reason: 'rebote' }));
    const html = renderBloqueadosSsr({ bloqueados: many }, opts);
    const rows = (html.match(/id="bloqueados-row-/g) || []).length;
    assert.equal(rows, 30);
    assert.doesNotMatch(html, /\+\s*\d+\s*más/i);
    assert.doesNotMatch(html, /continúa/i);
});

test('#4193 brand bar MIZPÁ presente en el documento standalone', () => {
    const doc = renderBloqueados({ bloqueados: [{ issue: 1, age_hours: 1 }] }, opts);
    assert.match(doc, /MIZPÁ/);
    assert.match(doc, /Que el Señor vigile/);
    assert.match(doc, /mz-projsel/);          // selector multiproyecto
    assert.match(doc, /1 \/ 3/);
});

test('#4193 XSS en el banner: title del más viejo escapado, sin tags vivos', () => {
    for (const payload of XSS_PAYLOADS) {
        const html = renderBloqueadosSsr({
            bloqueados: [{ issue: 9, age_hours: 50, title: payload, reason: 'rebote' }],
        }, opts);
        assert.ok(!hasLiveTags(html), 'payload no debe producir tags vivos: ' + payload);
    }
});

test('#4193 el filtro client-side oculta grupos sin filas visibles', () => {
    const js = renderBloqueadosClientScript();
    assert.match(js, /v3-bloqueados-group/);
    assert.match(js, /anyVisible/);
});

// ---------------------------------------------------------------------------
// #6191 — La tarjeta encabeza con la DECISIÓN (ficha única de decision-card.js)
//
// Contrato: `bloqueados.js` aporta jerarquía, orden y estado de colapso; el copy
// de decisión lo redacta `lib/decision-card.js` (#6190) y NADIE MÁS. Los tests
// de abajo verifican eso por inspección del HTML renderizado, que es la única
// evidencia que no se puede falsear leyendo el código.
// ---------------------------------------------------------------------------

const { buildDecisionCard } = require('../../../lib/decision-card');
const humanBlock = require('../../../lib/human-block');
const fsNode = require('node:fs');

// Bloqueo tipo `dependencia`: es el único de la tabla congelada que produce
// opciones sin necesitar contexto que el marker no trae (verificado en
// definicion/criterios y re-verificado acá).
const DEP = {
    issue: 6191, title: 'La ventana de bloqueados', skill: 'po', phase: 'criterios',
    age_hours: 27, reason: '{"dependency_block":[6190]}', blocked_at: '2026-06-08T09:00:00Z',
};
// Bloqueo con `reason` no clasificable → ficha `indeterminado`, cero opciones.
// Según la medición del `ux` (H-6191-2) es el caso MÁS FRECUENTE, no un borde.
const INDET = {
    issue: 5805, title: 'Instrumentar el vault', skill: 'delivery', phase: 'entrega',
    age_hours: 29, reason: 'zzz-motivo-que-nadie-clasifica', blocked_at: '2026-06-08T07:00:00Z',
};

function rowHtml(b, state) {
    return renderBloqueadosSsr(Object.assign({ bloqueados: [b] }, state || {}), opts);
}
// Todo lo que está antes de la apertura del `<details>` es lo que el operador
// ve SIN abrir nada. Es el corte que pide CA-2 literalmente.
function visiblePart(html) {
    const i = html.indexOf('<details');
    assert.ok(i > -1, 'la tarjeta debe traer el bloque técnico colapsable');
    return html.slice(0, i);
}
function reEscape(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('#6191 CA-1 la tarjeta muestra `que_se_decide` como encabezado', () => {
    const card = buildDecisionCard(DEP, NOW);
    const html = rowHtml(DEP);
    // El texto de la ficha está DENTRO del elemento de encabezado de la tarjeta.
    assert.match(html, new RegExp('<h3 class="v3-bloqueados-decision">' + reEscape(card.que_se_decide) + '</h3>'));
    // Y el encabezado es el PRIMER contenido de la tarjeta (CA-UX-5: el lector
    // de pantalla arranca por la decisión, igual que el ojo).
    const row = html.slice(html.indexOf('id="bloqueados-row-6191"'));
    assert.ok(row.indexOf('v3-bloqueados-decision') < row.indexOf('v3-bloqueados-subtitle'));
});

test('#6191 CA-UX-1 el numero y titulo bajan a subtítulo secundario', () => {
    const html = rowHtml(DEP);
    assert.match(html, /<span class="v3-bloqueados-subtitle"[^>]*>#6191 «La ventana de bloqueados»<\/span>/);
});

test('#6191 CA-2 las opciones se ven sin abrir nada, con etiqueta y consecuencia', () => {
    const card = buildDecisionCard(DEP, NOW);
    assert.ok(card.opciones.length >= 2, 'la ficha de dependencia debe traer opciones');
    const visible = visiblePart(rowHtml(DEP));
    for (const o of card.opciones) {
        assert.ok(visible.includes(o.etiqueta), 'etiqueta fuera de la parte visible: ' + o.etiqueta);
        assert.ok(visible.includes(o.consecuencia), 'consecuencia fuera de la parte visible: ' + o.etiqueta);
    }
});

test('#6191 CA-3 el detalle técnico va en un details SIN atributo open', () => {
    for (const b of [DEP, INDET]) {
        const html = rowHtml(b);
        assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
        assert.match(html, /<summary class="v3-bloqueados-tech-summary">Detalle técnico del bloqueo · motivo completo, actividad reciente y accesos<\/summary>/);
    }
});

test('#6191 CA-3 el motivo crudo, el resumen y la actividad reciente viven dentro del details', () => {
    const html = rowHtml({
        issue: 4242, title: 'x', age_hours: 5, reason: 'motivo crudo del agente',
        summary: 'resumen funcional', recent_events: [{ when: '2026-06-09T11:00:00Z', author: 'leito', preview: 'un comentario' }],
    });
    const visible = visiblePart(html);
    assert.ok(!visible.includes('motivo crudo del agente'), 'el motivo crudo no puede estar visible');
    assert.ok(!visible.includes('resumen funcional'), 'el resumen no puede estar visible');
    assert.ok(!visible.includes('Actividad reciente'), 'la actividad reciente no puede estar visible');
    assert.match(html, /motivo crudo del agente/);
    assert.match(html, /Actividad reciente/);
});

test('#6191 CA-4 la ficha del dashboard es idéntica a la del objeto crudo (evidence/precondition propagados)', () => {
    // Objeto crudo TAL CUAL lo devuelve `listBlockedIssues()` (human-block.js).
    const crudo = {
        issue: 6191, skill: 'po', phase: 'criterios', pipeline: 'definicion',
        reason: '{"dependency_block":[6190]}', question: '',
        precondition: { kind: 'human_judgement' },
        evidence: 'El PO pidió confirmar el alcance antes de seguir',
        blocked_at: '2026-06-08T09:00:00Z', age_hours: 27, marker_path: 'x',
    };
    // La MISMA proyección que usa `dashboard.js` en sus dos caminos.
    const fila = humanBlock.toDashboardRow(crudo, { summary: 's', recent_events: [], stale: false }, { 6191: { title: 'La ventana' } });
    assert.equal(fila.evidence, crudo.evidence, 'la fila del dashboard debe propagar `evidence`');
    assert.deepEqual(fila.precondition, crudo.precondition, 'la fila del dashboard debe propagar `precondition`');
    // El verificable literal del criterio: misma evidencia mínima por ambos lados.
    assert.deepEqual(
        buildDecisionCard(fila, NOW).evidencia_minima,
        buildDecisionCard(crudo, NOW).evidencia_minima,
    );
    // Y la cita del issue efectivamente llega (si no, el criterio pasaría en vacío).
    assert.ok(buildDecisionCard(fila, NOW).evidencia_minima.some(e => e.includes(crudo.evidence)));
});

test('#6191 CA-4 dashboard.js arma la lista con la proyección única, también en el fallback', () => {
    // Guarda contra la regresión concreta que este issue cierra (gap G-2): dos
    // `map` gemelos escritos a mano, y arreglar uno solo deja el bug vivo.
    const src = fsNode.readFileSync(path.join(__dirname, '..', '..', '..', 'dashboard.js'), 'utf8');
    const usos = (src.match(/humanBlock\.toDashboardRow\(/g) || []).length;
    assert.equal(usos, 2, 'los DOS caminos (principal y catch) deben usar toDashboardRow');
});

test('#6191 CA-5 todo campo de ficha sale escapado y ninguno llega por innerHTML', () => {
    const hostil = 'Bug" onmouseover=alert(1) x=" & <script>alert(2)</script> R&D';
    const html = rowHtml({ issue: 777, title: hostil, age_hours: 5, reason: '{"dependency_block":[6190]}', evidence: hostil });
    assert.ok(!hasLiveTags(html));
    // El `&` y la `"` que el saneo de la ficha NO toca (H-6191-3) salen escapados.
    assert.ok(!/<h3 class="v3-bloqueados-decision">[^<]*"/.test(html), 'comilla cruda dentro del encabezado');
    assert.match(html, /&amp;/);
    // R6 — cero `innerHTML` en el camino alimentado por la ficha. El único
    // `innerHTML =` del módulo es preexistente, vive en el client script y se
    // alimenta de contadores numéricos de la ola, no de campos de la tarjeta.
    const fuente = fsNode.readFileSync(path.join(__dirname, '..', 'bloqueados.js'), 'utf8');
    const desde = fuente.indexOf('function renderRowSsr');
    const hasta = fuente.indexOf('\nfunction ', desde + 1);
    assert.ok(desde > -1 && hasta > desde);
    assert.doesNotMatch(fuente.slice(desde, hasta), /innerHTML/);
    assert.equal((fuente.match(/innerHTML\s*=/g) || []).length, 1, 'no se agregaron asignaciones de innerHTML');
});

test('#6191 CA-6 las opciones son información: cero onclick/href/data-action con su etiqueta', () => {
    const card = buildDecisionCard(DEP, NOW);
    const html = rowHtml(DEP);
    for (const o of card.opciones) {
        const etq = reEscape(o.etiqueta);
        assert.doesNotMatch(html, new RegExp('onclick="[^"]*' + etq));
        assert.doesNotMatch(html, new RegExp('href="[^"]*' + etq));
        assert.doesNotMatch(html, new RegExp('data-action="[^"]*' + etq));
    }
    // Las acciones ejecutables se conservan: CTA + Destrabar + Desestimar visibles.
    const visible = visiblePart(html);
    assert.match(visible, /needsHumanCta\(6191, '/);
    assert.match(visible, /needsHumanReactivate\(6191\)/);
    assert.match(visible, /Destrabar/);
    assert.match(visible, /needsHumanDismiss\(6191\)/);
    assert.match(visible, /Desestimar/);
    // Desestimar va última (destructiva, separada y a la derecha — D-2 del UX).
    assert.ok(visible.indexOf('needsHumanReactivate') < visible.indexOf('needsHumanDismiss'));
});

test('#6191 CA-6 Ver issue / Ver logs / Telegram bajan al detalle colapsado', () => {
    const html = rowHtml(DEP, { telegramBotUsername: 'intrale_bot' });
    const visible = visiblePart(html);
    assert.ok(!visible.includes('Ver issue'), 'Ver issue debe vivir dentro del details');
    assert.ok(!visible.includes('Ver logs'), 'Ver logs debe vivir dentro del details');
    assert.ok(!visible.includes('t.me/'), 'el deep-link de Telegram debe vivir dentro del details');
    // Pero siguen existiendo (no se perdió ninguna vía de acceso).
    assert.match(html, /href="https:\/\/github\.com\/intrale\/platform\/issues\/6191"/);
    assert.match(html, /href="\/historial\?q=6191"/);
    assert.match(html, /href="https:\/\/t\.me\/intrale_bot\?start=unblock_6191"/);
});

test('#6191 CA-UX-2 con cero opciones se muestra `card.falta`, no un hueco', () => {
    const card = buildDecisionCard(INDET, NOW);
    assert.equal(card.opciones.length, 0, 'el fixture debe producir una ficha indeterminada');
    assert.ok(card.falta, 'la ficha indeterminada trae `falta`');
    const visible = visiblePart(rowHtml(INDET));
    assert.ok(visible.includes(card.falta), 'falta debe estar visible sin abrir nada');
    assert.match(visible, /v3-bloqueados-falta/);
    // Y no se inventa copy propio para tapar el vacío.
    assert.doesNotMatch(rowHtml(INDET), /sin opciones disponibles/i);
});

test('#6191 CA-UX-3 la recomendada se distingue sin depender del color; sin ella, la ficha dice por qué', () => {
    // Sin contexto de dependencia la ficha NO recomienda: es degradación
    // diseñada (#6190), no un defecto — y la tarjeta no puede inventar la estrella.
    const card = buildDecisionCard(DEP, NOW);
    assert.ok(!card.opciones.some(o => o.es_recomendada));
    const html = rowHtml(DEP);
    assert.ok(!html.includes('★'), 'prohibido inventar una estrella que la ficha no trae');
    assert.ok(visiblePart(html).includes(card.sin_recomendacion_porque));

    // Con el contexto que habilita la recomendación aparecen las TRES señales.
    const conReco = Object.assign({}, DEP, { dep_age_hours: 3, dep_titulo: 'El módulo de la ficha', dependientes: 2 });
    const cardReco = buildDecisionCard(conReco, NOW);
    const reco = cardReco.opciones.find(o => o.es_recomendada);
    assert.ok(reco, 'con contexto de dependencia la ficha sí recomienda');
    const htmlReco = rowHtml(conReco);
    assert.match(htmlReco, /v3-bloqueados-opcion-reco/);          // barra de acento
    assert.match(htmlReco, /v3-bloqueados-opcion-star" aria-hidden="true">★/); // glifo
    assert.ok(htmlReco.includes(reco.razon_recomendacion));        // razón visible
});

test('#6191 CA-UX-4 `costo_de_no_decidir` siempre visible, fuera del details', () => {
    for (const b of [DEP, INDET]) {
        const card = buildDecisionCard(b, NOW);
        const visible = visiblePart(rowHtml(b));
        assert.ok(visible.includes(card.costo_de_no_decidir), 'el costo de no decidir debe verse sin abrir nada');
        assert.ok(visible.includes('Si no decidís:'));
    }
});

test('#6191 CA-UX-5 cada tarjeta es un article con details/summary nativo', () => {
    const html = rowHtml(DEP);
    assert.match(html, /<article class="v3-bloqueados-row [^"]*" id="bloqueados-row-6191"/);
    assert.match(html, /<details class="v3-bloqueados-tech">\s*<summary/);
    // Nada de colapsable reimplementado con div + onclick.
    assert.doesNotMatch(html, /class="v3-bloqueados-tech[^"]*"[^>]*onclick=/);
});

test('#6191 CA-UX-5 el texto de ficha sólo usa colores que llegan a AA en los dos temas', () => {
    // Medido con la fórmula WCAG 2.1 componiendo el alpha de los `*-soft`
    // contra el fondo real de la tarjeta, en ambos temas de `theme.css`:
    //   --in-fg      12,42 / 13,55 (sobre tarjeta) · 10,51 / 14,52 (sobre reco)
    //   --in-fg-dim   4,77 /  5,48 (sobre tarjeta) ·  5,62 /  6,39 (sobre opción)
    //   --in-fg-soft  3,20 /  2,60 → PROHIBIDO
    //   --in-accent   7,81 /  1,46 → falla en claro
    //   --in-warn     4,32 /  1,90 → falla en los dos
    //   --in-bad      4,38 /  2,88 → falla en los dos
    // El color nunca es el único portador: la recomendada tiene ★ + barra de
    // acento y la nota de `falta` tiene borde punteado + fondo (WCAG 1.4.1).
    const css = fsNode.readFileSync(path.join(__dirname, '..', 'theme.css'), 'utf8');
    const prohibidos = ['--in-fg-soft', '--in-accent', '--in-warn', '--in-bad'];
    const clasesDeFicha = [
        'v3-bloqueados-decision', 'v3-bloqueados-subtitle', 'v3-bloqueados-porque',
        'v3-bloqueados-opcion-etq', 'v3-bloqueados-opcion-cons', 'v3-bloqueados-opcion-razon',
        'v3-bloqueados-falta', 'v3-bloqueados-falta-rotulo', 'v3-bloqueados-falta-txt',
        'v3-bloqueados-sinreco', 'v3-bloqueados-costo', 'v3-bloqueados-costo-rotulo',
        'v3-bloqueados-evidencia-item', 'v3-bloqueados-tech-summary',
    ];
    for (const cls of clasesDeFicha) {
        const re = new RegExp('\\.' + cls + '[^{}]*\\{[^}]*\\}', 'g');
        const bloques = css.match(re) || [];
        assert.ok(bloques.length >= 1, 'falta la regla de ' + cls);
        for (const bloque of bloques) {
            // Sólo interesa la propiedad `color`: el mismo token puede seguir
            // usándose para `border`/`background`, que no son texto.
            const color = (bloque.match(/(?:^|[;{])\s*color\s*:\s*([^;}]+)/) || [])[1] || '';
            for (const token of prohibidos) {
                assert.ok(!color.includes(token), cls + ' usa ' + token + ' como color de texto de ficha (no llega a AA)');
            }
        }
    }
});

test('#6191 la vista degrada sin romper si la ficha no aporta opciones ni contexto', () => {
    // El pipeline no puede morir por una ficha: la fila sigue renderizando su
    // bloque técnico, que es información real.
    const html = rowHtml({ issue: 31337, age_hours: 2, reason: 'motivo plano' });
    assert.match(html, /id="bloqueados-row-31337"/);
    assert.match(html, /motivo plano/);
    assert.ok(!hasLiveTags(html));
});
