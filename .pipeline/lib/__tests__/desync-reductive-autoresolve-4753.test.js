// =============================================================================
// desync-reductive-autoresolve-4753.test.js — Issue #4753
//
// Auto-resolver el desync REDUCTIVO del Pulpo (issues cerrados residuales en
// waves.json) SIN frenar el dispatch ni pedir GATE 3.
//
// Cubre:
//   CA-1 / SEC-5  convergencia real: una divergencia puramente reductiva (solo
//                 issues cerrados sobrantes en waves.json) se auto-resuelve
//                 marcándolos `completed`; un segundo detectDesync → desync:false.
//   CA-3 / SEC-1  fail-closed: un issue ABIERTO o INDETERMINADO en la divergencia
//                 (isClosed !== true) NO auto-resuelve → human-block, sin mutar.
//   SEC-2         la frontera (todo cerrado-confirmado) se enforcea ANTES de la
//                 política de acción: un abierto nunca alcanza notify-and-proceed.
//   CA-7          regresión de la escalera: in-sync → no-op; ambiguo → human-block.
//   waves.js      markIssuesCompletedInActiveWave: atómico, idempotente, skip de
//                 issues ausentes de la ola, audit.
//   wave-dispatch poda convergente con fail-safe del predicado isClosed.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/desync-reductive-autoresolve-4753.test.js
// =============================================================================

'use strict';

process.env.PULPO_NO_AUTOSTART = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const desyncDetector = require('../desync-detector');
const waves = require('../waves');
const waveAudit = require('../wave-audit');
const dispatch = require('../wave-dispatch');
const pulpo = require('../../pulpo.js');

// -----------------------------------------------------------------------------
// Helpers de fixture (mismo patrón que desync-sync-4525.test.js)
// -----------------------------------------------------------------------------
function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'desync-4753-')); }
function rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }

function setup() {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    try { waves.invalidateCache(); } catch (_) {}
    // Garantizar que no arrastramos flag de un test previo.
    try { desyncDetector.clearDesyncFlag(); } catch (_) {}
    return dir;
}

function teardown(dir) {
    try { desyncDetector.clearDesyncFlag(); } catch (_) {}
    delete process.env.PIPELINE_DIR_OVERRIDE;
    try { waves.invalidateCache(); } catch (_) {}
    rmrf(dir);
}

// activeIssues: array de { number, status }
function writeWaves(dir, activeIssues) {
    const state = {
        version: '1.0',
        meta: {
            created_at: '2026-07-17T00:00:00Z', updated_at: '2026-07-17T00:00:00Z',
            updated_by: 'fixture', source: 'manual', note: 'test #4753', next_wave_number: 99,
        },
        active_wave: {
            number: 42,
            name: 'Ola Puente — Test 4753',
            goal: 'auto-resolver desync reductivo por cierre',
            started_at: '2026-07-17T00:00:00.000Z',
            issues: activeIssues.map((i) => ({ number: i.number, status: i.status || 'in_progress' })),
        },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    };
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(state, null, 2));
    try { waves.invalidateCache(); } catch (_) {}
}

function writeAllowlist(dir, allowedIssues) {
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({
        allowed_issues: allowedIssues,
        created_at: '2026-07-17T00:00:00.000Z',
        source: 'fixture',
    }, null, 2));
}

function readWaveStatuses(dir) {
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
    const out = {};
    for (const i of state.active_wave.issues) out[i.number] = i.status;
    return out;
}

// Predicado de cierre inyectado (title-cache simulado).
function isClosedFrom(set) {
    const s = new Set(set);
    return (n) => s.has(Number(n));
}

// =============================================================================
// CA-1 / SEC-5 — Convergencia real: reductivo puro por cierre se auto-resuelve
// =============================================================================
test('CA-1/SEC-5: #4716-#4719 cerrados residuales en la ola (con otro abierto) se auto-resuelven y el segundo probe converge a desync:false', () => {
    const dir = setup();
    try {
        writeWaves(dir, [
            { number: 100, status: 'in_progress' },
            { number: 4716, status: 'in_progress' }, { number: 4717, status: 'in_progress' },
            { number: 4718, status: 'in_progress' }, { number: 4719, status: 'in_progress' },
        ]);
        writeAllowlist(dir, [100]);
        const isClosed = isClosedFrom([4716, 4717, 4718, 4719]);

        // Precondición: divergencia reductiva (removed = cerrados, added vacío).
        const before = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true, isClosed });
        assert.equal(before.desync, true);
        assert.deepEqual(before.added, []);
        assert.deepEqual(before.removed.sort((a, b) => a - b), [4716, 4717, 4718, 4719]);
        assert.equal(before.classification, 'resoluble_reductivo');

        pulpo.evaluateDesyncAndMaybeRealign('periodic', { isClosed });

        // Los cerrados quedaron marcados completed; el abierto intacto.
        const st = readWaveStatuses(dir);
        assert.equal(st[100], 'in_progress');
        for (const n of [4716, 4717, 4718, 4719]) assert.equal(st[n], 'completed', `#${n} debe quedar completed`);

        // SEC-5: convergencia real — segundo probe sin desync + sin flag.
        assert.equal(desyncDetector.isDesyncFlagSet(), false, 'no debe quedar human-block');
        const after = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true, isClosed });
        assert.equal(after.desync, false, 'la divergencia reductiva debe converger');
    } finally { teardown(dir); }
});

