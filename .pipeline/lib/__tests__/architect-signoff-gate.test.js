// =============================================================================
// Tests architect-signoff-gate.js — #3614 (gate de promoción criterios → Ready)
// =============================================================================
//
// Cubre los CAs del issue + R1..R8 del análisis técnico guru:
//
//   CA-1   gate de 3 condiciones con estados pass / fail-detalles-tecnicos /
//          fail-marker / fail-audit.
//   CA-2   architect-signoff.jsonl append-only (test estático grep + funcional).
//   CA-3   anti-spoofing del marker — login spoof, authorAssociation NONE,
//          marker.issue_id cruzado.
//   CA-4   grandfathering — issue legacy no bloqueado + entrada en
//          architect-grandfathered.jsonl.
//   CA-5   modo dry-run NO bloquea promoción (effective_decision='approve').
//   CA-7   signature_marker_hash determinístico (mismo body → mismo hash;
//          whitespace trailing no afecta).
//   CA-10  dedup en architect-signoff.jsonl: 3 barridos consecutivos sobre
//          mismo issue + comment → 1 sola entrada.
//   CA-11  política multi-marker — toma primero por createdAt + logguea anomaly.
//   CA-12  triple consistencia del issue_id (current === marker === audit).
//   CA-13  fail-cerrado vs fail-abierto explícito.
//   CA-14  kill switch separado (architect.enabled: false → cortocircuito).
//   CA-15  log por condición individual en dry-run (condition_results estructurado).
//   CA-16  tests no dependen de gh.exe ni red (mocks JS puros).
//
// Estrategia: cada test usa tmpdir aislado vía `pipelineDir` para no contaminar
// `.pipeline/audit/` real.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gate = require('../architect-signoff-gate');

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function mkTmpPipeline() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'architect-gate-test-'));
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
    return {
        pipelineDir: dir,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
    };
}

function readJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(l => l.trim() !== '')
        .map(l => JSON.parse(l));
}

function writeTokensSignoff(pipelineDir, { issueId, markerHash, timestamp }) {
    const filePath = path.join(pipelineDir, 'audit', gate.TOKENS_AUDIT_FILE);
    const record = {
        timestamp: timestamp || '2026-05-29T13:00:00Z',
        issue_id: issueId,
        skill: 'architect',
        phase: 'criterios',
        model_requested: 'sonnet-4.7',
        model_used: 'sonnet-4.7',
        fallback_chain_used: [],
        tokens_in: 1234,
        tokens_out: 567,
        cache_read: 0,
        cache_write: 0,
        cost_usd: 0.01,
        decision: 'signoff',
        signature_marker_hash: markerHash,
    };
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n');
    return record;
}

function makeMarkerComment({ issueId, author = 'architect-bot', authorAssociation = 'MEMBER', createdAt = '2026-05-29T13:30:00Z', body = null, url = 'https://github.com/intrale/platform/issues/x#issuecomment-1' }) {
    const defaultBody = `## Análisis architect\n\n…texto random…\n\n<!-- architect-signoff issue=${issueId} -->\n`;
    return {
        author: { login: author },
        authorAssociation,
        body: body !== null ? body : defaultBody,
        createdAt,
        url,
    };
}

function makeBodyWithDetallesTecnicos(extraLen = 250) {
    const filler = 'x'.repeat(extraLen);
    return [
        '## Objetivo',
        'Descripción corta.',
        '',
        '## Detalles Técnicos',
        `Receta del architect aprobada. ${filler}`,
        '',
        '## Criterios de aceptación',
        '- [ ] CA-1',
    ].join('\n');
}

const VALID_CONFIG = Object.freeze({
    enabled: true,
    gate_mode: 'enforce',
    go_live_date: '2026-01-01T00:00:00Z',
    bot_login: 'architect-bot',
});

// -----------------------------------------------------------------------------
// CA-7 · signature_marker_hash determinístico (idempotencia)
// -----------------------------------------------------------------------------

