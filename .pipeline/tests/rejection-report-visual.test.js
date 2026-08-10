// Tests del bloque side-by-side mockup vs entrega en rejection-report.js
// (Issue #3383, CA-12 / CA-13 / CA-14 / CA-UX-1..6).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    renderVisualComparisonBlock,
    renderHtml,
    generateNarration,
    escapeHtml,
    loadVisualComparison,
    safeImageSrc,
} = require('../rejection-report');

// ----- renderVisualComparisonBlock ----------------------------------------

test('renderVisualComparisonBlock con null retorna vacío (no opt-in, no render)', () => {
    assert.equal(renderVisualComparisonBlock(null), '');
    assert.equal(renderVisualComparisonBlock(undefined), '');
});

test('renderVisualComparisonBlock incluye header VISUAL MISMATCH + ambas columnas (CA-12)', () => {
    const out = renderVisualComparisonBlock({
        mockup: { src: 'https://example.com/m.png' },
        delivery: { src: 'https://example.com/e.png' },
        diffs: [{ title: 'Botón sin gradiente', description: 'falta linear-gradient(--brand-cyan, --brand-blue)', impact: 'alto' }],
    });
    assert.ok(out.includes('VISUAL MISMATCH'));
    assert.ok(out.includes('MOCKUP ESPERADO'));
    assert.ok(out.includes('ENTREGA ACTUAL'));
    assert.ok(out.includes('visual-col-mockup'));
    assert.ok(out.includes('visual-col-delivery'));
});

test('renderVisualComparisonBlock muestra placeholder cuando falta src (CA-UX-4)', () => {
    const out = renderVisualComparisonBlock({
        mockup: {},
        delivery: { src: 'x://e.png' },
        diffs: [],
    });
    assert.ok(out.includes('MOCKUP ESPERADO no disponible'));
    assert.ok(out.includes('visual-placeholder'));
});

test('renderVisualComparisonBlock renderiza 3 secciones (CA-13)', () => {
    const out = renderVisualComparisonBlock({
        mockup: { src: 'x://1.png' },
        delivery: { src: 'x://2.png' },
        diffs: [
            { title: 'A', description: 'a', impact: 'alto' },
            { title: 'B', description: 'b', impact: 'medio' },
            { title: 'C', description: 'c', impact: 'bajo' },
        ],
        suggestedAction: { skill: 'android-dev', text: 'usar tokens del design-system' },
    });
    // (a) mockup esperado, (b) screenshot entrega, (c) diferencias identificadas
    assert.ok(out.includes('MOCKUP ESPERADO'));
    assert.ok(out.includes('ENTREGA ACTUAL'));
    assert.ok(out.includes('Diferencias identificadas'));
    // suggested action incluida
    assert.ok(out.includes('Rebote a android-dev'));
});

