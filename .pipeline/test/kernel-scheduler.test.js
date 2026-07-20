'use strict';

// =============================================================================
// kernel-scheduler.test.js — Scheduler global de dos niveles (Ola Puente P5a #4775)
//
// Cobertura → criterios de aceptación:
//   - CA-1 : reparto respeta cap por producto, cap global y piso anti-starvation;
//            un producto saturado NO roba slots de otro.
//   - CA-3 : ventanas y providerBudget por producto acotados al techo global.
//   - CA-6 : forma EXACTA del evento de encolado, reason en enum cerrado, determinismo.
//   - CA-8 : con un solo producto reproduce el reparto actual; el módulo NO importa
//            os / getSystemResourceUsage (la presión se inyecta).
// Estilo: node --test (patrón de kernel-action-policy.test.js).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const s = require('../lib/kernel-scheduler');

// -----------------------------------------------------------------------------
// CA-1 — reparto de dos niveles + anti-starvation
// -----------------------------------------------------------------------------

test('CA-1: ningún producto excede su agentCap', () => {
  const { allocations } = s.allocateSlots({
    effectiveGlobalCap: 10,
    pressure: { level: 'green' },
    products: [
      { productId: 'prod-a', active: true, agentCap: 2, minFloor: 0, priority: 0, demand: 5 },
      { productId: 'prod-b', active: true, agentCap: 3, minFloor: 0, priority: 1, demand: 5 },
    ],
  });
  assert.ok(allocations['prod-a'] <= 2, 'prod-a no puede exceder su cap');
  assert.ok(allocations['prod-b'] <= 3, 'prod-b no puede exceder su cap');
  assert.equal(allocations['prod-a'], 2);
  assert.equal(allocations['prod-b'], 3);
});

test('CA-1: la suma de slots asignados nunca supera el cap global', () => {
  const globalCap = 4;
  const { allocations, slotsUsados } = s.allocateSlots({
    effectiveGlobalCap: globalCap,
    pressure: { level: 'green' },
    products: [
      { productId: 'prod-a', active: true, agentCap: 10, minFloor: 0, priority: 0, demand: 10 },
      { productId: 'prod-b', active: true, agentCap: 10, minFloor: 1, priority: 1, demand: 10 },
    ],
  });
  const sum = Object.values(allocations).reduce((a, b) => a + b, 0);
  assert.ok(sum <= globalCap, `Σ slots (${sum}) ≤ cap global (${globalCap})`);
  assert.equal(sum, slotsUsados);
});

test('CA-1: cada producto active recibe un piso mínimo (anti-starvation)', () => {
  // prod-a tiene mayor prioridad y demanda enorme, pero prod-b tiene piso 1:
  // el techo global (2) debe reservar el piso de prod-b antes que el excedente de prod-a.
  const { allocations } = s.allocateSlots({
    effectiveGlobalCap: 2,
    pressure: { level: 'green' },
    products: [
      { productId: 'prod-a', active: true, agentCap: 10, minFloor: 0, priority: 0, demand: 10 },
      { productId: 'prod-b', active: true, agentCap: 10, minFloor: 1, priority: 5, demand: 10 },
    ],
  });
  assert.ok(allocations['prod-b'] >= 1, 'prod-b recibe su piso pese a menor prioridad');
  assert.equal(allocations['prod-a'], 1);
  assert.equal(allocations['prod-b'], 1);
});

test('CA-1: un producto saturado no deja a otro en 0', () => {
  // prod-a quiere todo; prod-b tiene piso 1 → nunca cae a 0.
  const { allocations } = s.allocateSlots({
    effectiveGlobalCap: 3,
    pressure: { level: 'green' },
    products: [
      { productId: 'greedy', active: true, agentCap: 100, minFloor: 0, priority: 0, demand: 100 },
      { productId: 'small', active: true, agentCap: 100, minFloor: 1, priority: 10, demand: 4 },
    ],
  });
  assert.ok(allocations['small'] >= 1, 'small no puede quedar en 0');
  assert.ok(allocations['greedy'] < 100, 'greedy no roba todos los slots');
  const sum = allocations['greedy'] + allocations['small'];
  assert.equal(sum, 3);
});

