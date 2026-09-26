// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';
// #7632 — Núcleo puro del verificador de autoría en CI (verify.js).

const test = require('node:test');
const assert = require('node:assert');

const verify = require('../authorship/verify');
const trailer = require('../authorship/trailer');
const copy = require('../authorship/copy');
const commitBuilder = require('../delivery/commit-builder');

const HUMAN = trailer.formatHumanDirection({
    ok: true, login: 'leitolarreta', ts: '2026-09-24T10:00:00Z', kind: 'gate2', hash: 'a'.repeat(64),
});
const AI = trailer.formatAiAssisted([{ provider: 'anthropic', model: 'claude-opus-5-5', role: 'pipeline-dev' }]);
const LINES = { humanLine: HUMAN, aiLine: AI };

function bodyWithAnchor(issue = 7632, lines = LINES, base = 'Resumen del cambio.\n\nCloses #7632') {
    return copy.applyAnchorToBody(base, issue, lines);
}

function codes(r) { return r.findings.map((f) => f.code); }

test('round-trip: el ancla que escribe delivery verifica sin hallazgos', () => {
    const r = verify.verifyProposedMessage({
        prBody: bodyWithAnchor(),
        commitMessages: ['feat: algo\n\nCo-Authored-By: Claude <noreply@anthropic.com>'],
        issueExists: 'exists',
        headRef: 'agent/7632-pipeline-dev',
    });
    assert.deepStrictEqual(r.findings, []);
    assert.deepStrictEqual(r.checks, { format: 'ok', issue: 'ok', anchor: 'ok' });
    assert.strictEqual(r.issue, '7632');
});

test('round-trip con buildTrailerBlock: el bloque de delivery pasa verifyCommitMessage', () => {
    const msg = commitBuilder.buildSquashMessage({ issue: 7632, branchMessages: 'feat: x', humanLine: HUMAN, aiLine: AI });
    assert.ok(msg.endsWith(trailer.buildTrailerBlock({ issue: 7632, humanLine: HUMAN, aiLine: AI })));
    assert.deepStrictEqual(verify.verifyCommitMessage(`Título (#7700)\n\n${msg}`), { candidate: true, findings: [] });
});

test('body sin ancla → MISSING_TRAILER', () => {
    const r = verify.verifyProposedMessage({ prBody: 'Sin constancia.\n\nCloses #7632' });
    assert.deepStrictEqual(codes(r), ['MISSING_TRAILER']);
    assert.strictEqual(r.checks.format, 'fail');
});

test('ancla que apunta a otro issue que la rama → ANCHOR_MISMATCH', () => {
    const r = verify.verifyProposedMessage({ prBody: bodyWithAnchor(7000), issueExists: 'exists', headRef: 'agent/7632-x' });
    assert.deepStrictEqual(codes(r), ['ANCHOR_MISMATCH']);
    assert.strictEqual(r.checks.anchor, 'fail');
});

test('marcador del ancla con issue distinto del Intrale-Issue → ANCHOR_MISMATCH', () => {
    const body = bodyWithAnchor().replace('authorship-anchor issue=7632', 'authorship-anchor issue=7633');
    assert.deepStrictEqual(codes(verify.verifyProposedMessage({ prBody: body, issueExists: 'exists' })), ['ANCHOR_MISMATCH']);
});

test('clave Intrale-* duplicada dentro del ancla → DUPLICATE_KEY', () => {
    const body = bodyWithAnchor().replace('Intrale-Issue: #7632', 'Intrale-Issue: #7632\nIntrale-Issue: #7632');
    assert.ok(codes(verify.verifyProposedMessage({ prBody: body, issueExists: 'exists' })).includes('DUPLICATE_KEY'));
});

test('dos bloques authorship-anchor → DUPLICATE_KEY', () => {
    const body = `${bodyWithAnchor()}\n\n${copy.buildAnchorBlock(7632, LINES)}`;
    assert.ok(codes(verify.verifyProposedMessage({ prBody: body, issueExists: 'exists' })).includes('DUPLICATE_KEY'));
});

