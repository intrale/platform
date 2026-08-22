'use strict';

// =============================================================================
// Tests de la política PURA glitch-retry.js (#3950 / EP7-H3).
//
// Cubre (CA-7 + SR-A/B/C):
//   - secuencia de decisiones (1→retry_same/3s, 2→retry_same/6s,
//     3→retry_standard, 4→give_up)
//   - no-retry sobre errorClass ajeno (CA-5)
//   - backoff acotado <= 10s (SR-C.2)
//   - resolveStandardModel: strip anclado de [1m], rechazo de
//     metacaracteres/longitud/no-string → null, sin hardcodeo del modelo
//   - readConfiguredModel con settings corrupto/ausente → null sin throw (SR-B)
//   - formatAttemptLog con shape exacto
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const g = require('../glitch-retry');

const GLITCH = 'cli_1m_context_glitch';

// -----------------------------------------------------------------------------
// decide() — secuencia de decisiones
// -----------------------------------------------------------------------------

test('decide: attempt 1 con glitch → retry_same backoff 3000', () => {
    assert.deepEqual(g.decide({ attempt: 1, errorClass: GLITCH }), { action: 'retry_same', backoffMs: 3000 });
});

test('decide: attempt 2 con glitch → retry_same backoff 6000', () => {
    assert.deepEqual(g.decide({ attempt: 2, errorClass: GLITCH }), { action: 'retry_same', backoffMs: 6000 });
});

test('decide: attempt 3 con glitch → retry_standard backoff 0', () => {
    assert.deepEqual(g.decide({ attempt: 3, errorClass: GLITCH }), { action: 'retry_standard', backoffMs: 0 });
});

test('decide: attempt 4 con glitch → give_up', () => {
    assert.deepEqual(g.decide({ attempt: 4, errorClass: GLITCH }), { action: 'give_up', backoffMs: 0 });
});

test('decide: attempt 5+ con glitch → give_up (no loop infinito)', () => {
    assert.equal(g.decide({ attempt: 5, errorClass: GLITCH }).action, 'give_up');
    assert.equal(g.decide({ attempt: 99, errorClass: GLITCH }).action, 'give_up');
});

// -----------------------------------------------------------------------------
// decide() — CA-5: no reintenta sobre errorClass ajeno
// -----------------------------------------------------------------------------

test('decide: errorClass quota_exhausted → give_up aunque sea attempt 1', () => {
    assert.deepEqual(g.decide({ attempt: 1, errorClass: 'quota_exhausted' }), { action: 'give_up', backoffMs: 0 });
});

test('decide: errorClass ausente/null/undefined → give_up', () => {
    assert.equal(g.decide({ attempt: 1 }).action, 'give_up');
    assert.equal(g.decide({ attempt: 1, errorClass: null }).action, 'give_up');
    assert.equal(g.decide({ attempt: 2, errorClass: '' }).action, 'give_up');
});

test('decide: attempt inválido (0/negativo/float/no-int) se normaliza a 1', () => {
    assert.equal(g.decide({ attempt: 0, errorClass: GLITCH }).action, 'retry_same');
    assert.equal(g.decide({ attempt: -3, errorClass: GLITCH }).action, 'retry_same');
    assert.equal(g.decide({ attempt: 1.5, errorClass: GLITCH }).action, 'retry_same');
    assert.equal(g.decide({ errorClass: GLITCH }).action, 'retry_same');
    assert.equal(g.decide(undefined).action, 'give_up'); // sin errorClass
});

// -----------------------------------------------------------------------------
// decide() — SR-C.2: backoff siempre acotado <= MAX_BACKOFF_MS
// -----------------------------------------------------------------------------

test('decide: backoff de toda la secuencia nunca supera MAX_BACKOFF_MS (10s)', () => {
    for (let a = 1; a <= 10; a++) {
        const d = g.decide({ attempt: a, errorClass: GLITCH });
        assert.ok(d.backoffMs >= 0 && d.backoffMs <= g.MAX_BACKOFF_MS,
            `attempt ${a} backoff ${d.backoffMs} fuera de rango`);
    }
});

