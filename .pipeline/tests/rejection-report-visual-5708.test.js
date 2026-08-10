// #5708 — CA-8..CA-17: el bloque visual no puede secuestrar la narración de un
// rechazo ajeno, y ninguna supresión puede leerse como "no hubo desvíos".
//
// Complementa `rejection-report-visual.test.js` (#3383), que cubre el render del
// inventario con contrato válido.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
    renderHtml,
    generateNarration,
    loadVisualComparison,
    safeImageSrc,
} = require('../rejection-report');
const { MAX_VISUAL_JSON_BYTES } = require('../lib/visual-contract-limits');
const shapeGate = require('../hooks/visual-report-shape-gate');

const ROOT = path.resolve(__dirname, '..', '..');
// Issue de prueba fuera del rango real. Vive bajo `qa/evidence/` porque es el
// único directorio al que el loader confina.
const ISSUE = '999002';
const DIR = path.join(ROOT, 'qa', 'evidence', ISSUE);
const FIXTURES = path.join(__dirname, 'fixtures');

const minimalData = {
    issue: ISSUE,
    skill: 'qa',
    fase: 'verificacion',
    elapsed: 60,
    motivo: 'Visual mismatch detectado',
    timestamp: '2026-08-10',
    isoDate: '2026-08-10T00:00:00Z',
    issueCtx: { title: 'QA visual: inventario completo' },
    rejectHistory: [],
    logTail: '',
    readableLog: '',
    depIssues: { linkedDeps: [] },
    autoCreatedDeps: [],
    preflight: { ok: true, line: 'emulador ok' },
    evidence: { video: null, frames: 0, logPath: null, videoBytes: 0, logBytes: 0 },
    primaryCause: null,
    inconclusive: false,
    sessionCtx: { provider: 'anthropic', model: 'opus-4.7', cliVersion: '0.1.0' },
};

function escribirContrato(nombreFixture, override) {
    fs.mkdirSync(DIR, { recursive: true });
    const base = JSON.parse(fs.readFileSync(path.join(FIXTURES, nombreFixture), 'utf8'));
    const contrato = { ...base, ...(override || {}) };
    const target = path.join(DIR, 'visual-comparison.json');
    fs.writeFileSync(target, JSON.stringify(contrato, null, 2), 'utf8');
    return target;
}

function limpiar() {
    fs.rmSync(DIR, { recursive: true, force: true });
}

// Captura stderr para afirmar que NINGÚN skip es silencioso (SEC-4).
function capturandoStderr(fn) {
    const original = console.error;
    const lineas = [];
    console.error = (...args) => lineas.push(args.join(' '));
    try {
        return { valor: fn(), lineas };
    } finally {
        console.error = original;
    }
}

function conFlagGate(valor, fn) {
    const previo = process.env[shapeGate.FLAG_ENV_NAME];
    if (valor === undefined) delete process.env[shapeGate.FLAG_ENV_NAME];
    else process.env[shapeGate.FLAG_ENV_NAME] = valor;
    try {
        return fn();
    } finally {
        if (previo === undefined) delete process.env[shapeGate.FLAG_ENV_NAME];
        else process.env[shapeGate.FLAG_ENV_NAME] = previo;
    }
}

test.beforeEach(limpiar);
test.after(limpiar);

// ----- CA-8 · discriminante de veredicto ----------------------------------

test('CA-8: verdict approved NO devuelve contrato y declara el motivo', () => {
    const target = escribirContrato('visual-comparison-approved.json');
    const { valor, lineas } = capturandoStderr(() => loadVisualComparison(ISSUE, target, 3));
    assert.equal(valor.contract, null);
    assert.equal(valor.skip.reason, 'verdict-approved');
    assert.ok(lineas.some(l => l.includes('verdict-approved')), 'el skip debe loguearse, nunca ser mudo');
});

test('CA-8 · UX-13: un aprobado no emite el badge VISUAL MISMATCH en el PDF', () => {
    const target = escribirContrato('visual-comparison-approved.json');
    const { contract, skip } = loadVisualComparison(ISSUE, target, 3);
    const html = renderHtml({ ...minimalData, visualComparison: contract, visualSkip: skip });
    assert.equal(html.includes('VISUAL MISMATCH'), false);
    assert.ok(html.includes('data-visual-state="E2"'));
    // E2 sí muestra la cobertura: es la línea base de la próxima pasada.
    assert.ok(html.includes('Cobertura visual declarada'));
});

test('CA-8: verdict ausente es fail-closed con motivo verdict-missing', () => {
    const target = escribirContrato('visual-comparison-rejected.json', { verdict: undefined });
    const { valor, lineas } = capturandoStderr(() => loadVisualComparison(ISSUE, target, 3));
    assert.equal(valor.contract, null);
    assert.equal(valor.skip.reason, 'verdict-missing');
    assert.ok(lineas.some(l => l.includes('verdict-missing')));
});

// ----- CA-9 · `rev` con consumidor real ------------------------------------

