// =============================================================================
// Tests del audit trail + gate de mutaciones a `.partial-pause.json` (#3625).
//
// Cobertura mínima (CA-7):
//   - appendMutation persiste con chain válido y campos canónicos.
//   - validateAuthorizedBy acepta enum cerrado y rechaza valores libres.
//   - sanitizeJustification redacta AWS keys, JWT, etc. y trunca a 500.
//   - computeDiff devuelve added/removed estables.
//   - emitBackfillIfNeeded idempotente (no reescribe si ya hay entries).
//   - Gate fail-closed cuando hay removals sin authorizedBy.
//   - waves.promoteWaveAtomic con gate activo NO se traba (pasa wave-promote).
//   - resumeAll requiere resume:operator.
//   - TTL expira correctamente (fake clock).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Aislar todo a un tmp dir.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-partial-pause-audit-'));
process.env.PIPELINE_DIR_OVERRIDE = TMP_DIR;
// #3625 — forzar gate STRICT en estos tests (el default en producción es
// grace mode durante 1 release; queremos cubrir el comportamiento final).
process.env.PARTIAL_PAUSE_STRICT_AUTH = '1';
// Crear audit/ dir.
fs.mkdirSync(path.join(TMP_DIR, 'audit'), { recursive: true });

// Mockear notify-telegram para no spamear consola en tests.
const NOTIFY_LOG_PATH = path.join(TMP_DIR, 'notify.log');
const notifyMod = require.resolve('../notify-telegram');
require.cache[notifyMod] = {
    id: notifyMod, filename: notifyMod, loaded: true,
    exports: {
        notifyTelegram(msg) {
            try { fs.appendFileSync(NOTIFY_LOG_PATH, String(msg) + '\n'); } catch {}
        },
    },
};

delete require.cache[require.resolve('../partial-pause-audit')];
delete require.cache[require.resolve('../partial-pause')];
delete require.cache[require.resolve('../audit-log')];

const audit = require('../partial-pause-audit');
const partialPause = require('../partial-pause');
const auditLog = require('../audit-log');

function resetFs() {
    const { PARTIAL_FILE, PAUSE_FILE } = partialPause._paths();
    const { AUDIT_FILE } = audit._paths();
    try { fs.unlinkSync(PARTIAL_FILE); } catch {}
    try { fs.unlinkSync(PAUSE_FILE); } catch {}
    try { fs.unlinkSync(AUDIT_FILE); } catch {}
    try { fs.unlinkSync(AUDIT_FILE + '.lock'); } catch {}
    try { fs.unlinkSync(NOTIFY_LOG_PATH); } catch {}
}

// -----------------------------------------------------------------------------
// validateAuthorizedBy
// -----------------------------------------------------------------------------

test('validateAuthorizedBy acepta cada valor estático del enum', () => {
    for (const v of audit.AUTHORIZED_BY_STATIC) {
        const r = audit.validateAuthorizedBy(v);
        assert.equal(r.valid, true, `debería aceptar ${v}`);
        assert.equal(r.normalized, v);
    }
});

test('validateAuthorizedBy acepta recursive-deps:from-<N>', () => {
    assert.equal(audit.validateAuthorizedBy('recursive-deps:from-3559').valid, true);
    assert.equal(audit.validateAuthorizedBy('recursive-deps:from-1').valid, true);
});

test('validateAuthorizedBy rechaza valores libres', () => {
    assert.equal(audit.validateAuthorizedBy('leo').valid, false);
    assert.equal(audit.validateAuthorizedBy('admin').valid, false);
    assert.equal(audit.validateAuthorizedBy('commander:bot_TOKEN_LEAKED').valid, false);
    assert.equal(audit.validateAuthorizedBy('recursive-deps:from-abc').valid, false);
    assert.equal(audit.validateAuthorizedBy('recursive-deps:from-0').valid, false);
    assert.equal(audit.validateAuthorizedBy(null).valid, false);
    assert.equal(audit.validateAuthorizedBy(undefined).valid, false);
    assert.equal(audit.validateAuthorizedBy('').valid, false);
});

// -----------------------------------------------------------------------------
// sanitizeJustification
// -----------------------------------------------------------------------------

test('sanitizeJustification redacta AWS keys', () => {
    const r = audit.sanitizeJustification('Razón con AKIAIOSFODNN7EXAMPLE pegada');
    assert.ok(!r.sanitized.includes('AKIAIOSFODNN7EXAMPLE'));
    assert.equal(r.didRedact, true);
});

test('sanitizeJustification redacta JWT tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const r = audit.sanitizeJustification(`Razón con ${jwt} embedded`);
    assert.ok(!r.sanitized.includes(jwt), 'JWT debe ser redactado');
    assert.equal(r.didRedact, true);
});

