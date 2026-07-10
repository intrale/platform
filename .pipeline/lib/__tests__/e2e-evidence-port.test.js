// =============================================================================
// e2e-evidence-port.test.js — Tests unitarios del puerto `e2e` (#4573)
//
// Cobertura mapeada a criterios de aceptación:
//   - CA-2/CA-9: manifest bien formado con los 4 campos de representatividad.
//   - CA-2/CA-3: frescura derivada del mtime real (no inyectable).
//   - CA-4: hash SHA-256 cambia cuando cambia el input (anti-cache).
//   - CA-5: Tier 2 skip-con-razón sin label/capability; trigger cuando aplica.
//   - CA-6: estado capturado declarado (happy/error/empty).
//   - CA-7: rechazo de vista dinámica (defensa SSRF) + comando Tier 2 validado.
//   - CA-8: kill-switch por feature-flag.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const port = require('../e2e-evidence-port');

// -----------------------------------------------------------------------------
// Helpers de test
// -----------------------------------------------------------------------------

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-port-'));
}

function writeFile(dir, name, content) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
}

// -----------------------------------------------------------------------------
// Feature-flag (CA-8)
// -----------------------------------------------------------------------------

test('isEnabled: default off, on con "1"', () => {
    assert.equal(port.isEnabled({}), false);
    assert.equal(port.isEnabled({ PIPELINE_E2E_EVIDENCE_ENABLED: '0' }), false);
    assert.equal(port.isEnabled({ PIPELINE_E2E_EVIDENCE_ENABLED: '1' }), true);
    assert.equal(port.isEnabled({ PIPELINE_E2E_EVIDENCE_ENABLED: ' 1 ' }), true);
});