test('CA-9: contrato de otra pasada se descarta con log stale-rev', () => {
    const target = escribirContrato('visual-comparison-rejected.json', { rev: 1 });
    const { valor, lineas } = capturandoStderr(() => loadVisualComparison(ISSUE, target, 3));
    assert.equal(valor.contract, null);
    assert.equal(valor.skip.reason, 'stale-rev');
    assert.match(valor.skip.detail, /rev 1 vs actual 3/);
    assert.ok(lineas.some(l => l.includes('stale-rev')));
});

test('CA-9: sin --rev el bloque se suprime con rev-unknown (fail-closed)', () => {
    const target = escribirContrato('visual-comparison-rejected.json');
    const { valor } = capturandoStderr(() => loadVisualComparison(ISSUE, target, null));
    assert.equal(valor.contract, null);
    assert.equal(valor.skip.reason, 'rev-unknown');
    const html = renderHtml({ ...minimalData, visualComparison: null, visualSkip: valor.skip });
    assert.ok(html.includes('data-visual-state="E3"'));
    assert.equal(html.includes('VISUAL MISMATCH'), false);
});

test('CA-9: contrato de la pasada actual sí se carga', () => {
    const target = escribirContrato('visual-comparison-rejected.json');
    const { contract, skip } = loadVisualComparison(ISSUE, target, 3);
    assert.equal(skip, null);
    assert.equal(contract.diffs.length, 4);
});

// ----- CA-10 / CA-17 / SEC-11 · orden de narración -------------------------

test('CA-10 · SEC-11: un rechazo de security narra la causa real, no el visual', () => {
    const target = escribirContrato('visual-comparison-rejected.json');
    const { contract } = loadVisualComparison(ISSUE, target, 3);
    const text = generateNarration({
        issue: 5708,
        skill: 'security',
        primaryCause: { summary: 'secreto hardcodeado en ClientLoginService.kt' },
        inconclusive: false,
        autoCreatedDeps: [],
        visualComparison: contract,
    });
    const primeraOracion = text.split('.').slice(0, 2).join('.');
    assert.ok(primeraOracion.includes('secreto hardcodeado'), `la primera oración debe narrar la causa real: ${text}`);
    assert.equal(text.toLowerCase().startsWith('issue 5708: rechazo visual'), false);
    // Los desvíos visuales siguen apareciendo — como sufijo, nunca como titular.
    assert.match(text, /Además, 4 desvíos visuales\./);
});

test('CA-10: un rechazo inconcluyente tampoco lo secuestra el bloque visual', () => {
    const text = generateNarration({
        issue: 5708,
        inconclusive: true,
        autoCreatedDeps: [],
        visualComparison: { verdict: 'rejected', diffs: [{ title: 'x', impact: 'alto' }] },
    });
    assert.ok(text.includes('rechazo inconcluyente'));
    assert.match(text, /Además, 1 desvíos visuales\./);
});

test('UX-12: los estados degradados se narran como sufijo, nunca como titular', () => {
    const stale = generateNarration({
        issue: 5708,
        primaryCause: { summary: 'tests del modulo users fallan' },
        autoCreatedDeps: [],
        visualSkip: { reason: 'stale-rev', detail: 'rev 1 vs actual 3' },
    });
    assert.ok(stale.startsWith('Issue 5708: rechazado. Causa: tests del modulo users fallan'));
    assert.ok(stale.includes('pasada anterior'));

    const fail = generateNarration({
        issue: 5708,
        primaryCause: { summary: 'linter rojo' },
        autoCreatedDeps: [],
        visualSkip: { reason: 'oversize', detail: 'size 2000000 B > MAX_VISUAL_JSON_BYTES 1048576' },
    });
    assert.ok(fail.includes('La evidencia visual no se pudo evaluar en esta pasada.'));
});

test('CA-10: sin primaryCause ni inconclusive, el visual sí titula', () => {
    const text = generateNarration({
        issue: 5708,
        primaryCause: null,
        inconclusive: false,
        autoCreatedDeps: [],
        visualComparison: {
            verdict: 'rejected',
            diffs: [{ title: 'A3 nunca se pinta en rojo', impact: 'alto' }],
            suggestedAction: { skill: 'pipeline-dev' },
        },
    });
    assert.ok(text.toLowerCase().includes('rechazo visual'));
});

// ----- CA-13 · topes declarados, nunca `null` mudo -------------------------

