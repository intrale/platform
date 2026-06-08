// =============================================================================
// Tests SSR de la ventana Historial (#3734, split del épico #3715).
//
// Cubre los CA-11..CA-17 del PO + REQ-SEC del análisis security:
//   1.  CA-11 — render vacío → string vacío (no rendea wrapper).
//   2.        — render básico → wrapper + 1 card.
//   3.  CA-12 — XSS en `titulo` escapado.
//   4.  CA-13 — XSS en `logFile` → link omitido + fallback GitHub.
//   5.  CA-14 — XSS en `resultado` escapado.
//   6.        — XSS en `skill` escapado (body + atributo title).
//   7.        — XSS en `fase` escapado.
//   8.  CA-15 — path traversal en `logFile` → link omitido.
//   9.        — path traversal en `rejectionPdf` → <a ah-pdf> omitido.
//   10. CA-16 — anti-tabnabbing: todo <a target="_blank"> lleva rel.
//   11. CA-17 — orden trabajando-first respetado.
//   12.        — coerción de `issue` no numérico → prioActions omitido.
//
// node:test (sin Jest). Render directo del módulo, sin arrancar dashboard.js.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const HIST_PATH = path.resolve(__dirname, '..', 'historial.js');
const { renderHistorialSsr, isSafeFilename } = require(HIST_PATH);

// Opts mínimos válidos (igual que los inyecta el padre).
function opts(extra) {
    return Object.assign({
        agentPersona: { 'pipeline-dev': { icon: '⚙', name: 'PipeDev', color: '#a371f7' } },
        manualOrderIndex: new Map(),
        fmtDuration: (ms) => `${Math.round((ms || 0) / 1000)}s`,
        ghBaseUrl: 'https://github.com/intrale/platform/issues',
    }, extra || {});
}

// Entrada base finalizada aprobada.
function baseEntry(extra) {
    return Object.assign({
        issue: 1732,
        titulo: 'Mi issue',
        skill: 'pipeline-dev',
        pipeline: 'desarrollo',
        fase: 'dev',
        estado: 'procesado',
        resultado: 'aprobado',
        duration: 5000,
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_100_000,
        hasLog: true,
        logFile: 'dev-1732.log',
        hasRejectionPdf: false,
        rejectionPdf: null,
    }, extra || {});
}

// --- 1. CA-11: render vacío ---
test('CA-11 — agentHistory vacío retorna string vacío (no rendea wrapper)', () => {
    assert.equal(renderHistorialSsr({ agentHistory: [] }, opts()), '');
    assert.equal(renderHistorialSsr({}, opts()), '');
    assert.equal(renderHistorialSsr(null, opts()), '');
});

// --- 2. render básico ---
test('render básico — 1 entrada aprobada produce wrapper + 1 card', () => {
    const html = renderHistorialSsr({ agentHistory: [baseEntry()] }, opts());
    assert.match(html, /id="agent-history"/);
    assert.match(html, /data-section="historial"/);
    assert.match(html, /class="ah-list"/);
    assert.match(html, /class="ah-card ah-ok"/);
    assert.match(html, /1 ejecuciones/);
});

