// =============================================================================
// init-waves-from-partial.test.js — Tests del seed inicial (#3616).
//
// Cubre CA-1 del issue #3616:
//   - Idempotencia: si waves.json ya tiene active_wave, no-op.
//   - Fail-closed: si .partial-pause.json está malformado, aborta.
//   - Atomicidad: write con tmp + fsync + rename (delegado a lib/waves).
//   - Seed correcto: numeración + shape.
//   - Sin partial-pause ni allowlist vacía: no-op silencioso.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/init-waves-from-partial.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let init;

function mkTmpPipeline() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'init-waves-'));
}

function rmrf(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function setupTmp() {
    const dir = mkTmpPipeline();
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    // Re-require para que init y waves vean el override.
    delete require.cache[require.resolve('../../scripts/init-waves-from-partial')];
    delete require.cache[require.resolve('../waves')];
    init = require('../../scripts/init-waves-from-partial');
    init._internal._resetDedupeForTests();
    return dir;
}

function teardownTmp(dir) {
    rmrf(dir);
    delete process.env.PIPELINE_DIR_OVERRIDE;
}

function writePartial(dir, content) {
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), content);
}

function writeWaves(dir, content) {
    fs.writeFileSync(path.join(dir, 'waves.json'), content);
}

function readWaves(dir) {
    const raw = fs.readFileSync(path.join(dir, 'waves.json'), 'utf8');
    return JSON.parse(raw);
}

// ─── Happy path: seed inicial ───────────────────────────────────────────────

test('#3616 CA-1: siembra waves.json desde .partial-pause.json cuando ambos están en estado inicial', () => {
    const dir = setupTmp();
    try {
        // .partial-pause.json con allowlist real (replica de prod 2026-05-29).
        writePartial(dir, JSON.stringify({
            allowed_issues: [3559, 3605, 3616],
            created_at: '2026-05-29T12:07:00Z',
            source: 'manual',
        }));
        // waves.json NO existe.

        const r = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r.action, 'seeded');
        assert.equal(r.waveNumber, 1);
        assert.deepEqual(r.allowlist, [3559, 3605, 3616]);

        const state = readWaves(dir);
        assert.equal(state.version, '1.0');
        assert.equal(state.active_wave.number, 1);
        assert.equal(state.active_wave.issues.length, 3);
        assert.equal(state.active_wave.issues[0].number, 3559);
        assert.equal(state.meta.updated_by, 'init-waves-from-partial');
        assert.equal(state.meta.source, 'auto-seed');
    } finally { teardownTmp(dir); }
});

test('#3616 CA-1: seed con waves.json vacío (existente pero sin active_wave) → siembra OK', () => {
    const dir = setupTmp();
    try {
        // waves.json existe pero está en el shape "vacío" inicial.
        writeWaves(dir, JSON.stringify({
            version: '1.0',
            meta: {
                created_at: '2026-05-24T00:00:00Z',
                updated_at: '2026-05-24T00:00:00Z',
                updated_by: 'System',
                source: 'manual',
                note: 'Inicialización vacía',
            },
            active_wave: null,
            planned_waves: [],
            archived_waves: [],
            dependencies: [],
        }));
        writePartial(dir, JSON.stringify({
            allowed_issues: [3616, 3638],
        }));

        const r = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r.action, 'seeded');

        const state = readWaves(dir);
        assert.equal(state.active_wave.number, 1);
        assert.equal(state.active_wave.issues.length, 2);
    } finally { teardownTmp(dir); }
});

// ─── Idempotencia (CA-1 punto 3) ────────────────────────────────────────────

test('#3616 CA-1 idempotente: si waves.json ya tiene active_wave, NO toca', () => {
    const dir = setupTmp();
    try {
        const existing = {
            version: '1.0',
            meta: { created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z' },
            active_wave: {
                number: 7,
                name: 'Ola N+7 — existente',
                issues: [{ number: 9000, status: 'in_progress' }],
            },
            planned_waves: [],
            archived_waves: [],
            dependencies: [],
        };
        writeWaves(dir, JSON.stringify(existing, null, 2));
        // partial-pause con OTROS issues — el init NO debe pisar la activa.
        writePartial(dir, JSON.stringify({ allowed_issues: [1, 2, 3] }));

        const r = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r.action, 'noop_already_seeded');
        assert.equal(r.waveNumber, 7);

        const state = readWaves(dir);
        // Byte-equivalente al original (idempotencia estricta).
        assert.equal(state.active_wave.number, 7);
        assert.equal(state.active_wave.issues[0].number, 9000);
    } finally { teardownTmp(dir); }
});