test('runE2eEvidence: flag off → skipped sin producir evidencia (CA-8)', async () => {
    const result = await port.runE2eEvidence({
        workItemRef: { issue: 4573 },
        allowedRoot: tmpDir(),
        env: {},
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'flag-off');
    assert.equal(result.artifacts.length, 0);
    assert.equal(result.manifest.tier1.status, 'skipped');
});

// -----------------------------------------------------------------------------
// Representatividad: manifest con los 4 campos (CA-2 / CA-9)
// -----------------------------------------------------------------------------

test('buildArtifactEntry: manifest con los 4 campos de representatividad (CA-2)', () => {
    const dir = tmpDir();
    const p = writeFile(dir, 'render.png', 'contenido-render');
    const entry = port.buildArtifactEntry(p, {
        kind: 'render',
        viewport: { width: 1440, height: 900 },
        capturedState: 'happy',
    });
    assert.equal(entry.path, p);
    assert.match(entry.hash, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(entry.viewport, { width: 1440, height: 900 });
    assert.equal(entry.capturedState, 'happy');
    // Frescura ISO válida y coincide con el mtime real del archivo.
    const mtimeIso = fs.statSync(p).mtime.toISOString();
    assert.equal(entry.freshness, mtimeIso);
});

test('deriveFreshness: derivada del mtime real, NO inyectable (CA-2/CA-3)', () => {
    const dir = tmpDir();
    const p = writeFile(dir, 'x.png', 'abc');
    const mtimeIso = fs.statSync(p).mtime.toISOString();

    // Aunque el caller intente inyectar un timestamp falso en meta, el entry usa
    // el mtime real del archivo — el campo `freshness` inyectado se ignora.
    const entry = port.buildArtifactEntry(p, {
        viewport: { width: 800, height: 600 },
        capturedState: 'happy',
        freshness: '1999-01-01T00:00:00.000Z', // inyección maliciosa
        hash: 'sha256:falso',                    // inyección maliciosa
    });
    assert.equal(entry.freshness, mtimeIso);
    assert.notEqual(entry.freshness, '1999-01-01T00:00:00.000Z');
    assert.notEqual(entry.hash, 'sha256:falso');
});

// -----------------------------------------------------------------------------
// Anti-cache: hash cambia con el input (CA-4)
// -----------------------------------------------------------------------------

test('sha256File: hash cambia cuando cambia el input (CA-4)', () => {
    const dir = tmpDir();
    const a = writeFile(dir, 'a.png', 'input-uno');
    const b = writeFile(dir, 'b.png', 'input-dos');
    const same = writeFile(dir, 'c.png', 'input-uno');

    assert.notEqual(port.sha256File(a), port.sha256File(b));
    assert.equal(port.sha256File(a), port.sha256File(same)); // determinístico por contenido
    assert.match(port.sha256File(a), /^sha256:[a-f0-9]{64}$/);
});

// -----------------------------------------------------------------------------
// Estado capturado declarado (CA-6)
// -----------------------------------------------------------------------------

test('normalizeCapturedState: acepta happy/error/empty, default happy (CA-6)', () => {
    assert.equal(port.normalizeCapturedState('happy'), 'happy');
    assert.equal(port.normalizeCapturedState('error'), 'error');
    assert.equal(port.normalizeCapturedState('empty'), 'empty');
    assert.equal(port.normalizeCapturedState(undefined), 'happy');
});

test('normalizeCapturedState: estado no declarable tira (CA-6)', () => {
    assert.throws(() => port.normalizeCapturedState('perfecto'), /capturedState inválido/);
});

// -----------------------------------------------------------------------------
// Tiered / lazy (CA-5)
// -----------------------------------------------------------------------------

test('shouldTriggerTier2: no dispara sin label app:* (CA-5)', () => {
    assert.equal(port.shouldTriggerTier2({
        labels: ['area:pipeline'],
        hasNonMachineCriteria: true,
        adapterCapability: { e2e: true },
    }), false);
});

test('shouldTriggerTier2: no dispara sin capability e2e (CA-5)', () => {
    assert.equal(port.shouldTriggerTier2({
        labels: ['app:client'],
        hasNonMachineCriteria: true,
        adapterCapability: { e2e: false },
    }), false);
});

test('shouldTriggerTier2: no dispara sin criterio no-máquina (CA-5)', () => {
    assert.equal(port.shouldTriggerTier2({
        labels: ['app:client'],
        hasNonMachineCriteria: false,
        adapterCapability: { e2e: true },
    }), false);
});

test('shouldTriggerTier2: dispara con label + capability + criterio (CA-5)', () => {
    assert.equal(port.shouldTriggerTier2({
        labels: ['app:delivery', 'priority:high'],
        hasNonMachineCriteria: true,
        adapterCapability: { e2e: true },
    }), true);
    // Acepta labels como objetos {name}.
    assert.equal(port.shouldTriggerTier2({
        labels: [{ name: 'app:business' }],
        hasNonMachineCriteria: true,
        adapterCapability: { e2e: true },
    }), true);
});

test('tier2SkipReason: razón explícita por cada causa de skip (CA-5)', () => {
    assert.match(port.tier2SkipReason({
        labels: ['app:client'], hasNonMachineCriteria: true, adapterCapability: { e2e: false },
    }), /capability e2e/);
    assert.match(port.tier2SkipReason({
        labels: ['area:pipeline'], hasNonMachineCriteria: true, adapterCapability: { e2e: true },
    }), /sin label app/);
    assert.match(port.tier2SkipReason({
        labels: ['app:client'], hasNonMachineCriteria: false, adapterCapability: { e2e: true },
    }), /no verificable por máquina/);
    // Cuando SÍ dispara, no hay razón de skip.
    assert.equal(port.tier2SkipReason({
        labels: ['app:client'], hasNonMachineCriteria: true, adapterCapability: { e2e: true },
    }), null);
});

test('runE2eEvidence: Tier 2 skip-con-razón cuando no aplica (CA-5)', async () => {
    const dir = tmpDir();
    // Fake capture que escribe un PNG real para que el manifest pueda derivar mtime/hash.
    const fakeCapture = async ({ outputPath, allowedRoot }) => {
        const p = path.join(allowedRoot, outputPath);
        fs.writeFileSync(p, 'render-bytes');
        return { ok: true, outputPath: p, effectiveViewport: { width: 1440, height: 900 } };
    };
    const result = await port.runE2eEvidence({
        workItemRef: { issue: 4573, labels: ['area:pipeline'] },
        artefacto: { dashboardView: '/v3', capturedState: 'happy' },
        entornoObjetivo: { adapterCapability: { e2e: true }, hasNonMachineCriteria: true },
        allowedRoot: dir,
        env: { PIPELINE_E2E_EVIDENCE_ENABLED: '1' },
        _capture: fakeCapture,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.manifest.tier2.status, 'skipped');
    assert.match(result.manifest.tier2.reason, /sin label app/);
    // Tier 1 sí produjo el render con representatividad completa.
    assert.equal(result.manifest.tier1.status, 'ok');
    assert.equal(result.manifest.tier1.artifacts.length, 1);
    assert.deepEqual(result.manifest.tier1.artifacts[0].viewport, { width: 1440, height: 900 });
});

test('runE2eEvidence: Tier 2 ready con comando validado cuando aplica (CA-5)', async () => {
    const dir = tmpDir();
    const fakeCapture = async ({ outputPath, allowedRoot }) => {
        const p = path.join(allowedRoot, outputPath);
        fs.writeFileSync(p, 'render-bytes');
        return { ok: true, outputPath: p, effectiveViewport: { width: 1440, height: 900 } };
    };
    const result = await port.runE2eEvidence({
        workItemRef: { issue: 4573, labels: ['app:client'] },
        artefacto: { dashboardView: '/', capturedState: 'happy' },
        entornoObjetivo: { adapterCapability: { e2e: true }, hasNonMachineCriteria: true, flavor: 'client' },
        allowedRoot: dir,
        env: { PIPELINE_E2E_EVIDENCE_ENABLED: '1' },
        _capture: fakeCapture,
    });
    assert.equal(result.manifest.tier2.status, 'ready');
    assert.equal(result.manifest.tier2.command.cmd, './gradlew');
    assert.deepEqual(result.manifest.tier2.command.args, [':app:composeApp:assembleClientDebug', '--no-daemon']);
});

// -----------------------------------------------------------------------------
// Seguridad: SSRF + inyección de comando (CA-7)
// -----------------------------------------------------------------------------

test('assertAllowedView: acepta vistas de la allowlist, rechaza dinámicas (CA-7/SSRF)', () => {
    assert.equal(port.assertAllowedView('/'), '/');
    assert.equal(port.assertAllowedView('/v3'), '/v3');
    assert.throws(() => port.assertAllowedView('/ops'), /no autorizada/);
    assert.throws(() => port.assertAllowedView('http://169.254.169.254/latest'), /no autorizada/);
    assert.throws(() => port.assertAllowedView('http://evil.com'), /no autorizada/);
});

test('runE2eEvidence: vista dinámica → failed con diagnóstico (CA-7/SSRF)', async () => {
    const result = await port.runE2eEvidence({
        workItemRef: { issue: 4573, labels: ['area:pipeline'] },
        artefacto: { dashboardView: 'http://169.254.169.254/latest' },
        entornoObjetivo: {},
        allowedRoot: tmpDir(),
        env: { PIPELINE_E2E_EVIDENCE_ENABLED: '1' },
        _capture: async () => { throw new Error('no debería invocarse'); },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.manifest.tier1.status, 'failed');
    assert.ok(result.diagnostics.some((d) => /no autorizada/.test(d)));
});

test('buildTier2Command: valida issue ^\\d+$ y flavor allowlist (CA-7/A03)', () => {
    const ok = port.buildTier2Command({ issue: 4573, flavor: 'business' });
    assert.equal(ok.cmd, './gradlew');
    assert.deepEqual(ok.args, [':app:composeApp:assembleBusinessDebug', '--no-daemon']);

    assert.throws(() => port.buildTier2Command({ issue: '4573; rm -rf /', flavor: 'client' }), /issue inválido/);
    assert.throws(() => port.buildTier2Command({ issue: 'abc', flavor: 'client' }), /issue inválido/);
    assert.throws(() => port.buildTier2Command({ issue: 4573, flavor: 'evil' }), /flavor inválido/);
    assert.throws(() => port.buildTier2Command({ issue: 4573, flavor: 'client; whoami' }), /flavor inválido/);
});

// -----------------------------------------------------------------------------
// buildManifest: forma estable
// -----------------------------------------------------------------------------

test('buildManifest: estructura estable con defaults', () => {
    const m = port.buildManifest({ workItemRef: { issue: 4573, type: 'bug' } });
    assert.equal(m.version, port.MANIFEST_VERSION);
    assert.equal(m.port, 'e2e');
    assert.equal(m.workItemRef.issue, '4573');
    assert.equal(m.workItemRef.type, 'bug');
    assert.equal(m.tier1.status, 'skipped');
    assert.equal(m.tier2.status, 'skipped');
    assert.deepEqual(m.tier1.artifacts, []);
});
