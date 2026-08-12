// #5708 — CA-18..CA-24: la revisión 2 del contrato visual.
//
// Los CA-8..CA-17 (cubiertos en `rejection-report-visual-5708.test.js`) dejaron
// el contrato seguro de consumir: discriminante de veredicto, consumidor de
// `rev`, emisor acotado, topes con fallo declarado. Lo que cierran estos otros
// es la otra mitad del problema: que cada supresión se describa con el MOTIVO
// CORRECTO.
//
// Una banda que dice "el contrato no se pudo cargar" cuando el contrato se leyó
// perfecto manda al dev a diagnosticar el archivo en vez de re-ejecutar el
// barrido. Es el mismo defecto que ataca este issue —afirmar algo que la pasada
// no verificó— aplicado al propio reporte.
//
// Fuente normativa: `.pipeline/assets/mockups/50-visual-block-rev2-states.svg`
// + `.pipeline/assets/mockups/5708/ux-criterios-5708-addendum2.md` (UX-14..UX-19).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
    renderHtml,
    generateNarration,
    loadVisualComparison,
    resolveImageSrc,
    renderVisualComparisonBlock,
} = require('../rejection-report');
const store = require('../lib/visual-coverage-store');
const shapeGate = require('../hooks/visual-report-shape-gate');

const ROOT = path.resolve(__dirname, '..', '..');
// Issue de prueba fuera del rango real, bajo `qa/evidence/` porque es el único
// directorio al que el loader confina.
const ISSUE = '999003';
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

// Captura stderr: ningún skip puede ser silencioso (SEC-4).
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

// ----- CA-18 / UX-14 · E6: barrido no aceptado no es falla de carga --------

test('CA-18: shape-gate-block pinta la banda E6, no la E4 de falla de carga', () => {
    const target = escribirContrato('visual-comparison-coverage-incompleta.json');
    const cargado = conFlagGate('1', () => capturandoStderr(() => loadVisualComparison(ISSUE, target, 3)).valor);
    assert.equal(cargado.skip.reason, 'shape-gate-block');

    const html = renderHtml({ ...minimalData, visualComparison: null, visualSkip: cargado.skip });
    assert.ok(html.includes('data-visual-state="E6"'), 'debe ser banda propia E6');
    assert.ok(html.includes('BARRIDO VISUAL NO ACEPTADO'), 'la etiqueta debe nombrar el barrido');
    // Criterio de cierre literal de CA-18.
    assert.equal(html.includes('el contrato no se pudo cargar'), false,
        'E6 no puede describirse como falla de carga: el contrato se leyó bien');
    assert.ok(html.includes('El contrato se leyó correctamente'), 'debe afirmar que la lectura sí funcionó');
    // Símbolo distinguible por FORMA, no sólo por color (PDF monocromo).
    assert.ok(html.includes('visual-band-symbol-partial'), 'E6 lleva símbolo propio, distinto de la cruz de E4');
    assert.equal(html.includes('VISUAL MISMATCH'), false, 'UX-19: ninguna banda degradada emite el badge');
});

test('CA-18: la acción de E6 manda a re-ejecutar el barrido, no a revisar el archivo', () => {
    const target = escribirContrato('visual-comparison-coverage-incompleta.json');
    const cargado = conFlagGate('1', () => capturandoStderr(() => loadVisualComparison(ISSUE, target, 3)).valor);
    const html = renderHtml({ ...minimalData, visualComparison: null, visualSkip: cargado.skip });
    assert.ok(html.includes('re-ejecutar QA visual con barrido completo'));
    // El motivo objetivable del guardrail sigue visible en el pie monoespaciado.
    assert.ok(html.includes('coverage-incomplete'));
});

// ----- CA-19 / UX-15 · E3b: no atribuible no es lo mismo que vieja --------

