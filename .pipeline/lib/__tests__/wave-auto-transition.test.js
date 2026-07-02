// =============================================================================
// wave-auto-transition.test.js — Tests de la transición automática de ola
// (#4368, Ola 8.3). Cubre CA-1..CA-9 del issue.
//
// CA-1  detectWaveComplete fail-closed: gh exit≠0 / timeout / issue ausente /
//       parse error / issue abierto ⇒ complete:false.
// CA-2  mode notify (default): ola completa ⇒ NO muta waves.json ni
//       .partial-pause.json, notifica, escribe audit en logs/waves.jsonl.
// CA-3  mode auto: ola completa ⇒ promoteWaveAtomic invocado (estado promovido);
//       fallo simulado ⇒ estado sin cambios (rollback) + promote_failed.
// CA-4  anti-doble-promoción: fail-closed marker activo ⇒ skip_promote_blocked.
// CA-5  proyección recursiva del allowlist tras promoción (fixture con dep).
// CA-6  kill-switch: enabled:false o kill_switch:true ⇒ cero acciones.
// CA-3b planned_waves vacío ⇒ halt + alerta, sin promoción.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/wave-auto-transition.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ─── Aislamiento por test ────────────────────────────────────────────────────

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-auto-transition-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    process.env.WAVE_PROMOTE_RECOVERY_TTL_MS = '50';
    // Recargar módulos con estado de cache por pipelineRoot.
    delete require.cache[require.resolve('../waves')];
    delete require.cache[require.resolve('../partial-pause')];
    delete require.cache[require.resolve('../wave-auto-transition')];
    const waves = require('../waves');
    const wat = require('../wave-auto-transition');
    waves.invalidateCache();
    return { dir, waves, wat };
}

function teardownTmp(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    delete process.env.WAVE_PROMOTE_RECOVERY_TTL_MS;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}

function seedWaves(dir, state) {
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(state, null, 2));
}

function seedPartial(dir, allowed) {
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({
        allowed_issues: allowed,
        created_at: '2026-06-01T00:00:00.000Z',
        source: 'test-seed',
    }, null, 2));
}

function readWaves(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
}

function readPartial(dir) {
    const p = path.join(dir, '.partial-pause.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readAuditLines(dir) {
    const p = path.join(dir, 'logs', 'waves.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readTelegramDrops(dir) {
    const d = path.join(dir, 'servicios', 'telegram', 'pendiente');
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')));
}

// Fixture base: ola activa 7 con 2 issues, ola planificada 8.
function sampleWaves(overrides = {}) {
    return {
        version: '1.0',
        meta: {
            created_at: '2026-06-01T10:00:00.000Z',
            updated_at: '2026-06-01T10:00:00.000Z',
            updated_by: 'System',
            source: 'manual',
        },
        active_wave: {
            number: 7,
            name: 'Ola N+7',
            started_at: '2026-06-01T10:00:00.000Z',
            issues: [{ number: 3451, status: 'in_progress' }, { number: 3452, status: 'in_progress' }],
        },
        planned_waves: [
            { number: 8, name: 'Ola N+8', issues: [{ number: 3520 }, { number: 3521 }] },
        ],
        archived_waves: [],
        dependencies: [],
        ...overrides,
    };
}

// Fabrica un ghCall mock que responde CLOSED/OPEN según un mapa por issue.
function mkGhCall(statesByIssue) {
    return async (args) => {
        // args = ['issue','view','<N>','--json','state']
        const n = Number(args[2]);
        const state = statesByIssue[n];
        if (state === undefined) {
            // simula issue ausente: gh devuelve error
            const err = new Error(`no issue found ${n}`);
            throw err;
        }
        return { stdout: JSON.stringify({ state }) };
    };
}

const CFG_NOTIFY = { wave_auto_transition: { enabled: true, kill_switch: false, mode: 'notify', gh_timeout_ms: 5000 } };
const CFG_AUTO = { wave_auto_transition: { enabled: true, kill_switch: false, mode: 'auto', gh_timeout_ms: 5000 } };

// ─── CA-1 — detectWaveComplete fail-closed ───────────────────────────────────

test('CA-1 detectWaveComplete: todos CLOSED ⇒ complete:true', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        waves.invalidateCache();
        const det = await wat.detectWaveComplete(CFG_NOTIFY, { ghCall: mkGhCall({ 3451: 'CLOSED', 3452: 'CLOSED' }) });
        assert.equal(det.complete, true);
        assert.equal(det.reason, 'all_closed');
        assert.equal(det.from_wave, 7);
        assert.equal(det.checked.length, 2);
    } finally { teardownTmp(dir); }
});