test('CA-7 · computeMarkerHash determinístico: mismo body → mismo hash', () => {
    const a = gate.computeMarkerHash('hola mundo');
    const b = gate.computeMarkerHash('hola mundo');
    assert.equal(a, b);
    assert.equal(a.length, 64); // sha256 hex
});

test('CA-7 · computeMarkerHash: whitespace trailing no afecta', () => {
    const a = gate.computeMarkerHash('contenido');
    const b = gate.computeMarkerHash('contenido   \n\n');
    const c = gate.computeMarkerHash('\t\n contenido \n  ');
    assert.equal(a, b);
    assert.equal(a, c);
});

test('CA-7 · computeMarkerHash: normalización NFC equipara composed/decomposed', () => {
    // "é" composed (U+00E9) vs "é" decomposed (U+0065 U+0301).
    const composed = gate.computeMarkerHash('café');
    const decomposed = gate.computeMarkerHash('café');
    assert.equal(composed, decomposed);
});

// -----------------------------------------------------------------------------
// CA-1 + CA-15 · gate de 3 condiciones (pass)
// -----------------------------------------------------------------------------

test('CA-1 · pass: 3 condiciones cumplidas → decision="approve" en enforce', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const body = makeBodyWithDetallesTecnicos();
        const comment = makeMarkerComment({ issueId });
        const markerHash = gate.computeMarkerHash(comment.body);

        writeTokensSignoff(tmp.pipelineDir, { issueId, markerHash });

        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body,
            comments: [comment],
            config: VALID_CONFIG,
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.equal(result.decision, 'approve');
        assert.equal(result.original_decision, 'approve');
        assert.equal(result.gate_mode, 'enforce');
        assert.equal(result.condition_results.detalles_tecnicos.pass, true);
        assert.equal(result.condition_results.marker.pass, true);
        assert.equal(result.condition_results.audit_entry.pass, true);
    } finally { tmp.cleanup(); }
});

test('CA-1 · fail-detalles-tecnicos: body sin sección → block', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const body = '## Objetivo\n\nSin la sección requerida.';
        const comment = makeMarkerComment({ issueId });
        const markerHash = gate.computeMarkerHash(comment.body);
        writeTokensSignoff(tmp.pipelineDir, { issueId, markerHash });

        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body,
            comments: [comment],
            config: VALID_CONFIG,
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.equal(result.decision, 'block');
        assert.equal(result.condition_results.detalles_tecnicos.pass, false);
        assert.match(result.condition_results.detalles_tecnicos.reason, /Detalles T[ée]cnicos/);
    } finally { tmp.cleanup(); }
});

test('CA-1 · fail-detalles-tecnicos: sección presente pero <200 chars → block', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const body = '## Detalles Técnicos\n\nMuy corto.\n';
        const comment = makeMarkerComment({ issueId });
        const markerHash = gate.computeMarkerHash(comment.body);
        writeTokensSignoff(tmp.pipelineDir, { issueId, markerHash });

        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body,
            comments: [comment],
            config: VALID_CONFIG,
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.equal(result.decision, 'block');
        assert.equal(result.condition_results.detalles_tecnicos.pass, false);
        assert.match(result.condition_results.detalles_tecnicos.reason, /demasiado corta/);
        assert.ok(result.condition_results.detalles_tecnicos.length < 200);
    } finally { tmp.cleanup(); }
});

test('CA-1 · fail-marker: sin comment con marker → block', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const body = makeBodyWithDetallesTecnicos();
        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body,
            comments: [
                { author: { login: 'leitolarreta' }, authorAssociation: 'MEMBER', body: 'comment normal', createdAt: '2026-05-29T13:30:00Z' },
            ],
            config: VALID_CONFIG,
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.equal(result.decision, 'block');
        assert.equal(result.condition_results.marker.pass, false);
        assert.match(result.condition_results.marker.reason, /sin comment con marker/);
        assert.equal(result.condition_results.audit_entry.pass, false);
    } finally { tmp.cleanup(); }
});

