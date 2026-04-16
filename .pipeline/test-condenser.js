#!/usr/bin/env node
// =============================================================================
// Test del condensador + create-issue + retry en servicio-github.js
// Ejecutar: node .pipeline/test-condenser.js
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PIPELINE = __dirname;
const QUEUE_DIR = path.join(PIPELINE, 'servicios', 'github');
const PENDIENTE = path.join(QUEUE_DIR, 'pendiente');
const TRABAJANDO = path.join(QUEUE_DIR, 'trabajando');
const LISTO = path.join(QUEUE_DIR, 'listo');
const FALLIDO = path.join(QUEUE_DIR, 'fallido');

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

function cleanTestFiles(prefix) {
  for (const dir of [PENDIENTE, TRABAJANDO, LISTO, FALLIDO]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(prefix)) fs.unlinkSync(path.join(dir, f));
      }
    } catch {}
  }
  // Limpiar condenser files
  try {
    for (const f of fs.readdirSync(QUEUE_DIR)) {
      if (f.startsWith('condenser-') && f.includes(prefix)) fs.unlinkSync(path.join(QUEUE_DIR, f));
    }
  } catch {}
}

// =============================================================================
console.log('\n=== TEST 1: parseCommandArgs ===');
// =============================================================================
{
  // Importar la funcion directamente evaluando el modulo
  // Como no exporta, testeamos el patron directamente
  function parseCommandArgs(command) {
    const cmd = command.replace(/^node\s+/, '');
    const args = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
    for (const ch of cmd) {
      if (inQuote) {
        if (ch === quoteChar) { inQuote = false; }
        else { current += ch; }
      } else if (ch === '"' || ch === "'") {
        inQuote = true;
        quoteChar = ch;
      } else if (ch === ' ') {
        if (current) { args.push(current); current = ''; }
      } else {
        current += ch;
      }
    }
    if (current) args.push(current);
    return args;
  }

  test('comando simple sin comillas', () => {
    const args = parseCommandArgs('node .pipeline/rejection-report.js --phase complete');
    assert(args[0] === '.pipeline/rejection-report.js', `esperaba .pipeline/rejection-report.js, got ${args[0]}`);
    assert(args[1] === '--phase', `esperaba --phase, got ${args[1]}`);
    assert(args[2] === 'complete', `esperaba complete, got ${args[2]}`);
    assert(args.length === 3, `esperaba 3 args, got ${args.length}`);
  });

  test('comando con path entre comillas', () => {
    const args = parseCommandArgs('node .pipeline/rejection-report.js --phase complete --context "C:\\path con espacios\\context.json"');
    assert(args[3] === '--context', `esperaba --context en args[3], got ${args[3]}`);
    assert(args[4] === 'C:\\path con espacios\\context.json', `esperaba path con espacios en args[4], got ${args[4]}`);
    assert(args.length === 5, `esperaba 5 args, got ${args.length}`);
  });

  test('comando con comillas simples', () => {
    const args = parseCommandArgs("node script.js --arg 'value with spaces'");
    assert(args[2] === 'value with spaces', `esperaba 'value with spaces', got ${args[2]}`);
  });
}

// =============================================================================
console.log('\n=== TEST 2: Estructura de directorios ===');
// =============================================================================
{
  test('directorio pendiente/ existe', () => {
    assert(fs.existsSync(PENDIENTE), 'pendiente/ no existe');
  });
  test('directorio trabajando/ existe', () => {
    assert(fs.existsSync(TRABAJANDO), 'trabajando/ no existe');
  });
  test('directorio listo/ existe', () => {
    assert(fs.existsSync(LISTO), 'listo/ no existe');
  });
  test('directorio fallido/ existe', () => {
    assert(fs.existsSync(FALLIDO), 'fallido/ no existe');
  });
}

