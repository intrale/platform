// =============================================================================
// desync-sync-4439.test.js — Issue #4439
//
// Que el modelo operativo nunca deje desincronizados waves.json ↔
// .partial-pause.json ni bloquee la ola por un desync interno trazable.
//
// Cubre:
//   CA-1  suma coherente (handleWaveAdd deja ambos archivos en sync en un acto)
//   CA-2  auto-limpieza del flag stale (desync:false ⇒ flag inexistente)
//   CA-3  auto-resync aditivo de divergencia ambigua LEGÍTIMA (traza en audit)
//   CA-4  human-block preservado sin traza legítima (defensa A08) + binding
//   SEC-4439-1..4  predicado legit-add-trace: enum cerrado, binding por issue,
//                  TTL, fail-safe (traza forjada/expirada/replay).
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/desync-sync-4439.test.js
// =============================================================================

'use strict';

process.env.PULPO_NO_AUTOSTART = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Módulos bajo prueba — requeridos SIN borrar require.cache para compartir la
// instancia con pulpo.js (los libs resuelven PIPELINE_DIR_OVERRIDE en cada
// llamada, así que el override por-test funciona con instancias compartidas).
const legitAddTrace = require('../legit-add-trace');
const partialPause = require('../partial-pause');
const partialPauseAudit = require('../partial-pause-audit');
const desyncDetector = require('../desync-detector');
const waves = require('../waves');
const cd = require('../commander-deterministic');
const pulpo = require('../../pulpo.js');

// -----------------------------------------------------------------------------
// Helpers de fixture
// -----------------------------------------------------------------------------

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'desync-4439-')); }
function rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }

function setup() {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'desarrollo'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'definicion'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    try { waves.invalidateCache(); } catch (_) {}
    try { cd._waveInternal.invalidateKnownIssuesCache(); } catch (_) {}
    return dir;
}

function teardown(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    try { waves.invalidateCache(); } catch (_) {}
    try { cd._waveInternal.invalidateKnownIssuesCache(); } catch (_) {}
    rmrf(dir);
}

function writeWaves(dir, activeIssues, plannedWaves = []) {
    const state = {
        version: '1.0',
        meta: {
            created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
            updated_by: 'fixture', source: 'manual', note: 'test #4439',
        },
        active_wave: {
            number: 1,
            name: 'Ola activa — Test 4439',
            goal: 'sync waves↔partial-pause',
            started_at: '2026-07-01T00:00:00.000Z',
            issues: activeIssues.map((n) => ({ number: n, status: 'in_progress' })),
        },
        planned_waves: plannedWaves,
        archived_waves: [],
        dependencies: [],
    };
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(state, null, 2));
    try { waves.invalidateCache(); } catch (_) {}
}

function dropArtifact(dir, issue) {
    const target = path.join(dir, 'desarrollo', 'dev', 'pendiente');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, `${issue}.pipeline-dev`), `issue: ${issue}\n`);
}

function readAllowlist(dir) {
    const p = path.join(dir, '.partial-pause.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')).allowed_issues;
}

function readWaveIssues(dir) {
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
    return state.active_wave.issues.map((i) => i.number);
}

// Semilla de allowlist vía el gate auditado (deja audit-entry encadenada).
function seedAllowlist(issues, justification = 'seed test #4439') {
    return partialPause.setPartialPause(issues, {
        source: 'wave-promote',
        authorizedBy: 'wave-promote',
        justification,
    });
}

// =============================================================================
// SEC-4439 — legit-add-trace.isLegitimateRecentAdd (predicado puro)
// =============================================================================

function makeEntry(over = {}) {
    return {
        timestamp: new Date().toISOString(),
        action: 'write',
        authorized_by: 'wave-promote',
        diff: { added: [100], removed: [] },
        ...over,
    };
}

test('legit-add: traza válida y reciente (wave-promote + added incluye N) → legítima', () => {
    const now = 1_000_000_000_000;
    const reader = () => [makeEntry({ timestamp: new Date(now - 1000).toISOString(), diff: { added: [100], removed: [] } })];
    assert.deepEqual(legitAddTrace.isLegitimateRecentAdd([100], { now, auditReader: reader }), [100]);
});

