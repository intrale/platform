// =============================================================================
// Tests SSR del Historial timeline (#3963, rediseño sobre el split #3734/#3715).
//
// Estructura nueva: línea de tiempo agrupada por día, header de agregados, barra
// de filtros/búsqueda y cards expandibles (<details>/<summary>) con detalle
// (fases, rebotes, causa, costo, links a log/PR/reporte).
//
// Cubre:
//   - render vacío → '' (CA-11 back-compat).
//   - timeline + grupo de día + header de agregados (count, %aprobado, mediana).
//   - card expandible con detalle (causa, rebote, costo, links).
//   - timestamps humanos ("hace N min/h/d") con absoluto en title=.
//   - estado vacío para filtros sin match.
//   - Seguridad: XSS escapado en titulo/resultado/skill/fase, path traversal en
//     logFile/rejectionPdf, anti-tabnabbing (rel en target=_blank), URL de PR
//     validada, query reflejado escapado (REQ-SEC-1).
//
// node:test (sin Jest). Render directo del módulo.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const HIST_PATH = path.resolve(__dirname, '..', 'historial.js');
const { renderHistorialSsr, isSafeFilename, isSafeHttpUrl, relativeTime } = require(HIST_PATH);

const NOW = 1_718_000_000_000;
const MIN = 60_000;

function opts(extra) {
    return Object.assign({
        agentPersona: { 'pipeline-dev': { icon: '⚙', name: 'PipeDev', color: '#a371f7' } },
        manualOrderIndex: new Map(),
        fmtDuration: (ms) => `${Math.round((ms || 0) / 1000)}s`,
        ghBaseUrl: 'https://github.com/intrale/platform/issues',
        now: NOW,
    }, extra || {});
}

function baseEntry(extra) {
    return Object.assign({
        issue: 1732,
        titulo: 'Mi issue',
        skill: 'pipeline-dev',
        pipeline: 'desarrollo',
        fase: 'dev',
        estado: 'procesado',
        resultado: 'aprobado',
        motivo: null,
        duration: 5000,
        startedAt: NOW - 100 * 1000,
        finishedAt: NOW - 5 * MIN,
        hasLog: true,
        logFile: 'dev-1732.log',
        hasRejectionPdf: false,
        rejectionPdf: null,
        prUrl: null,
        reboteNumero: 0,
        crossphaseCount: 0,
        costo: null,
    }, extra || {});
}

// --- 1. render vacío ---
test('agentHistory vacío retorna string vacío (no rendea wrapper)', () => {
    assert.equal(renderHistorialSsr({ agentHistory: [] }, opts()), '');
    assert.equal(renderHistorialSsr({}, opts()), '');
    assert.equal(renderHistorialSsr(null, opts()), '');
});

// --- 2. render timeline básico ---
test('render básico — 1 entrada produce timeline + grupo de día + card', () => {
    const html = renderHistorialSsr({ agentHistory: [baseEntry()] }, opts());
    assert.match(html, /id="agent-history"/);
    assert.match(html, /data-section="historial"/);
    assert.match(html, /data-ah-timeline/);
    assert.match(html, /class="ah-day-group"/);
    assert.match(html, /class="ah-item ah-ok"/);
    assert.match(html, /1 ejecuciones/);
});

// --- 3. header de agregados ---
test('header de agregados — count, %aprobado y mediana del período', () => {
    const list = [
        baseEntry({ issue: 1, resultado: 'aprobado', duration: 10 * MIN }),
        baseEntry({ issue: 2, resultado: 'rechazado', duration: 30 * MIN }),
    ];
    const html = renderHistorialSsr({ agentHistory: list }, opts({ fmtDuration: (ms) => `${Math.round(ms / MIN)} m` }));
    assert.match(html, /class="ah-aggr"/);
    assert.match(html, /50 %/);        // 1 de 2 aprobado
    assert.match(html, /mediana 20 m/); // p50 de [10,30]m
});

// --- 4. card expandible con detalle ---
test('card expandible — detalle con causa, rebote y costo s/d', () => {
    const entry = baseEntry({
        resultado: 'rechazado', motivo: 'deep-link entre flavors', reboteNumero: 2, costo: null,
    });
    const html = renderHistorialSsr({ agentHistory: [entry] }, opts());
    assert.match(html, /<details class="ah-item ah-fail"/);
    assert.match(html, /class="ah-detail"/);
    assert.match(html, /causa: deep-link entre flavors/);
    assert.match(html, /rebote ×2/);
    assert.match(html, /costo: s\/d/);
});

