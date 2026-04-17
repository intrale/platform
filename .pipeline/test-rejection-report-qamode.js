#!/usr/bin/env node
// =============================================================================
// Test unitario para selectPrimaryCause con filtro por qaMode (#2322 CA-5)
//
// Verifica que un issue con qaMode != 'android' (api o structural) NO genere
// issue dependiente de "Emulador Android no está corriendo", aunque el
// pattern-match del log lo haya detectado.
//
// Ejecutar: node .pipeline/test-rejection-report-qamode.js
// =============================================================================

const { selectPrimaryCause } = require('./rejection-report');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'Values not equal'} — esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
  }
}

// --- Fixtures ---
const emuDep = {
  summary: 'Emulador Android no esta corriendo',
  detail: 'Se necesita el emulador Android para ejecutar las pruebas QA.',
  source: 'pattern-match',
  priority: 'normal',
};

const apkDep = {
  summary: 'El APK no se pudo generar',
  detail: 'El build de Android fallo.',
  source: 'pattern-match',
  priority: 'high',
};

const genericDep = {
  summary: 'Bug en parser JSON de otro servicio',
  detail: 'La app crashea al parsear respuesta del backend.',
  source: 'pattern-match',
  priority: 'high',
};

// =============================================================================
// Tests
// =============================================================================
console.log('\n=== Test: selectPrimaryCause filtra emulador por qaMode (#2322 CA-5) ===\n');

// --- Caso 1: qaMode='api' con dep de emulador → null (filtrado)
test('qaMode=api con dep de emulador única → returns null', () => {
  const result = selectPrimaryCause([emuDep], { ok: false, qaMode: 'api' });
  assertEqual(result, null, 'Emulador no debería ser primaryCause para qaMode=api');
});

// --- Caso 2: qaMode='structural' con dep de emulador → null (filtrado)
test('qaMode=structural con dep de emulador única → returns null', () => {
  const result = selectPrimaryCause([emuDep], { ok: false, qaMode: 'structural' });
  assertEqual(result, null, 'Emulador no debería ser primaryCause para qaMode=structural');
});

// --- Caso 3: qaMode='android' con dep de emulador → returns el dep (permitido)
test('qaMode=android con dep de emulador única → returns emulador dep', () => {
  const result = selectPrimaryCause([emuDep], { ok: false, qaMode: 'android' });
  assert(result !== null, 'Emulador SÍ debería poder ser primaryCause para qaMode=android');
  assertEqual(result.summary, emuDep.summary, 'primaryCause debería ser la dep de emulador');
});

// --- Caso 4: qaMode='api' con emulador + dep genuina → returns la genuina
test('qaMode=api con emu + dep genuina → selecciona la genuina', () => {
  const result = selectPrimaryCause([emuDep, genericDep], { ok: false, qaMode: 'api' });
  assert(result !== null, 'Debería haber primaryCause');
  assertEqual(result.summary, genericDep.summary, 'primaryCause debería ser el bug JSON, no el emulador');
});

// --- Caso 5: qaMode='api' sin deps de emulador → funciona normal
test('qaMode=api con deps no-emulador → selecciona la de mayor prioridad', () => {
  const result = selectPrimaryCause([apkDep, genericDep], { ok: false, qaMode: 'api' });
  assert(result !== null, 'Debería haber primaryCause');
  // Ambas son high, pero la primera en ranking debe ser una high con source pattern-match
  assert(result.priority === 'high', 'primaryCause debería tener prioridad high');
});

// --- Caso 6: preflight.ok=true (filtro viejo) sigue funcionando
test('preflight.ok=true sigue filtrando emulador (regresión)', () => {
  const result = selectPrimaryCause([emuDep], { ok: true, qaMode: 'android' });
  assertEqual(result, null, 'Si preflight pasó, no debería crear dep de emulador');
});

// --- Caso 7: preflight sin qaMode (fallback, no rompe)
test('preflight sin qaMode → no aplica filtro CA-5 (usa sólo filtro viejo)', () => {
  const result = selectPrimaryCause([emuDep], { ok: false, qaMode: null });
  // Sin qaMode y sin preflight.ok, el filtro viejo tampoco aplica → dep pasa
  assert(result !== null, 'Sin qaMode ni preflight.ok, la dep de emulador pasa');
  assertEqual(result.summary, emuDep.summary, 'primaryCause debería ser la dep de emulador');
});

// --- Caso 8: sin preflight (undefined) → comportamiento legacy
test('preflight undefined → no rompe, dep pasa', () => {
  const result = selectPrimaryCause([emuDep]);
  assert(result !== null, 'Sin preflight, la dep de emulador pasa (legacy)');
});

// --- Caso 9: deps vacías → null
test('deps vacías → returns null', () => {
  const result = selectPrimaryCause([], { ok: false, qaMode: 'api' });
  assertEqual(result, null, 'Sin deps, null');
});

// --- Caso 10: qaMode='api' con múltiples deps de emulador (variantes) → todas filtradas
test('qaMode=api con variantes de emu/emulator/adb → todas filtradas', () => {
  const deps = [
    { summary: 'Emulador Android no esta corriendo', source: 'pattern-match', priority: 'normal' },
    { summary: 'ADB connection lost', source: 'pattern-match', priority: 'normal' },
    { summary: 'Emulator device not found', source: 'pattern-match', priority: 'normal' },
  ];
  const result = selectPrimaryCause(deps, { ok: false, qaMode: 'api' });
  assertEqual(result, null, 'Todas las variantes de emulator/adb deberían filtrarse');
});

// =============================================================================
// Resumen
// =============================================================================
console.log(`\n=== Resumen ===`);
console.log(`✅ Pasaron: ${passed}`);
console.log(`❌ Fallaron: ${failed}`);
console.log();

process.exit(failed > 0 ? 1 : 0);