test('CA-1 detectWaveComplete: un issue OPEN ⇒ complete:false', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        waves.invalidateCache();
        const det = await wat.detectWaveComplete(CFG_NOTIFY, { ghCall: mkGhCall({ 3451: 'CLOSED', 3452: 'OPEN' }) });
        assert.equal(det.complete, false);
        assert.equal(det.reason, 'issue_open_3452');
    } finally { teardownTmp(dir); }
});

test('CA-1 detectWaveComplete: gh error / issue ausente ⇒ fail-closed', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        waves.invalidateCache();
        // 3452 ausente → mkGhCall lanza.
        const det = await wat.detectWaveComplete(CFG_NOTIFY, { ghCall: mkGhCall({ 3451: 'CLOSED' }) });
        assert.equal(det.complete, false);
        assert.match(det.reason, /^gh_error_issue_3452/);
    } finally { teardownTmp(dir); }
});

test('CA-1 detectWaveComplete: timeout de gh ⇒ fail-closed', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        waves.invalidateCache();
        const ghCall = async () => { const e = new Error('gh-call-timeout: 5000ms'); e.code = 'GH_CALL_TIMEOUT'; throw e; };
        const det = await wat.detectWaveComplete(CFG_NOTIFY, { ghCall });
        assert.equal(det.complete, false);
        assert.match(det.reason, /gh_error_issue_/);
    } finally { teardownTmp(dir); }
});

test('CA-1 detectWaveComplete: respuesta sin state ⇒ fail-closed (missing)', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        waves.invalidateCache();
        const ghCall = async () => ({ stdout: JSON.stringify({}) }); // sin state
        const det = await wat.detectWaveComplete(CFG_NOTIFY, { ghCall });
        assert.equal(det.complete, false);
        assert.match(det.reason, /gh_no_state_issue_/);
        assert.ok(det.missing.length >= 1);
    } finally { teardownTmp(dir); }
});

test('CA-1 detectWaveComplete: JSON inválido ⇒ fail-closed', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        waves.invalidateCache();
        const ghCall = async () => ({ stdout: 'no-es-json' });
        const det = await wat.detectWaveComplete(CFG_NOTIFY, { ghCall });
        assert.equal(det.complete, false);
        assert.match(det.reason, /gh_parse_error_issue_/);
    } finally { teardownTmp(dir); }
});

test('CA-1 detectWaveComplete: sin ola activa ⇒ fail-closed', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir, sampleWaves({ active_wave: null }));
        waves.invalidateCache();
        const det = await wat.detectWaveComplete(CFG_NOTIFY, { ghCall: mkGhCall({}) });
        assert.equal(det.complete, false);
        assert.equal(det.reason, 'no_active_wave');
    } finally { teardownTmp(dir); }
});

// ─── CA-2 — mode notify (default, no muta estado) ────────────────────────────

test('CA-2 mode notify: ola completa ⇒ NO muta estado, notifica y audita', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        seedPartial(dir, [3451, 3452]);
        waves.invalidateCache();
        const before = readWaves(dir);
        const beforePartial = readPartial(dir);

        const res = await wat.autoTransitionIfComplete(CFG_NOTIFY, {
            ghCall: mkGhCall({ 3451: 'CLOSED', 3452: 'CLOSED' }),
        });

        assert.equal(res.action, 'detected_complete');
        assert.equal(res.from_wave, 7);
        assert.equal(res.to_wave, 8);

        // NO mutó waves.json ni .partial-pause.json.
        assert.deepEqual(readWaves(dir).active_wave, before.active_wave);
        assert.deepEqual(readPartial(dir).allowed_issues, beforePartial.allowed_issues);

        // Notificó y auditó.
        const drops = readTelegramDrops(dir);
        assert.equal(drops.length, 1);
        assert.match(drops[0].text, /ready-to-close 7/);
        const audit = readAuditLines(dir);
        assert.equal(audit.length, 1);
        assert.equal(audit[0].action, 'detected_complete');
        assert.equal(audit[0].actor, 'auto-transition');
    } finally { teardownTmp(dir); }
});