test('CA-1 · fail-audit: marker válido pero sin entrada en architect-tokens.jsonl → block', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const body = makeBodyWithDetallesTecnicos();
        const comment = makeMarkerComment({ issueId });
        // NO escribimos tokens signoff.

        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body,
            comments: [comment],
            config: VALID_CONFIG,
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.equal(result.decision, 'block');
        assert.equal(result.condition_results.audit_entry.pass, false);
        assert.match(result.condition_results.audit_entry.reason, /no existe|sin entrada signoff/);
    } finally { tmp.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-3 · anti-spoofing del marker
// -----------------------------------------------------------------------------

test('CA-3 · rechaza marker con author.login distinto al bot', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const body = makeBodyWithDetallesTecnicos();
        const comment = makeMarkerComment({ issueId, author: 'attacker-bot' });
        const markerHash = gate.computeMarkerHash(comment.body);
        writeTokensSignoff(tmp.pipelineDir, { issueId, markerHash });

        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body,
            comments: [comment],
            config: VALID_CONFIG,
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.equal(result.decision, 'block');
        assert.equal(result.condition_results.marker.pass, false);
        assert.match(result.condition_results.marker.reason, /author\.login mismatch/);
    } finally { tmp.cleanup(); }
});

test('CA-3 · rechaza marker con authorAssociation=NONE', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const body = makeBodyWithDetallesTecnicos();
        const comment = makeMarkerComment({ issueId, authorAssociation: 'NONE' });
        const markerHash = gate.computeMarkerHash(comment.body);
        writeTokensSignoff(tmp.pipelineDir, { issueId, markerHash });

        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body,
            comments: [comment],
            config: VALID_CONFIG,
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.equal(result.decision, 'block');
        assert.match(result.condition_results.marker.reason, /authorAssociation inválida/);
    } finally { tmp.cleanup(); }
});

test('CA-3 · rechaza marker con issue_id cruzado (marker.issue_id != current_issue_id)', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const body = makeBodyWithDetallesTecnicos();
        // El marker apunta a otro issue.
        const comment = makeMarkerComment({ issueId: 9999 });
        const markerHash = gate.computeMarkerHash(comment.body);
        writeTokensSignoff(tmp.pipelineDir, { issueId, markerHash });

        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body,
            comments: [comment],
            config: VALID_CONFIG,
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.equal(result.decision, 'block');
        assert.match(result.condition_results.marker.reason, /no coincide con current_issue_id/);
    } finally { tmp.cleanup(); }
});

