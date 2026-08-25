// #4375 — Tests del slice `desyncStatusSlice` (indicador de estado de sync
// allowlist↔ola). Cubre el mapeo estado→color (CA-10), la garantía read-only
// (CA-5), el fail-safe sin llamadas a GitHub (CA-7) y la validación de enteros
// (CA-8). Framework: node --test (built-in, sin dependencias).
//
// Estrategia de aislamiento:
//   - Mapeo: se inyecta un detector FAKE vía `_setDesyncDetector` — no toca el
//     estado global del pipeline; cada caso fuerza un probe determinístico.
//   - Read-only: se corre el detector REAL contra un directorio temporal
//     (PIPELINE_DIR_OVERRIDE) con fixtures, y se asserta que NO se crea el flag
//     ni cambian los mtimes de los archivos de estado tras N invocaciones.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const slices = require('./lib/dashboard-slices');
// #6259 (P2 / D-6259-3) — `PIPELINE_DIR_OVERRIDE` es variable COMUN
// (`isSecurityControlVar` -> false). Este archivo ya restauraba a mano con un
// par `prevOverride` / `else ... = prevOverride`; se migra al helper compartido
// en vez de allowlistearlo: una allowlist de una sola entrada que ya cumple el
// patron nace obsoleta y arranca dando ruido en el guardrail de #6260.
const { withEnv } = require('./lib/test-helpers/with-env');

// --- Helpers -----------------------------------------------------------------

// Detector fake: devuelve un probe fijo y un flag configurable. `calls` acumula
// las opts recibidas para poder assertar el contrato read-only (CA-5/CA-7).
function makeFakeDetector(probe, flagSet, calls) {
    return {
        detectDesync(opts) {
            if (calls) calls.push(opts);
            if (typeof probe === 'function') return probe();
            return probe;
        },
        isDesyncFlagSet() { return flagSet === true; },
    };
}

function runWithFake(probe, flagSet, calls) {
    slices._setDesyncDetector(makeFakeDetector(probe, flagSet, calls));
    try {
        return slices.desyncStatusSlice({}, {});
    } finally {
        slices._resetDesyncDetector();
    }
}

// --- Mapeo estado→color (CA-10) ----------------------------------------------

test('desync:false + reason:null → sincronizado', () => {
    const r = runWithFake({ desync: false, reason: null, classification: null, added: [], removed: [], waves_allowlist: [1, 2] }, false);
    assert.strictEqual(r.estado, 'sincronizado');
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.bloqueado, false);
});

test('desync:true + classification:resoluble_reductivo → realineado_reductivo', () => {
    const r = runWithFake({ desync: true, reason: 'allowlist_mismatch', classification: 'resoluble_reductivo', added: [], removed: [3], waves_allowlist: [1, 2, 3] }, false);
    assert.strictEqual(r.estado, 'realineado_reductivo');
    assert.deepStrictEqual(r.removed, [3]);
});

test('desync:true + classification:ambiguo → divergencia_bloqueada', () => {
    const r = runWithFake({ desync: true, reason: 'allowlist_mismatch', classification: 'ambiguo', added: [9], removed: [], waves_allowlist: [1, 2] }, false);
    assert.strictEqual(r.estado, 'divergencia_bloqueada');
    assert.deepStrictEqual(r.added, [9]);
});

test('isDesyncFlagSet()===true → divergencia_bloqueada aunque el probe diga sincronizado', () => {
    const r = runWithFake({ desync: false, reason: null, classification: null, added: [], removed: [], waves_allowlist: [1] }, true);
    assert.strictEqual(r.estado, 'divergencia_bloqueada');
    assert.strictEqual(r.bloqueado, true);
});

test('reason:no_waves_yet → desconocido (evita el falso verde)', () => {
    const r = runWithFake({ desync: false, reason: 'no_waves_yet', classification: null, added: [], removed: [], waves_allowlist: null }, false);
    assert.strictEqual(r.estado, 'desconocido');
});

test('reason:no_partial_pause → desconocido (evita el falso verde)', () => {
    const r = runWithFake({ desync: false, reason: 'no_partial_pause', classification: null, added: [], removed: [], waves_allowlist: [1, 2] }, false);
    assert.strictEqual(r.estado, 'desconocido');
});

test('detector que tira excepción → desconocido, sin propagar (CA-4)', () => {
    const r = runWithFake(() => { throw new Error('boom'); }, false);
    assert.strictEqual(r.estado, 'desconocido');
    assert.ok(r.error, 'debe exponer el error capturado');
});

