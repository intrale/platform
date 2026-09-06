'use strict';

// =============================================================================
// #5176 · grupo 1 — Migración de los lectores puros de olas al envoltorio.
//
// Cada test de acá fija un riesgo VERIFICADO de la receta de pre-admisión, no
// una línea de código:
//
//   A-2  — `desync-detector` conserva su lectura propia de `waves.json`:
//          `null` (sin canónica) NO puede colapsar en `[]` (ola vacía), y un
//          `waves.json` corrupto no puede tumbar el tick del detector.
//   SEC-3 — con halt total presente, el detector sigue viendo el CONTENIDO del
//          marker de allowlist. Si lo leyera por `getDispatchState()` vería
//          `[]` y reportaría un desync falso contra la ola activa.
//   R7    — el halt total gana sobre la allowlist en el header del dashboard, y
//          NO se confunde con "allowlist vacía".
//   SEC-4 — una ventana por SKILL (sin issues) activa `partial_pause` en el
//          header, igual que en el gate real del Pulpo.
//
// node --test .pipeline/lib/__tests__/operational-state-readers-g1-5176.test.js
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setupTmp(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    return dir;
}

function teardownTmp(dir, prevOverride) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (prevOverride === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
    else process.env.PIPELINE_DIR_OVERRIDE = prevOverride;
}

function freshDesyncDetector() {
    delete require.cache[require.resolve('../desync-detector')];
    return require('../desync-detector');
}

function writeWaves(dir, activeWave) {
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify({
        version: '1.0',
        meta: { updated_at: new Date().toISOString(), updated_by: 't', source: 't' },
        active_wave: activeWave,
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    }));
}

function writePartial(dir, marker) {
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify(marker));
}

// ─── Envoltorio · readDispatchAllowlist (los 3 estados) ─────────────────────

test('#5176 readDispatchAllowlist: marker ausente → null (no es "allowlist vacía")', () => {
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    const dir = setupTmp('ops-readers-absent-');
    try {
        const ops = require('../operational-state');
        assert.equal(ops.readDispatchAllowlist(), null);
    } finally { teardownTmp(dir, prev); }
});

test('#5176 readDispatchAllowlist: marker presente y vacío → { issues: [] }', () => {
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    const dir = setupTmp('ops-readers-empty-');
    try {
        writePartial(dir, { allowed_issues: [], created_at: '2026-08-14T00:00:00Z', source: 't' });
        const ops = require('../operational-state');
        const snap = ops.readDispatchAllowlist();
        assert.deepEqual(snap.issues, []);
        assert.equal(snap.createdAt, '2026-08-14T00:00:00Z');
    } finally { teardownTmp(dir, prev); }
});

test('#5176 readDispatchAllowlist: marker ilegible → null (no inventa contenido)', () => {
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    const dir = setupTmp('ops-readers-corrupt-');
    try {
        fs.writeFileSync(path.join(dir, '.partial-pause.json'), '{ esto no es json');
        const ops = require('../operational-state');
        assert.equal(ops.readDispatchAllowlist(), null);
    } finally { teardownTmp(dir, prev); }
});

test('#5176 R7 · readDispatchAllowlist conserva el contenido bajo halt total, getDispatchState no', () => {
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    const dir = setupTmp('ops-readers-halt-');
    try {
        writePartial(dir, { allowed_issues: [5176, 5179], created_at: '2026-08-14T00:00:00Z' });
        fs.writeFileSync(path.join(dir, '.paused'), '');
        const ops = require('../operational-state');

        // El gate de dispatch deniega (halt total gana — contrato §4).
        const dispatch = ops.getDispatchState();
        assert.equal(dispatch.mode, 'paused');
        assert.deepEqual(dispatch.allowedIssues, []);
        assert.equal(ops.isIssueAllowed(5176), false);

        // …pero el CONTENIDO del marker sigue siendo legible: son markers
        // separados, y "halt total" no significa "allowlist vacía".
        assert.deepEqual(ops.readDispatchAllowlist().issues, [5176, 5179]);
    } finally { teardownTmp(dir, prev); }
});

// ─── A-2 · desync-detector conserva su lectura propia de waves.json ─────────

test('#5176 A-2 · sin active_wave el detector NO reporta desync (null ≠ [])', () => {
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    const dir = setupTmp('desync-noactive-');
    try {
        writeWaves(dir, null);
        writePartial(dir, { allowed_issues: [4242] });
        const mod = freshDesyncDetector();
        const res = mod.detectDesync({ skipFlag: true, skipAlert: true });
        assert.equal(res.desync, false, 'ausencia de canónica no es divergencia');
        assert.equal(res.reason, 'no_waves_yet');
        assert.equal(res.waves_allowlist, null, 'null, NO [] — el colapso es el bug de A-2');
    } finally { teardownTmp(dir, prev); }
});

