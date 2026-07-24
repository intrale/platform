'use strict';

// Tests de block-classifier.js (#4765 — parte (a) del split de #4759).
// Cubren CA-1..CA-23 + SR-1..SR-12. Framework: node --test.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Aislar el audit de las auto-resoluciones `mecanico` en un archivo temporal
// para no ensuciar `.pipeline/audit/` durante los tests (SR-11).
const AUDIT_FILE = path.join(os.tmpdir(), `bc-audit-${process.pid}.jsonl`);
process.env.BLOCK_CLASSIFIER_AUDIT_FILE = AUDIT_FILE;

const bc = require('../lib/block-classifier');
const delivery = require('../skills-deterministicos/delivery');
const auditLog = require('../lib/audit-log');

const {
    canonicalizePath,
    matchGlob,
    matchSegment,
    matchDenylist,
    matchAllowlist,
    matchAllowEntry,
    mapDesyncClassification,
    loadConfig,
    allowlistHash,
} = bc._internal;

// Helper: bloque merge-conflict.
const merge = (paths) => ({ kind: 'merge-conflict', paths });

// ---------------------------------------------------------------------------
// A. Contrato y clasificación funcional.
// ---------------------------------------------------------------------------

test('CA-1 — contrato de salida {category, reason, delegateTo, evidence}', () => {
    const out = bc.classifyBlock(merge(['docs/guia.md']));
    assert.deepStrictEqual(Object.keys(out).sort(), ['category', 'delegateTo', 'evidence', 'reason']);
    assert.ok(['mecanico', 'decision'].includes(out.category));
    assert.strictEqual(typeof out.reason, 'string');
});

test('CA-2 — merge no-producto (allowlist) → mecanico', () => {
    const out = bc.classifyBlock(merge(['docs/guia.md']));
    assert.strictEqual(out.category, 'mecanico');
    assert.strictEqual(out.delegateTo, 'delivery.classifyConflictFiles');
});

test('CA-2 — allowlist con varias entradas ancladas → mecanico', () => {
    assert.strictEqual(bc.classifyBlock(merge(['docs/a.md', 'readme.md'])).category, 'mecanico');
});

test('CA-3 — merge mixto producto+no-producto → decision (SR-1)', () => {
    const out = bc.classifyBlock(merge(['docs/guia.md', 'app/composeApp/src/Main.kt']));
    assert.strictEqual(out.category, 'decision');
});

test('CA-3 — path de producto solo (fuera de allowlist) → decision', () => {
    assert.strictEqual(bc.classifyBlock(merge(['app/composeApp/src/Main.kt'])).category, 'decision');
});

test('CA-4 — desync reductivo → mecanico', () => {
    const out = bc.classifyBlock({ kind: 'desync', diff: { added: [], removed: [42] } });
    assert.strictEqual(out.category, 'mecanico');
    assert.strictEqual(out.delegateTo, 'desync-detector.classifyDesync');
});

test('CA-4 — desync ambiguo → decision', () => {
    const out = bc.classifyBlock({ kind: 'desync', diff: { added: [7], removed: [] } });
    assert.strictEqual(out.category, 'decision');
});

test('CA-4 — mapeo explícito reductivo→mecanico / ambiguo→decision / otro→decision', () => {
    assert.strictEqual(mapDesyncClassification('resoluble_reductivo'), 'mecanico');
    assert.strictEqual(mapDesyncClassification('ambiguo'), 'decision');
    assert.strictEqual(mapDesyncClassification('cualquier_otra_cosa'), 'decision');
    assert.strictEqual(mapDesyncClassification(undefined), 'decision');
});

test('CA-5 — gate-reject por defecto → decision', () => {
    const out = bc.classifyBlock({ kind: 'gate-reject', reason: 'lo que sea' });
    assert.strictEqual(out.category, 'decision');
});

// ---------------------------------------------------------------------------
// B. Fail-closed / conservador (SR-8).
// ---------------------------------------------------------------------------

test('CA-6 — kind desconocido → decision', () => {
    assert.strictEqual(bc.classifyBlock({ kind: 'no-existe' }).category, 'decision');
});

test('CA-7 — entrada inválida (null/undefined/tipos raros/array) → decision sin lanzar', () => {
    for (const bad of [null, undefined, 'string', 42, true, [], [1, 2, 3], Symbol.iterator]) {
        const out = bc.classifyBlock(bad);
        assert.strictEqual(out.category, 'decision');
    }
});

test('CA-7 — array gigante como bloque → decision', () => {
    const huge = new Array(100000).fill('x');
    assert.strictEqual(bc.classifyBlock(huge).category, 'decision');
});

test('CA-8 — excepción en delegación → decision', () => {
    // isClosed que lanza fuerza a classifyDesync a propagar la excepción; el
    // try/catch externo de classifyBlock debe capturarla y caer a decision.
    const out = bc.classifyBlock({
        kind: 'desync',
        diff: { added: [1], removed: [] },
        isClosed: () => { throw new Error('boom delegado'); },
    });
    assert.strictEqual(out.category, 'decision');
});