// =============================================================================
// CA-1 (borde) — Ola SIN issues abiertos (todos cerrados): igual converge
// =============================================================================
test('CA-1 borde: ola con SOLO issues cerrados converge (poda + allowlist vacía == running), sin quedar bloqueada', () => {
    const dir = setup();
    try {
        writeWaves(dir, [
            { number: 4716, status: 'in_progress' }, { number: 4717, status: 'in_progress' },
            { number: 4718, status: 'in_progress' }, { number: 4719, status: 'in_progress' },
        ]);
        writeAllowlist(dir, []); // allowlist ya vacía (limpieza previa la sacó)
        const isClosed = isClosedFrom([4716, 4717, 4718, 4719]);

        const before = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true, isClosed });
        assert.equal(before.desync, true);
        assert.equal(before.classification, 'resoluble_reductivo');

        pulpo.evaluateDesyncAndMaybeRealign('periodic', { isClosed });

        const st = readWaveStatuses(dir);
        for (const n of [4716, 4717, 4718, 4719]) assert.equal(st[n], 'completed');
        assert.equal(desyncDetector.isDesyncFlagSet(), false, 'no debe quedar human-block');
        const after = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true, isClosed });
        assert.equal(after.desync, false);
    } finally { teardown(dir); }
});

// =============================================================================
// CA-3 / SEC-1 / SEC-2 — Fail-closed: issue ABIERTO en la divergencia NO auto-resuelve
// =============================================================================
test('CA-3/SEC-1: un issue ABIERTO faltante en la allowlist NO auto-resuelve → human-block, sin mutar waves.json', () => {
    const dir = setup();
    try {
        writeWaves(dir, [
            { number: 100, status: 'in_progress' },
            { number: 4716, status: 'in_progress' }, // cerrado
            { number: 9999, status: 'in_progress' }, // ABIERTO faltante en allowlist
        ]);
        writeAllowlist(dir, [100]);
        const isClosed = isClosedFrom([4716]); // 9999 abierto (isClosed=false)

        const before = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true, isClosed });
        assert.equal(before.desync, true);
        // added vacío ⇒ classifyDesync devuelve resoluble_reductivo, PERO removed
        // trae un abierto (#9999) → la frontera de #4753 debe bloquear igual.
        assert.equal(before.classification, 'resoluble_reductivo');

        pulpo.evaluateDesyncAndMaybeRealign('periodic', { isClosed });

        const st = readWaveStatuses(dir);
        assert.equal(st[4716], 'in_progress', 'no se poda nada si hay un abierto en la divergencia (SEC-1)');
        assert.equal(st[9999], 'in_progress');
        assert.equal(desyncDetector.isDesyncFlagSet(), true, 'debe escalar a human-block (fail-closed)');
    } finally { teardown(dir); }
});

test('SEC-1: estado INDETERMINADO (isClosed devuelve undefined) NO auto-resuelve → human-block', () => {
    const dir = setup();
    try {
        writeWaves(dir, [
            { number: 100, status: 'in_progress' },
            { number: 4716, status: 'in_progress' },
        ]);
        writeAllowlist(dir, [100]);
        // isClosed devuelve undefined para 4716 (cache miss / notFound / stale).
        const isClosed = (n) => (Number(n) === 100 ? false : undefined);

        pulpo.evaluateDesyncAndMaybeRealign('periodic', { isClosed });

        const st = readWaveStatuses(dir);
        assert.equal(st[4716], 'in_progress', 'indeterminado nunca se poda (fail-safe)');
        assert.equal(desyncDetector.isDesyncFlagSet(), true, 'human-block preservado');
    } finally { teardown(dir); }
});

// =============================================================================
// CA-7 — Regresión de la escalera de resolución
// =============================================================================
test('CA-7: in-sync → no-op (sin flag, sin mutación)', () => {
    const dir = setup();
    try {
        writeWaves(dir, [{ number: 100, status: 'in_progress' }]);
        writeAllowlist(dir, [100]);
        const isClosed = isClosedFrom([]);

        pulpo.evaluateDesyncAndMaybeRealign('periodic', { isClosed });

        assert.equal(desyncDetector.isDesyncFlagSet(), false);
        assert.equal(readWaveStatuses(dir)[100], 'in_progress');
    } finally { teardown(dir); }
});

