// =============================================================================
// deliverable-notify-wave.test.js — #4019
//
// Cubre la sección de avance de ola en la notificación de entrega:
//   - CA-1: avance intermedio → `🌊 Ola N — C/M cerradas (P%) · quedan K ...`
//   - CA-2: último issue (open === 0) → `🎉 Ola N finalizada — M/M cerradas.`
//   - CA-3: conteo con estado fresco de GitHub (mock de runGh)
//   - CA-4: issue sin ola → null, buildText no agrega sección
//   - CA-5: degradación elegante ante fallo de gh / JSON inválido → null
//   - CA-6: una sola llamada gh, listado solo con números, input saneado
//   - G-5: truncado del listado de abiertos
//
// Estrategia: inyectamos `deps = { resolveWaveForIssue, runGh }` para no tocar
// ni waves.json real ni GitHub. `buildWaveProgressSection` es la única capa
// impura; la testeamos con stubs deterministas.
//
// Ejecutar: node --test .pipeline/lib/__tests__/deliverable-notify-wave.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dn = require('../deliverable-notify');
const { buildWaveProgressSection, formatOpenIssueList, buildText } = dn.__forTests__;

// Stub de runGh que devuelve el shape de `runCmd` (exit_code/stdout/stderr).
function fakeRunGh(states, { exitCode = 0 } = {}) {
    const calls = [];
    const fn = (args) => {
        calls.push(args);
        return {
            cmd: `gh ${args.join(' ')}`,
            exit_code: exitCode,
            stdout: states === null ? '' : JSON.stringify(states),
            stderr: exitCode === 0 ? '' : 'boom',
            wall_ms: 1,
            signal: null,
            error: null,
        };
    };
    fn.calls = calls;
    return fn;
}

function fakeResolveWave(wave) {
    return () => wave;
}

// -----------------------------------------------------------------------------
// CA-1 — avance intermedio
// -----------------------------------------------------------------------------

test('CA-1 · avance intermedio: 3/6 cerradas (50%) + lista de abiertos', () => {
    const wave = { number: 3, name: 'Ola 3', issues: [3001, 3002, 3003, 3004, 3005, 3006] };
    const runGh = fakeRunGh([
        { number: 3001, state: 'CLOSED' },
        { number: 3002, state: 'CLOSED' },
        { number: 3003, state: 'CLOSED' },
        { number: 3004, state: 'OPEN' },
        { number: 3005, state: 'OPEN' },
        { number: 3006, state: 'OPEN' },
    ]);
    const out = buildWaveProgressSection({
        issue: 3003,
        pipelineRoot: '/tmp/x',
        deps: { resolveWaveForIssue: fakeResolveWave(wave), runGh },
    });
    assert.equal(out, '🌊 Ola 3 — 3/6 cerradas (50%) · quedan 3 abiertas: #3004, #3005, #3006');
});

test('CA-1 · concordancia singular: "quedan 1 abierta"', () => {
    const wave = { number: 4, name: 'Ola 4', issues: [4001, 4002] };
    const runGh = fakeRunGh([
        { number: 4001, state: 'CLOSED' },
        { number: 4002, state: 'OPEN' },
    ]);
    const out = buildWaveProgressSection({
        issue: 4001,
        pipelineRoot: '/tmp/x',
        deps: { resolveWaveForIssue: fakeResolveWave(wave), runGh },
    });
    assert.equal(out, '🌊 Ola 4 — 1/2 cerradas (50%) · quedan 1 abierta: #4002');
});

test('CA-1 · porcentaje redondeado a entero (67%)', () => {
    const wave = { number: 3, name: 'Ola 3', issues: [1, 2, 3, 4, 5, 6] };
    const runGh = fakeRunGh([
        { number: 1, state: 'CLOSED' },
        { number: 2, state: 'CLOSED' },
        { number: 3, state: 'CLOSED' },
        { number: 4, state: 'CLOSED' },
        { number: 5, state: 'OPEN' },
        { number: 6, state: 'OPEN' },
    ]);
    const out = buildWaveProgressSection({
        issue: 1,
        pipelineRoot: '/tmp/x',
        deps: { resolveWaveForIssue: fakeResolveWave(wave), runGh },
    });
    assert.match(out, /4\/6 cerradas \(67%\)/);
});

// -----------------------------------------------------------------------------
// CA-2 — último issue (cierre de ola)
// -----------------------------------------------------------------------------

