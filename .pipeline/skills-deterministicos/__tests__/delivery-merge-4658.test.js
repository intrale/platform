// #4658 — Delivery: mergear (no rebasar) contra main y escalar al operador ante
// conflicto de merge REAL. Reproducción del caso #4632 y gates de seguridad
// R1–R7. Sin invocar gh/git: validamos las decisiones puras y el escalado
// fail-closed (audit tamper-evident + cola Telegram) con filesystem aislado.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar REPO_ROOT (delivery escribe audit + cola Telegram centrales acá).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-delivery4658-'));
fs.mkdirSync(path.join(TMP, '.claude', 'hooks'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'logs'), { recursive: true });
process.env.PIPELINE_REPO_ROOT = TMP;
process.env.CLAUDE_PROJECT_DIR = TMP;

delete require.cache[require.resolve('../delivery')];
const delivery = require('../delivery');
const humanBlock = require('../../lib/human-block');

// ── classifyMergeFailure (señal server-side, CA-2 / R7) ────────────────────
test('#4658 CA-2 — classifyMergeFailure: HTTP 405 (not mergeable) = conflicto real', () => {
    const c = delivery.classifyMergeFailure({ exit_code: 1, stderr: 'gh: Pull Request is not mergeable (HTTP 405)' });
    assert.equal(c.conflict, true);
    assert.equal(c.httpStatus, 405);
});

test('#4658 CA-2 — classifyMergeFailure: HTTP 409 (head changed) = conflicto real', () => {
    const c = delivery.classifyMergeFailure({ exit_code: 1, stderr: 'HTTP 409: Head branch was modified. Review and try the merge again.' });
    assert.equal(c.conflict, true);
    assert.equal(c.httpStatus, 409);
});

test('#4658 — classifyMergeFailure: deteccion textual sin codigo HTTP explicito', () => {
    const c = delivery.classifyMergeFailure({ exit_code: 1, stdout: '{"message":"Merge conflict"}' });
    assert.equal(c.conflict, true);
});

test('#4658 — classifyMergeFailure: fallo generico (5xx/red) NO es conflicto -> rebote tecnico normal', () => {
    assert.equal(delivery.classifyMergeFailure({ exit_code: 1, stderr: 'HTTP 502 Bad Gateway' }).conflict, false);
    assert.equal(delivery.classifyMergeFailure({ exit_code: 1, stderr: 'error: could not connect to github.com' }).conflict, false);
});

test('#4658 — classifyMergeFailure: merge OK (exit 0) no es conflicto', () => {
    assert.equal(delivery.classifyMergeFailure({ exit_code: 0 }).conflict, false);
});

// ── shouldEscalateLocalMerge (repro #4632: merge limpio no rebota) ──────────
test('#4658 CA-1 — shouldEscalateLocalMerge: merge limpio (mergeable) NO escala (repro #4632)', () => {
    assert.equal(delivery.shouldEscalateLocalMerge({ supported: true, mergeable: true }), false);
});

test('#4658 CA-2 — shouldEscalateLocalMerge: conflicto real (mergeable=false) escala', () => {
    assert.equal(delivery.shouldEscalateLocalMerge({ supported: true, mergeable: false }), true);
});

test('#4658 — shouldEscalateLocalMerge: merge-tree no soportado (null) NO escala local (delega a server-side)', () => {
    assert.equal(delivery.shouldEscalateLocalMerge({ supported: false, mergeable: null }), false);
});

// ── buildConflictMotivo -> human-block (NO rebote a dev en loop, CA-2) ──────
test('#4658 CA-2 — buildConflictMotivo produce motivo que el pulpo trata como BLOQUEO HUMANO (no rebote)', () => {
    const motivo = delivery.buildConflictMotivo({ prNumber: 4700, branch: 'agent/4658-x', httpStatus: 405 });
    assert.equal(humanBlock.isHumanBlockReason(motivo), true,
        'el motivo debe matchear HUMAN_BLOCK_PATTERNS -> bloqueado-humano/needs-human sin rev++');
});