test('CA-2 mode notify: ola NO completa ⇒ noop sin notificar', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        waves.invalidateCache();
        const res = await wat.autoTransitionIfComplete(CFG_NOTIFY, {
            ghCall: mkGhCall({ 3451: 'CLOSED', 3452: 'OPEN' }),
        });
        assert.equal(res.action, 'noop');
        assert.equal(readTelegramDrops(dir).length, 0);
        assert.equal(readAuditLines(dir).length, 0);
    } finally { teardownTmp(dir); }
});

// ─── CA-3 — mode auto (promoción atómica) ────────────────────────────────────

test('CA-3 mode auto: ola completa ⇒ promueve la siguiente ola', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        seedPartial(dir, [3451, 3452]);
        waves.invalidateCache();

        const res = await wat.autoTransitionIfComplete(CFG_AUTO, {
            ghCall: mkGhCall({ 3451: 'CLOSED', 3452: 'CLOSED' }),
        });

        assert.equal(res.action, 'auto_transition');
        assert.equal(res.from_wave, 7);
        assert.equal(res.to_wave, 8);

        // waves.json: ola 8 ahora activa, ola 7 archivada.
        const after = readWaves(dir);
        assert.equal(after.active_wave.number, 8);
        assert.ok(after.archived_waves.some((w) => w.number === 7));
        assert.ok(!after.planned_waves.some((w) => w.number === 8));

        // audit auto_transition presente.
        const audit = readAuditLines(dir);
        assert.ok(audit.some((a) => a.action === 'auto_transition'));
    } finally { teardownTmp(dir); }
});

test('CA-3 mode auto: promoteWaveAtomic falla ⇒ estado sin cambios (rollback) + promote_failed', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        seedPartial(dir, [3451, 3452]);
        waves.invalidateCache();
        const before = readWaves(dir);

        // Marker in-progress fuerza a promoteWaveAtomic a lanzar ANTES de aplicar
        // (transacción en curso). No es un fail-closed marker, así que el guard
        // isWavePromoteBlocked NO lo intercepta — ejercita el catch real.
        fs.writeFileSync(path.join(dir, 'wave-promote.in-progress.json'), JSON.stringify({ pid: 999999 }));

        const res = await wat.autoTransitionIfComplete(CFG_AUTO, {
            ghCall: mkGhCall({ 3451: 'CLOSED', 3452: 'CLOSED' }),
        });

        assert.equal(res.action, 'promote_failed');
        // Estado intacto: la ola 7 sigue activa, la 8 sigue planificada.
        const after = readWaves(dir);
        assert.equal(after.active_wave.number, 7);
        assert.deepEqual(after.active_wave, before.active_wave);
        // Alerta de error emitida.
        const drops = readTelegramDrops(dir);
        assert.ok(drops.some((d) => /Falló la promoción/.test(d.text)));
    } finally { teardownTmp(dir); }
});

// ─── CA-3b — planned_waves vacío ─────────────────────────────────────────────

test('CA-3b mode auto: sin olas planificadas ⇒ halt + alerta, sin promoción', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir, sampleWaves({ planned_waves: [] }));
        waves.invalidateCache();
        const before = readWaves(dir);

        const res = await wat.autoTransitionIfComplete(CFG_AUTO, {
            ghCall: mkGhCall({ 3451: 'CLOSED', 3452: 'CLOSED' }),
        });

        assert.equal(res.action, 'halt_no_planned');
        assert.deepEqual(readWaves(dir).active_wave, before.active_wave);
        const drops = readTelegramDrops(dir);
        assert.ok(drops.some((d) => /NO hay olas planificadas/.test(d.text)));
    } finally { teardownTmp(dir); }
});