test('CA-19: rev-unknown NO afirma que la evidencia sea de otra pasada', () => {
    const target = escribirContrato('visual-comparison-rejected.json');
    const { valor } = capturandoStderr(() => loadVisualComparison(ISSUE, target, null));
    assert.equal(valor.skip.reason, 'rev-unknown');

    const html = renderHtml({ ...minimalData, visualComparison: null, visualSkip: valor.skip });
    // Criterio de cierre literal de CA-19.
    assert.equal(html.includes('corresponde a una pasada anterior'), false,
        'con rev-unknown el contrato puede ser el de esta misma pasada: afirmarlo inventa un hecho');
    assert.ok(html.includes('data-visual-state="E3b"'));
    assert.ok(html.includes('NO ATRIBUIBLE A ESTA PASADA'));
    assert.ok(html.includes('se afirma que no se sabe'));
    // La acción apunta al EMISOR: el dev no puede arreglar que no llegue --rev.
    assert.ok(html.includes('el emisor debe pasar la pasada actual'));
});

test('CA-19: E3b es distinguible de E3 (stale-rev) por estado y por copy', () => {
    const target = escribirContrato('visual-comparison-rejected.json', { rev: 1 });
    const stale = capturandoStderr(() => loadVisualComparison(ISSUE, target, 3)).valor.skip;
    const htmlStale = renderHtml({ ...minimalData, visualComparison: null, visualSkip: stale });
    assert.ok(htmlStale.includes('data-visual-state="E3"'));
    // stale-rev SÍ puede afirmar que es vieja: tenemos las dos revisiones y no coinciden.
    assert.ok(htmlStale.includes('corresponde a una pasada anterior'));

    const unknown = capturandoStderr(() => loadVisualComparison(ISSUE, target, null)).valor.skip;
    const htmlUnknown = renderHtml({ ...minimalData, visualComparison: null, visualSkip: unknown });
    assert.equal(htmlUnknown.includes('data-visual-state="E3"'), false);
    assert.ok(htmlUnknown.includes('data-visual-state="E3b"'));
});

// ----- CA-21 / UX-17 · tres estados de regresión, no dos -------------------

test('CA-21: sin línea base ningún hallazgo puede decir NO ES REGRESIÓN', () => {
    const target = escribirContrato('visual-comparison-rejected.json');
    const { contract } = loadVisualComparison(ISSUE, target, 3);
    assert.equal(contract.regressionBaselineRev, null);

    const html = renderHtml({ ...minimalData, visualComparison: contract, visualSkip: null });
    // Criterio de cierre literal de CA-21.
    assert.equal(html.includes('NO ES REGRESIÓN'), false,
        'sin store previo no hay nada tipificado: decir «no es regresión» afirma una verificación inexistente');
    assert.ok(html.includes('SIN LÍNEA BASE'));
    assert.ok(html.includes('no hay pasada previa registrada'));
    // La distinción sobrevive al monocromo: textura además del texto.
    assert.ok(html.includes('badge-textured'));
});

test('CA-21: con línea base se distinguen REGRESIÓN y NO ES REGRESIÓN', () => {
    // rev2 declaró A y B verificadas, con hallazgo sólo en B.
    store.writeCoverage({
        issue: ISSUE, rev: 2, baseDir: DIR,
        coverage: { secciones_declaradas: ['A', 'B'], verificadas: ['A', 'B'] },
        diffs: [{ section: 'B' }],
    });
    const target = escribirContrato('visual-comparison-rejected.json', {
        rev: 3,
        coverage: { secciones_declaradas: ['A', 'B'], verificadas: ['A', 'B'], no_verificadas: [] },
        diffs: [
            { section: 'A', title: 'desvio nuevo en A', description: 'x', impact: 'alto' },
            { section: 'B', title: 'el mismo desvio de B', description: 'y', impact: 'alto' },
        ],
    });
    const { contract } = loadVisualComparison(ISSUE, target, 3);
    assert.equal(contract.regressionBaselineRev, 2);
    assert.deepEqual(contract.diffs.map(d => d.regressionState), ['regression', 'not-regression']);

    const html = renderHtml({ ...minimalData, visualComparison: contract, visualSkip: null });
    assert.ok(html.includes('REGRESIÓN · verificada sin hallazgos en rev 2'));
    // B SÍ fue verificada en rev2 — sólo que ya tenía hallazgos. Decir «sección
    // no verificada» sobre una sección que se barrió es inventar un hecho.
    assert.ok(html.includes('NO ES REGRESIÓN · ya tenía hallazgos en rev 2'));
    assert.equal(html.includes('NO ES REGRESIÓN · sección no verificada'), false);
    // Con línea base registrada, «sin línea base» no puede aparecer.
    assert.equal(html.includes('SIN LÍNEA BASE'), false);
});