// ── buildMergeConflictEscalation (UX + fail-closed) ────────────────────────
test('#4658 — mensaje de escalado incluye opciones explicitas resolver/abortar/reintentar', () => {
    const msg = delivery.buildMergeConflictEscalation({ issue: 4658, prNumber: 4700, branch: 'agent/4658-x', httpStatus: 405 });
    assert.match(msg, /resolver/i);
    assert.match(msg, /abortar/i);
    assert.match(msg, /reintentar/i);
    assert.match(msg, /INTACTO/i, 'debe tranquilizar que main quedo intacto');
    assert.match(msg, /#4658/, 'debe indicar como responder con el issue');
});

test('#4658 R5/R6 — mensaje de escalado sanea texto libre (secrets redactados, sin CRLF)', () => {
    const msg = delivery.buildMergeConflictEscalation({
        issue: 4658, prNumber: 1, branch: 'agent/4658-x',
        conflictExcerpt: 'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 second line\r\notra',
    });
    assert.ok(!msg.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), 'no debe filtrar el token');
    const excerptLine = msg.split('\n').find((l) => l.startsWith('Contexto del conflicto:'));
    assert.ok(excerptLine && !/\r/.test(excerptLine), 'el excerpt viaja en una sola linea (CRLF colapsado)');
});

// ── authorizeOperatorResponse (CA-4 / R1: allowlist cerrada) ────────────────
test('#4658 CA-4 — authorizeOperatorResponse: chat_id fuera de allowlist NO autoriza (fail-closed)', () => {
    assert.equal(delivery.authorizeOperatorResponse('999999', ['111', '222']).authorized, false);
});

test('#4658 CA-4 — authorizeOperatorResponse: chat_id en allowlist autoriza', () => {
    assert.equal(delivery.authorizeOperatorResponse('111', ['111', '222']).authorized, true);
});

test('#4658 CA-4 — authorizeOperatorResponse: allowlist vacia NO autoriza a nadie', () => {
    assert.equal(delivery.authorizeOperatorResponse('111', []).authorized, false);
});

// ── escalateMergeConflict: audit tamper-evident + Telegram (CA-5/CA-3/R3) ───
test('#4658 CA-5/CA-3 — escalateMergeConflict: audita fail-closed (verifyChain OK) y encola Telegram central', () => {
    const savedOverride = process.env.PIPELINE_DIR_OVERRIDE;
    const auditProbe = require('../../lib/operator-absence-audit');
    try {
        const esc = delivery.escalateMergeConflict({
            issue: 4658, prNumber: 4700, branch: 'agent/4658-x', httpStatus: 405,
            conflictExcerpt: 'file.txt both modified', timestamp: '2026-07-11T00:00:00Z',
        });
        assert.equal(humanBlock.isHumanBlockReason(esc.motivo), true, 'motivo human-block (no rebote)');

        // El audit se escribio en REPO_ROOT/.pipeline (= TMP). Apuntamos el probe ahi.
        process.env.PIPELINE_DIR_OVERRIDE = path.join(TMP, '.pipeline');
        const chain = auditProbe.verifyChain();
        assert.equal(chain.ok, true, 'la cadena hash del audit debe validar (verifyChain)');
        assert.ok(chain.entriesChecked >= 1, 'debe haber al menos una decision auditada');
        const last = auditProbe.tail(1)[0];
        assert.equal(last.decision, 'fail-closed');
        assert.equal(last.gate, 'delivery-merge');

        // Telegram encolado en la cola CENTRAL (REPO_ROOT/.pipeline = TMP).
        const qDir = path.join(TMP, '.pipeline', 'servicios', 'telegram', 'pendiente');
        const drops = fs.existsSync(qDir) ? fs.readdirSync(qDir) : [];
        assert.ok(drops.length >= 1, 'debe encolar al menos un mensaje al operador');
        const anyOptions = drops.some((f) => /reintentar/i.test(JSON.parse(fs.readFileSync(path.join(qDir, f), 'utf8')).text));
        assert.ok(anyOptions, 'debe existir el mensaje con opciones para el operador');
    } finally {
        if (savedOverride === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = savedOverride;
    }
});

test('#4658 R3 — el audit expone appendChained + verifyChain (tamper-evident, no fs.appendFile plano)', () => {
    const auditProbe = require('../../lib/operator-absence-audit');
    assert.equal(typeof auditProbe.appendDecision, 'function');
    assert.equal(typeof auditProbe.verifyChain, 'function');
});