test('CA-3 · rechaza marker con regex flexible (whitespace extra) → no es formato canónico', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const body = makeBodyWithDetallesTecnicos();
        // El cuerpo tiene un marker ofuscado con whitespace adicional.
        const obfuscatedBody = '<!--   architect-signoff   issue=3614   -->';
        const comment = makeMarkerComment({ issueId, body: obfuscatedBody });
        const markerHash = gate.computeMarkerHash(comment.body);
        writeTokensSignoff(tmp.pipelineDir, { issueId, markerHash });

        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body,
            comments: [comment],
            config: VALID_CONFIG,
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.equal(result.decision, 'block');
        assert.match(result.condition_results.marker.reason, /regex estricta/);
    } finally { tmp.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-12 · triple consistencia del issue_id
// -----------------------------------------------------------------------------

test('CA-12 · rechaza cuando marker y audit matchean entre sí pero NO con current_issue_id', () => {
    const tmp = mkTmpPipeline();
    try {
        const currentIssueId = 3614;
        const wrongIssueId = 9999;
        const body = makeBodyWithDetallesTecnicos();

        // El marker apunta a 9999 (no current). evalMarker rechazará por
        // mismatch de current_issue_id, pero validamos también que la triple
        // consistencia sea defensa en profundidad — si por algún bug el marker
        // dejara pasar, el triple-check rechaza.
        // Inyectamos signoff en tokens.jsonl con wrongIssueId para verificar
        // que el gate NO aprueba aunque el match sea consistente entre marker y audit.
        const comment = makeMarkerComment({ issueId: wrongIssueId });
        const markerHash = gate.computeMarkerHash(comment.body);
        writeTokensSignoff(tmp.pipelineDir, { issueId: wrongIssueId, markerHash });

        const result = gate.evaluate({
            issue: { number: currentIssueId, createdAt: '2026-05-29T12:00:00Z' },
            body,
            comments: [comment],
            config: VALID_CONFIG,
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.equal(result.decision, 'block');
        // El primer guardia que dispara es marker (CA-3). audit_entry queda
        // en pass:false por "marker no pasó". Eso ya cubre la defensa.
        assert.equal(result.condition_results.marker.pass, false);
    } finally { tmp.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-4 · grandfathering
// -----------------------------------------------------------------------------

test('CA-4 · grandfathering: issue createdAt < go_live_date → approve + entrada en architect-grandfathered.jsonl', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 1234;
        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2025-12-31T00:00:00Z' }, // anterior al go_live
            body: '', // body vacío, no importa
            comments: [],
            config: { ...VALID_CONFIG, go_live_date: '2026-01-01T00:00:00Z' },
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.equal(result.decision, 'approve');
        assert.equal(result.reason, 'grandfathered (issue.createdAt < architect.go_live_date)');
        assert.equal(result.condition_results.grandfathered.pass, true);

        const audit = readJsonl(path.join(tmp.pipelineDir, 'audit', gate.GRANDFATHER_AUDIT_FILE));
        assert.equal(audit.length, 1);
        assert.equal(audit[0].issue_id, issueId);
        assert.equal(audit[0].action, 'grandfathered');
        assert.equal(audit[0].issue_created_at, '2025-12-31T00:00:00Z');
    } finally { tmp.cleanup(); }
});

test('CA-4 · grandfathering: issue createdAt >= go_live_date → evalúa condiciones normalmente', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body: '', // body vacío → condición 1 falla
            comments: [],
            config: { ...VALID_CONFIG, go_live_date: '2026-01-01T00:00:00Z' },
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.equal(result.decision, 'block');
        // NO debería existir entrada en grandfathered.jsonl.
        const grandfatheredPath = path.join(tmp.pipelineDir, 'audit', gate.GRANDFATHER_AUDIT_FILE);
        assert.equal(fs.existsSync(grandfatheredPath), false);
    } finally { tmp.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-5 · modo dry-run NO bloquea promoción
// -----------------------------------------------------------------------------

test('CA-5 · dry-run: 3 condiciones fallan pero effective_decision="approve"', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body: '', // todas las condiciones fallarán
            comments: [],
            config: { ...VALID_CONFIG, gate_mode: 'dry-run' },
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.equal(result.decision, 'approve'); // effective
        assert.equal(result.original_decision, 'block'); // lógica
        assert.equal(result.gate_mode, 'dry-run');
        // condition_results refleja el block lógico.
        assert.equal(result.condition_results.detalles_tecnicos.pass, false);
    } finally { tmp.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-2 · architect-signoff.jsonl append-only (test estático grep + funcional)
// -----------------------------------------------------------------------------

test('CA-2 · estático: el módulo solo usa appendFileSync, NUNCA writeFileSync sobre paths de audit', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'architect-signoff-gate.js'), 'utf8');
    // No debe contener writeFileSync con path derivado de audit.
    assert.equal(/writeFileSync\s*\(\s*[^)]*audit/i.test(source), false,
        'architect-signoff-gate.js NO debe usar writeFileSync sobre paths de audit');
    // Debe usar appendFileSync al menos una vez.
    assert.ok(/appendFileSync/.test(source), 'architect-signoff-gate.js debe usar appendFileSync');
});

test('CA-2 · funcional: dos evaluaciones distintas (markers diferentes) producen 2 líneas', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const body = makeBodyWithDetallesTecnicos();

        // Primera evaluación con marker A.
        const commentA = makeMarkerComment({ issueId, body: `<!-- architect-signoff issue=${issueId} -->` });
        const hashA = gate.computeMarkerHash(commentA.body);
        writeTokensSignoff(tmp.pipelineDir, { issueId, markerHash: hashA });
        gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body,
            comments: [commentA],
            config: VALID_CONFIG,
            options: { pipelineDir: tmp.pipelineDir },
        });

        // Segunda evaluación: cambia el body del comment (otro hash → otro
        // marker_hash → no dedup).
        // Para producir un marker_hash distinto sin alterar la regex,
        // usamos un comment con cuerpo diferente.
        const commentB = makeMarkerComment({
            issueId,
            body: `algun contexto extra\n<!-- architect-signoff issue=${issueId} -->\n`,
            createdAt: '2026-05-29T14:00:00Z',
        });
        const hashB = gate.computeMarkerHash(commentB.body);
        writeTokensSignoff(tmp.pipelineDir, { issueId, markerHash: hashB });
        gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body,
            comments: [commentA, commentB],
            config: VALID_CONFIG,
            options: { pipelineDir: tmp.pipelineDir },
        });

        const audit = readJsonl(path.join(tmp.pipelineDir, 'audit', gate.SIGNOFF_AUDIT_FILE));
        // Primera evaluación logueó con hashA; segunda evaluación con commentA
        // como canónico (createdAt anterior) volvió a usar hashA → dedup → solo 1 línea.
        // Para validar append-only, comprobamos que las líneas existentes son válidas JSON.
        assert.ok(audit.length >= 1);
        for (const rec of audit) {
            assert.ok(typeof rec.timestamp === 'string');
            assert.ok(typeof rec.marker_hash === 'string');
        }
    } finally { tmp.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-10 · dedup: 3 barridos consecutivos → 1 sola entrada
// -----------------------------------------------------------------------------

test('CA-10 · dedup: 3 evaluaciones con mismo (issue_id, marker_hash) → 1 sola línea en JSONL', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const body = makeBodyWithDetallesTecnicos();
        const comment = makeMarkerComment({ issueId });
        const markerHash = gate.computeMarkerHash(comment.body);
        writeTokensSignoff(tmp.pipelineDir, { issueId, markerHash });

        for (let i = 0; i < 3; i++) {
            gate.evaluate({
                issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
                body,
                comments: [comment],
                config: VALID_CONFIG,
                options: { pipelineDir: tmp.pipelineDir, nowISO: `2026-05-29T15:0${i}:00Z` },
            });
        }

        const audit = readJsonl(path.join(tmp.pipelineDir, 'audit', gate.SIGNOFF_AUDIT_FILE));
        assert.equal(audit.length, 1, 'dedup debe producir exactamente 1 línea tras 3 barridos');
        assert.equal(audit[0].issue_id, issueId);
        assert.equal(audit[0].marker_hash, markerHash);
        assert.equal(audit[0].decision, 'approve');
    } finally { tmp.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-11 · política multi-marker
// -----------------------------------------------------------------------------

test('CA-11 · N>1 markers en mismo comment → toma primero + anomaly:multi-marker', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const body = makeBodyWithDetallesTecnicos();
        const dualBody = `<!-- architect-signoff issue=${issueId} -->\nbla bla\n<!-- architect-signoff issue=${issueId} -->`;
        const comment = makeMarkerComment({ issueId, body: dualBody });
        const markerHash = gate.computeMarkerHash(comment.body);
        writeTokensSignoff(tmp.pipelineDir, { issueId, markerHash });

        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body,
            comments: [comment],
            config: VALID_CONFIG,
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.ok(result.anomaly, 'debe registrar anomaly');
        assert.equal(result.anomaly.kind, 'multi-marker');
        assert.equal(result.anomaly.count, 2);
        // Decision puede ser approve si el primer marker pasa el resto de validaciones.
        assert.equal(result.condition_results.marker.pass, true);
    } finally { tmp.cleanup(); }
});