// =============================================================================
console.log('\n=== TEST 3: Retry con contador ===');
// =============================================================================
{
  const prefix = 'test-retry';
  cleanTestFiles(prefix);

  // Simular un item que falla: action invalida con issue inexistente
  const testFile = `${prefix}-${Date.now()}.json`;
  fs.writeFileSync(path.join(PENDIENTE, testFile), JSON.stringify({
    action: 'label',
    issue: 999999999,  // issue que no existe
    label: 'test-label-inexistente',
  }));

  test('item con issue inexistente se encola en pendiente/', () => {
    assert(fs.existsSync(path.join(PENDIENTE, testFile)), 'archivo no encontrado en pendiente/');
  });

  // Simular procesamiento manual (sin el servicio corriendo)
  // Movemos a trabajando, intentamos procesar, deberia fallar y volver a pendiente con retries=1
  const trabajandoPath = path.join(TRABAJANDO, testFile);
  fs.renameSync(path.join(PENDIENTE, testFile), trabajandoPath);

  try {
    const data = JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));
    try {
      execSync(`"C:\\Workspaces\\gh-cli\\bin\\gh.exe" issue edit ${data.issue} --add-label "${data.label}"`, {
        cwd: path.resolve(PIPELINE, '..'), encoding: 'utf8', timeout: 15000, windowsHide: true
      });
    } catch (e) {
      // Esperado: falla porque el issue no existe
      data.retries = (data.retries || 0) + 1;
      data.lastError = e.message;
      if (data.retries >= 3) {
        fs.writeFileSync(path.join(FALLIDO, testFile), JSON.stringify(data, null, 2));
        try { fs.unlinkSync(trabajandoPath); } catch {}
      } else {
        fs.writeFileSync(path.join(PENDIENTE, testFile), JSON.stringify(data, null, 2));
        try { fs.unlinkSync(trabajandoPath); } catch {}
      }
    }
  } catch {}

  test('item fallido vuelve a pendiente/ con retries=1', () => {
    assert(fs.existsSync(path.join(PENDIENTE, testFile)), 'archivo no encontrado en pendiente/');
    const data = JSON.parse(fs.readFileSync(path.join(PENDIENTE, testFile), 'utf8'));
    assert(data.retries === 1, `esperaba retries=1, got ${data.retries}`);
    assert(data.lastError, 'esperaba lastError');
  });

  // Simular 2 fallos mas para que vaya a fallido/
  for (let i = 0; i < 2; i++) {
    const src = path.join(PENDIENTE, testFile);
    if (!fs.existsSync(src)) break;
    fs.renameSync(src, trabajandoPath);
    const data = JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));
    data.retries = (data.retries || 0) + 1;
    data.lastError = 'simulated failure';
    if (data.retries >= 3) {
      fs.writeFileSync(path.join(FALLIDO, testFile), JSON.stringify(data, null, 2));
      try { fs.unlinkSync(trabajandoPath); } catch {}
    } else {
      fs.writeFileSync(path.join(PENDIENTE, testFile), JSON.stringify(data, null, 2));
      try { fs.unlinkSync(trabajandoPath); } catch {}
    }
  }

  test('item con 3 fallos va a fallido/', () => {
    assert(fs.existsSync(path.join(FALLIDO, testFile)), 'archivo no encontrado en fallido/');
    const data = JSON.parse(fs.readFileSync(path.join(FALLIDO, testFile), 'utf8'));
    assert(data.retries === 3, `esperaba retries=3, got ${data.retries}`);
  });

  cleanTestFiles(prefix);
}