test('legit-add: authorized_by fuera del enum → NO legítima (SEC-4439-1)', () => {
    const now = 1_000_000_000_000;
    const reader = () => [makeEntry({ authorized_by: 'pulpo:cleanup', timestamp: new Date(now).toISOString() })];
    assert.deepEqual(legitAddTrace.isLegitimateRecentAdd([100], { now, auditReader: reader }), []);
});

test('legit-add: commander:leo también legitima', () => {
    const now = 1_000_000_000_000;
    const reader = () => [makeEntry({ authorized_by: 'commander:leo', timestamp: new Date(now).toISOString() })];
    assert.deepEqual(legitAddTrace.isLegitimateRecentAdd([100], { now, auditReader: reader }), [100]);
});

test('legit-add: entry para OTRO issue no legitima N (binding por issue, SEC-4439-2)', () => {
    const now = 1_000_000_000_000;
    const reader = () => [makeEntry({ diff: { added: [999], removed: [] }, timestamp: new Date(now).toISOString() })];
    assert.deepEqual(legitAddTrace.isLegitimateRecentAdd([100], { now, auditReader: reader }), []);
});

test('legit-add: traza expirada (fuera de TTL) → NO legítima (SEC-4439-3)', () => {
    const now = 1_000_000_000_000;
    const ttlMs = 90_000;
    const reader = () => [makeEntry({ timestamp: new Date(now - ttlMs - 1).toISOString() })];
    assert.deepEqual(legitAddTrace.isLegitimateRecentAdd([100], { now, ttlMs, auditReader: reader }), []);
});

test('legit-add: action reject/clear no legitima (solo write)', () => {
    const now = 1_000_000_000_000;
    const reader = () => [makeEntry({ action: 'reject', timestamp: new Date(now).toISOString() })];
    assert.deepEqual(legitAddTrace.isLegitimateRecentAdd([100], { now, auditReader: reader }), []);
});

test('legit-add: timestamp inválido → NO legítima (fail-safe SEC-4439-4)', () => {
    const now = 1_000_000_000_000;
    const reader = () => [makeEntry({ timestamp: 'no-es-fecha' })];
    assert.deepEqual(legitAddTrace.isLegitimateRecentAdd([100], { now, auditReader: reader }), []);
});

test('legit-add: mixto — N legítimo + M sin traza → solo N (binding cruzado)', () => {
    const now = 1_000_000_000_000;
    const reader = () => [makeEntry({ diff: { added: [100], removed: [] }, timestamp: new Date(now).toISOString() })];
    assert.deepEqual(legitAddTrace.isLegitimateRecentAdd([100, 200], { now, auditReader: reader }), [100]);
});

test('legit-add: issue cerrado se excluye aunque tenga traza (SEC-4439-5)', () => {
    const now = 1_000_000_000_000;
    const reader = () => [makeEntry({ timestamp: new Date(now).toISOString() })];
    const isClosed = (n) => n === 100;
    assert.deepEqual(legitAddTrace.isLegitimateRecentAdd([100], { now, auditReader: reader, isClosed }), []);
});

test('legit-add: auditReader que lanza → [] fail-safe', () => {
    const reader = () => { throw new Error('audit ilegible'); };
    assert.deepEqual(legitAddTrace.isLegitimateRecentAdd([100], { now: 1, auditReader: reader }), []);
});

test('legit-add: candidatos vacíos → []', () => {
    assert.deepEqual(legitAddTrace.isLegitimateRecentAdd([], {}), []);
    assert.deepEqual(legitAddTrace.isLegitimateRecentAdd(null, {}), []);
});

// =============================================================================
// CA-1 — Suma coherente en handleWaveAdd
// =============================================================================