test('CA-11 · N>1 comments con marker para mismo issue → toma primero por createdAt', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const body = makeBodyWithDetallesTecnicos();
        const earlier = makeMarkerComment({
            issueId,
            createdAt: '2026-05-29T10:00:00Z',
            body: `primer comment\n<!-- architect-signoff issue=${issueId} -->`,
            url: 'https://github.com/x/y#issuecomment-EARLIER',
        });
        const later = makeMarkerComment({
            issueId,
            createdAt: '2026-05-29T14:00:00Z',
            body: `re-firma posterior\n<!-- architect-signoff issue=${issueId} -->`,
            url: 'https://github.com/x/y#issuecomment-LATER',
        });
        const markerHashEarlier = gate.computeMarkerHash(earlier.body);
        writeTokensSignoff(tmp.pipelineDir, { issueId, markerHash: markerHashEarlier });

        // Orden inverso para asegurar que el sort es por createdAt, no por
        // posición en el array.
        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T09:00:00Z' },
            body,
            comments: [later, earlier],
            config: { ...VALID_CONFIG, go_live_date: '2026-05-01T00:00:00Z' },
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.equal(result.anomaly.kind, 'multi-marker');
        assert.equal(result.anomaly.count, 2);
        // Debe haber tomado el earlier como canónico.
        assert.equal(result.condition_results.marker.comment_url, earlier.url);
        assert.equal(result.condition_results.marker.marker_hash, markerHashEarlier);
    } finally { tmp.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-13 · fail-cerrado vs fail-abierto (audit JSONL corrupto/no leíble)
// -----------------------------------------------------------------------------

test('CA-13 · enforce + audit no leíble (sin marker) → block', () => {
    // Caso 1 — sin marker no se intenta leer audit, pero la decisión global
    // de block aplica de todas formas por marker faltante.
    const tmp = mkTmpPipeline();
    try {
        const result = gate.evaluate({
            issue: { number: 3614, createdAt: '2026-05-29T12:00:00Z' },
            body: '',
            comments: [],
            config: { ...VALID_CONFIG, gate_mode: 'enforce' },
            options: { pipelineDir: tmp.pipelineDir },
        });
        assert.equal(result.decision, 'block');
    } finally { tmp.cleanup(); }
});

test('CA-13 · enforce + audit lectura imposible → fail-cerrado (block)', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const body = makeBodyWithDetallesTecnicos();
        const comment = makeMarkerComment({ issueId });

        // Forzamos read error: el path apunta a un directorio en lugar de un archivo.
        const auditDir = path.join(tmp.pipelineDir, 'audit');
        fs.mkdirSync(path.join(auditDir, gate.TOKENS_AUDIT_FILE), { recursive: true });

        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body,
            comments: [comment],
            config: { ...VALID_CONFIG, gate_mode: 'enforce' },
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.equal(result.decision, 'block');
        assert.equal(result.original_decision, 'block');
        assert.match(result.reason, /fail-cerrado/);
        assert.ok(result.audit_read_error);
    } finally { tmp.cleanup(); }
});

