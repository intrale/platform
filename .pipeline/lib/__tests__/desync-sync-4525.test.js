// =============================================================================
// desync-sync-4525.test.js — Issue #4525
//
// Auto-resolver el desync ADITIVO cuando los issues agregados a la allowlist son
// hijos VERIFICABLES de un split del propio pipeline (`authorization_ttls[n].parent`
// pertenece a la ola activa Y `authorized_by = recursive-deps:from-<parent>`).
// Reproduce el incidente 2026-07-06: split de #4509 → #4523/#4524 (+5 h frenado).
//
// Cubre:
//   CA-1  happy path: auto-incorporación a la ola + dependencia declarada +
//         flag limpio + dispatch reanuda sin intervención humana.
//   CA-2  red de seguridad: un `added` sin provenance de split → se mantiene
//         BLOQUEADO POR DESYNC (binding por issue, sólo el trazable se resuelve).
//   CA-4  auditoría inmutable: la auto-incorporación deja rastro en el audit
//         encadenado append-only (wave-audit / dependency_declared).
//   CA-6  fail-safe TTL: authorization_ttls purgado → se mantiene el bloqueo.
//   RS-1  adversarial: parent en la ola pero authorized_by no matchea → bloqueo.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/desync-sync-4525.test.js
// =============================================================================

'use strict';

process.env.PULPO_NO_AUTOSTART = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const partialPause = require('../partial-pause');
const partialPauseAudit = require('../partial-pause-audit');
const desyncDetector = require('../desync-detector');
const waves = require('../waves');
const waveAudit = require('../wave-audit');
const splitProvenance = require('../split-provenance');
const pulpo = require('../../pulpo.js');

// -----------------------------------------------------------------------------
// Helpers de fixture (mismo patrón que desync-sync-4439.test.js)
// -----------------------------------------------------------------------------

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'desync-4525-')); }
function rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }

function setup() {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'desarrollo'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'definicion'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    try { waves.invalidateCache(); } catch (_) {}
    return dir;
}

function teardown(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    try { waves.invalidateCache(); } catch (_) {}
    rmrf(dir);
}

function writeWaves(dir, activeIssues) {
    const state = {
        version: '1.0',
        meta: {
            created_at: '2026-07-06T00:00:00Z', updated_at: '2026-07-06T00:00:00Z',
            updated_by: 'fixture', source: 'manual', note: 'test #4525',
        },
        active_wave: {
            number: 3,
            name: 'Ola activa — Test 4525',
            goal: 'sync waves↔partial-pause por provenance de split',
            started_at: '2026-07-06T00:00:00.000Z',
            issues: activeIssues.map((n) => ({ number: n, status: 'in_progress' })),
        },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    };
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(state, null, 2));
    try { waves.invalidateCache(); } catch (_) {}
}

// Escribe la allowlist DIRECTO (como el proceso de split la dejó) con
// authorization_ttls. Deliberadamente NO pasa por el gate auditado: reproduce
// el estado del incidente donde la traza #4439 (TTL 90 s) ya venció y sólo queda
// la provenance estructural durable de authorization_ttls.
function writeAllowlistWithTtls(dir, allowedIssues, authorizationTtls) {
    const data = {
        allowed_issues: allowedIssues,
        created_at: '2026-07-06T06:09:00.000Z',
        source: 'recursive-deps:from-4509',
    };
    if (authorizationTtls) data.authorization_ttls = authorizationTtls;
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify(data, null, 2));
}

function readWaveIssues(dir) {
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
    return state.active_wave.issues.map((i) => i.number).sort((a, b) => a - b);
}

function readDependencies(dir) {
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
    return Array.isArray(state.dependencies) ? state.dependencies : [];
}

function ttl(parent, over = {}) {
    return {
        parent,
        authorized_by: `recursive-deps:from-${parent}`,
        expires_at: '2999-01-01T00:00:00Z',
        created_at: '2026-07-06T06:09:00Z',
        ...over,
    };
}

// =============================================================================
// CA-1 — Happy path: auto-incorporación por provenance de split
// =============================================================================

test('CA-1: hijos de split (#4523/#4524, padre #4509 en la ola) → auto-incorporados + dependencia + flag limpio', () => {
    const dir = setup();
    try {
        writeWaves(dir, [4509]);
        writeAllowlistWithTtls(dir, [4509, 4523, 4524], { 4523: ttl(4509), 4524: ttl(4509) });

        // Precondición: divergencia aditiva ambigua (added=[4523,4524], padre en la ola).
        const before = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true });
        assert.equal(before.desync, true);
        assert.deepEqual(before.added, [4523, 4524]);
        assert.equal(before.classification, 'ambiguo');

        pulpo.evaluateDesyncAndMaybeRealign('periodic');

        // Los hijos ahora están en la ola.
        assert.deepEqual(readWaveIssues(dir), [4509, 4523, 4524], 'hijos auto-incorporados a la ola');

        // Dependencia padre→hijos declarada en el dependencies TOP-LEVEL.
        const deps = readDependencies(dir);
        const dep = deps.find((d) => d.parent === 4509 && d.source === 'split-auto');
        assert.ok(dep, 'debe existir la dependencia {parent:4509, source:split-auto}');
        assert.deepEqual(dep.blocked_by.sort((a, b) => a - b), [4523, 4524]);

        // Flag de desync limpio → dispatch reanuda sin intervención humana.
        assert.equal(desyncDetector.isDesyncFlagSet(), false, 'no debe quedar flag de desync');
        const after = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true });
        assert.equal(after.desync, false);
    } finally { teardown(dir); }
});

// =============================================================================
// CA-4 — Auditoría inmutable (rastro append-only)
// =============================================================================