test('#3616 CA-1: dos invocaciones consecutivas → segunda es no-op', () => {
    const dir = setupTmp();
    try {
        writePartial(dir, JSON.stringify({ allowed_issues: [100, 200] }));

        const r1 = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r1.action, 'seeded');
        const stateAfterFirst = readWaves(dir);

        const r2 = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r2.action, 'noop_already_seeded');
        const stateAfterSecond = readWaves(dir);

        // Mismo número de ola, mismos issues (idempotente byte-equivalente).
        assert.equal(stateAfterFirst.active_wave.number, stateAfterSecond.active_wave.number);
        assert.deepEqual(
            stateAfterFirst.active_wave.issues,
            stateAfterSecond.active_wave.issues,
        );
    } finally { teardownTmp(dir); }
});

// ─── Fail-closed (CA-1 fail-closed + security req 1) ────────────────────────

test('#3616 CA-1 fail-closed: .partial-pause.json con ID no entero → aborta sin tocar waves.json', () => {
    const dir = setupTmp();
    try {
        // ID "abc" no es entero positivo.
        writePartial(dir, JSON.stringify({ allowed_issues: ['abc', 123] }));

        const r = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r.action, 'aborted_invalid_partial');
        assert.ok(r.errors && r.errors.length > 0);
        // waves.json NO se creó.
        assert.equal(fs.existsSync(path.join(dir, 'waves.json')), false);
    } finally { teardownTmp(dir); }
});

test('#3616 CA-1 fail-closed: .partial-pause.json con ID negativo → aborta', () => {
    const dir = setupTmp();
    try {
        writePartial(dir, JSON.stringify({ allowed_issues: [-1] }));
        const r = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r.action, 'aborted_invalid_partial');
        assert.equal(fs.existsSync(path.join(dir, 'waves.json')), false);
    } finally { teardownTmp(dir); }
});

test('#3616 CA-1 fail-closed: .partial-pause.json con JSON inválido → aborta', () => {
    const dir = setupTmp();
    try {
        writePartial(dir, '{ this is not json');
        const r = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r.action, 'aborted_invalid_partial');
        assert.equal(fs.existsSync(path.join(dir, 'waves.json')), false);
    } finally { teardownTmp(dir); }
});

test('#3616 CA-1 fail-closed: .partial-pause.json sin allowed_issues → aborta', () => {
    const dir = setupTmp();
    try {
        writePartial(dir, JSON.stringify({ created_at: '2026-05-29T00:00:00Z' }));
        const r = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r.action, 'aborted_invalid_partial');
        assert.equal(fs.existsSync(path.join(dir, 'waves.json')), false);
    } finally { teardownTmp(dir); }
});

test('#3616 CA-1: waves.json corrupto → aborta sin tocarlo', () => {
    const dir = setupTmp();
    try {
        writeWaves(dir, '{ not parseable');
        writePartial(dir, JSON.stringify({ allowed_issues: [1, 2] }));

        const r = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r.action, 'aborted_waves_corrupt');
        // waves.json sigue siendo el corrupto original.
        const raw = fs.readFileSync(path.join(dir, 'waves.json'), 'utf8');
        assert.equal(raw, '{ not parseable');
    } finally { teardownTmp(dir); }
});

// ─── No-ops válidos ─────────────────────────────────────────────────────────

test('#3616 CA-1 no-op: sin .partial-pause.json → no-op silencioso', () => {
    const dir = setupTmp();
    try {
        const r = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r.action, 'noop_no_partial');
        assert.equal(fs.existsSync(path.join(dir, 'waves.json')), false);
    } finally { teardownTmp(dir); }
});

test('#3616 CA-1 no-op: .partial-pause.json con allowlist vacía → no-op', () => {
    const dir = setupTmp();
    try {
        writePartial(dir, JSON.stringify({ allowed_issues: [] }));
        const r = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r.action, 'noop_empty_partial');
        assert.equal(fs.existsSync(path.join(dir, 'waves.json')), false);
    } finally { teardownTmp(dir); }
});

// ─── Numeración (guru riesgo #4) ────────────────────────────────────────────

