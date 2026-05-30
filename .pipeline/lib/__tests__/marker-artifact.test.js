'use strict';

// Tests: `lib/marker-artifact.isMarkerArtifact` — single source of truth del
// invariant runtime del pipeline V2 (#3638 CA-F-1).
//
// Equivalencia funcional con las 6 duplicaciones previas:
//   pulpo.js:868, dashboard.js:78, lib/dashboard-slices.js:44,
//   lib/human-block.js:103, lib/wave-state.js:87 (y eta-markers via import).
//
// La lógica histórica era: `name.split('.').length > 2 OR endsWith(
//   '.reason.json' | '.guidance.txt' | '.comment.md')`.

const { test } = require('node:test');
const assert = require('node:assert');
const { isMarkerArtifact } = require('../marker-artifact');

test('marker válido <issue>.<skill> NO es artifact', () => {
    assert.equal(isMarkerArtifact('1732.po'), false);
    assert.equal(isMarkerArtifact('3638.pipeline-dev'), false);
    assert.equal(isMarkerArtifact('2441.guru'), false);
    assert.equal(isMarkerArtifact('5000.backend-dev'), false);
});

test('sufijo .comment.md es artifact', () => {
    assert.equal(isMarkerArtifact('1732.po.comment.md'), true);
    assert.equal(isMarkerArtifact('3076.po.comment.md'), true);
});

test('sufijo .guidance.txt es artifact', () => {
    assert.equal(isMarkerArtifact('1732.po.guidance.txt'), true);
    assert.equal(isMarkerArtifact('3073.pipeline-dev.guidance.txt'), true);
});

test('sufijo .reason.json es artifact', () => {
    assert.equal(isMarkerArtifact('1732.qa.reason.json'), true);
    assert.equal(isMarkerArtifact('3638.review.reason.json'), true);
});

test('cualquier nombre con > 2 segmentos es artifact', () => {
    assert.equal(isMarkerArtifact('a.b.c'), true);
    assert.equal(isMarkerArtifact('1.2.3.4'), true);
    assert.equal(isMarkerArtifact('1732.po.work.tmp'), true);
});

test('.gitkeep NO es artifact', () => {
    assert.equal(isMarkerArtifact('.gitkeep'), false);
});

test('tolera entrada no-string sin crashear', () => {
    assert.equal(isMarkerArtifact(null), false);
    assert.equal(isMarkerArtifact(undefined), false);
    assert.equal(isMarkerArtifact(123), false);
});

test('equivalencia funcional con la lógica histórica de las 6 duplicaciones', () => {
    const legacy = (name) => {
        if (name.split('.').length > 2) return true;
        return name.endsWith('.reason.json')
            || name.endsWith('.guidance.txt')
            || name.endsWith('.comment.md');
    };
    const samples = [
        '1732.po', '3638.pipeline-dev', '2441.guru',
        '1732.po.comment.md', '1732.po.guidance.txt', '1732.po.reason.json',
        '5000.qa.reason.json', '8888.review',
        '.gitkeep', 'a.b.c', '1.2.3.4', '1732.po.work.tmp',
    ];
    for (const s of samples) {
        assert.equal(
            isMarkerArtifact(s),
            legacy(s),
            `desvío de comportamiento legacy en "${s}"`,
        );
    }
});

test('re-export desde human-block sigue funcionando (compat #2854)', () => {
    const hb = require('../human-block');
    assert.equal(typeof hb.isMarkerArtifact, 'function');
    assert.equal(hb.isMarkerArtifact('1732.po.comment.md'), true);
    assert.equal(hb.isMarkerArtifact('1732.po'), false);
});