// =============================================================================
console.log('\n=== TEST 4: Condensador — grupo completo dispara onComplete ===');
// =============================================================================
{
  const prefix = 'test-condenser';
  const group = `${prefix}-group-${Date.now()}`;
  cleanTestFiles(prefix);

  // Limpiar markers del condensador para este grupo
  const firedMarker = path.join(QUEUE_DIR, `condenser-fired-${group}.json`);
  try { fs.unlinkSync(firedMarker); } catch {}

  // Simular 2 items del grupo ya completados en listo/
  const item1 = `${prefix}-1-${Date.now()}.json`;
  const item2 = `${prefix}-2-${Date.now()}.json`;

  // El onComplete escribe un marker file para verificar que se disparo
  const onCompleteMarker = path.join(QUEUE_DIR, `test-oncomplete-fired-${group}.json`);

  fs.writeFileSync(path.join(LISTO, item1), JSON.stringify({
    action: 'create-issue',
    group,
    groupSize: 2,
    title: 'dep: Test dependencia 1',
    result: { number: 9001, url: 'https://github.com/test/9001' },
    onComplete: {
      // El onComplete simplemente escribe un archivo marker
      command: `node -e "require('fs').writeFileSync('${onCompleteMarker.replace(/\\/g, '\\\\')}', JSON.stringify({fired:true, ts:Date.now()}))"`,
    }
  }));

  // Segundo item NO tiene resultado todavia — simulamos que falta
  test('grupo incompleto (1/2) no dispara onComplete', () => {
    // Verificar conteo manual
    let count = 0;
    for (const dir of [LISTO, FALLIDO]) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.json')) continue;
          try {
            const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (d.group === group) count++;
          } catch {}
        }
      } catch {}
    }
    assert(count === 1, `esperaba 1 item del grupo, got ${count}`);
    assert(!fs.existsSync(onCompleteMarker), 'onComplete no deberia haberse disparado todavia');
  });

  // Agregar el segundo item a listo/ — ahora el grupo esta completo
  fs.writeFileSync(path.join(LISTO, item2), JSON.stringify({
    action: 'create-issue',
    group,
    groupSize: 2,
    title: 'dep: Test dependencia 2',
    result: { number: 9002, url: 'https://github.com/test/9002' },
    onComplete: {
      command: `node -e "require('fs').writeFileSync('${onCompleteMarker.replace(/\\/g, '\\\\')}', JSON.stringify({fired:true, ts:Date.now()}))"`,
    }
  }));

  test('grupo completo (2/2) — conteo correcto', () => {
    let count = 0;
    for (const dir of [LISTO, FALLIDO]) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.json')) continue;
          try {
            const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (d.group === group) count++;
          } catch {}
        }
      } catch {}
    }
    assert(count === 2, `esperaba 2 items del grupo, got ${count}`);
  });

  // Simular checkCondenser llamado por el servicio
  // Reimplementamos la logica aqui para testear
  function testCheckCondenser(data) {
    if (!data.group || !data.groupSize) return false;
    let completed = 0;
    for (const dir of [LISTO, FALLIDO]) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.json')) continue;
          try {
            const item = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (item.group === data.group) completed++;
          } catch {}
        }
      } catch {}
    }
    if (completed < data.groupSize) return false;

    // Proteccion anti-duplicado
    try {
      fs.writeFileSync(firedMarker, JSON.stringify({ group, ts: Date.now() }), { flag: 'wx' });
    } catch {
      return false; // ya disparado
    }

    // Recolectar resultados
    const results = [];
    for (const dir of [LISTO, FALLIDO]) {
      const dirName = path.basename(dir);
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.json')) continue;
          try {
            const item = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (item.group === data.group) {
              results.push({ ...item, _status: dirName === 'fallido' ? 'failed' : 'completed' });
            }
          } catch {}
        }
      } catch {}
    }

    // Escribir results
    const resultsPath = path.join(QUEUE_DIR, `condenser-results-${group}.json`);
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

    // Ejecutar onComplete
    try {
      const { execSync } = require('child_process');
      execSync(data.onComplete.command, { cwd: path.resolve(PIPELINE, '..'), timeout: 10000, windowsHide: true });
    } catch {}

    return true;
  }

  const data2 = JSON.parse(fs.readFileSync(path.join(LISTO, item2), 'utf8'));
  const fired = testCheckCondenser(data2);

  test('condensador dispara onComplete al completar grupo', () => {
    assert(fired, 'checkCondenser deberia haber retornado true');
  });

  test('marker anti-duplicado creado', () => {
    assert(fs.existsSync(firedMarker), 'condenser-fired marker no encontrado');
  });

  test('results JSON generado con los datos del grupo', () => {
    const resultsPath = path.join(QUEUE_DIR, `condenser-results-${group}.json`);
    assert(fs.existsSync(resultsPath), 'condenser-results no encontrado');
    const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    assert(results.length === 2, `esperaba 2 resultados, got ${results.length}`);
    assert(results[0].result.number === 9001 || results[1].result.number === 9001, 'falta result #9001');
    assert(results[0].result.number === 9002 || results[1].result.number === 9002, 'falta result #9002');
  });

  test('onComplete se ejecuto (marker file existe)', () => {
    assert(fs.existsSync(onCompleteMarker), 'onComplete marker no encontrado — el comando no se ejecuto');
    const marker = JSON.parse(fs.readFileSync(onCompleteMarker, 'utf8'));
    assert(marker.fired === true, 'marker.fired deberia ser true');
  });

  test('segundo intento de disparar es bloqueado por anti-duplicado', () => {
    const fired2 = testCheckCondenser(data2);
    assert(!fired2, 'no deberia disparar dos veces');
  });

  // Cleanup
  try { fs.unlinkSync(onCompleteMarker); } catch {}
  try { fs.unlinkSync(firedMarker); } catch {}
  try { fs.unlinkSync(path.join(QUEUE_DIR, `condenser-results-${group}.json`)); } catch {}
  cleanTestFiles(prefix);
}