test('CA-13: superar el tope de bytes es fallo DECLARADO con banda E4 y sufijo', () => {
    fs.mkdirSync(DIR, { recursive: true });
    const target = path.join(DIR, 'visual-comparison.json');
    const relleno = 'x'.repeat(MAX_VISUAL_JSON_BYTES + 1);
    fs.writeFileSync(target, JSON.stringify({ verdict: 'rejected', rev: 3, relleno }), 'utf8');
    const { valor, lineas } = capturandoStderr(() => loadVisualComparison(ISSUE, target, 3));
    assert.equal(valor.contract, null);
    assert.equal(valor.skip.reason, 'oversize');
    assert.match(valor.skip.detail, new RegExp(`> MAX_VISUAL_JSON_BYTES ${MAX_VISUAL_JSON_BYTES}`));
    assert.ok(lineas.some(l => l.includes('oversize')), 'el oversize no puede ser silencioso (SEC-4)');

    const html = renderHtml({ ...minimalData, visualComparison: null, visualSkip: valor.skip });
    assert.ok(html.includes('data-visual-state="E4"'));
    assert.ok(html.includes('NO significa'), 'E4 debe desambiguar frente a «sin desvíos» (UX-11)');
    assert.ok(html.includes(`MAX_VISUAL_JSON_BYTES ${MAX_VISUAL_JSON_BYTES}`), 'el motivo va medido en bytes (UX-11)');
    assert.equal(html.includes('VISUAL MISMATCH'), false);

    const audio = generateNarration({ issue: 5708, primaryCause: null, autoCreatedDeps: [], visualSkip: valor.skip });
    assert.ok(audio.includes('La evidencia visual no se pudo evaluar en esta pasada.'));
});

test('CA-13: un JSON ilegible declara unreadable, no null mudo', () => {
    fs.mkdirSync(DIR, { recursive: true });
    const target = path.join(DIR, 'visual-comparison.json');
    fs.writeFileSync(target, '{ esto no es json', 'utf8');
    const { valor, lineas } = capturandoStderr(() => loadVisualComparison(ISSUE, target, 3));
    assert.equal(valor.skip.reason, 'unreadable');
    assert.ok(lineas.length > 0);
});

// ----- CA-14 / SEC-8 · imágenes por referencia -----------------------------

test('CA-14 · SEC-8: un contrato con base64 embebido se rechaza', () => {
    const target = escribirContrato('visual-comparison-rejected.json', {
        mockup: { src: 'data:image/png;base64,iVBORw0KGgo=' },
    });
    const { valor } = capturandoStderr(() => loadVisualComparison(ISSUE, target, 3));
    assert.equal(valor.contract, null);
    assert.equal(valor.skip.reason, 'contract-embeds-base64');
    assert.equal(valor.skip.detail, 'mockup');
});

test('CA-14: safeImageSrc resuelve el path relativo contra qa/evidence/<issue>', () => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, 'render-rev3.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    const src = safeImageSrc('render-rev3.png', ISSUE);
    assert.match(src, /^data:image\/png;base64,/);
    // Y sigue confinado: no se puede salir del directorio del issue.
    assert.equal(safeImageSrc('../../../package.json', ISSUE), null);
});

test('CA-14: los fixtures versionados no contienen base64', () => {
    for (const nombre of fs.readdirSync(FIXTURES)) {
        const raw = fs.readFileSync(path.join(FIXTURES, nombre), 'utf8');
        assert.equal(raw.includes('data:image'), false, `${nombre} no puede embeber imágenes`);
    }
});

// ----- CA-16 / SEC-10 · call-site real del guardrail -----------------------

test('CA-16 · SEC-10: con el flag ON, una cobertura incompleta no se renderiza', () => {
    const target = escribirContrato('visual-comparison-coverage-incompleta.json');
    const cargado = conFlagGate('1', () => capturandoStderr(() => loadVisualComparison(ISSUE, target, 3)).valor);
    assert.equal(cargado.contract, null);
    assert.equal(cargado.skip.reason, 'shape-gate-block');
    assert.match(cargado.skip.detail, /coverage-incomplete/);

    const html = renderHtml({ ...minimalData, visualComparison: null, visualSkip: cargado.skip });
    assert.equal(html.includes('A3 nunca se pinta en rojo'), false, 'el inventario no puede renderizarse');
    assert.ok(html.includes('data-visual-state="E4"'));
});

test('CA-6: con el flag OFF (default) el mismo contrato SÍ se renderiza', () => {
    const target = escribirContrato('visual-comparison-coverage-incompleta.json');
    const cargado = conFlagGate(undefined, () => loadVisualComparison(ISSUE, target, 3));
    assert.equal(cargado.skip, null);
    const html = renderHtml({ ...minimalData, visualComparison: cargado.contract, visualSkip: null });
    assert.ok(html.includes('A3 nunca se pinta en rojo'));
    assert.ok(html.includes('VISUAL MISMATCH'));
});

// ----- E1 · sin contrato en disco no hay banda ------------------------------

test('E1: sin visual-comparison.json no hay skip ni banda (rechazo no visual)', () => {
    const { valor, lineas } = capturandoStderr(() => loadVisualComparison(ISSUE, null, 3));
    assert.equal(valor.contract, null);
    assert.equal(valor.skip, null);
    assert.equal(lineas.length, 0, 'la ausencia de contrato no es una supresión: no se loguea');
    const html = renderHtml({ ...minimalData, visualComparison: null, visualSkip: null });
    assert.equal(html.includes('Comparativo visual'), false);
});