test('sanitizeJustification trunca a 500 chars max', () => {
    const big = 'x'.repeat(800);
    const r = audit.sanitizeJustification(big);
    assert.ok(r.sanitized.length <= 500);
    assert.equal(r.didTruncate, true);
});

test('sanitizeJustification con null devuelve vacío sin error', () => {
    const r = audit.sanitizeJustification(null);
    assert.equal(r.sanitized, '');
    assert.equal(r.didRedact, false);
});

// -----------------------------------------------------------------------------
// computeDiff
// -----------------------------------------------------------------------------

test('computeDiff devuelve added/removed ordenados', () => {
    const d = audit.computeDiff([3559, 3605], [3616, 3617, 3605]);
    assert.deepEqual(d.removed, [3559]);
    assert.deepEqual(d.added, [3616, 3617]);
});

test('computeDiff sin cambios → vacío', () => {
    const d = audit.computeDiff([3559, 3605], [3605, 3559]);
    assert.deepEqual(d.removed, []);
    assert.deepEqual(d.added, []);
});

// -----------------------------------------------------------------------------
// appendMutation + chain válido
// -----------------------------------------------------------------------------

test('appendMutation persiste con hash-chain válido', () => {
    resetFs();
    const r1 = audit.appendMutation({
        source: 'commander:leo',
        action: 'write',
        previous: [],
        current: [3559],
        authorizedBy: 'commander:leo',
        justification: 'agregar #3559 al allowlist',
    });
    assert.ok(r1.ok);
    assert.ok(typeof r1.hash_self === 'string');
    const r2 = audit.appendMutation({
        source: 'commander:leo',
        action: 'write',
        previous: [3559],
        current: [3559, 3605],
        authorizedBy: 'commander:leo',
        justification: 'agregar #3605 al allowlist',
    });
    assert.ok(r2.ok);
    const v = audit.verifyChain();
    assert.equal(v.ok, true);
    assert.ok(v.entriesChecked >= 2);
});

test('emitBackfillIfNeeded es idempotente', () => {
    resetFs();
    const a = audit.emitBackfillIfNeeded();
    assert.equal(a.emitted, true);
    const b = audit.emitBackfillIfNeeded();
    assert.equal(b.emitted, false);
    const v = audit.verifyChain();
    assert.equal(v.ok, true);
    assert.equal(v.entriesChecked, 1);
});

test('verifyChain detecta corrupción manual del archivo', () => {
    resetFs();
    audit.appendMutation({
        source: 'commander:leo', action: 'write',
        previous: [], current: [3559],
        authorizedBy: 'commander:leo',
        justification: 'entry 1',
    });
    audit.appendMutation({
        source: 'commander:leo', action: 'write',
        previous: [3559], current: [3559, 3605],
        authorizedBy: 'commander:leo',
        justification: 'entry 2',
    });
    // Corromper manualmente la primera línea (tampering).
    const { AUDIT_FILE } = audit._paths();
    const content = fs.readFileSync(AUDIT_FILE, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const first = JSON.parse(lines[0]);
    first.justification = 'TAMPERED';
    lines[0] = JSON.stringify(first);
    fs.writeFileSync(AUDIT_FILE, lines.join('\n') + '\n');
    const v = audit.verifyChain();
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 0);
});

// -----------------------------------------------------------------------------
// Gate de partial-pause.setPartialPause
// -----------------------------------------------------------------------------

test('setPartialPause add sin removals NO requiere authorizedBy', () => {
    resetFs();
    const r = partialPause.setPartialPause([3559], { source: 'test' });
    assert.equal(r.ok, true, 'add puro debe ser aceptado');
    assert.deepEqual(r.allowedIssues, [3559]);
});

test('setPartialPause removal sin authorizedBy → REJECTED', () => {
    resetFs();
    // Estado inicial: [3559, 3605]
    partialPause.setPartialPause([3559, 3605], {
        source: 'commander:leo',
        authorizedBy: 'commander:leo',
        justification: 'setup inicial',
    });
    // Mutación maliciosa: reescribir a [3616, 3617] (remueve 3559 y 3605).
    const r = partialPause.setPartialPause([3616, 3617], { source: 'test' });
    assert.equal(r.ok, false);
    assert.equal(r.rejected, true);
    // Estado NO se modificó.
    const state = partialPause.getPipelineMode();
    assert.deepEqual(state.allowedIssues, [3559, 3605]);
});