test('renderVisualComparisonBlock clasifica impacto en badges (alto/medio/bajo)', () => {
    const out = renderVisualComparisonBlock({
        mockup: { src: 'x://1.png' },
        delivery: { src: 'x://2.png' },
        diffs: [
            { title: 'A', description: 'a', impact: 'alto' },
            { title: 'B', description: 'b', impact: 'medio' },
            { title: 'C', description: 'c', impact: 'bajo' },
        ],
    });
    // alto → badge-red, medio → badge-yellow, bajo → badge-blue
    assert.ok(/badge-red[^"]*">impacto: alto/i.test(out));
    assert.ok(/badge-yellow[^"]*">impacto: medio/i.test(out));
    assert.ok(/badge-blue[^"]*">impacto: bajo/i.test(out));
});

test('renderVisualComparisonBlock muestra inventario completo hasta 50 y declara truncado', () => {
    const tenDiffs = Array.from({ length: 63 }, (_, i) => ({
        section: `S${i % 3}`,
        title: `D${i}`,
        description: `descripción ${i}`,
        impact: 'medio',
    }));
    const out = renderVisualComparisonBlock({
        mockup: { src: 'x://1.png' },
        delivery: { src: 'x://2.png' },
        diffs: tenDiffs,
    });
    assert.ok(out.includes('50 de 63 desvíos mostrados'));
    assert.ok(out.includes('inventario completo en visual-comparison.json'));
    assert.ok(out.includes('sección: S0'));
});

test('renderVisualComparisonBlock escapa HTML del title/description (SEC-1)', () => {
    const out = renderVisualComparisonBlock({
        mockup: { src: 'x://1.png' },
        delivery: { src: 'x://2.png' },
        diffs: [{
            title: '<script>alert(1)</script>',
            description: '"><img onerror=foo>',
            impact: 'alto',
        }],
    });
    assert.ok(!out.includes('<script>alert(1)'));
    assert.ok(out.includes('&lt;script&gt;'));
});

test('renderVisualComparisonBlock redacta secretos de todos los campos textuales visuales', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const out = renderVisualComparisonBlock({
        mockup: { label: secret, subtitle: secret, baseline: secret },
        delivery: { label: secret, subtitle: secret },
        coverage: {
            secciones_declaradas: [secret],
            verificadas: [secret],
            no_verificadas: [],
        },
        diffs: [{ section: secret, title: secret, description: secret, impact: secret }],
        suggestedAction: { skill: secret, text: secret },
    });
    assert.equal(out.includes(secret), false);
    assert.match(out, /\[REDACTED(?::AWS_ACCESS_KEY)?\]/);
});

test('renderVisualComparisonBlock sin diffs muestra mensaje de revisión humana', () => {
    const out = renderVisualComparisonBlock({
        mockup: { src: 'x://1.png' },
        delivery: { src: 'x://2.png' },
        diffs: [],
    });
    assert.ok(out.toLowerCase().includes('revisión humana'));
});

// ----- renderHtml integration ---------------------------------------------

const minimalData = {
    issue: 1234,
    skill: 'qa',
    fase: 'verificacion',
    elapsed: 60,
    motivo: 'Visual mismatch detectado',
    timestamp: '2026-05-20',
    isoDate: '2026-05-20T00:00:00Z',
    issueCtx: { title: 'Probar onboarding paso 2' },
    rejectHistory: [],
    logTail: '',
    readableLog: '',
    depIssues: { linkedDeps: [] },
    autoCreatedDeps: [],
    preflight: { ok: true, line: 'emulator ok' },
    evidence: { video: null, frames: 0, logPath: null, videoBytes: 0, logBytes: 0 },
    primaryCause: { summary: 'Botón sin gradiente', detail: 'falta brand-cyan→brand-blue', priority: 'normal' },
    inconclusive: false,
    sessionCtx: { provider: 'anthropic', model: 'opus-4.7', cliVersion: '0.1.0' },
};

test('renderHtml integra renderVisualComparisonBlock cuando visualComparison está presente', () => {
    const html = renderHtml({
        ...minimalData,
        visualComparison: {
            mockup: { src: 'https://example.com/m.png' },
            delivery: { src: 'https://example.com/e.png' },
            diffs: [{ title: 'Padding incorrecto', description: '24px → 8px', impact: 'medio' }],
            suggestedAction: { skill: 'android-dev', text: 're-aplicar token de spacing' },
        },
    });
    assert.ok(html.includes('Comparativo visual'));
    assert.ok(html.includes('VISUAL MISMATCH'));
    assert.ok(html.includes('Padding incorrecto'));
});

test('renderHtml omite el bloque si no hay visualComparison (backwards compat)', () => {
    const html = renderHtml(minimalData);
    assert.ok(!html.includes('Comparativo visual'));
    assert.ok(!html.includes('VISUAL MISMATCH'));
});

// ----- generateNarration con visualComparison (CA-UX-5) -------------------

test('generateNarration usa diffs cuando hay visualComparison (CA-UX-5, audio < 60s)', () => {
    const text = generateNarration({
        issue: 1234,
        primaryCause: null,
        inconclusive: false,
        autoCreatedDeps: [],
        visualComparison: {
            // #5708 / D8 — la rama visual del audio sólo titula con veredicto
            // de rechazo explícito. Sin `verdict`, el contrato es fail-closed.
            verdict: 'rejected',
            mockup: { src: 'x://1.png' },
            delivery: { src: 'x://2.png' },
            diffs: [
                { title: 'Botón sin gradiente de marca', description: '', impact: 'alto' },
                { title: 'Padding 24 vs 8', description: '', impact: 'medio' },
            ],
            suggestedAction: { skill: 'android-dev', text: '' },
        },
    });
    assert.ok(text.includes('Issue 1234'));
    assert.ok(text.toLowerCase().includes('rechazo visual'));
    assert.ok(text.toLowerCase().includes('botón sin gradiente'));
    assert.ok(text.toLowerCase().includes('android-dev'));
    // Audio < 60s ≈ < 900 chars a 150wpm
    assert.ok(text.length < 900, `narration demasiado larga (${text.length} chars)`);
});

test('generateNarration limita a 3 diffs en audio', () => {
    const text = generateNarration({
        issue: 1234,
        primaryCause: null,
        inconclusive: false,
        autoCreatedDeps: [],
        visualComparison: {
            verdict: 'rejected',
            mockup: { src: 'x' },
            delivery: { src: 'x' },
            diffs: [
                { title: 'A1', impact: 'alto' },
                { title: 'B2', impact: 'medio' },
                { title: 'C3', impact: 'bajo' },
                { title: 'D4', impact: 'bajo' },
                { title: 'E5', impact: 'bajo' },
            ],
            suggestedAction: { skill: 'android-dev' },
        },
    });
    assert.ok(text.includes('A1'));
    assert.ok(text.includes('C3'));
    assert.ok(!text.includes('D4'));
    assert.ok(!text.includes('E5'));
    assert.ok(text.includes('5 desvíos detectados'));
});

test('generateNarration redacta secretos del contrato visual', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const text = generateNarration({
        issue: 1234,
        primaryCause: null,
        inconclusive: false,
        autoCreatedDeps: [],
        visualComparison: {
            verdict: 'rejected',
            diffs: [{ title: secret, impact: secret }],
            suggestedAction: { skill: secret },
        },
    });
    assert.equal(text.includes(secret), false);
    assert.match(text, /\[REDACTED(?::AWS_ACCESS_KEY)?\]/);
});

test('loader confina paths y las imágenes rechazan esquemas remotos', () => {
    // #5708 — el loader ya no devuelve `null` mudo: declara SIEMPRE el motivo.
    assert.equal(loadVisualComparison(5708, '../../../etc/passwd', 1).skip.reason, 'unreadable');
    assert.equal(loadVisualComparison('no-numérico', null, 1).skip.reason, 'unreadable');
    assert.equal(safeImageSrc('https://example.com/a.png', 5708), null);
    assert.equal(safeImageSrc('file:///etc/passwd', 5708), null);
    assert.match(safeImageSrc('data:image/png;base64,AAAA', 5708), /^data:image\/png/);
});

test('escapeHtml escapa comilla simple', () => {
    assert.equal(escapeHtml("'"), '&#39;');
});

test('generateNarration sin visualComparison no menciona visual', () => {
    const text = generateNarration({
        issue: 1234,
        primaryCause: { summary: 'algo' },
        inconclusive: false,
        autoCreatedDeps: [],
    });
    assert.ok(!text.toLowerCase().includes('rechazo visual'));
});