test('costo numérico se formatea en USD en el detalle', () => {
    const html = renderHistorialSsr({ agentHistory: [baseEntry({ costo: 0.84 })] }, opts());
    assert.match(html, /costo: 0\.84 USD/);
});

// --- 5. timestamps humanos ---
test('timestamps humanos — "hace N min" en card con absoluto en title', () => {
    const html = renderHistorialSsr({ agentHistory: [baseEntry({ finishedAt: NOW - 5 * MIN })] }, opts());
    assert.match(html, /hace 5 min/);
    // el absoluto queda en un title= (precisión)
    assert.match(html, /class="ah-time" title="[^"]+"/);
});

test('relativeTime — escalas min/h/d', () => {
    assert.equal(relativeTime(NOW - 30 * 1000, NOW), 'ahora');
    assert.equal(relativeTime(NOW - 5 * MIN, NOW), 'hace 5 min');
    assert.equal(relativeTime(NOW - 3 * 60 * MIN, NOW), 'hace 3 h');
    assert.equal(relativeTime(NOW - 50 * 60 * MIN, NOW), 'hace 2 d');
});

// --- 6. links: log / PR / reporte ---
test('links — log seguro, PR válido y reporte PDF se emiten como acciones', () => {
    const entry = baseEntry({
        hasLog: true, logFile: 'dev-1732.log',
        prUrl: 'https://github.com/intrale/platform/pull/42',
        hasRejectionPdf: true, rejectionPdf: 'rejection-1732-qa.pdf', resultado: 'rechazado',
    });
    const html = renderHistorialSsr({ agentHistory: [entry] }, opts());
    assert.match(html, /href="\/logs\/view\/dev-1732\.log"/);
    assert.match(html, /href="https:\/\/github\.com\/intrale\/platform\/pull\/42"/);
    assert.match(html, /href="\/logs\/rejection-1732-qa\.pdf"/);
});

test('PR con URL no-https (javascript:) se omite (isSafeHttpUrl)', () => {
    assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
    assert.equal(isSafeHttpUrl('http://github.com/x'), false);
    assert.equal(isSafeHttpUrl('https://github.com/intrale/platform/pull/1'), true);
    const html = renderHistorialSsr({ agentHistory: [baseEntry({ prUrl: 'javascript:alert(1)' })] }, opts());
    assert.ok(!html.includes('javascript:alert(1)'), 'no debe inyectar prUrl peligroso');
    assert.ok(!html.includes('ah-act-pr'), 'no debe emitir el botón PR con URL insegura');
});

// --- 7. estado vacío por filtros sin match ---
test('estado vacío — filtro que no matchea muestra "Sin ejecuciones para estos filtros"', () => {
    const html = renderHistorialSsr({ agentHistory: [baseEntry()] }, opts({ skill: 'no-existe' }));
    assert.match(html, /Sin ejecuciones para estos filtros/);
});