test('CA-1: /wave add a la ola ACTIVA con pausa parcial deja waves.json ∧ allowlist en sync (desync:false)', async () => {
    const dir = setup();
    try {
        writeWaves(dir, [990002]);
        dropArtifact(dir, 990001);
        seedAllowlist([990002]);          // pausa parcial activa con la ola actual

        const { reply } = await cd._waveInternal.handleWaveAdd({
            pipelineRoot: dir, waveNumber: 1, issueNumber: 990001,
            cooldown: null, chatId: 'leo', from: 'Leo',
        });
        assert.ok(reply.includes('990001'));

        // Ambos archivos contienen el issue nuevo, en un solo acto.
        assert.ok(readWaveIssues(dir).includes(990001), 'waves.json debe contener 990001');
        assert.ok(readAllowlist(dir).includes(990001), 'allowlist debe contener 990001');

        // El probe canónico da desync:false.
        const probe = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true });
        assert.equal(probe.desync, false, 'no debe haber desync tras la suma coherente');
    } finally { teardown(dir); }
});

test('CA-1: en modo running (sin pausa parcial) NO se crea marker al sumar a la ola', async () => {
    const dir = setup();
    try {
        writeWaves(dir, [990002]);
        dropArtifact(dir, 990001);
        // No seedAllowlist → pipeline running.

        await cd._waveInternal.handleWaveAdd({
            pipelineRoot: dir, waveNumber: 1, issueNumber: 990001,
            cooldown: null, chatId: 'leo', from: 'Leo',
        });

        assert.ok(readWaveIssues(dir).includes(990001), 'waves.json debe contener 990001');
        assert.equal(readAllowlist(dir), null, 'no debe crearse .partial-pause.json en modo running');
        const probe = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true });
        assert.equal(probe.desync, false);
    } finally { teardown(dir); }
});

test('CA-1: sumar a una ola PLANIFICADA no toca la allowlist (no genera extra ambiguo)', async () => {
    const dir = setup();
    try {
        const planned = [{ number: 2, name: 'Ola planificada', issues: [{ number: 990050 }] }];
        writeWaves(dir, [990002], planned);
        dropArtifact(dir, 990051);
        seedAllowlist([990002]);

        await cd._waveInternal.handleWaveAdd({
            pipelineRoot: dir, waveNumber: 2, issueNumber: 990051,
            cooldown: null, chatId: 'leo', from: 'Leo',
        });

        // El issue entró a la ola planificada, NO a la allowlist.
        assert.deepEqual(readAllowlist(dir), [990002], 'allowlist intacta (sólo ola activa)');
        const probe = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true });
        assert.equal(probe.desync, false, 'sin desync: la allowlist sólo refleja la ola activa');
    } finally { teardown(dir); }
});

// =============================================================================
// CA-2 — Auto-limpieza del flag stale
// =============================================================================

test('CA-2: archivos en sync + flag stale presente → evaluateDesyncAndMaybeRealign limpia el flag', () => {
    const dir = setup();
    try {
        writeWaves(dir, [990002]);
        seedAllowlist([990002]);          // en sync

        // Instalamos un flag stale a mano (divergencia previa ya resuelta).
        fs.writeFileSync(path.join(dir, desyncDetector.DESYNC_FLAG_BASENAME),
            JSON.stringify({ detected_at: '2026-07-03T00:00:00Z', classification: 'ambiguo' }));
        assert.equal(desyncDetector.isDesyncFlagSet(), true, 'precondición: flag instalado');

        pulpo.evaluateDesyncAndMaybeRealign('periodic');

        assert.equal(desyncDetector.isDesyncFlagSet(), false, 'flag stale limpiado');
        assert.equal(fs.existsSync(path.join(dir, desyncDetector.DESYNC_FLAG_BASENAME)), false,
            'el archivo de flag no debe existir');
    } finally { teardown(dir); }
});

// =============================================================================
// CA-3 — Auto-resync aditivo de divergencia ambigua LEGÍTIMA
// =============================================================================

