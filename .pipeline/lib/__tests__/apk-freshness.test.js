// =============================================================================
// Tests apk-freshness.js — Issue #2351 (CA-2 + R2, R5)
//
// Cobertura:
//   R5 · extractFailureLines conserva sólo líneas FAILURE:/Task ... FAILED
//   R5 · matchesApkFailureInFailureLines no matchea en paths/comentarios
//   R5 · matchesApkFailureInFailureLines SI matchea en líneas de falla real
//   R2 · checkDebugApksFresh marca fresh=false cuando mtime <= buildStartTime
//   R2 · checkDebugApksFresh marca fresh=true cuando mtime > buildStartTime
//   CA-2 · estimateBuildStartTimeMs usa elapsed cuando viene, fallback 30min
//   CA-2 · buildDismissEvent tiene forma auditable con apkStatus detallado
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    extractFailureLines,
    matchesApkFailureInFailureLines,
    apkPathForFlavor,
    checkDebugApksFresh,
    buildDismissEvent,
    estimateBuildStartTimeMs,
    APK_PATTERN,
    DEFAULT_FLAVORS,
} = require('../apk-freshness');

// ─── Helpers de fakeFs para inyectar statSync sin tocar disco ──────────────
function fakeFsFromMap(apkMap) {
    return {
        statSync(p) {
            if (!(p in apkMap)) {
                const err = new Error('ENOENT');
                err.code = 'ENOENT';
                throw err;
            }
            const entry = apkMap[p];
            return {
                isFile: () => true,
                mtimeMs: entry.mtimeMs,
                mtime: new Date(entry.mtimeMs),
                size: entry.size,
            };
        },
    };
}

// ─── extractFailureLines (R5) ──────────────────────────────────────────────
test('R5 · extractFailureLines conserva línea FAILURE:', () => {
    const log = [
        'some random output',
        'FAILURE: Execution failed for task \':app:composeApp:assembleClientRelease\'.',
        '  > Some detail here',
        'BUILD SUCCESSFUL after 5s',
    ].join('\n');
    const out = extractFailureLines(log);
    assert.match(out, /FAILURE:/);
    assert.doesNotMatch(out, /random output/);
    assert.doesNotMatch(out, /BUILD SUCCESSFUL/);
});

test('R5 · extractFailureLines conserva "> Task :xxx FAILED"', () => {
    const log = [
        '> Task :app:composeApp:compileClientDebugKotlinAndroid',
        '> Task :app:composeApp:bundleBusinessReleaseClassesToRuntimeJar FAILED',
        '> Task :backend:test',
    ].join('\n');
    const out = extractFailureLines(log);
    assert.match(out, /bundleBusinessReleaseClassesToRuntimeJar FAILED/);
    // Task ok (sin FAILED) no se conserva
    assert.doesNotMatch(out, /compileClientDebugKotlinAndroid$/m);
});

test('R5 · extractFailureLines con input vacío o no-string devuelve string vacío', () => {
    assert.equal(extractFailureLines(''), '');
    assert.equal(extractFailureLines(null), '');
    assert.equal(extractFailureLines(undefined), '');
    assert.equal(extractFailureLines(42), '');
});

// ─── matchesApkFailureInFailureLines (R5) ──────────────────────────────────
test('R5 · NO matchea sobre paths/filenames en buffer crudo', () => {
    // Regresión del falso positivo: un log con mención literal de "apk-not-found.kt"
    // en un path no debe disparar el pattern.
    const log = [
        'agent wrote file: src/apk-not-found.kt',
        'BUILD SUCCESSFUL after 2s',
        '> Task :backend:test',
    ].join('\n');
    assert.equal(matchesApkFailureInFailureLines(log), false);
});

test('R5 · SI matchea cuando FAILURE: habla de assemble', () => {
    const log = [
        'random noise',
        'FAILURE: Execution failed for task \':app:composeApp:assembleBusinessRelease\'.',
        '  > Querying the mapped value of provider',
    ].join('\n');
    assert.equal(matchesApkFailureInFailureLines(log), true);
});

test('R5 · SI matchea cuando "> Task ... FAILED" contiene assemble/bundle APK', () => {
    const log = [
        '> Task :app:composeApp:assembleClientDebug FAILED',
    ].join('\n');
    // La línea `> Task ... FAILED` con token "assemble*" → match (co-ocurrencia)
    assert.equal(matchesApkFailureInFailureLines(log), true);
});

test('R5 · APK_PATTERN exportado es regex case-insensitive', () => {
    assert.ok(APK_PATTERN instanceof RegExp);
    assert.equal(APK_PATTERN.flags.includes('i'), true);
});