test('línea Intrale-* fuera del ancla (aun con homoglifos) → KEY_OUTSIDE_BLOCK', () => {
    const body = `Intrale​-Issue： #1\n\n${bodyWithAnchor()}`;
    assert.ok(codes(verify.verifyProposedMessage({ prBody: body, issueExists: 'exists' })).includes('KEY_OUTSIDE_BLOCK'));
});

test('Intrale-* sólo en un commit interno (clave ausente del ancla) → MISSING_TRAILER', () => {
    const body = bodyWithAnchor().replace(/Intrale-AI-Assisted: .*\n/, '');
    const r = verify.verifyProposedMessage({
        prBody: body,
        commitMessages: [`feat: x\n\nIntrale-AI-Assisted: ${AI}`],
        issueExists: 'exists',
    });
    assert.ok(codes(r).includes('MISSING_TRAILER'));
});

test('Intrale-* sólo en commits, sin ancla → MISSING_TRAILER una sola vez', () => {
    const r = verify.verifyProposedMessage({ prBody: 'x', commitMessages: [`feat\n\nIntrale-Issue: #7632\nIntrale-AI-Assisted: ${AI}`] });
    assert.deepStrictEqual(codes(r), ['MISSING_TRAILER']);
});

test('valor Human-Direction mal formado → INVALID_FORMAT', () => {
    const body = bodyWithAnchor().replace(HUMAN, 'alguien; ayer; gate2');
    assert.deepStrictEqual(codes(verify.verifyProposedMessage({ prBody: body, issueExists: 'exists' })), ['INVALID_FORMAT']);
});

test('Intrale-Issue no numérico o con inyección → INVALID_FORMAT y sin issue candidato', () => {
    for (const bad of ['#1; rm -rf /', '--repo otro/repo', '#12345678', 'abc']) {
        const body = bodyWithAnchor().replace('Intrale-Issue: #7632', `Intrale-Issue: ${bad}`);
        const r = verify.verifyProposedMessage({ prBody: body });
        assert.ok(codes(r).includes('INVALID_FORMAT'), `esperaba INVALID_FORMAT con ${bad}`);
        assert.strictEqual(verify.extractIssueCandidate(body), null);
    }
});

test('clave Intrale-* desconocida en el ancla → INVALID_FORMAT', () => {
    const body = bodyWithAnchor().replace('Intrale-Issue: #7632', 'Intrale-Issue: #7632\nIntrale-Extra: si');
    assert.ok(codes(verify.verifyProposedMessage({ prBody: body, issueExists: 'exists' })).includes('INVALID_FORMAT'));
});

test('ancla sin cierre → INVALID_FORMAT', () => {
    const body = bodyWithAnchor().replace('<!-- /authorship-anchor -->', '');
    assert.ok(codes(verify.verifyProposedMessage({ prBody: body, issueExists: 'exists' })).includes('INVALID_FORMAT'));
});

test('issue inexistente → ISSUE_NOT_FOUND con el número validado', () => {
    const r = verify.verifyProposedMessage({ prBody: bodyWithAnchor(), issueExists: 'not_found' });
    assert.deepStrictEqual(r.findings, [{ code: 'ISSUE_NOT_FOUND', issue: '7632' }]);
    assert.strictEqual(r.checks.issue, 'fail');
});

test('error de API al consultar el issue → UNVERIFIABLE', () => {
    const r = verify.verifyProposedMessage({ prBody: bodyWithAnchor(), issueExists: 'error' });
    assert.deepStrictEqual(codes(r), ['UNVERIFIABLE']);
    assert.strictEqual(r.checks.issue, 'unknown');
});

test('más de 64 KB → TOO_LARGE sin parsear', () => {
    const r = verify.verifyProposedMessage({ prBody: `${'x'.repeat(verify.MAX_BYTES)}\n${bodyWithAnchor()}` });
    assert.deepStrictEqual(codes(r), ['TOO_LARGE']);
    assert.strictEqual(verify.extractIssueCandidate('x'.repeat(verify.MAX_BYTES + 1)), null);
});