test('detector ausente → desconocido con error explícito', () => {
    slices._setDesyncDetector({}); // sin detectDesync
    try {
        const r = slices.desyncStatusSlice({}, {});
        assert.strictEqual(r.estado, 'desconocido');
        assert.strictEqual(r.error, 'desync_detector_unavailable');
    } finally {
        slices._resetDesyncDetector();
    }
});

// --- Validación de enteros (CA-8) --------------------------------------------

test('added/removed filtran no-enteros (CA-8)', () => {
    const r = runWithFake({
        desync: true, reason: 'allowlist_mismatch', classification: 'ambiguo',
        added: [1, '2', 2.5, 3, null, undefined, NaN],
        removed: [4, '5', 6],
        waves_allowlist: [1, 2, 3],
    }, false);
    assert.deepStrictEqual(r.added, [1, 3]);
    assert.deepStrictEqual(r.removed, [4, 6]);
});

// --- Contrato JSON (CA-6) ----------------------------------------------------

test('el slice siempre devuelve el shape completo del contrato', () => {
    const r = runWithFake({ desync: false, reason: null, classification: null, added: [], removed: [], waves_allowlist: [] }, false);
    for (const k of ['estado', 'classification', 'desync', 'reason', 'added', 'removed', 'bloqueado', 'count']) {
        assert.ok(Object.prototype.hasOwnProperty.call(r, k), `falta la clave ${k}`);
    }
});

// --- Read-only garantizado (CA-5) con detector REAL + fixtures ---------------

test('CA-5/CA-7 — el slice pide modo read-only y sin isClosed', () => {
    const calls = [];
    runWithFake({ desync: false, reason: null, classification: null, added: [], removed: [], waves_allowlist: [] }, false, calls);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].skipFlag, true, 'skipFlag debe ser true (no mutar)');
    assert.strictEqual(calls[0].skipAlert, true, 'skipAlert debe ser true (no alertar)');
    assert.ok(!('isClosed' in calls[0]), 'no debe pasar isClosed (sin red a GitHub)');
});

test('CA-5 — N invocaciones del detector REAL no crean el flag ni mutan estado', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desync-4375-'));
    const wavesPath = path.join(dir, 'waves.json');
    const partialPath = path.join(dir, '.partial-pause.json');
    const flagPath = path.join(dir, '.desync-detected.flag');
    // Fixture con divergencia AMBIGUA (extra abierto en la allowlist) para
    // ejercitar el camino más "caliente" del detector — igual no debe mutar.
    fs.writeFileSync(wavesPath, JSON.stringify({ active_wave: { issues: [{ number: 1 }, { number: 2 }] } }));
    fs.writeFileSync(partialPath, JSON.stringify({ allowed_issues: [1, 2, 9] }));

    // Aseguramos el detector REAL (no el fake de tests previos).
    slices._resetDesyncDetector();
    try {
      withEnv({ PIPELINE_DIR_OVERRIDE: dir }, () => {
        const mtWavesBefore = fs.statSync(wavesPath).mtimeMs;
        const mtPartialBefore = fs.statSync(partialPath).mtimeMs;

        let last;
        for (let i = 0; i < 5; i++) {
            last = slices.desyncStatusSlice({}, {});
        }

        // Estado esperado: extra abierto sin isClosed → ambiguo → bloqueada.
        assert.strictEqual(last.estado, 'divergencia_bloqueada');
        assert.deepStrictEqual(last.added, [9]);
        // Read-only: no se creó el flag, ni cambiaron los mtimes.
        assert.strictEqual(fs.existsSync(flagPath), false, 'NO debe crearse .desync-detected.flag');
        assert.strictEqual(fs.statSync(wavesPath).mtimeMs, mtWavesBefore, 'waves.json no debe mutar');
        assert.strictEqual(fs.statSync(partialPath).mtimeMs, mtPartialBefore, '.partial-pause.json no debe mutar');
      });
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

test('CA-4 — waves.json corrupto → desconocido sin crash (detector REAL)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desync-4375-corrupt-'));
    fs.writeFileSync(path.join(dir, 'waves.json'), '{ esto no es json valido');
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({ allowed_issues: [1] }));
    slices._resetDesyncDetector();
    try {
      withEnv({ PIPELINE_DIR_OVERRIDE: dir }, () => {
        const r = slices.desyncStatusSlice({}, {});
        // waves ilegible → readWavesAllowlist null → reason no_waves_yet → desconocido.
        assert.strictEqual(r.estado, 'desconocido');
      });
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});