test('#5176 A-2 · waves.json corrupto → sin canónica y el detector NO lanza', () => {
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    const dir = setupTmp('desync-corrupt-');
    try {
        fs.writeFileSync(path.join(dir, 'waves.json'), '{ roto');
        writePartial(dir, { allowed_issues: [4242] });
        const mod = freshDesyncDetector();
        const res = mod.detectDesync({ skipFlag: true, skipAlert: true });
        assert.equal(res.desync, false);
        assert.equal(res.waves_allowlist, null);
    } finally { teardownTmp(dir, prev); }
});

test('#5176 SEC-3 · halt total + allowlist con issues → el detector NO reporta desync falso', () => {
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    const dir = setupTmp('desync-halt-');
    try {
        writeWaves(dir, {
            number: 94,
            name: 'ola de prueba',
            issues: [{ number: 5176 }, { number: 5179 }],
        });
        writePartial(dir, { allowed_issues: [5176, 5179] });
        fs.writeFileSync(path.join(dir, '.paused'), '');
        const mod = freshDesyncDetector();
        const res = mod.detectDesync({ skipFlag: true, skipAlert: true });
        assert.equal(res.desync, false, 'el halt total no vacía la allowlist observada');
        assert.deepEqual(res.partial_allowlist, [5176, 5179]);
    } finally { teardownTmp(dir, prev); }
});

test('#5176 · marker de allowlist ausente sigue distinguiéndose de allowlist vacía', () => {
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    const dir = setupTmp('desync-absent-');
    try {
        writeWaves(dir, { number: 94, name: 'ola', issues: [{ number: 5176 }] });
        const mod = freshDesyncDetector();
        const sinMarker = mod.detectDesync({ skipFlag: true, skipAlert: true });
        assert.equal(sinMarker.desync, false);
        assert.equal(sinMarker.reason, 'no_partial_pause');

        writePartial(dir, { allowed_issues: [] });
        const conMarkerVacio = mod.detectDesync({ skipFlag: true, skipAlert: true });
        assert.equal(conMarkerVacio.desync, true, 'marker vacío SÍ es divergencia contra una ola con issues');
        assert.deepEqual(conMarkerVacio.partial_allowlist, []);
    } finally { teardownTmp(dir, prev); }
});

// ─── R7 / SEC-4 · headerSlice del dashboard ────────────────────────────────

function headerModeIn(dir) {
    const slices = require('../dashboard-slices');
    const state = {
        procesos: { pulpo: { alive: true, uptime: 0 } },
        issueMatrix: {},
        bloqueados: [],
        actividad: [],
        priorityWindows: {},
        resources: {},
    };
    return slices.headerSlice(state, { PIPELINE: dir });
}

test('#5176 R7 · headerSlice: halt total gana sobre la allowlist y no se lee como vacía', () => {
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    const dir = setupTmp('header-halt-');
    try {
        writePartial(dir, { allowed_issues: [5176, 5179] });
        fs.writeFileSync(path.join(dir, '.paused'), '');
        const out = headerModeIn(dir);
        assert.equal(out.mode, 'paused', 'halt total, NO partial_pause ni running');
    } finally { teardownTmp(dir, prev); }
});

test('#5176 SEC-4 · headerSlice: ventana por skill (sin issues) reporta partial_pause', () => {
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    const dir = setupTmp('header-skill-');
    try {
        writePartial(dir, { allowed_issues: [], allowed_skills: ['multi-provider-smoke-test'] });
        const out = headerModeIn(dir);
        assert.equal(out.mode, 'partial_pause', 'antes decía running con el dispatch acotado');
        assert.deepEqual(out.allowedIssues, []);
    } finally { teardownTmp(dir, prev); }
});

test('#5176 · headerSlice: allowlist con issues → partial_pause con la lista real', () => {
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    const dir = setupTmp('header-issues-');
    try {
        writePartial(dir, { allowed_issues: [5176] });
        const out = headerModeIn(dir);
        assert.equal(out.mode, 'partial_pause');
        assert.deepEqual(out.allowedIssues, [5176]);
    } finally { teardownTmp(dir, prev); }
});

test('#5176 · headerSlice: sin markers → running (paridad con el estado previo)', () => {
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    const dir = setupTmp('header-running-');
    try {
        const out = headerModeIn(dir);
        assert.equal(out.mode, 'running');
        assert.deepEqual(out.allowedIssues, []);
    } finally { teardownTmp(dir, prev); }
});