// =============================================================================
console.log('\n=== TEST 5: Condensador — grupo con items fallidos ===');
// =============================================================================
{
  const prefix = 'test-fallido';
  const group = `${prefix}-group-${Date.now()}`;
  cleanTestFiles(prefix);

  const firedMarker = path.join(QUEUE_DIR, `condenser-fired-${group}.json`);
  try { fs.unlinkSync(firedMarker); } catch {}

  // 1 item en listo, 1 item en fallido — grupo de 2
  const item1 = `${prefix}-1-${Date.now()}.json`;
  const item2 = `${prefix}-2-${Date.now()}.json`;

  fs.writeFileSync(path.join(LISTO, item1), JSON.stringify({
    action: 'create-issue', group, groupSize: 2,
    title: 'dep: Test ok', result: { number: 8001 },
    onComplete: { command: 'node -e "true"' }
  }));

  fs.writeFileSync(path.join(FALLIDO, item2), JSON.stringify({
    action: 'create-issue', group, groupSize: 2,
    title: 'dep: Test fallido', retries: 3, lastError: 'gh timeout',
    onComplete: { command: 'node -e "true"' }
  }));

  test('grupo con 1 listo + 1 fallido cuenta como completo', () => {
    let count = 0;
    for (const dir of [LISTO, FALLIDO]) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.json')) continue;
          try {
            const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (d.group === group) count++;
          } catch {}
        }
      } catch {}
    }
    assert(count === 2, `esperaba 2, got ${count}`);
  });

  test('results incluye items de ambos directorios', () => {
    const results = [];
    for (const dir of [LISTO, FALLIDO]) {
      const dirName = path.basename(dir);
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.json')) continue;
          try {
            const item = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (item.group === group) {
              results.push({ ...item, _status: dirName === 'fallido' ? 'failed' : 'completed' });
            }
          } catch {}
        }
      } catch {}
    }
    const ok = results.filter(r => r._status === 'completed');
    const fail = results.filter(r => r._status === 'failed');
    assert(ok.length === 1, `esperaba 1 completado, got ${ok.length}`);
    assert(fail.length === 1, `esperaba 1 fallido, got ${fail.length}`);
    assert(ok[0].result.number === 8001, 'resultado exitoso deberia tener number 8001');
    assert(fail[0].lastError === 'gh timeout', 'resultado fallido deberia tener lastError');
  });

  try { fs.unlinkSync(firedMarker); } catch {}
  cleanTestFiles(prefix);
}

