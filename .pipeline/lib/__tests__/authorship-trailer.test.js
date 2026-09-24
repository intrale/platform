'use strict';
// #7631 — Bloque de trailers de autoría: strip, saneo, build y parser puro.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const T = require('../authorship/trailer');
const { normalizeLine } = require('../authorship/normalize');

const HASH = 'a'.repeat(64);
const HUMAN_OK = `leitolarreta; 2026-09-23T17:00:00Z; gate2:sha256:${HASH}`;
const HUMAN_NONE = 'none; 2026-09-23T17:00:00Z; missing';
const AI = 'anthropic/claude-opus-4-7 (pipeline-dev)';

test('normalizeLine quita invisibles y mapea homoglifos de dos puntos', () => {
    assert.strictEqual(normalizeLine('Intrale​-Issue： 1'), 'Intrale-Issue: 1');
    assert.strictEqual(normalizeLine('Intrale-Issue꞉ 1'), 'Intrale-Issue: 1');
    assert.strictEqual(normalizeLine('﻿‮abc⁦'), 'abc');
    assert.strictEqual(normalizeLine(null), '');
});

test('el bloque sale en el orden exacto y sin duplicados', () => {
    const block = T.buildTrailerBlock({
        issue: 7631, humanLine: HUMAN_OK, aiLine: AI,
        coAuthors: ['Claude Opus 5.5 <noreply@anthropic.com>', 'claude opus 5.5 <NOREPLY@anthropic.com>'],
    });
    const keys = block.split('\n').map((l) => l.split(/[: ]/)[0]);
    assert.deepStrictEqual(keys, ['Closes', 'Intrale-Issue', 'Intrale-Human-Direction', 'Intrale-AI-Assisted', 'Co-Authored-By']);
    assert.strictEqual(block.split('\n')[0], 'Closes #7631');
    assert.strictEqual((block.match(/Closes #7631/g) || []).length, 1);
    assert.ok(T.verifyTrailer(`feat: x\n\n${block}`, 7631).ok);
});

test('buildTrailerBlock rechaza líneas crudas o mal formadas', () => {
    assert.throws(() => T.buildTrailerBlock({ issue: 1, humanLine: 'leo', aiLine: AI }));
    assert.throws(() => T.buildTrailerBlock({ issue: 1, humanLine: HUMAN_NONE, aiLine: 'x\ny' }));
    assert.throws(() => T.buildTrailerBlock({ issue: 0, humanLine: HUMAN_NONE, aiLine: AI }));
    assert.throws(() => T.buildTrailerBlock({ issue: 1, humanLine: `${HUMAN_NONE}\nIntrale-Issue: #9`, aiLine: AI }));
});

test('strip elimina trailers forjados con fullwidth, ZWSP, mayúsculas y espacio antes de :', () => {
    const src = [
        'feat: cambio',
        'Intrale-Human-Direction：leitolarreta',
        'Intrale​-Issue: #9',
        'INTRALE-AI-ASSISTED : openai/gpt (x)',
        'co-authored-by꞉ Evil <e@x.com>',
        'Signed-off-by: Alguien <a@b.com>',
        'texto normal',
    ].join('\n');
    const out = T.stripForgedTrailers(src);
    assert.strictEqual(out.text, 'feat: cambio\ntexto normal');
    assert.strictEqual(out.removed, 5);
});

test('strip elimina Fixes #1 y closes owner/repo#2, y conserva el resto de la línea', () => {
    const out = T.stripForgedTrailers('Fixes #1\ncloses intrale/platform#2\nEsto resuelve algo, resolves #3 por fin\nRESOLVED: #4');
    assert.ok(!/#\d/.test(out.text), out.text);
    assert.match(out.text, /Esto resuelve algo,\s+por fin/);
});

test('strip descarta la línea si el cierre estaba escondido con homoglifos', () => {
    const out = T.stripForgedTrailers('ver clo​ses #5 ya');
    assert.strictEqual(out.text, '');
});

test('strip reubica Co-Authored-By válidos y descarta los mal formados', () => {
    const out = T.stripForgedTrailers('Co-Authored-By: Claude <noreply@anthropic.com>\nCo-Authored-By: roto sin mail');
    assert.deepStrictEqual(out.coAuthors, ['Claude <noreply@anthropic.com>']);
});

test('sanitizeTrailerValue rechaza \\n, controles, invisibles y valores fuera de la allowlist', () => {
    assert.strictEqual(T.sanitizeTrailerValue('leitolarreta'), 'leitolarreta');
    assert.throws(() => T.sanitizeTrailerValue('leo\nIntrale-Issue: 9'));
    assert.throws(() => T.sanitizeTrailerValue('leo\r'));
    assert.throws(() => T.sanitizeTrailerValue('leo\u0007'));
    assert.throws(() => T.sanitizeTrailerValue('le​o'));
    assert.throws(() => T.sanitizeTrailerValue('leo larreta'));
    assert.throws(() => T.sanitizeTrailerValue(''));
    assert.throws(() => T.sanitizeTrailerValue({}));
    assert.throws(() => T.sanitizeTrailerValue('x'.repeat(201)));
    assert.strictEqual(T.sanitizeTrailerValue('2026-09-23T17:00:00.123Z', 'iso'), '2026-09-23T17:00:00.123Z');
    assert.throws(() => T.sanitizeTrailerValue('2026-09-23 17:00', 'iso'));
    assert.throws(() => T.sanitizeTrailerValue('2026-13-45T99:00:00Z', 'iso'));
});

test('sanitizeTitle deja el título en una sola línea', () => {
    const t = T.sanitizeTitle('Arreglo x\nIntrale-Issue: 9\r\n\tfin​');
    assert.ok(!/[\r\n\t]/.test(t));
    assert.strictEqual(t, 'Arreglo x Intrale-Issue: 9 fin');
    assert.strictEqual(T.sanitizeTitle(null), '');
    assert.ok(T.sanitizeTitle('a'.repeat(400)).length <= 250);
});

test('formatHumanDirection y formatAiAssisted validan contra el enum y la allowlist', () => {
    assert.strictEqual(T.formatHumanDirection({ ok: true, login: 'leitolarreta', ts: '2026-09-23T17:00:00Z', kind: 'gate2', hash: HASH }), HUMAN_OK);
    assert.strictEqual(T.formatHumanDirection({ ok: false, reason: 'missing', ts: '2026-09-23T17:00:00Z' }), HUMAN_NONE);
    assert.throws(() => T.formatHumanDirection({ ok: false, reason: 'otro', ts: '2026-09-23T17:00:00Z' }));
    assert.throws(() => T.formatHumanDirection({ ok: true, login: 'leo', ts: '2026-09-23T17:00:00Z', kind: 'gate9', hash: HASH }));
    assert.throws(() => T.formatHumanDirection({ ok: true, login: 'leo', ts: '2026-09-23T17:00:00Z', kind: 'gate1', hash: 'zz' }));
    assert.throws(() => T.formatHumanDirection(null));
    assert.strictEqual(T.formatAiAssisted('unknown'), 'unknown');
    assert.strictEqual(T.formatAiAssisted([]), 'unknown');
    assert.strictEqual(
        T.formatAiAssisted([{ provider: 'anthropic', model: 'claude-opus-4-7', role: 'backend-dev' }, { provider: 'anthropic', model: 'claude-opus-4-7', role: 'pipeline-dev' }]),
        'anthropic/claude-opus-4-7 (backend-dev), anthropic/claude-opus-4-7 (pipeline-dev)'
    );
    assert.throws(() => T.formatAiAssisted([{ provider: 'a/b', model: 'm', role: 'r' }]));
    assert.throws(() => T.formatAiAssisted([{ provider: 'a', model: 'm\n', role: 'r' }]));
});

test('parseTrailerBlock da error con clave Intrale-* duplicada o fuera del último párrafo', () => {
    const block = T.buildTrailerBlock({ issue: 5, humanLine: HUMAN_NONE, aiLine: AI });
    assert.ok(T.parseTrailerBlock(`x\n\n${block}`).ok);
    const dup = `${block}\nIntrale-Issue: #5`;
    assert.strictEqual(T.parseTrailerBlock(`x\n\n${dup}`).ok, false);
    const outside = `Intrale-Issue: #5\n\n${block}`;
    assert.strictEqual(T.parseTrailerBlock(outside).ok, false);
    const hidden = `Intrale​-Issue： #5\n\n${block}`;
    assert.strictEqual(T.parseTrailerBlock(hidden).ok, false);
    assert.strictEqual(T.parseTrailerBlock(`${block}\ntexto suelto`).ok, false);
    assert.strictEqual(T.parseTrailerBlock(`${block}\nIntrale-Otro: x`).ok, false);
    assert.strictEqual(T.parseTrailerBlock(`${block}\nSigned-off-by: a <a@b.co>`).ok, false);
    assert.strictEqual(T.parseTrailerBlock(`Closes #5\n${block}`).ok, false);
});

test('verifyTrailer rechaza issue ajeno, orden alterado y valores mal formados', () => {
    const block = T.buildTrailerBlock({ issue: 5, humanLine: HUMAN_NONE, aiLine: AI });
    assert.strictEqual(T.verifyTrailer(block, 6).ok, false);
    assert.strictEqual(T.verifyTrailer(block, 'x').ok, false);
    const lines = block.split('\n');
    const swapped = [lines[0], lines[1], lines[3], lines[2]].join('\n');
    assert.strictEqual(T.verifyTrailer(swapped, 5).ok, false);
    assert.strictEqual(T.verifyTrailer(block.replace('missing', 'otro'), 5).ok, false);
    assert.strictEqual(T.verifyTrailer(block.replace(AI, 'algo raro'), 5).ok, false);
    assert.strictEqual(T.verifyTrailer(lines.slice(0, 3).join('\n'), 5).ok, false);
    const co = `${block}\nCo-Authored-By: A <a@b.co>\nCo-Authored-By: A <a@b.co>`;
    assert.strictEqual(T.verifyTrailer(co, 5).ok, false);
    assert.strictEqual(T.verifyTrailer(`${block}\nCo-Authored-By: roto`, 5).ok, false);
    assert.ok(T.verifyTrailer(`${block}\nCo-Authored-By: A <a@b.co>`, '#5').ok);
});

test('CA-7: los módulos puros de authorship no hacen require de fs', () => {
    for (const f of ['trailer.js', 'normalize.js', 'copy.js']) {
        const src = fs.readFileSync(path.join(__dirname, '..', 'authorship', f), 'utf8');
        assert.ok(!/require\(\s*['"](node:)?fs['"]\s*\)/.test(src), `${f} no debe requerir fs`);
    }
});