test('CA-2 · último issue: ola finalizada + sugerencia de próximo paso', () => {
    const wave = { number: 3, name: 'Ola 3', issues: [3001, 3002, 3003] };
    const runGh = fakeRunGh([
        { number: 3001, state: 'CLOSED' },
        { number: 3002, state: 'CLOSED' },
        { number: 3003, state: 'CLOSED' },
    ]);
    const out = buildWaveProgressSection({
        issue: 3003,
        pipelineRoot: '/tmp/x',
        deps: { resolveWaveForIssue: fakeResolveWave(wave), runGh },
    });
    assert.equal(
        out,
        '🎉 Ola 3 finalizada — 3/3 cerradas. Sugerencia: habilitá la Ola 4 para arrancar.',
    );
});

test('CA-2 · NO declara finalizada si un issue de la ola no aparece en gh (conservador)', () => {
    // gh devuelve solo 2 de 3 issues de la ola (límite / no existe). El tercero
    // se cuenta como NO cerrado → nunca "finalizada" de más.
    const wave = { number: 5, name: 'Ola 5', issues: [5001, 5002, 5003] };
    const runGh = fakeRunGh([
        { number: 5001, state: 'CLOSED' },
        { number: 5002, state: 'CLOSED' },
        // 5003 ausente
    ]);
    const out = buildWaveProgressSection({
        issue: 5002,
        pipelineRoot: '/tmp/x',
        deps: { resolveWaveForIssue: fakeResolveWave(wave), runGh },
    });
    assert.match(out, /^🌊 Ola 5 — 2\/3 cerradas \(67%\)/);
    assert.doesNotMatch(out, /finalizada/);
});

// -----------------------------------------------------------------------------
// CA-4 — issue sin ola
// -----------------------------------------------------------------------------

test('CA-4 · issue sin ola → null (sin sección, sin llamar a gh)', () => {
    const runGh = fakeRunGh([]);
    const out = buildWaveProgressSection({
        issue: 9999,
        pipelineRoot: '/tmp/x',
        deps: { resolveWaveForIssue: fakeResolveWave(null), runGh },
    });
    assert.equal(out, null);
    assert.equal(runGh.calls.length, 0); // no se consultó GitHub
});

test('CA-4 · ola sin issues → null', () => {
    const runGh = fakeRunGh([]);
    const out = buildWaveProgressSection({
        issue: 1,
        pipelineRoot: '/tmp/x',
        deps: { resolveWaveForIssue: fakeResolveWave({ number: 1, name: 'Ola 1', issues: [] }), runGh },
    });
    assert.equal(out, null);
});

// -----------------------------------------------------------------------------
// CA-5 — degradación elegante (resiliencia)
// -----------------------------------------------------------------------------

test('CA-5 · gh con exit_code !== 0 → null (no tira)', () => {
    const wave = { number: 3, name: 'Ola 3', issues: [1, 2] };
    const runGh = fakeRunGh([{ number: 1, state: 'CLOSED' }], { exitCode: 1 });
    const out = buildWaveProgressSection({
        issue: 1,
        pipelineRoot: '/tmp/x',
        deps: { resolveWaveForIssue: fakeResolveWave(wave), runGh },
    });
    assert.equal(out, null);
});

test('CA-5 · gh con stdout vacío → null', () => {
    const wave = { number: 3, name: 'Ola 3', issues: [1, 2] };
    const runGh = fakeRunGh(null); // stdout = ''
    const out = buildWaveProgressSection({
        issue: 1,
        pipelineRoot: '/tmp/x',
        deps: { resolveWaveForIssue: fakeResolveWave(wave), runGh },
    });
    assert.equal(out, null);
});

test('CA-5 · JSON inválido de gh → null', () => {
    const wave = { number: 3, name: 'Ola 3', issues: [1, 2] };
    const runGh = () => ({ exit_code: 0, stdout: 'no-es-json', stderr: '' });
    const out = buildWaveProgressSection({
        issue: 1,
        pipelineRoot: '/tmp/x',
        deps: { resolveWaveForIssue: fakeResolveWave(wave), runGh },
    });
    assert.equal(out, null);
});

test('CA-5 · runGh que tira excepción → null (capturado)', () => {
    const wave = { number: 3, name: 'Ola 3', issues: [1, 2] };
    const runGh = () => { throw new Error('spawn falló'); };
    const out = buildWaveProgressSection({
        issue: 1,
        pipelineRoot: '/tmp/x',
        deps: { resolveWaveForIssue: fakeResolveWave(wave), runGh },
    });
    assert.equal(out, null);
});

// -----------------------------------------------------------------------------
// CA-6 — seguridad: una sola llamada, sin shell, solo números
// -----------------------------------------------------------------------------