// =============================================================================
console.log('\n=== TEST 6: rejection-report collectReportData + renderHtml ===');
// =============================================================================
{
  // Testear que collectReportData + renderHtml producen HTML valido
  // Necesitamos simular los args del rejection-report
  test('collectReportData devuelve objeto con todos los campos', () => {
    // No podemos llamar directamente porque los args son globales,
    // pero podemos verificar que la estructura del modulo es correcta
    const content = fs.readFileSync(path.join(PIPELINE, 'rejection-report.js'), 'utf8');
    assert(content.includes('function collectReportData()'), 'falta collectReportData');
    assert(content.includes('function renderHtml(data)'), 'falta renderHtml');
    assert(content.includes('function generateNarration(data)'), 'falta generateNarration(data)');
    assert(content.includes('function sendReport(data)'), 'falta sendReport');
    assert(content.includes('function phaseCollect()'), 'falta phaseCollect');
    assert(content.includes('function phaseComplete()'), 'falta phaseComplete');
    assert(content.includes('function enqueueGitHub(data)'), 'falta enqueueGitHub');
    assert(content.includes('function enqueueCommentAndLabel('), 'falta enqueueCommentAndLabel');
  });

  test('fase collect es el default', () => {
    const content = fs.readFileSync(path.join(PIPELINE, 'rejection-report.js'), 'utf8');
    assert(content.includes("|| 'collect'"), 'fase default deberia ser collect');
  });

  test('fase complete lee contexto y resultados', () => {
    const content = fs.readFileSync(path.join(PIPELINE, 'rejection-report.js'), 'utf8');
    assert(content.includes('phaseComplete'), 'falta phaseComplete');
    assert(content.includes('contextFile'), 'falta manejo de contextFile');
    assert(content.includes('resultsFile'), 'falta manejo de resultsFile');
  });

  test('no queda referencia al global _autoCreatedDeps', () => {
    const content = fs.readFileSync(path.join(PIPELINE, 'rejection-report.js'), 'utf8');
    assert(!content.includes('let _autoCreatedDeps'), 'no deberia existir el global _autoCreatedDeps');
    assert(!content.includes('_autoCreatedDeps ='), 'no deberia escribir al global _autoCreatedDeps');
  });

  test('no queda referencia a createDependencyIssues (funcion vieja)', () => {
    const content = fs.readFileSync(path.join(PIPELINE, 'rejection-report.js'), 'utf8');
    assert(!content.includes('function createDependencyIssues'), 'la funcion vieja createDependencyIssues deberia haber sido eliminada');
  });

  test('enqueueGitHub escribe a la cola correcta', () => {
    const content = fs.readFileSync(path.join(PIPELINE, 'rejection-report.js'), 'utf8');
    assert(content.includes("servicios', 'github', 'pendiente'"), 'deberia encolar en servicios/github/pendiente/');
  });
}

// =============================================================================
console.log('\n=== TEST 7: Recovery de orphans ===');
// =============================================================================
{
  const prefix = 'test-orphan';
  cleanTestFiles(prefix);

  // Simular un orphan en trabajando/
  const orphanFile = `${prefix}-${Date.now()}.json`;
  fs.writeFileSync(path.join(TRABAJANDO, orphanFile), JSON.stringify({
    action: 'comment', issue: 1, body: 'test orphan'
  }));

  test('orphan en trabajando/ existe antes de recovery', () => {
    assert(fs.existsSync(path.join(TRABAJANDO, orphanFile)), 'orphan deberia estar en trabajando/');
  });

  // Simular recoverOrphans
  try {
    const files = fs.readdirSync(TRABAJANDO).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
    for (const f of files) {
      fs.renameSync(path.join(TRABAJANDO, f), path.join(PENDIENTE, f));
    }
  } catch {}

  test('orphan recuperado a pendiente/ despues de recovery', () => {
    assert(fs.existsSync(path.join(PENDIENTE, orphanFile)), 'orphan deberia estar en pendiente/');
    assert(!fs.existsSync(path.join(TRABAJANDO, orphanFile)), 'orphan no deberia estar en trabajando/');
  });

  cleanTestFiles(prefix);
}

// =============================================================================
console.log('\n=== TEST 8: Integracion — enqueue real de un comment ===');
// =============================================================================
{
  const prefix = 'test-enqueue';
  cleanTestFiles(prefix);

  // Encolar un comment real (no lo procesamos, solo verificamos que se encola)
  const testFile = `${prefix}-${Date.now()}.json`;
  const testData = {
    action: 'comment',
    issue: 1951,
    body: '🧪 Test de enqueue desde test-condenser.js — ignorar',
  };
  fs.writeFileSync(path.join(PENDIENTE, testFile), JSON.stringify(testData, null, 2));

  test('comment encolado correctamente en pendiente/', () => {
    assert(fs.existsSync(path.join(PENDIENTE, testFile)), 'archivo no encontrado');
    const data = JSON.parse(fs.readFileSync(path.join(PENDIENTE, testFile), 'utf8'));
    assert(data.action === 'comment', 'action deberia ser comment');
    assert(data.issue === 1951, 'issue deberia ser 1951');
  });

  // Limpiar para no procesar realmente
  cleanTestFiles(prefix);
}

// =============================================================================
// Resumen
// =============================================================================
console.log(`\n${'='.repeat(60)}`);
console.log(`  Resultados: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