// ─── CA-4 — anti doble promoción ─────────────────────────────────────────────

test('CA-4 mode auto: fail-closed marker activo ⇒ skip_promote_blocked', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        waves.invalidateCache();
        // Marker .failed.* activo → isWavePromoteBlocked() = blocked.
        fs.writeFileSync(path.join(dir, 'wave-promote.failed.2026-06-01.json'), JSON.stringify({ reason: 'test' }));

        const res = await wat.autoTransitionIfComplete(CFG_AUTO, {
            ghCall: mkGhCall({ 3451: 'CLOSED', 3452: 'CLOSED' }),
        });

        assert.equal(res.action, 'skip_promote_blocked');
        // No promovió.
        assert.equal(readWaves(dir).active_wave.number, 7);
    } finally { teardownTmp(dir); }
});

// ─── CA-5 — proyección recursiva del allowlist ───────────────────────────────

test('CA-5 mode auto: allowlist incluye recursivamente deps de la nueva ola', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        // La ola 8 tiene el issue 3520; 3520 está bloqueado por 9999 (dep).
        seedWaves(dir, sampleWaves({
            planned_waves: [{ number: 8, name: 'Ola N+8', issues: [{ number: 3520 }] }],
            dependencies: [{ blocked: 3520, blocker: 9999 }],
        }));
        seedPartial(dir, [3451, 3452]);
        waves.invalidateCache();

        const res = await wat.autoTransitionIfComplete(CFG_AUTO, {
            ghCall: mkGhCall({ 3451: 'CLOSED', 3452: 'CLOSED' }),
        });

        assert.equal(res.action, 'auto_transition');
        const partial = readPartial(dir);
        assert.ok(partial.allowed_issues.includes(3520), 'incluye issue de la ola');
        assert.ok(partial.allowed_issues.includes(9999), 'incluye dep recursiva');
        // diff refleja los added.
        assert.ok(res.allowlist_diff.added.includes(9999));
    } finally { teardownTmp(dir); }
});

// ─── CA-6 — kill switch ──────────────────────────────────────────────────────

test('CA-6 kill-switch: enabled:false ⇒ cero acciones (no llama ghCall)', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        waves.invalidateCache();
        let ghCalled = false;
        const ghCall = async () => { ghCalled = true; return { stdout: '{}' }; };

        const res = await wat.autoTransitionIfComplete(
            { wave_auto_transition: { enabled: false, mode: 'auto' } },
            { ghCall },
        );

        assert.equal(res.action, 'disabled');
        assert.equal(res.reason, 'not_enabled');
        assert.equal(ghCalled, false);
        assert.equal(readTelegramDrops(dir).length, 0);
        assert.equal(readAuditLines(dir).length, 0);
    } finally { teardownTmp(dir); }
});

test('CA-6 kill-switch: kill_switch:true ⇒ cero acciones aunque enabled:true', async () => {
    const { dir, waves, wat } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        waves.invalidateCache();
        let ghCalled = false;
        const ghCall = async () => { ghCalled = true; return { stdout: '{}' }; };

        const res = await wat.autoTransitionIfComplete(
            { wave_auto_transition: { enabled: true, kill_switch: true, mode: 'auto' } },
            { ghCall },
        );

        assert.equal(res.action, 'disabled');
        assert.equal(res.reason, 'kill_switch');
        assert.equal(ghCalled, false);
    } finally { teardownTmp(dir); }
});

// ─── Helper interno: pickNextPlannedWave ─────────────────────────────────────

test('pickNextPlannedWave: elige el menor número planificado', () => {
    const { dir, wat } = setupTmp();
    try {
        const next = wat._internal.pickNextPlannedWave({
            planned_waves: [{ number: 10 }, { number: 8 }, { number: 9 }],
        });
        assert.equal(next.number, 8);
        assert.equal(wat._internal.pickNextPlannedWave({ planned_waves: [] }), null);
    } finally { teardownTmp(dir); }
});
