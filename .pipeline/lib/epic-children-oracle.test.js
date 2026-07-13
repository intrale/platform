'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { allChildrenDone } = require('./epic-children-oracle');

test('allChildrenDone devuelve false con array vacio', () => {
  assert.equal(allChildrenDone({ children: [], issueStates: {} }), false);
});

test('allChildrenDone devuelve false con estado desconocido', () => {
  assert.equal(allChildrenDone({ children: [4662], issueStates: {} }), false);
  assert.equal(allChildrenDone({ children: [4662], issueStates: { 4662: 'OPEN' } }), false);
});

test('allChildrenDone devuelve true cuando todos estan CLOSED o Done', () => {
  assert.equal(allChildrenDone({
    children: [4662, '4663', 4664],
    issueStates: {
      4662: 'CLOSED',
      4663: { state: 'closed' },
      4664: { labels: ['status:done'] },
    },
  }), true);
});

test('allChildrenDone falla cerrado con hijo no numerico o sin estados', () => {
  assert.equal(allChildrenDone({ children: ['abc'], issueStates: { abc: 'CLOSED' } }), false);
  assert.equal(allChildrenDone({ children: [1], issueStates: null }), false);
});