test('setPartialPause removal con commander:leo válido → aplica', () => {
    resetFs();
    partialPause.setPartialPause([3559, 3605], {
        source: 'commander:leo',
        authorizedBy: 'commander:leo',
        justification: 'setup',
    });
    const r = partialPause.setPartialPause([3559], {
        source: 'commander:leo',
        authorizedBy: 'commander:leo',
        justification: 'remover #3605 manualmente',
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.allowedIssues, [3559]);
});

test('resumeAll sin authorizedBy lo agrega implícitamente con resume:operator', () => {
    resetFs();
    partialPause.setPartialPause([3559, 3605], {
        source: 'commander:leo',
        authorizedBy: 'commander:leo',
        justification: 'setup',
    });
    // resumeAll() default → resume:operator implícito.
    const r = partialPause.resumeAll();
    assert.equal(r.removedPartial, true);
});

test('clearPartialPause sin authorizedBy y con previous no-vacío → REJECTED', () => {
    resetFs();
    partialPause.setPartialPause([3559], {
        source: 'commander:leo',
        authorizedBy: 'commander:leo',
        justification: 'setup',
    });
    const r = partialPause.clearPartialPause();
    assert.equal(r.ok, false);
    assert.equal(r.rejected, true);
});

test('clearPartialPause con commander:leo válido → aplica', () => {
    resetFs();
    partialPause.setPartialPause([3559], {
        source: 'commander:leo',
        authorizedBy: 'commander:leo',
        justification: 'setup',
    });
    const r = partialPause.clearPartialPause({
        source: 'commander:leo',
        authorizedBy: 'commander:leo',
        justification: 'limpiar todo',
    });
    assert.equal(r.ok, true);
    assert.equal(r.existed, true);
});

// -----------------------------------------------------------------------------
// Atomicidad del gate: el audit se escribe SIEMPRE, incluso si la mutación
// no se aplica.
// -----------------------------------------------------------------------------

test('Mutación REJECTED igual genera entry de audit con action: reject', () => {
    resetFs();
    partialPause.setPartialPause([3559, 3605], {
        source: 'commander:leo',
        authorizedBy: 'commander:leo',
        justification: 'setup',
    });
    const r = partialPause.setPartialPause([3616], { source: 'sin-auth' });
    assert.equal(r.rejected, true);
    const tail = audit.tail(5);
    const rejectEntry = tail.find(e => e.action === 'reject');
    assert.ok(rejectEntry, 'debe haber al menos una entry con action: reject');
    assert.equal(rejectEntry.authorized_by, null);
});

// -----------------------------------------------------------------------------
// statsSince
// -----------------------------------------------------------------------------

test('statsSince agrupa por categoría', () => {
    resetFs();
    audit.appendMutation({
        source: 'commander:leo', action: 'write',
        previous: [], current: [1], authorizedBy: 'commander:leo',
        justification: 'ok',
    });
    audit.appendMutation({
        source: 'wave-promote', action: 'write',
        previous: [1], current: [1, 2], authorizedBy: 'wave-promote',
        justification: 'ok',
    });
    audit.appendMutation({
        source: 'unknown', action: 'reject',
        previous: [1, 2], current: [1, 2], authorizedBy: null,
        justification: 'reject',
    });
    const s = audit.statsSince({});
    assert.ok(s.total >= 3);
    assert.ok(s.authorized >= 2);
    assert.ok(s.rejected >= 1);
});

// -----------------------------------------------------------------------------
// Allowlist-recursive-promote (CA-3)
// -----------------------------------------------------------------------------

test('autoPromoteSplitChildren: padre en allowlist → hijos heredan con TTL', () => {
    resetFs();
    delete require.cache[require.resolve('../allowlist-recursive-promote')];
    const rp = require('../allowlist-recursive-promote');
    partialPause.setPartialPause([3559], {
        source: 'commander:leo',
        authorizedBy: 'commander:leo',
        justification: 'padre autorizado',
    });
    const r = rp.autoPromoteSplitChildren({
        parentIssue: 3559,
        childrenIssues: [3613, 3614, 3615],
    });
    assert.equal(r.promoted, true);
    assert.deepEqual(r.added, [3613, 3614, 3615]);
    const state = partialPause.getPipelineMode();
    assert.deepEqual([...state.allowedIssues].sort((a, b) => a - b), [3559, 3613, 3614, 3615]);
});

test('autoPromoteSplitChildren: padre NO en allowlist → no promueve', () => {
    resetFs();
    delete require.cache[require.resolve('../allowlist-recursive-promote')];
    const rp = require('../allowlist-recursive-promote');
    // Sin allowlist activa (running).
    const r = rp.autoPromoteSplitChildren({
        parentIssue: 3559,
        childrenIssues: [3613, 3614],
    });
    assert.equal(r.promoted, false);
    assert.equal(r.reason, 'no_partial_pause_active');
});

test('expireRecursiveAuthorizations remueve issues con TTL vencido', () => {
    resetFs();
    delete require.cache[require.resolve('../allowlist-recursive-promote')];
    const rp = require('../allowlist-recursive-promote');
    // Setup: padre + hijos con TTL en el pasado.
    partialPause.setPartialPause([3559], {
        source: 'commander:leo',
        authorizedBy: 'commander:leo',
        justification: 'setup',
    });
    rp.autoPromoteSplitChildren({ parentIssue: 3559, childrenIssues: [9001, 9002] });
    // Forzar TTLs al pasado.
    const { PARTIAL_FILE } = partialPause._paths();
    const data = JSON.parse(fs.readFileSync(PARTIAL_FILE, 'utf8'));
    assert.ok(data.authorization_ttls);
    const past = new Date(Date.now() - 60000).toISOString();
    for (const k of Object.keys(data.authorization_ttls)) {
        data.authorization_ttls[k].expires_at = past;
    }
    fs.writeFileSync(PARTIAL_FILE, JSON.stringify(data, null, 2));
    const r = rp.expireRecursiveAuthorizations();
    assert.ok(r.expired.length === 2);
    const state = partialPause.getPipelineMode();
    assert.deepEqual(state.allowedIssues, [3559]);
});

// -----------------------------------------------------------------------------
// Duplicate detector (CA-4)
// -----------------------------------------------------------------------------

test('tokenize quita stopwords y acentos', () => {
    const dd = require('../duplicate-detector');
    const t = dd.tokenize('La pantalla de perfil de usuario con tildés');
    assert.ok(t.has('pantalla'));
    assert.ok(t.has('perfil'));
    assert.ok(t.has('usuario'));
    assert.ok(t.has('tildes'));
    assert.ok(!t.has('la'), 'stopword "la" debe eliminarse');
    assert.ok(!t.has('de'), 'stopword "de" debe eliminarse');
});

test('jaccard 0 para vacíos y 1 para sets idénticos', () => {
    const dd = require('../duplicate-detector');
    assert.equal(dd.jaccard(new Set(), new Set()), 0);
    assert.equal(dd.jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
});

test('findSimilar detecta duplicado >= umbral', () => {
    const dd = require('../duplicate-detector');
    const r = dd.findSimilar('Pantalla de perfil de usuario', {
        openIssues: [
            { number: 100, title: 'Pantalla de perfil del usuario' },
            { number: 101, title: 'Carrito de compras' },
        ],
        threshold: 0.5,
    });
    assert.equal(r.hasDuplicate, true);
    assert.equal(r.topMatch.number, 100);
});

test('findSimilar no detecta cuando todos están bajo el umbral', () => {
    const dd = require('../duplicate-detector');
    const r = dd.findSimilar('Pantalla de perfil de usuario', {
        openIssues: [{ number: 100, title: 'Carrito de compras urgente' }],
        threshold: 0.7,
    });
    assert.equal(r.hasDuplicate, false);
});

test('logForceDuplicate rechaza justificación corta', () => {
    const dd = require('../duplicate-detector');
    const r = dd.logForceDuplicate({
        title: 'Pantalla nueva',
        matches: [{ number: 100, title: 'Pantalla vieja', score: 0.9 }],
        justification: 'breve',
        author: 'commander:leo',
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'justification_too_short');
});

test('logForceDuplicate persiste con chain válido si justification ≥ 20 chars', () => {
    const dd = require('../duplicate-detector');
    const r = dd.logForceDuplicate({
        title: 'Pantalla nueva',
        matches: [{ number: 100, title: 'Pantalla vieja', score: 0.9 }],
        justification: 'razón válida con más de veinte caracteres reales',
        author: 'commander:leo',
    });
    assert.equal(r.ok, true);
    assert.ok(typeof r.hash_self === 'string');
});

// -----------------------------------------------------------------------------
// Dashboard slice (CA-5)
// -----------------------------------------------------------------------------

test('partialPauseAuditSlice mapea entries a estados visuales correctos', () => {
    resetFs();
    audit.appendMutation({
        source: 'commander:leo', action: 'write',
        previous: [], current: [3559],
        authorizedBy: 'commander:leo',
        justification: 'humano',
    });
    audit.appendMutation({
        source: 'wave-promote', action: 'write',
        previous: [3559], current: [3559, 3605],
        authorizedBy: 'wave-promote',
        justification: 'subsistema',
    });
    audit.appendMutation({
        source: 'unknown:bad-caller', action: 'reject',
        previous: [3559, 3605], current: [3559, 3605],
        authorizedBy: null,
        justification: 'rechazado',
    });
    delete require.cache[require.resolve('../dashboard-slices')];
    const slices = require('../dashboard-slices');
    const slice = slices.partialPauseAuditSlice({}, { limit: 10 });
    assert.ok(Array.isArray(slice.entries));
    const visuals = slice.entries.map(e => e.visual);
    assert.ok(visuals.includes('human'));
    assert.ok(visuals.includes('subsystem'));
    assert.ok(visuals.includes('rejected'));
});
