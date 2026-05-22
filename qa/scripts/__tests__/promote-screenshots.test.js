// =============================================================================
// Tests promote-screenshots.js — Issue #3409 (CA-7.1 a CA-7.9)
//
// Cubre los 6 escenarios Gherkin del PO (#3409#issuecomment-4509799939):
//   1. QA exitoso promueve screenshots a la librería
//   2. Hook idempotente (no duplica al re-ejecutar)
//   3. Sobreescribe el más reciente del día
//   4. Fail-safe ante PII detectada (política PII disponible)
//   5. Fail-safe ante política PII NO disponible (default seguro)
//   6. Falla clara si la estructura de librería no existe
//
// + cobertura adicional:
//   - Heurística filename → pantalla canónica
//   - Inferencia de flavor desde qa-report.labels
//   - Unmapped PNGs no abortan el run
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const {
    promoteScreenshots,
    inferScreen,
    inferFlavorFromReport,
    loadPIIPolicy,
} = require('../promote-screenshots');

// ─── Helpers de fixture ──────────────────────────────────────────────────
function makeTmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'promote-screenshots-'));
}

function rmTmpRoot(root) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
}

function writePng(filePath, content = 'fake-png-content') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
}

function buildLibrary(libraryDir, screens = ['login', 'carrito', 'checkout', 'home', 'perfil']) {
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.writeFileSync(path.join(libraryDir, 'README.md'), '# library\n');
    for (const s of screens) {
        fs.mkdirSync(path.join(libraryDir, s), { recursive: true });
    }
}