// ─── checkDebugApksFresh (R2) ──────────────────────────────────────────────
test('R2 · APK con mtime > buildStartTime → fresh=true', () => {
    const now = 1_700_000_000_000;
    const buildStart = now - 60_000; // build empezó hace 1 min
    const apkPath = apkPathForFlavor('/root', 'client');
    const fakeFs = fakeFsFromMap({
        [apkPath]: { mtimeMs: now - 30_000, size: 20 * 1024 * 1024 }, // APK de hace 30s
    });
    const r = checkDebugApksFresh({
        rootDir: '/root',
        buildStartTimeMs: buildStart,
        flavors: ['client'],
        fsImpl: fakeFs,
    });
    assert.equal(r.checked[0].exists, true);
    assert.equal(r.checked[0].fresh, true);
    assert.equal(r.anyFresh, true);
});

test('R2 · APK con mtime <= buildStartTime → fresh=false (stale)', () => {
    const now = 1_700_000_000_000;
    const buildStart = now - 60_000;
    const apkPath = apkPathForFlavor('/root', 'client');
    const fakeFs = fakeFsFromMap({
        [apkPath]: { mtimeMs: now - (3 * 24 * 3600 * 1000), size: 20 * 1024 * 1024 }, // 3 días
    });
    const r = checkDebugApksFresh({
        rootDir: '/root',
        buildStartTimeMs: buildStart,
        flavors: ['client'],
        fsImpl: fakeFs,
    });
    assert.equal(r.checked[0].exists, true);
    assert.equal(r.checked[0].fresh, false);
    assert.equal(r.anyFresh, false);
});

test('R2 · APK que no existe → exists=false, fresh=false', () => {
    const r = checkDebugApksFresh({
        rootDir: '/root',
        buildStartTimeMs: Date.now(),
        flavors: ['client'],
        fsImpl: fakeFsFromMap({}),
    });
    assert.equal(r.checked[0].exists, false);
    assert.equal(r.checked[0].fresh, false);
    assert.equal(r.allPresent, false);
});

test('R2 · anyFresh=true si AL MENOS uno de los 3 flavors es fresco', () => {
    const now = 1_700_000_000_000;
    const buildStart = now - 60_000;
    const clientPath = apkPathForFlavor('/root', 'client');
    const businessPath = apkPathForFlavor('/root', 'business');
    const deliveryPath = apkPathForFlavor('/root', 'delivery');
    const fakeFs = fakeFsFromMap({
        [clientPath]: { mtimeMs: now - 30_000, size: 1 },       // fresh
        [businessPath]: { mtimeMs: now - 999_999_000, size: 1 }, // stale
        [deliveryPath]: { mtimeMs: now - 999_999_000, size: 1 }, // stale
    });
    const r = checkDebugApksFresh({
        rootDir: '/root',
        buildStartTimeMs: buildStart,
        fsImpl: fakeFs,
    });
    assert.equal(r.anyFresh, true);
    assert.equal(r.allFresh, false);
    assert.equal(r.allPresent, true);
});

test('R2 · DEFAULT_FLAVORS incluye los 3 flavors', () => {
    assert.deepEqual([...DEFAULT_FLAVORS].sort(), ['business', 'client', 'delivery']);
});

test('R2 · apkPathForFlavor genera el path canónico', () => {
    const p = apkPathForFlavor('/repo', 'business');
    assert.match(p, /app[\\/]composeApp[\\/]build[\\/]outputs[\\/]apk[\\/]business[\\/]debug[\\/]composeApp-business-debug\.apk$/);
});

// ─── estimateBuildStartTimeMs (CA-2) ───────────────────────────────────────
test('CA-2 · estimateBuildStartTimeMs usa elapsed + margen de seguridad', () => {
    const now = 1_700_000_000_000;
    const r = estimateBuildStartTimeMs({ elapsedSec: 120, nowMs: now });
    // 120s + 10 min de margen = 720 segundos antes
    assert.equal(r, now - (120 * 1000) - (10 * 60 * 1000));
});

test('CA-2 · estimateBuildStartTimeMs sin elapsed usa fallback 30min', () => {
    const now = 1_700_000_000_000;
    const r = estimateBuildStartTimeMs({ elapsedSec: null, nowMs: now });
    assert.equal(r, now - (30 * 60 * 1000));
});

test('CA-2 · estimateBuildStartTimeMs con elapsed="?" usa fallback 30min', () => {
    const now = 1_700_000_000_000;
    const r = estimateBuildStartTimeMs({ elapsedSec: '?', nowMs: now });
    assert.equal(r, now - (30 * 60 * 1000));
});

test('CA-2 · estimateBuildStartTimeMs acepta elapsed string numérico', () => {
    const now = 1_700_000_000_000;
    const r = estimateBuildStartTimeMs({ elapsedSec: '45', nowMs: now });
    assert.equal(r, now - (45 * 1000) - (10 * 60 * 1000));
});