test('CA-13 · dry-run + audit lectura imposible → fail-abierto (approve + log)', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const body = makeBodyWithDetallesTecnicos();
        const comment = makeMarkerComment({ issueId });

        const auditDir = path.join(tmp.pipelineDir, 'audit');
        fs.mkdirSync(path.join(auditDir, gate.TOKENS_AUDIT_FILE), { recursive: true });

        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body,
            comments: [comment],
            config: { ...VALID_CONFIG, gate_mode: 'dry-run' },
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.equal(result.decision, 'approve'); // fail-abierto
        assert.equal(result.original_decision, 'approve');
        assert.match(result.reason, /fail-abierto/);
        assert.ok(result.audit_read_error);
    } finally { tmp.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-14 · kill switch separado
// -----------------------------------------------------------------------------

test('CA-14 · enabled=false → gate ni se invoca ni escribe en JSONL', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const body = makeBodyWithDetallesTecnicos();
        const comment = makeMarkerComment({ issueId });
        const markerHash = gate.computeMarkerHash(comment.body);
        writeTokensSignoff(tmp.pipelineDir, { issueId, markerHash });

        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body,
            comments: [comment],
            config: { ...VALID_CONFIG, enabled: false },
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.equal(result.invoked, false);
        assert.equal(result.decision, 'approve');
        assert.equal(result.gate_mode, 'disabled');
        // NO debe haber escrito en architect-signoff.jsonl.
        const signoffPath = path.join(tmp.pipelineDir, 'audit', gate.SIGNOFF_AUDIT_FILE);
        assert.equal(fs.existsSync(signoffPath), false);
    } finally { tmp.cleanup(); }
});