// --- 3. CA-12: XSS en titulo ---
test('CA-12 — XSS en titulo queda escapado (no inyecta <img>)', () => {
    const html = renderHistorialSsr(
        { agentHistory: [baseEntry({ titulo: '<img src=x onerror=alert(1)>' })] },
        opts()
    );
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'no debe contener el tag literal');
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

// --- 4. CA-13: XSS + breakout en logFile → link omitido, fallback GitHub ---
test('CA-13 — logFile con breakout de atributo se omite y cae a fallback GitHub', () => {
    const entry = baseEntry({ logFile: '"><script>1</script>' });
    const html = renderHistorialSsr({ agentHistory: [entry] }, opts());
    assert.ok(!html.includes('<script>1</script>'), 'no debe inyectar script sin escapar');
    assert.ok(!html.includes('/logs/view/"><script>'), 'no debe usar el logFile peligroso en href');
    // Fallback al issue de GitHub con issue numérico.
    assert.match(html, /href="https:\/\/github\.com\/intrale\/platform\/issues\/1732"/);
});

// --- 5. CA-14: XSS en resultado ---
test('CA-14 — XSS en resultado queda escapado', () => {
    const html = renderHistorialSsr(
        { agentHistory: [baseEntry({ estado: 'procesado', resultado: '"><svg onload=alert(1)>' })] },
        opts()
    );
    assert.ok(!html.includes('<svg onload=alert(1)>'), 'no debe inyectar svg');
    assert.match(html, /&lt;svg onload=alert\(1\)&gt;/);
});

// --- 6. XSS en skill (body + atributo) ---
test('XSS en skill queda escapado en .ah-skill y en title=', () => {
    const persona = {}; // sin persona → usa h.skill como name
    const html = renderHistorialSsr(
        { agentHistory: [baseEntry({ skill: '<img onerror=alert(1)>', hasLog: true, logFile: 'x.log' })] },
        opts({ agentPersona: persona })
    );
    assert.ok(!html.includes('<img onerror=alert(1)>'), 'no debe inyectar img sin escapar');
    assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
});

// --- 7. XSS en fase ---
test('XSS en fase queda escapado en .ah-fase', () => {
    const html = renderHistorialSsr(
        { agentHistory: [baseEntry({ fase: '"><svg onload=1>' })] },
        opts()
    );
    assert.ok(!html.includes('<svg onload=1>'), 'no debe inyectar svg');
    assert.match(html, /&lt;svg onload=1&gt;/);
});

// --- 8. CA-15: path traversal en logFile ---
test('CA-15 — path traversal en logFile se omite (whitelist falla por /)', () => {
    const entry = baseEntry({ logFile: '../../etc/passwd' });
    const html = renderHistorialSsr({ agentHistory: [entry] }, opts());
    assert.ok(!html.includes('/logs/view/../../etc/passwd'), 'no debe inyectar el path traversal');
    assert.match(html, /href="https:\/\/github\.com\/intrale\/platform\/issues\/1732"/);
});

// --- 9. path traversal en rejectionPdf ---
test('CA-15 — path traversal en rejectionPdf omite el link ah-pdf', () => {
    const entry = baseEntry({ hasRejectionPdf: true, rejectionPdf: '../../../config' });
    const html = renderHistorialSsr({ agentHistory: [entry] }, opts());
    assert.ok(!html.includes('ah-pdf'), 'no debe emitir el link de PDF con path inseguro');
    // Filename seguro sí emite el link.
    const safe = baseEntry({ hasRejectionPdf: true, rejectionPdf: 'rejection-1732-qa.pdf' });
    const htmlSafe = renderHistorialSsr({ agentHistory: [safe] }, opts());
    assert.match(htmlSafe, /class="ah-pdf" href="\/logs\/rejection-1732-qa\.pdf"/);
});

// --- 10. CA-16: anti-tabnabbing ---
test('CA-16 — todo <a target="_blank"> lleva rel="noopener noreferrer"', () => {
    const html = renderHistorialSsr(
        { agentHistory: [baseEntry({ hasRejectionPdf: true, rejectionPdf: 'r.pdf' }), baseEntry({ issue: 99 })] },
        opts()
    );
    // Extraer cada apertura de <a ...> y verificar.
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

// --- 11. CA-17: orden trabajando-first ---
test('CA-17 — cards trabajando aparecen antes que procesado (respeta orden del padre)', () => {
    // El padre ya ordena; el módulo no reordena. Pasamos ya ordenado: 2 trabajando, 3 procesado.
    const list = [
        baseEntry({ issue: 1, estado: 'trabajando', resultado: null }),
        baseEntry({ issue: 2, estado: 'trabajando', resultado: null }),
        baseEntry({ issue: 3, estado: 'procesado', resultado: 'aprobado' }),
        baseEntry({ issue: 4, estado: 'procesado', resultado: 'rechazado' }),
        baseEntry({ issue: 5, estado: 'procesado', resultado: 'aprobado' }),
    ];
    const html = renderHistorialSsr({ agentHistory: list }, opts());
    const firstRunning = html.indexOf('ah-running');
    const firstOk = html.indexOf('ah-ok');
    const firstFail = html.indexOf('ah-fail');
    assert.ok(firstRunning >= 0 && firstRunning < firstOk, 'running antes que ok');
    assert.ok(firstRunning < firstFail, 'running antes que fail');
});

// --- 12. coerción de issue no numérico ---
test('coerción — issue no numérico (NaN) omite prioActions en card en ejecución', () => {
    const entry = baseEntry({ issue: '1234; alert(1)', estado: 'trabajando', resultado: null });
    const html = renderHistorialSsr({ agentHistory: [entry] }, opts());
    assert.ok(!html.includes('ah-prio-actions'), 'prioActions debe omitirse si Number(issue) es NaN');
    // El issue se rendea como texto escapado en .ah-issue (inofensivo), pero NO
    // debe aparecer en ningún contexto ejecutable (onclick / handlers de prio).
    assert.ok(!html.includes('issueMoveToTop'), 'no debe haber handler de prio con issue inválido');
    assert.ok(!/onclick="[^"]*alert\(1\)/.test(html), 'no debe inyectar el payload dentro de onclick');
    // Issue numérico válido en ejecución sí rendea prioActions.
    const ok = baseEntry({ issue: 55, estado: 'trabajando', resultado: null });
    const htmlOk = renderHistorialSsr({ agentHistory: [ok] }, opts());
    assert.match(htmlOk, /issueMoveToTop\(55\)/);
});

// --- extra: isSafeFilename whitelist ---
test('isSafeFilename — acepta filenames simples y rechaza traversal/metachar', () => {
    assert.equal(isSafeFilename('dev-1732.log'), true);
    assert.equal(isSafeFilename('rejection-1.pdf'), true);
    assert.equal(isSafeFilename('../etc/passwd'), false);
    assert.equal(isSafeFilename('a/b'), false);
    assert.equal(isSafeFilename('"><script>'), false);
    assert.equal(isSafeFilename(''), false);
    assert.equal(isSafeFilename(null), false);
    assert.equal(isSafeFilename(undefined), false);
});

// --- extra: cap de 50 + toggle "ver más" ---
test('cap de 50 — más de 15 entradas genera toggle "ver más" y no excede 50', () => {
    const list = Array.from({ length: 60 }, (_, i) => baseEntry({ issue: i + 1 }));
    const html = renderHistorialSsr({ agentHistory: list }, opts());
    assert.match(html, /class="ah-more"/);
    assert.match(html, /Ver 35 más…/); // min(60-15, 50-15) = 35
    const cards = (html.match(/class="ah-card/g) || []).length;
    assert.ok(cards <= 50, `no debe rendear más de 50 cards (rendeó ${cards})`);
});