test('CA-21: «no es regresión» distingue sección no barrida de sección con hallazgo previo', () => {
    // rev2 barrió sólo A; B quedó fuera del barrido.
    store.writeCoverage({
        issue: ISSUE, rev: 2, baseDir: DIR,
        coverage: { secciones_declaradas: ['A', 'B'], verificadas: ['A'] },
        diffs: [{ section: 'A' }],
    });
    const informe = store.deriveRegressionReport({
        issue: ISSUE, rev: 3, baseDir: DIR,
        diffs: [{ section: 'A' }, { section: 'B' }],
    });
    assert.deepEqual(informe.states, ['not-regression', 'not-regression']);
    // Mismo estado, motivos distintos: A se barrió y ya fallaba; B nunca se barrió.
    assert.deepEqual(informe.reasons, ['prev-had-findings', 'prev-not-verified']);

    const target = escribirContrato('visual-comparison-rejected.json', {
        rev: 3,
        coverage: { secciones_declaradas: ['A', 'B'], verificadas: ['A', 'B'], no_verificadas: [] },
        diffs: [
            { section: 'A', title: 'pendiente conocido', description: 'x', impact: 'alto' },
            { section: 'B', title: 'hallazgo tardio', description: 'y', impact: 'alto' },
        ],
    });
    const { contract } = loadVisualComparison(ISSUE, target, 3);
    const html = renderHtml({ ...minimalData, visualComparison: contract, visualSkip: null });
    assert.ok(html.includes('NO ES REGRESIÓN · ya tenía hallazgos en rev 2'));
    assert.ok(html.includes('NO ES REGRESIÓN · sección no verificada en rev 2'));
});

// ----- CA-22 / UX-18 · placeholder con motivo, badge «sin captura» ---------

test('CA-22: una entrega sin captura no puede llevar el badge «no matchea»', () => {
    fs.mkdirSync(DIR, { recursive: true });
    const resuelto = resolveImageSrc('render-que-no-existe.png', ISSUE);
    assert.equal(resuelto.src, null);
    assert.match(resuelto.reason, /ausente/);

    const html = renderVisualComparisonBlock({
        issue: ISSUE,
        mockup: { src: 'mockup-que-no-existe.png' },
        delivery: { src: 'render-que-no-existe.png' },
        diffs: [],
    }, ISSUE, null);
    assert.ok(html.includes('sin captura'), 'la columna sin imagen lleva badge «sin captura»');
    assert.equal(html.includes('no matchea'), false,
        '«no matchea» afirma el resultado de una comparación que no se hizo');
    assert.ok(html.includes('Esto NO significa que la entrega coincida con el mockup'));
    assert.ok(html.includes('archivo ausente en el directorio de evidencia del issue'));
});

test('CA-22: el placeholder declara cada motivo por separado', () => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, 'nota.txt'), 'no soy una imagen', 'utf8');
    assert.match(resolveImageSrc('nota.txt', ISSUE).reason, /extensión no permitida/);
    assert.match(resolveImageSrc('', ISSUE).reason, /no referencia ninguna imagen/);
    assert.match(resolveImageSrc('../../../package.json', ISSUE).reason, /fuera del directorio/);
});

