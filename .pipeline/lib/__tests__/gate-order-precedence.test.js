'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { supersededGateOrder } = require('../gate-order-precedence');

test('precedencia aislada por issue/target, timestamp inválido y recibo corrupto cierran', (t) => {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-precedence-'));
  t.after(() => fs.rmSync(queueDir, { recursive: true, force: true }));
  const order = { issue: 7206, action: 'label', label: 'qa:passed', origen: 'gate-caducidad-sello' };
  const newer = { queueDir, name: '7206-reratificado-gate-20260912200100000.json' };
  const older = { queueDir, name: '7206-seal-caduco-gate-20260912200000000.json' };
  assert.equal(supersededGateOrder({ ...order }, newer), false);
  assert.equal(supersededGateOrder({ ...order, label: 'qa:pending' }, older), true);
  assert.equal(supersededGateOrder({ ...order, target: 'pr', label: 'qa:pending' }, older), false);
  assert.equal(supersededGateOrder({ ...order, issue: 7207, label: 'qa:pending' }, older), false);
  assert.equal(supersededGateOrder({ ...order, action: 'remove-label' }, older), true);
  assert.equal(supersededGateOrder({ ...order, action: 'remove-label', label: 'qa:skipped' }, older), true);
  assert.throws(() => supersededGateOrder(order, { queueDir, name: 'sin-stamp.json' }), /timestamp/);
  assert.throws(() => supersededGateOrder(order, { queueDir, name: 'gate-20261312200100000.json' }), /inválido/);
  fs.writeFileSync(path.join(queueDir, 'gate-order-precedence', 'issue-7206.json'), '{}');
  assert.throws(() => supersededGateOrder(order, newer), /Recibo/);
});