test('decide: BACKOFF_MS configurado es creciente y acotado', () => {
    assert.ok(Array.isArray(g.BACKOFF_MS));
    assert.equal(g.BACKOFF_MS.length, g.MAX_SAME_CONTEXT_RETRIES);
    g.BACKOFF_MS.forEach((b) => assert.ok(b > 0 && b <= g.MAX_BACKOFF_MS));
});

// -----------------------------------------------------------------------------
// resolveStandardModel() — SR-A
// -----------------------------------------------------------------------------

test('resolveStandardModel: strip anclado del sufijo [1m]', () => {
    assert.deepEqual(g.resolveStandardModel({ rawModel: 'claude-fable-5[1m]' }), { model: 'claude-fable-5', reason: 'ok' });
});

test('resolveStandardModel: modelo sin sufijo pasa tal cual', () => {
    assert.deepEqual(g.resolveStandardModel({ rawModel: 'claude-sonnet-4-6' }), { model: 'claude-sonnet-4-6', reason: 'ok' });
});

test('resolveStandardModel: solo strippea [1m] al FINAL (anclado), no en el medio', () => {
    // '[1m]' en el medio no se toca; el valor completo se valida por whitelist.
    const r = g.resolveStandardModel({ rawModel: 'claude-[1m]-x' });
    assert.equal(r.model, 'claude-[1m]-x');
});

test('resolveStandardModel: no-string → null (no_a_string)', () => {
    assert.equal(g.resolveStandardModel({ rawModel: null }).model, null);
    assert.equal(g.resolveStandardModel({ rawModel: 123 }).model, null);
    assert.equal(g.resolveStandardModel({ rawModel: { x: 1 } }).model, null);
    assert.equal(g.resolveStandardModel({}).model, null);
    assert.equal(g.resolveStandardModel().model, null);
});

test('resolveStandardModel: metacaracteres de shell → null (SR-A, anti-injection)', () => {
    for (const bad of ['evil & calc', 'a|b', 'm^x', 'a%PATH%', 'q"uote', 'a;b', 'a$(x)', 'a`b`', 'a b']) {
        const r = g.resolveStandardModel({ rawModel: bad });
        assert.equal(r.model, null, `"${bad}" debería rechazarse`);
        assert.equal(r.reason, 'failed_whitelist');
    }
});

test('resolveStandardModel: longitud fuera de rango → null', () => {
    assert.equal(g.resolveStandardModel({ rawModel: '' }).model, null);
    assert.equal(g.resolveStandardModel({ rawModel: 'a'.repeat(65) }).model, null);
    // 64 exacto válido:
    assert.equal(g.resolveStandardModel({ rawModel: 'a'.repeat(64) }).model, 'a'.repeat(64));
});

test('resolveStandardModel: string que queda vacío tras strip → null', () => {
    assert.equal(g.resolveStandardModel({ rawModel: '[1m]' }).model, null);
});

test('resolveStandardModel: NO hardcodea un nombre de modelo concreto', () => {
    // Debe derivar del input, no devolver siempre el mismo nombre.
    assert.equal(g.resolveStandardModel({ rawModel: 'mi-modelo-custom[1m]' }).model, 'mi-modelo-custom');
    assert.equal(g.resolveStandardModel({ rawModel: 'otro_modelo.v2' }).model, 'otro_modelo.v2');
});

// -----------------------------------------------------------------------------
// readConfiguredModel() — SR-B (lectura defensiva, inyectable)
// -----------------------------------------------------------------------------

function fakeFs(content, throwOn) {
    return {
        readFileSync(p) {
            if (throwOn) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
            return content;
        },
    };
}