test('CA-1: productos inactivos no participan del reparto', () => {
  const { allocations } = s.allocateSlots({
    effectiveGlobalCap: 5,
    pressure: { level: 'green' },
    products: [
      { productId: 'active-p', active: true, agentCap: 5, minFloor: 0, priority: 0, demand: 5 },
      { productId: 'idle-p', active: false, agentCap: 5, minFloor: 2, priority: 0, demand: 5 },
    ],
  });
  assert.equal(allocations['active-p'], 5);
  assert.equal(allocations['idle-p'], undefined);
});

test('CA-1: agentCap desmedido se clampa al techo global (anti-DoS)', () => {
  const { allocations } = s.allocateSlots({
    effectiveGlobalCap: 3,
    pressure: { level: 'green' },
    products: [
      { productId: 'evil', active: true, agentCap: 9999, minFloor: 0, priority: 0, demand: 9999 },
    ],
  });
  assert.equal(allocations['evil'], 3, 'clampeado al techo global aunque el cap sea absurdo');
});

// -----------------------------------------------------------------------------
// CA-3 — ventanas y cuota por producto acotadas al techo global
// -----------------------------------------------------------------------------

test('CA-3: clampProviderBudgetToGlobal topa cada provider al presupuesto global', () => {
  const out = s.clampProviderBudgetToGlobal(
    { anthropic: 80, codex: 50 },   // producto pide de más
    { anthropic: 60, codex: 60 },   // techo global
  );
  assert.equal(out.anthropic, 60, 'acotado al global');
  assert.equal(out.codex, 50, 'por debajo del global se respeta');
});

test('CA-3: clampWindowsToGlobal topa activationThreshold y safetyTimeout al global', () => {
  const out = s.clampWindowsToGlobal(
    { activationThreshold: 10, safetyTimeoutHours: 48 },
    { activationThreshold: 3, safetyTimeoutHours: 2 },
  );
  assert.equal(out.activationThreshold, 3);
  assert.equal(out.safetyTimeoutHours, 2);
});

test('CA-3: bajo presión el techo global reducido limita el reparto por producto', () => {
  // El techo global efectivo (reducido por pulpo bajo presión) es la autoridad final.
  const { allocations, slotsUsados } = s.allocateSlots({
    effectiveGlobalCap: 1, // pulpo ya redujo por ORANGE
    pressure: { level: 'orange' },
    products: [
      { productId: 'prod-a', active: true, agentCap: 5, minFloor: 0, priority: 0, demand: 5 },
      { productId: 'prod-b', active: true, agentCap: 5, minFloor: 0, priority: 1, demand: 5 },
    ],
  });
  assert.equal(slotsUsados, 1, 'el techo global reducido acota el total');
  assert.equal(allocations['prod-a'] + allocations['prod-b'], 1);
});

// -----------------------------------------------------------------------------
// CA-6 — evento estructurado de encolado + enum cerrado + determinismo
// -----------------------------------------------------------------------------

test('CA-6: buildEnqueueEvent devuelve la forma EXACTA del contrato', () => {
  const ev = s.buildEnqueueEvent({
    productId: 'prod-a',
    reason: s.ENQUEUE_REASONS.QUOTA_GLOBAL,
    slotsGlobal: 4,
    slotsUsados: 4,
    prioridad: 2,
  });
  assert.deepEqual(Object.keys(ev).sort(), [
    'decision', 'prioridad', 'productId', 'reason', 'slotsGlobal', 'slotsUsados',
  ]);
  assert.equal(ev.productId, 'prod-a');
  assert.equal(ev.decision, 'enqueued');
  assert.equal(ev.reason, 'quota_global');
  assert.equal(ev.slotsGlobal, 4);
  assert.equal(ev.slotsUsados, 4);
  assert.equal(ev.prioridad, 2);
});

test('CA-6: buildEnqueueEvent rechaza reason fuera del enum cerrado', () => {
  assert.throws(() => s.buildEnqueueEvent({ productId: 'prod-a', reason: 'porque-si' }), /enum cerrado/);
});