test('#3616 CA-1: numeración usa max(archived.number) + 1', () => {
    const dir = setupTmp();
    try {
        // Hay olas archivadas con números 5 y 7 → el seed debe usar 8.
        writeWaves(dir, JSON.stringify({
            version: '1.0',
            meta: { created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z' },
            active_wave: null,
            planned_waves: [],
            archived_waves: [
                { number: 5, name: 'N+5', closed_at: '2026-04-01T00:00:00Z' },
                { number: 7, name: 'N+7', closed_at: '2026-05-01T00:00:00Z' },
            ],
            dependencies: [],
        }));
        writePartial(dir, JSON.stringify({ allowed_issues: [1000] }));

        const r = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r.action, 'seeded');
        assert.equal(r.waveNumber, 8);
        const state = readWaves(dir);
        assert.equal(state.active_wave.number, 8);
        // Archivadas preservadas.
        assert.equal(state.archived_waves.length, 2);
    } finally { teardownTmp(dir); }
});

test('#3616 CA-1: numeración considera planned_waves para no chocar', () => {
    const dir = setupTmp();
    try {
        writeWaves(dir, JSON.stringify({
            version: '1.0',
            meta: { created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z' },
            active_wave: null,
            planned_waves: [{ number: 10, name: 'Futura' }],
            archived_waves: [],
            dependencies: [],
        }));
        writePartial(dir, JSON.stringify({ allowed_issues: [2000] }));

        const r = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r.action, 'seeded');
        // max(planned.number) = 10 → seed = 11.
        assert.equal(r.waveNumber, 11);
    } finally { teardownTmp(dir); }
});

// ─── Dry-run ────────────────────────────────────────────────────────────────

test('#3616: dryRun no escribe waves.json', () => {
    const dir = setupTmp();
    try {
        writePartial(dir, JSON.stringify({ allowed_issues: [777] }));
        const r = init.initWavesFromPartial({ skipAlert: true, dryRun: true });
        assert.equal(r.action, 'seeded');
        assert.equal(r.reason, 'dry-run');
        assert.equal(fs.existsSync(path.join(dir, 'waves.json')), false);
    } finally { teardownTmp(dir); }
});

// ─── Preservación de campos ────────────────────────────────────────────────

test('#3616 CA-1: preserva planned_waves, archived_waves, dependencies del waves.json existente', () => {
    const dir = setupTmp();
    try {
        writeWaves(dir, JSON.stringify({
            version: '1.0',
            meta: {
                created_at: '2026-05-01T00:00:00Z',
                updated_at: '2026-05-01T00:00:00Z',
                updated_by: 'planner',
                source: 'planner',
                note: 'plan pre-cargado',
            },
            active_wave: null,
            planned_waves: [{ number: 99, name: 'Futura especial' }],
            archived_waves: [{ number: 0, name: 'Genesis' }],
            dependencies: [{ blocker: 1, blocked: 2 }],
        }));
        writePartial(dir, JSON.stringify({ allowed_issues: [42] }));

        const r = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r.action, 'seeded');
        const state = readWaves(dir);
        assert.equal(state.planned_waves.length, 1);
        assert.equal(state.planned_waves[0].number, 99);
        assert.equal(state.archived_waves.length, 1);
        assert.equal(state.dependencies.length, 1);
        // meta.created_at preservado (no se pisa).
        assert.equal(state.meta.created_at, '2026-05-01T00:00:00Z');
    } finally { teardownTmp(dir); }
});

// ─── Sanitización ──────────────────────────────────────────────────────────

test('#3616: deduplica IDs repetidos en allowed_issues', () => {
    const dir = setupTmp();
    try {
        writePartial(dir, JSON.stringify({ allowed_issues: [1, 1, 2, 2, 3] }));
        const r = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r.action, 'seeded');
        const state = readWaves(dir);
        assert.equal(state.active_wave.issues.length, 3);
        assert.deepEqual(
            state.active_wave.issues.map((i) => i.number),
            [1, 2, 3],
        );
    } finally { teardownTmp(dir); }
});

test('#3616: normaliza IDs con prefijo "#"', () => {
    const dir = setupTmp();
    try {
        writePartial(dir, JSON.stringify({ allowed_issues: ['#42', '#43'] }));
        const r = init.initWavesFromPartial({ skipAlert: true });
        assert.equal(r.action, 'seeded');
        const state = readWaves(dir);
        assert.deepEqual(
            state.active_wave.issues.map((i) => i.number),
            [42, 43],
        );
    } finally { teardownTmp(dir); }
});

// ─── Smoke: el script CLI no crashea ───────────────────────────────────────

test('#3616: el script existe como CLI ejecutable', () => {
    const scriptPath = path.resolve(__dirname, '..', '..', 'scripts', 'init-waves-from-partial.js');
    assert.equal(fs.existsSync(scriptPath), true);
});