test('readConfiguredModel: settings válido → rawModel del campo model', () => {
    const fs = fakeFs(JSON.stringify({ model: 'claude-fable-5[1m]', otra: 1 }));
    assert.deepEqual(g.readConfiguredModel({ settingsPath: '/x/settings.json', fs }), { rawModel: 'claude-fable-5[1m]', reason: 'ok' });
});

test('readConfiguredModel: archivo ausente (readFileSync throw) → null sin tirar', () => {
    const fs = fakeFs(null, true);
    const r = g.readConfiguredModel({ settingsPath: '/no/existe.json', fs });
    assert.equal(r.rawModel, null);
    assert.equal(r.reason, 'read_error');
});

test('readConfiguredModel: JSON corrupto → null sin tirar', () => {
    const fs = fakeFs('{ esto no es json ');
    const r = g.readConfiguredModel({ settingsPath: '/x.json', fs });
    assert.equal(r.rawModel, null);
    assert.equal(r.reason, 'parse_error');
});

test('readConfiguredModel: sin campo model o model no-string → null', () => {
    assert.equal(g.readConfiguredModel({ settingsPath: '/x', fs: fakeFs('{}') }).rawModel, null);
    assert.equal(g.readConfiguredModel({ settingsPath: '/x', fs: fakeFs('{"model": 123}') }).rawModel, null);
    assert.equal(g.readConfiguredModel({ settingsPath: '/x', fs: fakeFs('{"model": null}') }).rawModel, null);
});

test('readConfiguredModel: model desmedido (>64) → null', () => {
    const fs = fakeFs(JSON.stringify({ model: 'a'.repeat(100) }));
    assert.equal(g.readConfiguredModel({ settingsPath: '/x', fs }).rawModel, null);
});

test('readConfiguredModel: path ausente/no-string → null (no_path), sin tocar fs', () => {
    assert.equal(g.readConfiguredModel({}).reason, 'no_path');
    assert.equal(g.readConfiguredModel({ settingsPath: 123 }).reason, 'no_path');
    assert.equal(g.readConfiguredModel().reason, 'no_path');
});

// -----------------------------------------------------------------------------
// formatAttemptLog() — shape exacto
// -----------------------------------------------------------------------------

test('formatAttemptLog: intento heredado (sin model) → context=1m model=inherited', () => {
    assert.equal(
        g.formatAttemptLog({ attempt: 1, context: '1m', model: null, backoffMs: 0 }),
        '[anthropic-1m] attempt=1 context=1m model=inherited backoff=0'
    );
});

test('formatAttemptLog: intento estándar con model validado', () => {
    assert.equal(
        g.formatAttemptLog({ attempt: 4, context: 'standard', model: 'claude-fable-5', backoffMs: 0 }),
        '[anthropic-1m] attempt=4 context=standard model=claude-fable-5 backoff=0'
    );
});

test('formatAttemptLog: defaults defensivos (attempt inválido→1, context raro→1m, backoff raro→0)', () => {
    assert.equal(
        g.formatAttemptLog({ attempt: -1, context: 'raro', model: '', backoffMs: -5 }),
        '[anthropic-1m] attempt=1 context=1m model=inherited backoff=0'
    );
    assert.equal(
        g.formatAttemptLog({}),
        '[anthropic-1m] attempt=1 context=1m model=inherited backoff=0'
    );
});

// -----------------------------------------------------------------------------
// Pureza: el módulo carga sin side effects (constantes presentes)
// -----------------------------------------------------------------------------

test('módulo expone constantes duras esperadas', () => {
    assert.equal(g.MAX_SAME_CONTEXT_RETRIES, 2);
    assert.equal(g.MAX_BACKOFF_MS, 10000);
    assert.equal(g.GLITCH_ERROR_CLASS, GLITCH);
    assert.ok(g.MODEL_WHITELIST instanceof RegExp);
    assert.ok(g.ONE_M_SUFFIX instanceof RegExp);
});