test('seguridad: rechaza una imagen alcanzada mediante un enlace intermedio', (t) => {
    fs.mkdirSync(DIR, { recursive: true });
    const outside = fs.mkdtempSync(path.join(ROOT, '.tmp-image-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, 'probe.png'), 'PNG-SECRET', 'utf8');
    fs.symlinkSync(outside, path.join(DIR, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

    const resolved = resolveImageSrc('linked/probe.png', ISSUE);
    assert.equal(resolved.src, null);
    assert.match(resolved.reason, /symlink o junction rechazado/);
});

test('seguridad: loadVisualComparison no lee un contrato mediante un enlace intermedio', (t) => {
    fs.mkdirSync(DIR, { recursive: true });
    const outside = fs.mkdtempSync(path.join(ROOT, '.tmp-contract-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, 'visual-comparison.json'), JSON.stringify({
        verdict: 'rejected', rev: 3, diffs: [],
    }), 'utf8');
    fs.symlinkSync(outside, path.join(DIR, 'linked-contract'), process.platform === 'win32' ? 'junction' : 'dir');

    const result = loadVisualComparison(ISSUE, path.join(DIR, 'linked-contract', 'visual-comparison.json'), 3);
    assert.equal(result.contract, null);
    assert.equal(result.skip.reason, 'unreadable');
    assert.match(result.skip.detail, /symlink o junction intermedio/);
});

test('CA-22: con la imagen resoluble el badge «no matchea» se conserva', () => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, 'render.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    const html = renderVisualComparisonBlock({
        issue: ISSUE, mockup: { src: 'render.png' }, delivery: { src: 'render.png' }, diffs: [],
    }, ISSUE, null);
    assert.ok(html.includes('no matchea'), 'con comparación real el badge original sigue valiendo');
    assert.equal(html.includes('sin captura'), false);
});

// ----- CA-23 / UX-19 · las bandas nuevas narran como sufijo ----------------

test('CA-23: E6 y E3b narran como sufijo, nunca como titular', () => {
    for (const reason of ['shape-gate-block', 'rev-unknown']) {
        const texto = generateNarration({
            issue: 5708,
            primaryCause: { summary: 'tests del modulo users fallan' },
            autoCreatedDeps: [],
            visualSkip: { reason, detail: 'x' },
        });
        assert.ok(texto.startsWith('Issue 5708: rechazado. Causa: tests del modulo users fallan'),
            `${reason} no puede titular la narración: ${texto}`);
    }
});

test('CA-23: la narración de E6 habla del barrido, no de una falla de carga', () => {
    const texto = generateNarration({
        issue: 5708,
        primaryCause: { summary: 'linter rojo' },
        autoCreatedDeps: [],
        visualSkip: { reason: 'shape-gate-block', detail: 'coverage-incomplete [C, D]' },
    });
    assert.ok(texto.includes('El barrido visual no se aceptó'));
    assert.equal(texto.includes('no se pudo evaluar'), false,
        'el fallback genérico describiría el motivo equivocado');
});

test('CA-23: la narración de rev-unknown no afirma que sea de otra pasada', () => {
    const texto = generateNarration({
        issue: 5708,
        primaryCause: { summary: 'linter rojo' },
        autoCreatedDeps: [],
        visualSkip: { reason: 'rev-unknown', detail: 'el caller no informó --rev' },
    });
    assert.equal(texto.includes('pasada anterior'), false);
    assert.ok(texto.includes('No se pudo determinar a qué pasada corresponde'));
});

// ----- CA-24 · el spec visual vive en el árbol donde el dev trabaja --------

test('CA-24: el mockup 50 y su addendum están versionados en esta rama', () => {
    const mockup = path.join(ROOT, '.pipeline', 'assets', 'mockups', '50-visual-block-rev2-states.svg');
    const addendum = path.join(ROOT, '.pipeline', 'assets', 'mockups', '5708', 'ux-criterios-5708-addendum2.md');
    assert.ok(fs.existsSync(mockup), 'sin el mockup 50 en el árbol, CA-18..CA-23 se implementan a ciegas');
    assert.ok(fs.existsSync(addendum), 'el addendum2 es la fuente normativa de CA-18..CA-23');
});