test('CA-6 · una sola llamada a gh con array de args (sin shell)', () => {
    const wave = { number: 3, name: 'Ola 3', issues: [1, 2, 3] };
    const runGh = fakeRunGh([
        { number: 1, state: 'CLOSED' },
        { number: 2, state: 'OPEN' },
        { number: 3, state: 'OPEN' },
    ]);
    buildWaveProgressSection({
        issue: 1,
        pipelineRoot: '/tmp/x',
        deps: { resolveWaveForIssue: fakeResolveWave(wave), runGh },
    });
    assert.equal(runGh.calls.length, 1);
    const args = runGh.calls[0];
    assert.ok(Array.isArray(args));
    assert.deepEqual(args.slice(0, 3), ['issue', 'list', '--repo']);
    assert.ok(args.includes('--state'));
    assert.ok(args.includes('all'));
    assert.ok(args.includes('number,state'));
});

test('CA-6 · el listado solo contiene números de issue (sin títulos)', () => {
    const wave = { number: 3, name: 'Ola 3', issues: [1, 2, 3] };
    const runGh = fakeRunGh([
        { number: 1, state: 'CLOSED' },
        { number: 2, state: 'OPEN', title: '<script>alert(1)</script>' },
        { number: 3, state: 'OPEN' },
    ]);
    const out = buildWaveProgressSection({
        issue: 1,
        pipelineRoot: '/tmp/x',
        deps: { resolveWaveForIssue: fakeResolveWave(wave), runGh },
    });
    assert.match(out, /quedan 2 abiertas: #2, #3$/);
    assert.doesNotMatch(out, /script/);
});

// -----------------------------------------------------------------------------
// G-5 — truncado del listado de abiertos
// -----------------------------------------------------------------------------

test('G-5 · formatOpenIssueList trunca a 8 con marcador (+N)', () => {
    const nums = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const out = formatOpenIssueList(nums);
    assert.equal(out, '#1, #2, #3, #4, #5, #6, #7, #8 … (+3)');
});

test('G-5 · formatOpenIssueList sin truncado cuando entra completo', () => {
    assert.equal(formatOpenIssueList([1, 2, 3]), '#1, #2, #3');
});

test('G-5 · avance con muchos abiertos trunca la lista en el mensaje', () => {
    const issues = [];
    for (let i = 1; i <= 12; i++) issues.push(i);
    const wave = { number: 7, name: 'Ola 7', issues };
    const states = issues.map((n) => ({ number: n, state: n === 1 ? 'CLOSED' : 'OPEN' }));
    const runGh = fakeRunGh(states);
    const out = buildWaveProgressSection({
        issue: 1,
        pipelineRoot: '/tmp/x',
        deps: { resolveWaveForIssue: fakeResolveWave(wave), runGh },
    });
    assert.match(out, /quedan 11 abiertas: #2, #3, #4, #5, #6, #7, #8, #9 … \(\+3\)/);
});

// -----------------------------------------------------------------------------
// buildText — integración de la sección
// -----------------------------------------------------------------------------

test('buildText · anexa waveProgress después del body y antes del link', () => {
    const txt = buildText({
        issue: 4019,
        title: 'Avance de ola',
        fase: 'entrega',
        skill: 'delivery',
        preview: 'Cuerpo de la entrega.',
        envelope: '<!-- env -->',
        waveProgress: '🌊 Ola 4 — 1/2 cerradas (50%) · quedan 1 abierta: #4023',
    });
    const lines = txt.split('\n');
    const idxBody = lines.findIndex((l) => l.includes('Cuerpo de la entrega'));
    const idxWave = lines.findIndex((l) => l.includes('🌊 Ola 4'));
    const idxLink = lines.findIndex((l) => l.includes('🔗 https://'));
    assert.ok(idxBody !== -1 && idxWave !== -1 && idxLink !== -1);
    assert.ok(idxBody < idxWave, 'wave va después del body');
    assert.ok(idxWave < idxLink, 'wave va antes del link');
});

test('buildText · omite la sección cuando waveProgress es null (CA-4)', () => {
    const txt = buildText({
        issue: 4019,
        title: 'Sin ola',
        fase: 'entrega',
        skill: 'delivery',
        preview: 'Cuerpo.',
        envelope: '<!-- env -->',
        waveProgress: null,
    });
    assert.doesNotMatch(txt, /🌊|🎉/);
});

test('buildText · omite la sección cuando waveProgress es string vacío', () => {
    const txt = buildText({
        issue: 4019,
        title: 'Vacío',
        fase: 'entrega',
        skill: 'delivery',
        preview: 'Cuerpo.',
        envelope: '<!-- env -->',
        waveProgress: '   ',
    });
    assert.doesNotMatch(txt, /🌊|🎉/);
});