test('CA-3: divergencia ambigua con traza legítima reciente → resync aditivo a la ola, flag limpio, no bloqueado', () => {
    const dir = setup();
    try {
        writeWaves(dir, [990002]);                 // ola activa sin 990010
        seedAllowlist([990002]);                   // base
        // Suma legítima de 990010 a la allowlist (deja audit wave-promote added:[990010]).
        seedAllowlist([990002, 990010], 'Suma coherente /wave add #990010 (#4439)');

        // Divergencia: allowlist=[990002,990010], ola=[990002] → added=[990010] abierto → ambiguo.
        const before = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true });
        assert.equal(before.desync, true);
        assert.deepEqual(before.added, [990010]);
        assert.equal(before.classification, 'ambiguo');

        pulpo.evaluateDesyncAndMaybeRealign('periodic');

        // Resync aditivo: 990010 ahora está en la ola.
        assert.ok(readWaveIssues(dir).includes(990010), 'resync aditivo debe agregar 990010 a la ola');
        // Ya no hay desync → flag limpio, pipeline no bloqueado.
        assert.equal(desyncDetector.isDesyncFlagSet(), false, 'no debe quedar flag');
        const after = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true });
        assert.equal(after.desync, false);
    } finally { teardown(dir); }
});

// =============================================================================
// CA-4 — Human-block preservado sin traza legítima (defensa A08)
// =============================================================================

test('CA-4: issue abierto ajeno inyectado SIN audit-entry → mantiene human-block (no auto-resync)', () => {
    const dir = setup();
    try {
        writeWaves(dir, [990002]);
        // Manipulación externa: escribir el JSON directo, sin pasar por el gate.
        fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({
            allowed_issues: [990002, 990666], created_at: '2026-07-03T00:00:00Z', source: 'manual',
        }, null, 2));

        pulpo.evaluateDesyncAndMaybeRealign('periodic');

        // NO se auto-resincroniza: el issue ajeno NO entra a la ola.
        assert.ok(!readWaveIssues(dir).includes(990666), '990666 no debe entrar a la ola');
        // Human-block preservado.
        assert.equal(desyncDetector.isDesyncFlagSet(), true, 'debe mantener el flag (human-block)');
    } finally { teardown(dir); }
});

test('CA-4: binding cruzado — N legítimo + M ajeno inyectado → solo N resync, M mantiene block', () => {
    const dir = setup();
    try {
        writeWaves(dir, [990002]);
        seedAllowlist([990002]);
        // N=990010 legítimo (deja audit wave-promote added:[990010]).
        seedAllowlist([990002, 990010], 'Suma coherente /wave add #990010 (#4439)');
        // M=990666 inyectado externamente encima, sin audit-entry.
        fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({
            allowed_issues: [990002, 990010, 990666], created_at: '2026-07-03T00:00:00Z', source: 'manual',
        }, null, 2));

        pulpo.evaluateDesyncAndMaybeRealign('periodic');

        const waveIssues = readWaveIssues(dir);
        assert.ok(waveIssues.includes(990010), 'N legítimo se resincroniza a la ola');
        assert.ok(!waveIssues.includes(990666), 'M ajeno NO se resincroniza');
        // M mantiene la divergencia → human-block persiste.
        assert.equal(desyncDetector.isDesyncFlagSet(), true, 'M ajeno mantiene el human-block');
        const after = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true });
        assert.equal(after.desync, true);
        assert.deepEqual(after.added, [990666], 'sólo queda M como divergencia ambigua');
    } finally { teardown(dir); }
});

// =============================================================================
// CA-4 (SEC replay) — traza forjada/expirada verificada a nivel predicado ya
// cubierta arriba; acá el extremo end-to-end: authorized_by inválido en audit
// real no habilita resync.
// =============================================================================

test('CA-4: traza con authorized_by no habilitante (pulpo:cleanup) → NO resync, human-block', () => {
    const dir = setup();
    try {
        writeWaves(dir, [990002]);
        seedAllowlist([990002]);
        // Suma de 990010 con autoría NO habilitante para auto-resync.
        partialPause.setPartialPause([990002, 990010], {
            source: 'pulpo:cleanup', authorizedBy: 'pulpo:cleanup',
            justification: 'limpieza programada (no habilita resync)',
        });

        pulpo.evaluateDesyncAndMaybeRealign('periodic');

        assert.ok(!readWaveIssues(dir).includes(990010), '990010 no debe entrar a la ola (autoría no habilitante)');
        assert.equal(desyncDetector.isDesyncFlagSet(), true, 'human-block preservado');
    } finally { teardown(dir); }
});