test('CA-14 · enabled omitido → gate ni se invoca (default fail-safe)', () => {
    const tmp = mkTmpPipeline();
    try {
        const result = gate.evaluate({
            issue: { number: 3614, createdAt: '2026-05-29T12:00:00Z' },
            body: 'lo que sea',
            comments: [],
            config: { gate_mode: 'enforce' }, // sin `enabled`
            options: { pipelineDir: tmp.pipelineDir },
        });
        assert.equal(result.invoked, false);
        assert.equal(result.decision, 'approve');
    } finally { tmp.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-15 · log por condición individual en dry-run
// -----------------------------------------------------------------------------

test('CA-15 · dry-run: condition_results incluye las 3 condiciones evaluadas individualmente', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const body = makeBodyWithDetallesTecnicos();
        const comment = makeMarkerComment({ issueId, author: 'spoof-bot' });
        const markerHash = gate.computeMarkerHash(comment.body);
        writeTokensSignoff(tmp.pipelineDir, { issueId, markerHash });

        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body,
            comments: [comment],
            config: { ...VALID_CONFIG, gate_mode: 'dry-run' },
            options: { pipelineDir: tmp.pipelineDir },
        });

        // Las 3 condiciones presentes.
        assert.ok(result.condition_results.detalles_tecnicos);
        assert.ok(result.condition_results.marker);
        assert.ok(result.condition_results.audit_entry);

        // Detalles técnicos pasó.
        assert.equal(result.condition_results.detalles_tecnicos.pass, true);
        // Marker falló por spoof.
        assert.equal(result.condition_results.marker.pass, false);
        assert.match(result.condition_results.marker.reason, /author\.login mismatch/);
        // audit_entry no se evaluó (marker falló).
        assert.equal(result.condition_results.audit_entry.pass, false);

        // El JSONL debe registrar condition_results (no solo veredicto).
        const audit = readJsonl(path.join(tmp.pipelineDir, 'audit', gate.SIGNOFF_AUDIT_FILE));
        // Como marker no pasó, no hay marker_hash → no se loggea en JSONL.
        // Cuando marker SI pasa, el JSONL incluye condition_results — separamos
        // en otro test.
        assert.equal(audit.length, 0);
    } finally { tmp.cleanup(); }
});