// ─── buildDismissEvent (CA-3/R3) ───────────────────────────────────────────
test('CA-3 · buildDismissEvent incluye issue, pattern, reason y apkStatus', () => {
    const apkStatus = {
        anyFresh: true,
        allFresh: false,
        allPresent: true,
        checked: [
            { flavor: 'client', exists: true, fresh: true, mtimeMs: Date.now() - 60000, sizeBytes: 20 * 1024 * 1024 },
            { flavor: 'business', exists: true, fresh: false, mtimeMs: Date.now() - (4 * 24 * 3600 * 1000), sizeBytes: 20 * 1024 * 1024 },
            { flavor: 'delivery', exists: false, fresh: false, mtimeMs: null, sizeBytes: null },
        ],
    };
    const evt = buildDismissEvent({
        issue: 2351,
        pattern: 'apk_not_generated',
        reason: 'APK debug fresco presente',
        apkStatus,
    });
    assert.equal(evt.event, 'match-dismissed');
    assert.equal(evt.issue, '2351');
    assert.equal(evt.pattern, 'apk_not_generated');
    assert.equal(evt.apkStatus.anyFresh, true);
    assert.equal(evt.apkStatus.flavors.length, 3);
    assert.equal(evt.apkStatus.flavors[0].flavor, 'client');
    assert.equal(evt.apkStatus.flavors[0].fresh, true);
});

test('CA-3 · buildDismissEvent sin apkStatus pone apkStatus:null (no crash)', () => {
    const evt = buildDismissEvent({ issue: 1, pattern: 'x', reason: 'y' });
    assert.equal(evt.apkStatus, null);
});

// ─── Escenario integrado: falso positivo #2351 ────────────────────────────
test('#2351 · log de Release FAILED + APKs Debug frescos → match descartado', () => {
    // Simula el log real que disparó el issue fantasma.
    const log = [
        '> Task :app:composeApp:compileBusinessDebugKotlinAndroid',
        '> Task :app:composeApp:assembleBusinessDebug',
        'FAILURE: Execution failed for task \':app:composeApp:bundleBusinessReleaseClassesToRuntimeJar\'.',
        '  > Querying the mapped value of provider(java.util.Set) before task',
        '    \':app:composeApp:compileBusinessReleaseKotlinAndroid\' has completed is not supported',
        '> Task :app:composeApp:bundleBusinessReleaseClassesToRuntimeJar FAILED',
    ].join('\n');
    // El pattern matchea en líneas de failure real
    assert.equal(matchesApkFailureInFailureLines(log), true);

    // Pero los APKs Debug SÍ están frescos
    const now = 1_700_000_000_000;
    const buildStart = now - 600_000; // build empezó hace 10 min
    const fakeFs = fakeFsFromMap({
        [apkPathForFlavor('/repo', 'client')]:   { mtimeMs: now - 120_000, size: 25 * 1024 * 1024 },
        [apkPathForFlavor('/repo', 'business')]: { mtimeMs: now - 100_000, size: 25 * 1024 * 1024 },
        [apkPathForFlavor('/repo', 'delivery')]: { mtimeMs: now -  80_000, size: 24 * 1024 * 1024 },
    });
    const apkStatus = checkDebugApksFresh({
        rootDir: '/repo',
        buildStartTimeMs: buildStart,
        fsImpl: fakeFs,
    });
    // Los 3 debug APKs están frescos → anyFresh y allFresh true
    assert.equal(apkStatus.anyFresh, true);
    assert.equal(apkStatus.allFresh, true);
    // El consumidor (rejection-report.js) decide NO addDep viendo anyFresh=true
});

test('#2351 · log sin FAILURE real + APKs stale → match no matchea por R5', () => {
    // Si sólo hay mención en comentarios/paths del log, R5 evita el match
    const log = 'some log about apk-not-found paths without any FAILURE line';
    assert.equal(matchesApkFailureInFailureLines(log), false);
});

test('#2351 · log con Release FAILED real + APKs ausentes → NO descartado', () => {
    // Caso verdadero: el build actual rompió y no hay APKs frescos
    const log = 'FAILURE: Execution failed for task \':app:composeApp:assembleClientDebug\'.';
    assert.equal(matchesApkFailureInFailureLines(log), true);
    const apkStatus = checkDebugApksFresh({
        rootDir: '/repo',
        buildStartTimeMs: Date.now() - 600_000,
        fsImpl: fakeFsFromMap({}), // ningún APK presente
    });
    assert.equal(apkStatus.anyFresh, false);
    // El consumidor SÍ debería addDep en este caso
});