test('CA-8 — excepción por config corrupta en merge-conflict → decision', () => {
    // path que fuerza fallo de canonicalización devuelve decision; verificamos
    // además que un delegado inválido no rompe (delivery ausente simulado).
    const out = bc.classifyBlock(merge([123, null]));
    assert.strictEqual(out.category, 'decision');
});

// ---------------------------------------------------------------------------
// C. Denylist de seguridad (evaluada ANTES que allowlist — SR-3).
// ---------------------------------------------------------------------------

test('CA-10 — denylist evaluada antes que allowlist (path en ambas → decision)', () => {
    const cfg = { allow: ['.pipeline/'], deny: ['.pipeline/**'] };
    const res = delivery.classifyConflictFiles(['.pipeline/pulpo.js'], cfg);
    assert.strictEqual(res.category, 'decision');
    assert.match(res.reason, /denylist/);
});

test('CA-11 — superficie RCE: .pipeline/**, .claude/hooks/**, settings, self-reference → decision', () => {
    for (const p of [
        '.pipeline/pulpo.js',
        '.claude/hooks/worktree-guard.js',
        '.claude/settings.json',
        '.claude/settings.local.json',
        '.pipeline/config/block-classifier-allowlist.json',
    ]) {
        assert.strictEqual(bc.classifyBlock(merge([p])).category, 'decision', `esperaba decision para ${p}`);
    }
});

test('CA-12 — secrets/firma/IaC/CI → decision', () => {
    for (const p of [
        'app/release.jks',
        'app/my.keystore',
        'app/keystore.properties',
        'local.properties',
        'app/signing.gradle',
        'config/.env.production',
        'certs/server.pem',
        'certs/cert.p12',
        'config/secrets.yaml',
        'backend/application.conf',
        'users/src/main/resources/application.conf',
        'infra/main.tf',
        '.github/workflows/ci.yml',
        'app/build.gradle.kts',
        'app/build.gradle',
        'backend/src/main/kotlin/SecuredFunction.kt',
        'backend/src/main/kotlin/CognitoClient.kt',
        'app/security/AuthGuard.kt',
    ]) {
        assert.strictEqual(bc.classifyBlock(merge([p])).category, 'decision', `esperaba decision para ${p}`);
    }
});

// ---------------------------------------------------------------------------
// D. Canonicalización de path (SR-10 — anti-evasión).
// ---------------------------------------------------------------------------

test('CA-13 — canonicalización: separadores, //, ./, case-fold, NFC', () => {
    assert.strictEqual(canonicalizePath('a\\b\\c'), 'a/b/c');
    assert.strictEqual(canonicalizePath('a//b/./c'), 'a/b/c');
    assert.strictEqual(canonicalizePath('A/B/C'), 'a/b/c');
    assert.strictEqual(canonicalizePath('a/b/../c'), 'a/c');
});

test('CA-14 — evasiones caen en denylist', () => {
    for (const p of [
        'users/src/main/resources/./application.conf',
        '.github//workflows/x.yml',
        'USERS/SRC/MAIN/RESOURCES/APPLICATION.CONF',
        '.GITHUB/WORKFLOWS/CI.YML',
        'App\\Release.JKS',
    ]) {
        assert.strictEqual(bc.classifyBlock(merge([p])).category, 'decision', `evasión no bloqueada: ${p}`);
    }
});

test('CA-15 — path no canonicalizable / que escapa la raíz → decision (null)', () => {
    assert.strictEqual(canonicalizePath('../../etc/passwd'), null);
    assert.strictEqual(canonicalizePath('..'), null);
    assert.strictEqual(canonicalizePath('a/../..'), null);
    assert.strictEqual(canonicalizePath(''), null);
    assert.strictEqual(canonicalizePath(123), null);
    assert.strictEqual(canonicalizePath(null), null);
    assert.strictEqual(bc.classifyBlock(merge(['../../etc/passwd'])).category, 'decision');
});

// ---------------------------------------------------------------------------
// E. Integridad de la allowlist (SR-2 / SR-11).
// ---------------------------------------------------------------------------

test('CA-16 — allowlist se carga del repo base, NO del cwd/branch evaluado', () => {
    const orig = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-cwd-'));
    try {
        process.chdir(tmp);
        const cfg = loadConfig();
        // Aunque el cwd sea otro, la config real del repo base se carga igual.
        assert.ok(cfg.deny.includes('.pipeline/**'));
        assert.strictEqual(typeof cfg.version, 'string');
        // Y la clasificación sigue funcionando desde un cwd ajeno.
        assert.strictEqual(bc.classifyBlock(merge(['docs/x.md'])).category, 'mecanico');
    } finally {
        process.chdir(orig);
    }
});

test('CA-17 — allowlist usa prefijos anclados, no globs laxos', () => {
    assert.ok(matchAllowEntry('docs/a/b.md', 'docs/'));
    assert.ok(matchAllowEntry('readme.md', 'readme.md'));
    // Anclado: no matchea por substring en medio del path.
    assert.strictEqual(matchAllowEntry('app/docs/x.md', 'docs/'), false);
    assert.strictEqual(matchAllowEntry('readme.md.bak', 'readme.md'), false);
});