test('CA-7: ambiguo (extra ABIERTO en la allowlist, sin traza) → human-block, no auto-resuelve', () => {
    const dir = setup();
    try {
        writeWaves(dir, [{ number: 100, status: 'in_progress' }]);
        writeAllowlist(dir, [100, 7777]); // 7777 abierto ajeno a la ola (added)
        const isClosed = isClosedFrom([]); // 7777 abierto

        const before = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true, isClosed });
        assert.equal(before.classification, 'ambiguo');

        pulpo.evaluateDesyncAndMaybeRealign('periodic', { isClosed });
        assert.equal(desyncDetector.isDesyncFlagSet(), true, 'ambiguo abierto sigue en human-block');
    } finally { teardown(dir); }
});

// =============================================================================
// waves.markIssuesCompletedInActiveWave — mutador atómico/auditado
// =============================================================================
test('waves.markIssuesCompletedInActiveWave marca completed, es idempotente y auditado', () => {
    const dir = setup();
    try {
        writeWaves(dir, [
            { number: 100, status: 'in_progress' },
            { number: 4716, status: 'in_progress' },
        ]);

        const r1 = waves.markIssuesCompletedInActiveWave([4716], { updated_by: 'test', source: 'unit' });
        assert.equal(r1.waveNumber, 42);
        assert.deepEqual(r1.completed, [4716]);
        assert.deepEqual(r1.skipped, []);
        assert.equal(readWaveStatuses(dir)[4716], 'completed');
        assert.equal(readWaveStatuses(dir)[100], 'in_progress');

        // Audit emitido.
        const events = waveAudit.readAllEvents();
        const ev = events.find((e) => e.event === 'issues_completed' && e.wave === 42);
        assert.ok(ev, 'debe existir un evento issues_completed');

        // Idempotente: re-marcar es no-op (skipped).
        const r2 = waves.markIssuesCompletedInActiveWave([4716], { updated_by: 'test' });
        assert.deepEqual(r2.completed, []);
        assert.deepEqual(r2.skipped, [4716]);
    } finally { teardown(dir); }
});

test('waves.markIssuesCompletedInActiveWave NUNCA agrega: issue ausente de la ola → skipped', () => {
    const dir = setup();
    try {
        writeWaves(dir, [{ number: 100, status: 'in_progress' }]);
        const r = waves.markIssuesCompletedInActiveWave([8888], { updated_by: 'test' });
        assert.deepEqual(r.completed, []);
        assert.deepEqual(r.skipped, [8888]);
        // La ola no cambió (sigue teniendo solo #100).
        const st = readWaveStatuses(dir);
        assert.deepEqual(Object.keys(st).map(Number), [100]);
    } finally { teardown(dir); }
});

// =============================================================================
// wave-dispatch — poda convergente con fail-safe del predicado isClosed
// =============================================================================
test('wave-dispatch: poda solo los CONFIRMADOS cerrados de la divergencia (marca completed)', () => {
    const dir = setup();
    try {
        writeWaves(dir, [
            { number: 100, status: 'in_progress' },
            { number: 4716, status: 'in_progress' },
        ]);
        writeAllowlist(dir, [100]);
        const res = dispatch.realignActiveWaveDispatch({
            isClosed: isClosedFrom([4716]),
            desync: { added: [], removed: [4716] },
            authorizedBy: 'wave-promote',
            source: 'test:realign',
        });
        assert.equal(res.ok, true);
        assert.deepEqual(res.prunedFromWave, [4716]);
        assert.equal(readWaveStatuses(dir)[4716], 'completed');
        assert.equal(readWaveStatuses(dir)[100], 'in_progress');
    } finally { teardown(dir); }
});

test('wave-dispatch fail-safe: isClosed=false/undefined NO poda waves.json', () => {
    const dir = setup();
    try {
        writeWaves(dir, [
            { number: 100, status: 'in_progress' },
            { number: 4716, status: 'in_progress' },
        ]);
        writeAllowlist(dir, [100]);
        // isClosed devuelve false para 4716 → no está confirmado cerrado.
        const res = dispatch.realignActiveWaveDispatch({
            isClosed: (n) => false,
            desync: { added: [], removed: [4716] },
            authorizedBy: 'wave-promote',
            source: 'test:realign',
        });
        assert.equal(res.ok, true);
        assert.deepEqual(res.prunedFromWave, []);
        assert.equal(readWaveStatuses(dir)[4716], 'in_progress', 'no se poda un no-confirmado-cerrado');
    } finally { teardown(dir); }
});