// --- 8. XSS en titulo ---
test('XSS en titulo queda escapado (no inyecta <img>)', () => {
    const html = renderHistorialSsr(
        { agentHistory: [baseEntry({ titulo: '<img src=x onerror=alert(1)>' })] }, opts());
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

// --- 9. logFile con breakout → fallback GitHub ---
test('logFile con breakout de atributo se omite y cae a fallback GitHub', () => {
    const entry = baseEntry({ logFile: '"><script>1</script>' });
    const html = renderHistorialSsr({ agentHistory: [entry] }, opts());
    assert.ok(!html.includes('<script>1</script>'));
    assert.ok(!html.includes('/logs/view/"><script>'));
    assert.match(html, /href="https:\/\/github\.com\/intrale\/platform\/issues\/1732"/);
});

// --- 10. XSS en resultado / skill / fase ---
test('XSS en resultado queda escapado (contexto atributo)', () => {
    const html = renderHistorialSsr(
        { agentHistory: [baseEntry({ resultado: '"><svg onload=alert(1)>' })] }, opts());
    assert.ok(!html.includes('<svg onload=alert(1)>'));
});

test('XSS en skill queda escapado', () => {
    const html = renderHistorialSsr(
        { agentHistory: [baseEntry({ skill: '<img onerror=alert(1)>' })] }, opts({ agentPersona: {} }));
    assert.ok(!html.includes('<img onerror=alert(1)>'));
    assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
});

test('XSS en fase queda escapado', () => {
    const html = renderHistorialSsr(
        { agentHistory: [baseEntry({ fase: '"><svg onload=1>' })] }, opts());
    assert.ok(!html.includes('<svg onload=1>'));
    assert.match(html, /&lt;svg onload=1&gt;/);
});

// --- 11. path traversal en logFile / rejectionPdf ---
test('path traversal en logFile se omite (whitelist falla por /)', () => {
    const html = renderHistorialSsr({ agentHistory: [baseEntry({ logFile: '../../etc/passwd' })] }, opts());
    assert.ok(!html.includes('/logs/view/../../etc/passwd'));
    assert.match(html, /href="https:\/\/github\.com\/intrale\/platform\/issues\/1732"/);
});

test('path traversal en rejectionPdf omite el link de reporte', () => {
    const entry = baseEntry({ hasRejectionPdf: true, rejectionPdf: '../../../config', resultado: 'rechazado' });
    const html = renderHistorialSsr({ agentHistory: [entry] }, opts());
    assert.ok(!html.includes('ah-act-pdf'), 'no debe emitir el link de PDF con path inseguro');
    const safe = baseEntry({ hasRejectionPdf: true, rejectionPdf: 'rejection-1732-qa.pdf', resultado: 'rechazado' });
    const htmlSafe = renderHistorialSsr({ agentHistory: [safe] }, opts());
    assert.match(htmlSafe, /href="\/logs\/rejection-1732-qa\.pdf"/);
});

// --- 12. anti-tabnabbing ---
test('todo <a target="_blank"> lleva rel="noopener noreferrer"', () => {
    const html = renderHistorialSsr(
        { agentHistory: [baseEntry({ prUrl: 'https://github.com/intrale/platform/pull/1', hasRejectionPdf: true, rejectionPdf: 'r.pdf', resultado: 'rechazado' })] },
        opts());
    const anchors = html.match(/<a\b[^>]*>/g) || [];
    let blankCount = 0;
    for (const a of anchors) {
        if (a.includes('target="_blank"')) {
            blankCount++;
            assert.ok(a.includes('rel="noopener noreferrer"'), `falta rel en: ${a}`);
        }
    }
    assert.ok(blankCount >= 2, 'debe haber al menos 2 anchors target=_blank');
});

// --- 13. query reflejado escapado (REQ-SEC-1) ---
test('query de búsqueda reflejado en el input queda escapado (XSS reflejado)', () => {
    const html = renderHistorialSsr({ agentHistory: [baseEntry()] }, opts({ q: '"><script>alert(1)</script>' }));
    assert.ok(!html.includes('<script>alert(1)</script>'), 'no debe reflejar el query sin escapar');
    assert.match(html, /value="[^"]*&lt;script&gt;/);
});

// --- 14. orden trabajando-first preservado ---
test('cards trabajando aparecen antes que procesado en el mismo día', () => {
    const list = [
        baseEntry({ issue: 1, estado: 'trabajando', resultado: null, startedAt: NOW - 3 * MIN }),
        baseEntry({ issue: 2, estado: 'procesado', resultado: 'aprobado', finishedAt: NOW - 4 * MIN }),
        baseEntry({ issue: 3, estado: 'procesado', resultado: 'rechazado', finishedAt: NOW - 5 * MIN }),
    ];
    const html = renderHistorialSsr({ agentHistory: list }, opts());
    const firstRunning = html.indexOf('ah-running');
    const firstOk = html.indexOf('ah-item ah-ok');
    const firstFail = html.indexOf('ah-item ah-fail');
    assert.ok(firstRunning >= 0 && firstRunning < firstOk, 'running antes que ok');
    assert.ok(firstRunning < firstFail, 'running antes que fail');
});

// --- 15. paginación SSR + load-more ---
test('más de 50 entradas pagina a 50 y emite botón "ver más"', () => {
    const list = Array.from({ length: 70 }, (_, i) => baseEntry({ issue: i + 1, finishedAt: NOW - i * MIN }));
    const html = renderHistorialSsr({ agentHistory: list }, opts());
    const cards = (html.match(/class="ah-item/g) || []).length;
    assert.ok(cards <= 50, `no debe rendear más de 50 cards (rendeó ${cards})`);
    assert.match(html, /class="ah-load-more"/);
});

// --- 16. isSafeFilename whitelist (heredado) ---
test('isSafeFilename — acepta simples y rechaza traversal/metachar', () => {
    assert.equal(isSafeFilename('dev-1732.log'), true);
    assert.equal(isSafeFilename('../etc/passwd'), false);
    assert.equal(isSafeFilename('a/b'), false);
    assert.equal(isSafeFilename('"><script>'), false);
    assert.equal(isSafeFilename(''), false);
    assert.equal(isSafeFilename(null), false);
});