test('CA-4: la auto-incorporación deja rastro dependency_declared en el audit encadenado', () => {
    const dir = setup();
    try {
        writeWaves(dir, [4509]);
        writeAllowlistWithTtls(dir, [4509, 4523], { 4523: ttl(4509) });

        pulpo.evaluateDesyncAndMaybeRealign('periodic');

        const events = waveAudit.readAllEvents();
        const decl = events.find((e) => e.event === 'dependency_declared'
            && e.estado_posterior && e.estado_posterior.parent === 4509);
        assert.ok(decl, 'debe existir un evento dependency_declared para el padre 4509');
        assert.ok(decl.estado_posterior.blocked_by.includes(4523), 'el rastro registra el hijo');
        assert.equal(decl.estado_posterior.source, 'split-auto');
        assert.ok(decl.timestamp, 'el rastro registra timestamp');

        // La cadena de auditoría permanece íntegra (append-only, hash-chained).
        const chain = waveAudit.verifyChain();
        assert.equal(chain.ok, true, 'la cadena de wave-audit debe verificar');
    } finally { teardown(dir); }
});

// =============================================================================
// CA-2 — Red de seguridad / default-deny (binding por issue)
// =============================================================================

test('CA-2: mixto — #4523 con provenance + #4666 sin provenance → sólo #4523 se incorpora, block por el resto', () => {
    const dir = setup();
    try {
        writeWaves(dir, [4509]);
        // #4666 no tiene entry en authorization_ttls (inyección/ajeno).
        writeAllowlistWithTtls(dir, [4509, 4523, 4666], { 4523: ttl(4509) });

        pulpo.evaluateDesyncAndMaybeRealign('periodic');

        const waveIssues = readWaveIssues(dir);
        assert.ok(waveIssues.includes(4523), '#4523 (trazable) se incorpora');
        assert.ok(!waveIssues.includes(4666), '#4666 (sin provenance) NO se incorpora');

        // Se mantiene el human-block por el remanente sin provenance.
        assert.equal(desyncDetector.isDesyncFlagSet(), true, 'debe mantener BLOQUEADO POR DESYNC');
        const after = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true });
        assert.equal(after.desync, true);
        assert.deepEqual(after.added, [4666], 'sólo queda #4666 como divergencia ambigua');
    } finally { teardown(dir); }
});

// =============================================================================
// RS-1 — adversarial: parent en la ola pero authorized_by forjado
// =============================================================================

test('RS-1: parent:4509 en la ola pero authorized_by:"recursive-deps:from-9999" → NO se incorpora, block', () => {
    const dir = setup();
    try {
        writeWaves(dir, [4509]);
        writeAllowlistWithTtls(dir, [4509, 4523], {
            4523: { parent: 4509, authorized_by: 'recursive-deps:from-9999', expires_at: '2999-01-01T00:00:00Z' },
        });

        pulpo.evaluateDesyncAndMaybeRealign('periodic');

        assert.ok(!readWaveIssues(dir).includes(4523), 'provenance forjada NO habilita incorporación');
        assert.equal(desyncDetector.isDesyncFlagSet(), true, 'human-block preservado (RS-1)');
    } finally { teardown(dir); }
});

// =============================================================================
// CA-6 — Fail-safe sobre TTL: authorization_ttls purgado → bloqueo
// =============================================================================

test('CA-6: authorization_ttls purgado/ausente → se mantiene el bloqueo (fail-safe, no incorporación silenciosa)', () => {
    const dir = setup();
    try {
        writeWaves(dir, [4509]);
        // El cron purgó authorization_ttls: la provenance desapareció.
        writeAllowlistWithTtls(dir, [4509, 4523], null);

        pulpo.evaluateDesyncAndMaybeRealign('periodic');

        assert.ok(!readWaveIssues(dir).includes(4523), 'sin provenance no hay incorporación');
        assert.equal(desyncDetector.isDesyncFlagSet(), true, 'bloqueo preservado (RS-4/CA-6)');
    } finally { teardown(dir); }
});

// =============================================================================
// Regresión — parent NO en la ola no habilita (provenance incompleta)
// =============================================================================

test('parent fuera de la ola → NO se incorpora (no hay split del pipeline verificable)', () => {
    const dir = setup();
    try {
        writeWaves(dir, [4509]);              // la ola NO contiene 4510
        writeAllowlistWithTtls(dir, [4509, 4523], { 4523: ttl(4510) }); // parent 4510 ∉ ola

        pulpo.evaluateDesyncAndMaybeRealign('periodic');

        assert.ok(!readWaveIssues(dir).includes(4523), 'parent fuera de la ola → sin incorporación');
        assert.equal(desyncDetector.isDesyncFlagSet(), true, 'human-block preservado');
    } finally { teardown(dir); }
});

// =============================================================================
// Idempotencia — segunda evaluación no duplica ni rompe
// =============================================================================

test('idempotencia: re-ejecutar tras auto-incorporar es no-op estable', () => {
    const dir = setup();
    try {
        writeWaves(dir, [4509]);
        writeAllowlistWithTtls(dir, [4509, 4523, 4524], { 4523: ttl(4509), 4524: ttl(4509) });

        pulpo.evaluateDesyncAndMaybeRealign('periodic');
        const deps1 = readDependencies(dir).filter((d) => d.parent === 4509);
        pulpo.evaluateDesyncAndMaybeRealign('periodic');
        const deps2 = readDependencies(dir).filter((d) => d.parent === 4509);

        assert.deepEqual(readWaveIssues(dir), [4509, 4523, 4524], 'sin duplicados en la ola');
        assert.equal(deps1.length, 1);
        assert.equal(deps2.length, 1, 'no se duplica la entry de dependencia');
        assert.deepEqual(deps2[0].blocked_by.sort((a, b) => a - b), [4523, 4524]);
    } finally { teardown(dir); }
});