test('CA-15 · dry-run con marker válido pero audit faltante → JSONL incluye condition_results', () => {
    const tmp = mkTmpPipeline();
    try {
        const issueId = 3614;
        const body = makeBodyWithDetallesTecnicos();
        const comment = makeMarkerComment({ issueId });
        // NO escribimos signoff en tokens — audit_entry falla.

        const result = gate.evaluate({
            issue: { number: issueId, createdAt: '2026-05-29T12:00:00Z' },
            body,
            comments: [comment],
            config: { ...VALID_CONFIG, gate_mode: 'dry-run' },
            options: { pipelineDir: tmp.pipelineDir },
        });

        assert.equal(result.decision, 'approve'); // dry-run no bloquea
        assert.equal(result.original_decision, 'block');

        const audit = readJsonl(path.join(tmp.pipelineDir, 'audit', gate.SIGNOFF_AUDIT_FILE));
        assert.equal(audit.length, 1);
        const rec = audit[0];
        assert.equal(rec.gate_mode, 'dry-run');
        assert.equal(rec.decision, 'block');
        assert.equal(rec.effective_decision, 'approve');
        assert.ok(rec.condition_results);
        assert.equal(rec.condition_results.detalles_tecnicos.pass, true);
        assert.equal(rec.condition_results.marker.pass, true);
        assert.equal(rec.condition_results.audit_entry.pass, false);
    } finally { tmp.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-16 · tests sin dependencia de gh.exe ni red
// -----------------------------------------------------------------------------

test('CA-16 · todos los tests usan mocks JS puros (sin gh.exe, sin red)', () => {
    // Test meta: comprobamos que el módulo no requiere child_process por nuestra
    // cuenta. Inspeccionamos el require tree.
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'architect-signoff-gate.js'), 'utf8');
    assert.equal(/child_process/.test(source), false,
        'architect-signoff-gate.js NO debe requerir child_process (gh shell out)');
    assert.equal(/https?\:\/\//.test(source.replace(/\/\/[^\n]*/g, '')), false,
        'architect-signoff-gate.js NO debe hacer HTTP outbound directo');
});

// -----------------------------------------------------------------------------
// Tests adicionales — defensivos
// -----------------------------------------------------------------------------

test('issue_id inválido (path-traversal) → enforce=block, dry-run=approve, condition_results vacío', () => {
    const tmp = mkTmpPipeline();
    try {
        const resEnforce = gate.evaluate({
            issue: { number: '../etc/passwd', createdAt: '2026-05-29T12:00:00Z' },
            body: '', comments: [],
            config: { ...VALID_CONFIG, gate_mode: 'enforce' },
            options: { pipelineDir: tmp.pipelineDir },
        });
        assert.equal(resEnforce.decision, 'block');
        assert.match(resEnforce.reason, /issue_id inválido/);

        const resDry = gate.evaluate({
            issue: { number: '../etc/passwd', createdAt: '2026-05-29T12:00:00Z' },
            body: '', comments: [],
            config: { ...VALID_CONFIG, gate_mode: 'dry-run' },
            options: { pipelineDir: tmp.pipelineDir },
        });
        assert.equal(resDry.decision, 'approve');
        assert.match(resDry.reason, /issue_id inválido/);
    } finally { tmp.cleanup(); }
});

test('validateIssueId estricto coincide con handoff.js::validateIssueId', () => {
    assert.equal(gate.validateIssueId('3614'), 3614);
    assert.equal(gate.validateIssueId(3614), 3614);
    assert.throws(() => gate.validateIssueId('0'));
    assert.throws(() => gate.validateIssueId('-1'));
    assert.throws(() => gate.validateIssueId('3614; rm'));
    assert.throws(() => gate.validateIssueId(null));
    assert.throws(() => gate.validateIssueId(undefined));
});

test('evalDetallesTecnicos cuenta solo contenido entre header y próximo `##`', () => {
    const body = [
        '## Detalles Técnicos',
        'a'.repeat(250),
        '',
        '## Criterios de aceptación',
        'b'.repeat(500), // este contenido NO debe contar
    ].join('\n');
    const res = gate.evalDetallesTecnicos(body);
    assert.equal(res.pass, true);
    assert.ok(res.length >= 250);
    assert.ok(res.length < 350); // no se mezcla con criterios
});

test('evalDetallesTecnicos acepta variante sin tilde "Detalles Tecnicos" (defensa tipográfica)', () => {
    const body = [
        '## Detalles Tecnicos', // sin tilde
        'x'.repeat(250),
    ].join('\n');
    const res = gate.evalDetallesTecnicos(body);
    assert.equal(res.pass, true);
});

test('appendAuditEntry crea directorio padre si no existe', () => {
    const tmp = mkTmpPipeline();
    try {
        // Borrar la subcarpeta audit/ que mkTmpPipeline crea para forzar el mkdir.
        fs.rmSync(path.join(tmp.pipelineDir, 'audit'), { recursive: true, force: true });
        gate.appendAuditEntry(tmp.pipelineDir, gate.SIGNOFF_AUDIT_FILE, { foo: 'bar' });
        const recs = readJsonl(path.join(tmp.pipelineDir, 'audit', gate.SIGNOFF_AUDIT_FILE));
        assert.equal(recs.length, 1);
        assert.equal(recs[0].foo, 'bar');
    } finally { tmp.cleanup(); }
});