test('reporta todos los hallazgos en el orden de CA-1', () => {
    const body = `Intrale-Issue: #1\n\n${bodyWithAnchor(7632).replace('authorship-anchor issue=7632', 'authorship-anchor issue=9')}`;
    const r = verify.verifyProposedMessage({ prBody: body, issueExists: 'not_found' });
    assert.deepStrictEqual(codes(r), ['KEY_OUTSIDE_BLOCK', 'ISSUE_NOT_FOUND', 'ANCHOR_MISMATCH']);
});

// Un test por cada texto de error de trailer.js: si cambia la redacción, este
// test rompe en vez de degradar el código a INVALID_FORMAT en silencio.
test('mapTrailerError traduce cada texto conocido de trailer.js al enum', () => {
    const casos = [
        ['clave Intrale-* fuera del bloque de trailers', 'KEY_OUTSIDE_BLOCK'],
        ['clave duplicada: Intrale-Issue', 'DUPLICATE_KEY'],
        ['Closes duplicado', 'DUPLICATE_KEY'],
        ['Co-Authored-By duplicado', 'DUPLICATE_KEY'],
        ['línea que no es trailer dentro del bloque', 'INVALID_FORMAT'],
        ['clave desconocida: Intrale-X', 'INVALID_FORMAT'],
        ['Intrale-Human-Direction ausente o mal formado', 'INVALID_FORMAT'],
        ['faltan trailers obligatorios del bloque', 'INVALID_FORMAT'],
    ];
    for (const [texto, code] of casos) assert.strictEqual(verify.mapTrailerError(texto), code, texto);
});

test('los textos reales de trailer.js siguen mapeando igual', () => {
    const block = trailer.buildTrailerBlock({ issue: 7632, humanLine: HUMAN, aiLine: AI });
    const fuera = trailer.parseTrailerBlock(`Intrale-Issue: #1\n\n${block}`);
    assert.strictEqual(verify.mapTrailerError(fuera.error), 'KEY_OUTSIDE_BLOCK');
    const dup = trailer.parseTrailerBlock(`${block}\nIntrale-Issue: #7632`);
    assert.strictEqual(verify.mapTrailerError(dup.error), 'DUPLICATE_KEY');
    const closes = trailer.parseTrailerBlock(`Closes #1\n${block}`);
    assert.strictEqual(verify.mapTrailerError(closes.error), 'DUPLICATE_KEY');
});

test('verifyCommitMessage: commit que no es de agente no es candidato', () => {
    assert.deepStrictEqual(verify.verifyCommitMessage('docs: algo (#12)\n\nSin coautor IA'), { candidate: false, findings: [] });
});

test('verifyCommitMessage: squash de agente sin trailer → hallazgo', () => {
    const msg = 'Título (#7700)\n\nCuerpo\n\nCo-Authored-By: Claude <noreply@anthropic.com>';
    const r = verify.verifyCommitMessage(msg);
    assert.strictEqual(r.candidate, true);
    assert.strictEqual(r.findings.length, 1);
});

test('verifyCommitMessage: trailer incompleto → hallazgo', () => {
    const r = verify.verifyCommitMessage('Título (#7700)\n\nCloses #7632\nIntrale-Issue: #7632');
    assert.deepStrictEqual(r, { candidate: true, findings: [{ code: 'INVALID_FORMAT' }] });
});

test('verifyCommitMessage: mensaje enorme → TOO_LARGE', () => {
    assert.deepStrictEqual(verify.verifyCommitMessage('x'.repeat(verify.MAX_BYTES + 1)).findings, [{ code: 'TOO_LARGE' }]);
});

test('el enum de códigos está congelado', () => {
    assert.ok(Object.isFrozen(verify.CODES));
    assert.deepStrictEqual([...verify.CODES], ['MISSING_TRAILER', 'INVALID_FORMAT', 'DUPLICATE_KEY', 'KEY_OUTSIDE_BLOCK',
        'ISSUE_NOT_FOUND', 'ANCHOR_MISMATCH', 'TOO_LARGE', 'UNVERIFIABLE']);
});