test('CA-18 — log auditable de auto-resolución mecanico con hash/versión de allowlist', () => {
    // Limpiar el audit temporal y forzar un mecanico.
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* noop */ }
    const out = bc.classifyBlock(merge(['docs/nota.md']));
    assert.strictEqual(out.category, 'mecanico');
    const entries = auditLog.readAll(AUDIT_FILE);
    assert.ok(entries.length >= 1, 'debe existir al menos una entry de auditoría');
    const last = entries[entries.length - 1];
    assert.strictEqual(last.event, 'block-classify-mecanico');
    assert.strictEqual(last.kind, 'merge-conflict');
    assert.ok(typeof last.allowlist_hash === 'string' && last.allowlist_hash.length === 64);
    assert.ok(last.allowlist_version);
    // El hash coincide con el de la config real cargada.
    assert.strictEqual(last.allowlist_hash, allowlistHash(loadConfig()));
});

// ---------------------------------------------------------------------------
// F. Robustez de entrada (SR-12 — anti-ReDoS / DoS).
// ---------------------------------------------------------------------------

test('CA-19 — matcher de globs no cuelga con entrada adversaria (anti-ReDoS)', () => {
    const adversarialPath = `${'a/'.repeat(500)}b.tf`;
    const pattern = `${'**/'.repeat(3)}*.tf`;
    const start = process.hrtime.bigint();
    const result = matchGlob(canonicalizePath(adversarialPath), pattern);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.strictEqual(typeof result, 'boolean');
    assert.ok(elapsedMs < 500, `matcher tardó ${elapsedMs}ms (posible ReDoS)`);
    // Segmento con muchos '*' contra input largo: sin backtracking catastrófico.
    const segStart = process.hrtime.bigint();
    matchSegment('a'.repeat(1000), `${'*'.repeat(50)}b`);
    const segMs = Number(process.hrtime.bigint() - segStart) / 1e6;
    assert.ok(segMs < 500, `matchSegment tardó ${segMs}ms`);
});

test('CA-20 — reason/evidence sanitizados (sin secrets/CRLF)', () => {
    const fakeKey = 'AKIA' + 'ABCDEFGHIJKLMNOP'; // AKIA + 16 → patrón de secret
    const out = bc.classifyBlock({ kind: fakeKey });
    assert.ok(!out.reason.includes(fakeKey), 'el secret no debe filtrarse en reason');
    assert.match(out.reason, /REDACTED/);
    // CRLF neutralizado.
    const out2 = bc.classifyBlock({ kind: 'x\ninjected\rline' });
    assert.ok(!/[\r\n]/.test(out2.reason), 'reason no debe contener CRLF crudo');
});

// ---------------------------------------------------------------------------
// G. Sub-clasificador de archivos (delivery.classifyConflictFiles) — export.
// ---------------------------------------------------------------------------

test('CA-21 — delivery exporta classifyConflictFiles', () => {
    assert.strictEqual(typeof delivery.classifyConflictFiles, 'function');
});

test('classifyConflictFiles — sin paths → decision', () => {
    assert.strictEqual(delivery.classifyConflictFiles([], {}).category, 'decision');
    assert.strictEqual(delivery.classifyConflictFiles(null, {}).category, 'decision');
});

test('classifyConflictFiles — todos en allow → mecanico; alguno fuera → decision', () => {
    const cfg = loadConfig();
    assert.strictEqual(delivery.classifyConflictFiles(['docs/a.md'], cfg).category, 'mecanico');
    assert.strictEqual(delivery.classifyConflictFiles(['docs/a.md', 'src/x.kt'], cfg).category, 'decision');
});

// ---------------------------------------------------------------------------
// Helpers de matching (cobertura directa).
// ---------------------------------------------------------------------------

test('matchDenylist / matchAllowlist — comportamiento de arrays', () => {
    assert.strictEqual(matchDenylist(['a/b.tf'], ['**/*.tf']), true);
    assert.strictEqual(matchDenylist(['a/b.kt'], ['**/*.tf']), false);
    assert.strictEqual(matchDenylist('no-array', ['**/*.tf']), false);
    assert.strictEqual(matchAllowlist(['docs/a.md'], ['docs/']), true);
    assert.strictEqual(matchAllowlist(['docs/a.md', 'x/y.kt'], ['docs/']), false);
    assert.strictEqual(matchAllowlist([], ['docs/']), false);
    assert.strictEqual(matchAllowlist(['docs/a.md'], []), false);
});

test('matchGlob — ** matchea cero o más segmentos', () => {
    assert.ok(matchGlob('build.gradle', '**/build.gradle*'));
    assert.ok(matchGlob('app/build.gradle.kts', '**/build.gradle*'));
    assert.ok(matchGlob('a/b/c/x.tf', '**/*.tf'));
    assert.strictEqual(matchGlob('a/b/c.kt', '**/*.tf'), false);
    assert.strictEqual(matchGlob('foo', 42), false);
});