function writeReport(reportPath, partial = {}) {
    const report = {
        issue_number: 3382,
        verdict: 'APROBADO',
        flavor: 'client',
        ...partial,
    };
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

// Fake PII policy module — escribimos un .js real en disco porque el hook
// hace `require()` con path absoluto (fail-safe es real, no mock-friendly).
function writePiiPolicyModule(targetPath, behavior = 'safe') {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    let body;
    switch (behavior) {
        case 'safe':
            body = `module.exports = { hasPII: () => ({ flagged: false, flags: [] }) };\n`;
            break;
        case 'flagged':
            body = `module.exports = { hasPII: () => ({ flagged: true, flags: ['contiene_email_usuario'] }) };\n`;
            break;
        case 'flagged-only-checkout':
            body = `module.exports = { hasPII: (f) => /checkout/i.test(String(f)) ? ({ flagged: true, flags: ['contiene_email_usuario'] }) : ({ flagged: false, flags: [] }) };\n`;
            break;
        case 'throws':
            body = `module.exports = { hasPII: () => { throw new Error('boom'); } };\n`;
            break;
        case 'broken-contract':
            body = `module.exports = { foo: 1 };\n`;
            break;
        case 'load-throws':
            body = `throw new Error('cannot load');\n`;
            break;
        default:
            throw new Error('unknown behavior: ' + behavior);
    }
    fs.writeFileSync(targetPath, body);
}

function setupFixture({ piiBehavior = 'safe', verdict = 'APROBADO', flavor = 'client', screenshots = [], extraReport = {} } = {}) {
    const root = makeTmpRoot();
    const evidenceDir = path.join(root, 'qa', 'evidence', '3382-test');
    const libraryDir = path.join(root, 'docs', 'app-screenshots-reference');
    const piiPolicyPath = path.join(root, 'qa', 'lib', 'pii-policy.js');
    const reportPath = path.join(evidenceDir, 'qa-report.json');

    buildLibrary(libraryDir);
    if (piiBehavior !== 'missing') {
        writePiiPolicyModule(piiPolicyPath, piiBehavior);
    }
    writeReport(reportPath, { verdict, flavor, ...extraReport });
    for (const s of screenshots) {
        writePng(path.join(evidenceDir, s.name), s.content || `content-${s.name}`);
    }

    return { root, evidenceDir, libraryDir, piiPolicyPath, reportPath };
}

// ─── Escenario 1: QA exitoso promueve screenshots a la librería ──────────
test('escenario 1 — QA exitoso promueve login y carrito a la librería', () => {
    const { root, evidenceDir, libraryDir, piiPolicyPath } = setupFixture({
        screenshots: [
            { name: '01-login.png', content: 'login-png-bytes' },
            { name: '02-carrito.png', content: 'carrito-png-bytes' },
        ],
    });
    try {
        const result = promoteScreenshots({
            issue: '3382-test',
            evidenceDir,
            libraryDir,
            piiPolicyPath,
            date: '2026-05-20',
        });

        assert.equal(result.ok, true);
        assert.equal(result.exitCode, 0);
        assert.equal(result.promoted, 2);
        assert.equal(result.already_in_library, 0);

        assert.ok(fs.existsSync(path.join(libraryDir, 'login', 'login-client-2026-05-20.png')));
        assert.ok(fs.existsSync(path.join(libraryDir, 'carrito', 'carrito-client-2026-05-20.png')));

        assert.ok(
            result.log.some((l) => l === 'promoted 2 screenshots to library'),
            `expected summary log; got: ${JSON.stringify(result.log)}`
        );
    } finally {
        rmTmpRoot(root);
    }
});

// ─── Escenario 2: Hook idempotente ───────────────────────────────────────
test('escenario 2 — hook idempotente (segunda corrida no duplica)', () => {
    const { root, evidenceDir, libraryDir, piiPolicyPath } = setupFixture({
        screenshots: [
            { name: '01-login.png', content: 'login-bytes' },
            { name: '02-carrito.png', content: 'carrito-bytes' },
        ],
    });
    try {
        const first = promoteScreenshots({ issue: '3382-test', evidenceDir, libraryDir, piiPolicyPath, date: '2026-05-20' });
        assert.equal(first.promoted, 2);

        const second = promoteScreenshots({ issue: '3382-test', evidenceDir, libraryDir, piiPolicyPath, date: '2026-05-20' });
        assert.equal(second.promoted, 0);
        assert.equal(second.already_in_library, 2);
        assert.ok(
            second.log.some((l) => l === 'promoted 0 screenshots (already in library)'),
            `expected idempotent summary; got: ${JSON.stringify(second.log)}`
        );

        // Verificación física: solo un archivo por destino, no duplicados.
        const loginFiles = fs.readdirSync(path.join(libraryDir, 'login'));
        assert.deepEqual(loginFiles, ['login-client-2026-05-20.png']);
    } finally {
        rmTmpRoot(root);
    }
});

// ─── Escenario 3: Sobreescribe el más reciente del día ──────────────────
test('escenario 3 — sobreescribe versión anterior del mismo día/pantalla/flavor', () => {
    const { root, evidenceDir, libraryDir, piiPolicyPath } = setupFixture({
        screenshots: [{ name: '01-login.png', content: 'login-v2-bytes' }],
    });
    try {
        // Pre-poblar la librería con una versión "vieja" del mismo día.
        const targetPath = path.join(libraryDir, 'login', 'login-client-2026-05-20.png');
        fs.writeFileSync(targetPath, 'login-v1-bytes');

        const result = promoteScreenshots({ issue: '3382-test', evidenceDir, libraryDir, piiPolicyPath, date: '2026-05-20' });
        assert.equal(result.promoted, 1);
        assert.equal(result.already_in_library, 0);

        const after = fs.readFileSync(targetPath, 'utf8');
        assert.equal(after, 'login-v2-bytes', 'expected overwrite with new content');

        assert.ok(
            result.log.some((l) => l === 'overwritten same-day screenshot login/client'),
            `expected overwrite log entry; got: ${JSON.stringify(result.log)}`
        );
    } finally {
        rmTmpRoot(root);
    }
});

// ─── Escenario 4: Fail-safe ante PII detectada ──────────────────────────
test('escenario 4 — PII detectada (política disponible) → promotion skipped', () => {
    const { root, evidenceDir, libraryDir, piiPolicyPath } = setupFixture({
        piiBehavior: 'flagged-only-checkout',
        screenshots: [{ name: 'checkout.png', content: 'checkout-bytes' }],
    });
    try {
        const result = promoteScreenshots({ issue: '3382-test', evidenceDir, libraryDir, piiPolicyPath, date: '2026-05-20' });
        assert.equal(result.ok, true);
        assert.equal(result.exitCode, 0);
        assert.equal(result.promoted, 0);
        assert.equal(result.skipped_pii, 1);

        const targetPath = path.join(libraryDir, 'checkout', 'checkout-client-2026-05-20.png');
        assert.equal(fs.existsSync(targetPath), false, 'expected no file promoted');

        assert.ok(
            result.log.some((l) => /PII detected — promotion skipped: checkout\.png/.test(l)),
            `expected PII skipped log; got: ${JSON.stringify(result.log)}`
        );
    } finally {
        rmTmpRoot(root);
    }
});

// ─── Escenario 5: Fail-safe ante política PII NO disponible ─────────────
test('escenario 5 — política PII NO disponible → fail-safe, no promueve nada', () => {
    const { root, evidenceDir, libraryDir, piiPolicyPath } = setupFixture({
        piiBehavior: 'missing',
        screenshots: [{ name: '01-login.png', content: 'login-bytes' }],
    });
    try {
        const result = promoteScreenshots({ issue: '3382-test', evidenceDir, libraryDir, piiPolicyPath, date: '2026-05-20' });
        assert.equal(result.ok, true);
        assert.equal(result.exitCode, 0, 'fail-safe debe salir 0 (no falla el QA)');
        assert.equal(result.promoted, 0);

        assert.ok(
            result.log.some((l) => /PII policy unavailable — promotion skipped/.test(l)),
            `expected fail-safe log; got: ${JSON.stringify(result.log)}`
        );

        const targetPath = path.join(libraryDir, 'login', 'login-client-2026-05-20.png');
        assert.equal(fs.existsSync(targetPath), false);
    } finally {
        rmTmpRoot(root);
    }
});

test('escenario 5b — módulo PII existe pero contrato roto → fail-safe', () => {
    const { root, evidenceDir, libraryDir, piiPolicyPath } = setupFixture({
        piiBehavior: 'broken-contract',
        screenshots: [{ name: '01-login.png' }],
    });
    try {
        const result = promoteScreenshots({ issue: '3382-test', evidenceDir, libraryDir, piiPolicyPath });
        assert.equal(result.exitCode, 0);
        assert.equal(result.promoted, 0);
        assert.ok(
            result.log.some((l) => /PII policy unavailable — promotion skipped.*hasPII/.test(l)),
            `expected broken-contract fail-safe; got: ${JSON.stringify(result.log)}`
        );
    } finally {
        rmTmpRoot(root);
    }
});

test('escenario 5c — módulo PII falla al cargar → fail-safe', () => {
    const { root, evidenceDir, libraryDir, piiPolicyPath } = setupFixture({
        piiBehavior: 'load-throws',
        screenshots: [{ name: '01-login.png' }],
    });
    try {
        const result = promoteScreenshots({ issue: '3382-test', evidenceDir, libraryDir, piiPolicyPath });
        assert.equal(result.exitCode, 0);
        assert.equal(result.promoted, 0);
        assert.ok(
            result.log.some((l) => /PII policy unavailable — promotion skipped.*failed to load/.test(l)),
            `expected load-throws fail-safe; got: ${JSON.stringify(result.log)}`
        );
    } finally {
        rmTmpRoot(root);
    }
});

test('escenario 5d — hasPII lanza por screenshot → skip individual (no aborta)', () => {
    const { root, evidenceDir, libraryDir, piiPolicyPath } = setupFixture({
        piiBehavior: 'throws',
        screenshots: [{ name: '01-login.png' }, { name: '02-carrito.png' }],
    });
    try {
        const result = promoteScreenshots({ issue: '3382-test', evidenceDir, libraryDir, piiPolicyPath });
        assert.equal(result.exitCode, 0);
        assert.equal(result.promoted, 0);
        assert.equal(result.skipped_pii, 2);
    } finally {
        rmTmpRoot(root);
    }
});

// ─── Escenario 6: Falla clara si la estructura de librería no existe ────
test('escenario 6 — librería ausente → error claro con referencia a #3407', () => {
    const root = makeTmpRoot();
    const evidenceDir = path.join(root, 'qa', 'evidence', '3382-test');
    const libraryDir = path.join(root, 'docs', 'app-screenshots-reference');
    const piiPolicyPath = path.join(root, 'qa', 'lib', 'pii-policy.js');
    const reportPath = path.join(evidenceDir, 'qa-report.json');

    writePiiPolicyModule(piiPolicyPath, 'safe');
    writeReport(reportPath);
    writePng(path.join(evidenceDir, '01-login.png'));

    try {
        const result = promoteScreenshots({ issue: '3382-test', evidenceDir, libraryDir, piiPolicyPath });
        assert.equal(result.ok, false);
        assert.equal(result.exitCode, 1);
        assert.ok(
            result.errors.some((e) => /screenshots-reference library missing — depends on #3407/.test(e)),
            `expected error mencioning #3407; got: ${JSON.stringify(result.errors)}`
        );
    } finally {
        rmTmpRoot(root);
    }
});

// ─── Tests adicionales: heurística filename → pantalla canónica ──────────
test('inferScreen — mapea nombres legacy a pantallas canónicas', () => {
    assert.equal(inferScreen('01-login.png'), 'login');
    assert.equal(inferScreen('b06-login-with-links.png'), 'login');
    assert.equal(inferScreen('password-recovery-step3.png'), 'login'); // sub-flow
    assert.equal(inferScreen('signup-validation.png'), 'signup');
    assert.equal(inferScreen('register.png'), 'signup');
    assert.equal(inferScreen('welcome.png'), 'welcome');
    assert.equal(inferScreen('business-home.png'), 'home');
    assert.equal(inferScreen('home-screen.png'), 'home');
    assert.equal(inferScreen('main-dashboard.png'), 'home');
    assert.equal(inferScreen('drawer-search.png'), 'busqueda');
    assert.equal(inferScreen('búsqueda-resultados.png'), 'busqueda');
    assert.equal(inferScreen('detalle-producto-banana.png'), 'detalle-producto');
    assert.equal(inferScreen('product-detail.png'), 'detalle-producto');
    assert.equal(inferScreen('carrito-vacio.png'), 'carrito');
    assert.equal(inferScreen('cart.png'), 'carrito');
    assert.equal(inferScreen('checkout-step2.png'), 'checkout');
    assert.equal(inferScreen('profile-selector.png'), 'perfil');
    assert.equal(inferScreen('perfil.png'), 'perfil');
    assert.equal(inferScreen('pedidos-list.png'), 'pedidos');
    assert.equal(inferScreen('orders.png'), 'pedidos');

    // No match → null (no se promueve).
    assert.equal(inferScreen('check2.png'), null);
    assert.equal(inferScreen('random-debug-overlay.png'), null);
});

// ─── Inferencia de flavor desde report ───────────────────────────────────
test('inferFlavorFromReport — respeta flavor explícito si presente', () => {
    assert.equal(inferFlavorFromReport({ flavor: 'business' }), 'business');
});

test('inferFlavorFromReport — usa label app:* si hay solo uno', () => {
    assert.equal(inferFlavorFromReport({ labels: ['app:client', 'enhancement'] }), 'client');
    assert.equal(inferFlavorFromReport({ labels: ['app:delivery'] }), 'delivery');
});

test('inferFlavorFromReport — devuelve null si hay múltiples app:*', () => {
    assert.equal(inferFlavorFromReport({ labels: ['app:client', 'app:business'] }), null);
});

test('inferFlavorFromReport — devuelve null si no hay flavor ni labels', () => {
    assert.equal(inferFlavorFromReport({}), null);
    assert.equal(inferFlavorFromReport(null), null);
});

// ─── Unmapped PNG no aborta ──────────────────────────────────────────────
test('unmapped PNG queda registrado como skipped_unmapped, sin abortar', () => {
    const { root, evidenceDir, libraryDir, piiPolicyPath } = setupFixture({
        screenshots: [
            { name: '01-login.png', content: 'login-bytes' },
            { name: 'random-debug.png', content: 'random-bytes' },
        ],
    });
    try {
        const result = promoteScreenshots({ issue: '3382-test', evidenceDir, libraryDir, piiPolicyPath, date: '2026-05-20' });
        assert.equal(result.exitCode, 0);
        assert.equal(result.promoted, 1);
        assert.equal(result.skipped_unmapped, 1);
        assert.ok(
            result.log.some((l) => /unmapped: random-debug\.png/.test(l)),
            `expected unmapped log; got: ${JSON.stringify(result.log)}`
        );
    } finally {
        rmTmpRoot(root);
    }
});

// ─── qa-report con verdict RECHAZADO no promueve ─────────────────────────
test('qa-report con verdict RECHAZADO no promueve', () => {
    const { root, evidenceDir, libraryDir, piiPolicyPath } = setupFixture({
        verdict: 'RECHAZADO',
        screenshots: [{ name: '01-login.png' }],
    });
    try {
        const result = promoteScreenshots({ issue: '3382-test', evidenceDir, libraryDir, piiPolicyPath });
        assert.equal(result.exitCode, 0);
        assert.equal(result.promoted, 0);
        assert.ok(
            result.log.some((l) => /verdict is RECHAZADO — promotion skipped/.test(l)),
            `expected verdict skip log; got: ${JSON.stringify(result.log)}`
        );
    } finally {
        rmTmpRoot(root);
    }
});

// ─── missing --issue ─────────────────────────────────────────────────────
test('falta --issue → exit code 2', () => {
    const result = promoteScreenshots({ issue: null });
    assert.equal(result.exitCode, 2);
    assert.ok(result.errors.some((e) => /missing --issue/.test(e)));
});

// ─── Flavor no resoluble → skip con log ──────────────────────────────────
test('si no hay flavor ni en CLI ni en report ni en labels → skip', () => {
    const { root, evidenceDir, libraryDir, piiPolicyPath } = setupFixture({
        flavor: null,
        screenshots: [{ name: '01-login.png' }],
        extraReport: { flavor: null, labels: ['app:client', 'app:business'] },
    });
    // Patch del report para borrar flavor manualmente
    const reportPath = path.join(evidenceDir, 'qa-report.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    delete report.flavor;
    report.labels = ['app:client', 'app:business'];
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    try {
        const result = promoteScreenshots({ issue: '3382-test', evidenceDir, libraryDir, piiPolicyPath, date: '2026-05-20' });
        assert.equal(result.exitCode, 0);
        assert.equal(result.promoted, 0);
        assert.ok(
            result.log.some((l) => /flavor not resolved/.test(l)),
            `expected flavor skip log; got: ${JSON.stringify(result.log)}`
        );
    } finally {
        rmTmpRoot(root);
    }
});
