'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const notice = require('../auto-recheck-notice');

test('#6611 UX-7 - head_ref largo se trunca por el medio con elipsis', () => {
    const head = 'agent/6611-' + 'nombre-muy-largo-'.repeat(12) + '-final-identificable';
    const out = notice.middleEllipsis(head, 120);
    assert.equal(out.length, 120);
    assert.match(out, /^agent\/6611-/);
    assert.match(out, /…/);
    assert.match(out, /final-identificable$/);
});

test('#6611 UX-6 - aviso de techo escala, explica causa y pide acción', () => {
    const out = notice.buildCeilingNotice({ issue: 6611, kind: 'pr_merge_blocked', pr: 6593, attempts: 3 });
    assert.match(out.telegram, /^🚨 Issue #6611:/);
    assert.match(out.telegram, /3 intentos/);
    assert.match(out.telegram, /pr_merge_blocked sobre el PR #6593/);
    assert.match(out.telegram, /queda deshabilitado/);
    assert.match(out.telegram, /Requiere intervención humana/);
    assert.match(out.comment, /queda deshabilitado para esta causa/);
    assert.match(out.comment, /sigue en `needs-human`/);
});