test('CA-6: buildEnqueueEvent rechaza productId inseguro (no isSafeId)', () => {
  assert.throws(() => s.buildEnqueueEvent({ productId: '../../evil', reason: s.ENQUEUE_REASONS.QUOTA_GLOBAL }), /productId inseguro/);
  assert.throws(() => s.buildEnqueueEvent({ productId: 'a/b', reason: s.ENQUEUE_REASONS.PRESSURE }), /productId inseguro/);
});

test('CA-6: allocateSlots emite evento quota_product cuando el cap propio limita', () => {
  const { events } = s.allocateSlots({
    effectiveGlobalCap: 100,
    pressure: { level: 'green' },
    products: [
      { productId: 'capped', active: true, agentCap: 2, minFloor: 0, priority: 0, demand: 10 },
    ],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'quota_product');
  assert.equal(events[0].productId, 'capped');
});

test('CA-6: allocateSlots emite quota_global cuando el techo global se agota sin presión', () => {
  const { events } = s.allocateSlots({
    effectiveGlobalCap: 2,
    pressure: { level: 'green' },
    products: [
      { productId: 'prod-a', active: true, agentCap: 10, minFloor: 0, priority: 0, demand: 10 },
      { productId: 'prod-b', active: true, agentCap: 10, minFloor: 0, priority: 1, demand: 10 },
    ],
  });
  const reasons = events.map((e) => e.reason);
  assert.ok(reasons.includes('quota_global'), `esperaba quota_global, got ${JSON.stringify(reasons)}`);
  assert.ok(!reasons.includes('pressure_ram_cpu'));
});

test('CA-6: allocateSlots emite pressure_ram_cpu cuando el global se agota bajo presión', () => {
  const { events } = s.allocateSlots({
    effectiveGlobalCap: 1,
    pressure: { level: 'red' },
    products: [
      { productId: 'prod-a', active: true, agentCap: 10, minFloor: 0, priority: 0, demand: 10 },
      { productId: 'prod-b', active: true, agentCap: 10, minFloor: 0, priority: 1, demand: 10 },
    ],
  });
  const reasons = events.map((e) => e.reason);
  assert.ok(reasons.includes('pressure_ram_cpu'), `esperaba pressure_ram_cpu, got ${JSON.stringify(reasons)}`);
});

test('CA-6: determinismo — mismas entradas producen exactamente la misma decisión', () => {
  const input = {
    effectiveGlobalCap: 3,
    pressure: { level: 'green' },
    products: [
      { productId: 'prod-a', active: true, agentCap: 5, minFloor: 1, priority: 1, demand: 5 },
      { productId: 'prod-b', active: true, agentCap: 5, minFloor: 1, priority: 0, demand: 5 },
    ],
  };
  const r1 = s.allocateSlots(input);
  const r2 = s.allocateSlots(input);
  assert.deepEqual(r1, r2);
});

// -----------------------------------------------------------------------------
// CA-8 — single product reproduce el reparto actual + módulo sin os/presión propia
// -----------------------------------------------------------------------------

test('CA-8: con un solo producto active el reparto == max_concurrent_devs', () => {
  for (const maxDevs of [1, 2, 3]) {
    const { allocations, slotsUsados } = s.allocateSlots({
      effectiveGlobalCap: maxDevs,
      pressure: { level: 'green' },
      products: [
        { productId: 'intrale-platform', active: true, agentCap: maxDevs, minFloor: 0, priority: 0, demand: maxDevs },
      ],
    });
    assert.equal(allocations['intrale-platform'], maxDevs, `cap ${maxDevs} reproducido`);
    assert.equal(slotsUsados, maxDevs);
  }
});

test('CA-8: kernel-scheduler.js NO importa os ni getSystemResourceUsage (presión inyectada)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'kernel-scheduler.js'), 'utf8');
  assert.ok(!/require\(\s*['"]os['"]\s*\)/.test(src), 'no debe importar os');
  assert.ok(!/require\(\s*['"]node:os['"]\s*\)/.test(src), 'no debe importar node:os');
  // Debe INYECTAR la presión, nunca llamar a la función que la calcula.
  assert.ok(!/getSystemResourceUsage\s*\(/.test(src), 'no debe llamar getSystemResourceUsage');
});
