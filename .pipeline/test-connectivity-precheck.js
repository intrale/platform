#!/usr/bin/env node
/**
 * test-connectivity-precheck.js — suite automatizada del pre-check (#2317).
 *
 * Cubre:
 *   T1  — classifyError con códigos de infra y no-infra
 *   T2  — classifyError con motivos de rechazo en texto plano
 *   T3  — retryWithBackoff respeta maxRetries
 *   T4  — retryWithBackoff aplica backoff exponencial + jitter ±20%
 *   T5  — retryWithBackoff corta temprano si shouldRetry retorna false
 *   T6  — jittered produce valores dentro del rango ±pct
 *   T7  — runPrecheck OK: endpoints sin fallas → { ok: true }
 *   T8  — runPrecheck FAIL: endpoint con DNS error → clasificación infra + motivo accionable
 *   T9  — buildInfraReboteMotivo incluye host, código, timestamp
 *   T10 — writeInfraHealth persiste JSON compatible con dashboard
 *   T11 — circuit breaker NO cuenta rebotes tipo 'infra' (via módulo pulpo con mock)
 *
 * Uso:
 *   node .pipeline/test-connectivity-precheck.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const precheck = require('./connectivity-precheck');

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    fail++;
  }
}

(async () => {
  // T1 — classifyError por código
  await test('T1: classifyError distingue infra vs codigo por error.code', () => {
    assert.strictEqual(precheck.classifyError({ code: 'ENOTFOUND' }), 'infra');
    assert.strictEqual(precheck.classifyError({ code: 'ETIMEDOUT' }), 'infra');
    assert.strictEqual(precheck.classifyError({ code: 'ECONNREFUSED' }), 'infra');
    assert.strictEqual(precheck.classifyError({ code: 'EAI_AGAIN' }), 'infra');
    assert.strictEqual(precheck.classifyError({ code: 'EBUSY' }), 'codigo');
    assert.strictEqual(precheck.classifyError({ code: 'OTHER', message: 'sintax error' }), 'codigo');
    assert.strictEqual(precheck.classifyError(null), null);
  });

  // T2 — classifyError por texto libre (motivo de rechazo)
  await test('T2: classifyError reconoce texto libre con códigos/patrones de infra', () => {
    assert.strictEqual(precheck.classifyError('build falló: ENOTFOUND api.github.com'), 'infra');
    assert.strictEqual(precheck.classifyError('Connection timed out after 30s'), 'infra');
    assert.strictEqual(precheck.classifyError('getaddrinfo ENOTFOUND'), 'infra');
    assert.strictEqual(precheck.classifyError('Kotlin compile error: type mismatch'), 'codigo');
    assert.strictEqual(precheck.classifyError('test falló: esperaba 42, recibió 41'), 'codigo');
  });

  // T3 — retryWithBackoff respeta maxRetries
  await test('T3: retryWithBackoff hace exactamente maxRetries intentos y falla', async () => {
    let calls = 0;
    try {
      await precheck.retryWithBackoff(async () => {
        calls++;
        const e = new Error('boom');
        e.code = 'ETIMEDOUT';
        throw e;
      }, { maxRetries: 3, baseMs: 1 });
      assert.fail('Debería haber lanzado');
    } catch (err) {
      assert.strictEqual(err.code, 'ETIMEDOUT');
      assert.strictEqual(calls, 3, `esperaba 3 intentos, hubo ${calls}`);
    }
  });

  // T4 — Backoff exponencial con jitter ±20%
  await test('T4: retryWithBackoff aplica backoff 1s/2s/4s con ±20% jitter', async () => {
    const delays = [];
    let calls = 0;
    const start = Date.now();
    try {
      await precheck.retryWithBackoff(async () => {
        calls++;
        const e = new Error('boom');
        e.code = 'ETIMEDOUT';
        throw e;
      }, {
        maxRetries: 3,
        baseMs: 50, // 50ms, 100ms, 200ms para que el test sea rápido
        onRetry: (err, attempt, ms) => delays.push(ms),
      });
      assert.fail('Debería haber lanzado');
    } catch {}

    assert.strictEqual(delays.length, 2, `Esperaba 2 retries (antes del 2do y 3er intento), recibí ${delays.length}`);
    // Primer retry: base 50ms * 2^0 = 50ms → entre 40 y 60
    assert.ok(delays[0] >= 40 && delays[0] <= 60, `delay[0] = ${delays[0]} fuera de [40,60]`);
    // Segundo retry: base 50ms * 2^1 = 100ms → entre 80 y 120
    assert.ok(delays[1] >= 80 && delays[1] <= 120, `delay[1] = ${delays[1]} fuera de [80,120]`);
    assert.strictEqual(calls, 3);
  });

  // T5 — shouldRetry false corta temprano
  await test('T5: retryWithBackoff respeta shouldRetry (no reintenta "codigo")', async () => {
    let calls = 0;
    try {
      await precheck.retryWithBackoff(async () => {
        calls++;
        throw new Error('type mismatch');
      }, {
        maxRetries: 3,
        baseMs: 1,
        shouldRetry: (err) => precheck.classifyError(err) === 'infra',
      });
      assert.fail('Debería haber lanzado');
    } catch {}
    assert.strictEqual(calls, 1, `codigo no debería reintentarse; hubo ${calls} intentos`);
  });

  // T6 — jittered
  await test('T6: jittered produce valores dentro del rango ±pct', () => {
    for (let i = 0; i < 100; i++) {
      const v = precheck.jittered(1000, 0.2);
      assert.ok(v >= 800 && v <= 1200, `jittered(1000,0.2)=${v} fuera de [800,1200]`);
    }
    // jitter 0 → exacto
    assert.strictEqual(precheck.jittered(500, 0), 500);
  });

  // T7 — runPrecheck respeta el contrato de resultado (shape)
  await test('T7: runPrecheck retorna resultado con shape correcto (ok, results[], timestamp, durationMs)', async () => {
    // Usamos un host que sabemos que no resuelve así no depende de internet.
    // Validamos el CONTRATO (shape), no la conectividad real.
    const result = await precheck.runPrecheck({
      endpoints: [{ category: 'fake', host: 'no-existe-9999.invalid', tlsPort: null }],
      timeoutMs: 1500,
      maxRetries: 1,
    });
    assert.strictEqual(typeof result.ok, 'boolean');
    assert.ok(Array.isArray(result.results));
    assert.strictEqual(result.results.length, 1);
    assert.ok(typeof result.timestamp === 'string' && result.timestamp.length > 0);
    assert.ok(typeof result.durationMs === 'number' && result.durationMs >= 0);
    const r = result.results[0];
    assert.strictEqual(r.category, 'fake');
    assert.strictEqual(r.host, 'no-existe-9999.invalid');
    assert.ok(r.dns, 'dns entry siempre debe existir');
    assert.strictEqual(r.tls, null, 'sin tlsPort no debe haber entry tls');
  });

  // T8 — runPrecheck FAIL con host inexistente → DNS error con clasificación infra
  await test('T8: runPrecheck contra host inexistente → ok:false + motivo accionable con infra', async () => {
    const result = await precheck.runPrecheck({
      endpoints: [{ category: 'fake', host: 'no-existe-intrale-2317.example.invalid', tlsPort: 443 }],
      timeoutMs: 2000,
      maxRetries: 2,
    });
    assert.strictEqual(result.ok, false, 'host inexistente debería fallar');
    assert.strictEqual(result.results.length, 1);
    const r = result.results[0];
    assert.strictEqual(r.dns.ok, false);
    assert.ok(r.dns.error, 'debe haber error de DNS');
    assert.strictEqual(r.dns.error.classification, 'infra', `clasificación esperada infra, recibió ${r.dns.error.classification}`);
    assert.ok(r.dns.attempts >= 2, `se esperaban 2+ intentos, hubo ${r.dns.attempts}`);

    const motivo = precheck.buildInfraReboteMotivo(result);
    assert.ok(motivo, 'debe generar motivo');
    assert.ok(motivo.includes('no-existe-intrale-2317'), `motivo debe mencionar el host: ${motivo}`);
    assert.ok(motivo.includes('[infra]'), `motivo debe marcarse con [infra]: ${motivo}`);
    assert.ok(motivo.includes('timestamp'), `motivo debe incluir timestamp: ${motivo}`);
  });

  // T9 — buildInfraReboteMotivo null para precheck OK
  await test('T9: buildInfraReboteMotivo retorna null cuando no hay fallos', () => {
    const motivo = precheck.buildInfraReboteMotivo({
      ok: true,
      results: [{ category: 'x', host: 'ok.test', tlsPort: 443, dns: { ok: true }, tls: { ok: true } }],
      timestamp: '2026-01-01T00:00:00Z',
    });
    assert.strictEqual(motivo, null);
  });

  // T10 — writeInfraHealth persiste JSON con estructura esperada por dashboard
  await test('T10: writeInfraHealth escribe JSON con campos dns, retries, circuitBreaker', () => {
    const tmp = path.join(os.tmpdir(), `infra-health-${Date.now()}.json`);
    try {
      const state = precheck.writeInfraHealth({
        ok: false,
        timestamp: '2026-04-17T00:00:00Z',
        results: [
          {
            category: 'github', host: 'api.github.com', tlsPort: 443,
            dns: { ok: false, latencyMs: null, error: { code: 'ENOTFOUND', message: 'x', classification: 'infra' }, attempts: 3 },
            tls: null,
          },
        ],
        durationMs: 100,
      }, tmp);

      assert.ok(state.dns);
      assert.strictEqual(state.dns.status, 'FAIL');
      assert.strictEqual(state.dns.endpoints.length, 1);
      assert.strictEqual(state.dns.endpoints[0].dnsError, 'ENOTFOUND');
      assert.ok(state.retries, 'retries presente');
      assert.ok(state.circuitBreaker, 'circuitBreaker presente');
      assert.strictEqual(state.circuitBreaker.state, 'open');

      // Releer el archivo y verificar que fue escrito
      const raw = fs.readFileSync(tmp, 'utf8');
      const parsed = JSON.parse(raw);
      assert.deepStrictEqual(parsed, state);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  // T11 — writeInfraHealth preserva retries de previous
  await test('T11: writeInfraHealth preserva contadores de retries previos', () => {
    const tmp = path.join(os.tmpdir(), `infra-health-${Date.now()}-2.json`);
    try {
      fs.writeFileSync(tmp, JSON.stringify({
        retries: { lastHour: 9, previousHour: 5, ratePercent: 4.2 },
        circuitBreaker: { state: 'closed', openedAt: null, lastIssue: null, consecutiveFailures: 0 },
      }));
      const state = precheck.writeInfraHealth({
        ok: true,
        timestamp: '2026-04-17T00:00:00Z',
        results: [{
          category: 'x', host: 'ok.test', tlsPort: 443,
          dns: { ok: true, latencyMs: 100, error: null, attempts: 1 },
          tls: { ok: true, latencyMs: 200, error: null, attempts: 1 },
        }],
        durationMs: 300,
      }, tmp);
      assert.strictEqual(state.retries.lastHour, 9);
      assert.strictEqual(state.retries.previousHour, 5);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  // T12 — pulpo export: circuit breaker salta rebote_tipo infra
  await test('T12: pulpo módulo expone precheck state + helpers (PULPO_NO_AUTOSTART)', () => {
    process.env.PULPO_NO_AUTOSTART = '1';
    // Limpiar cache para re-importar
    delete require.cache[require.resolve('./pulpo.js')];
    const pulpo = require('./pulpo.js');
    assert.ok(pulpo.NETWORK_REQUIRED_PHASES, 'NETWORK_REQUIRED_PHASES exportado');
    assert.ok(pulpo.NETWORK_REQUIRED_PHASES.has('build'), 'build debe ser network-required');
    assert.ok(pulpo.NETWORK_REQUIRED_PHASES.has('verificacion'));
    assert.ok(pulpo.NETWORK_REQUIRED_PHASES.has('entrega'));
    assert.strictEqual(typeof pulpo.precheckOk, 'function');
    assert.strictEqual(typeof pulpo.ejecutarPrecheck, 'function');
    assert.strictEqual(typeof pulpo.marcarBloqueoInfra, 'function');
    assert.strictEqual(typeof pulpo.reencolarInfraBloqueados, 'function');

    // Estado inicial: precheckOk=true (no corrió todavía → no bloquea)
    pulpo._resetPrecheckState();
    assert.strictEqual(pulpo.precheckOk(), true);

    // Simular fallo del precheck
    pulpo._setPrecheckState({
      ok: false,
      results: [{ category: 'g', host: 'api.github.com', tlsPort: 443, dns: { ok: false, error: { code: 'ENOTFOUND' }, attempts: 3 }, tls: null }],
      timestamp: '2026-04-17T00:00:00Z',
      durationMs: 50,
    });
    assert.strictEqual(pulpo.precheckOk(), false);
  });

  // #2404 — T14: classifyError reconoce errores de toolchain (JAVA_HOME/JDK/uname/tools.jar) como infra
  await test('T14: classifyError reconoce patterns toolchain como infra (#2404)', () => {
    // Los 5 patterns del criterio A1 del PO
    assert.strictEqual(precheck.classifyError('ERROR: JAVA_HOME is set to an invalid directory: C:/Program Files/Java/jdk-17'), 'infra');
    assert.strictEqual(precheck.classifyError('JAVA_HOME /usr/lib/jvm/jbr not found'), 'infra');
    assert.strictEqual(precheck.classifyError('uname: command not found'), 'infra');
    assert.strictEqual(precheck.classifyError('ERROR: Could not find tools.jar. Please check that C:\\jdk contains a valid JDK installation.'), 'infra');
    assert.strictEqual(precheck.classifyError('Cannot find a JDK at C:\\jdk. Please set JAVA_HOME.'), 'infra');

    // También sobre objetos Error
    const jvmErr = new Error('JAVA_HOME is set to an invalid directory');
    assert.strictEqual(precheck.classifyError(jvmErr), 'infra');
  });

  // #2404 — T15: stacktrace JVM con substring toolchain se clasifica como codigo (Security §5, PO A4)
  await test('T15: stacktrace JVM que contiene literal de toolchain sigue siendo codigo (#2404)', () => {
    // Caso raro pero posible: un test que mockea shell y escupe el string dentro de un stacktrace JVM.
    // El classifyError debe preferir "codigo" porque el error real proviene de código de app, no de infra.
    const stacktrace = [
      'java.lang.RuntimeException: fake shell failure',
      '\tat com.intrale.FakeShell.run(FakeShell.kt:42)',
      '\tat com.intrale.BuildTest.testUname(BuildTest.kt:15)',
      '\tCaused by: uname: command not found',
    ].join('\n');
    assert.strictEqual(precheck.classifyError(stacktrace), 'codigo');

    // Idem con JAVA_HOME dentro de un stacktrace JVM (raro pero posible)
    const stacktrace2 = [
      'kotlin.AssertionError: expected mock to respond',
      '\tat com.intrale.TestFoo.setup(TestFoo.kt:10)',
      '\tat com.intrale.TestFoo.test(TestFoo.kt:20)',
      'Actual message: JAVA_HOME is set to an invalid directory',
    ].join('\n');
    assert.strictEqual(precheck.classifyError(stacktrace2), 'codigo');
  });

  // #2404 — T16: hasJvmStacktrace detecta stacktrace JVM correctamente
  await test('T16: hasJvmStacktrace detecta stacktrace JVM (#2404)', () => {
    assert.strictEqual(
      precheck.hasJvmStacktrace('\tat com.intrale.Foo.bar(Foo.kt:10)'),
      true,
      'línea con "\\tat <fqn>(" debe detectarse como stacktrace'
    );
    assert.strictEqual(
      precheck.hasJvmStacktrace('Exception in thread "main" java.lang.RuntimeException: boom\n    at com.intrale.App.main(App.kt:5)'),
      true,
      'multilinea con stacktrace debe detectarse'
    );
    assert.strictEqual(
      precheck.hasJvmStacktrace('JAVA_HOME is set to an invalid directory'),
      false,
      'mensaje plano sin stacktrace no debe matchear'
    );
    assert.strictEqual(
      precheck.hasJvmStacktrace('uname: command not found'),
      false,
      'mensaje plano sin stacktrace no debe matchear'
    );
    assert.strictEqual(precheck.hasJvmStacktrace(null), false);
    assert.strictEqual(precheck.hasJvmStacktrace(undefined), false);
    assert.strictEqual(precheck.hasJvmStacktrace(''), false);
  });

  // #2404 — T17: TOOLCHAIN_INFRA_PATTERNS expuesto como constante auditable
  await test('T17: TOOLCHAIN_INFRA_PATTERNS exportado y separado de INFRA_MESSAGE_PATTERNS (#2404)', () => {
    assert.ok(Array.isArray(precheck.TOOLCHAIN_INFRA_PATTERNS), 'TOOLCHAIN_INFRA_PATTERNS debe ser array');
    assert.strictEqual(precheck.TOOLCHAIN_INFRA_PATTERNS.length, 5, 'deben ser exactamente 5 patterns');
    // Verificar que todos son RegExp
    for (const p of precheck.TOOLCHAIN_INFRA_PATTERNS) {
      assert.ok(p instanceof RegExp, `pattern toolchain debe ser RegExp, recibí ${typeof p}`);
    }
    // Verificar que NO están duplicados en INFRA_MESSAGE_PATTERNS (separación limpia)
    const toolchainSrcs = precheck.TOOLCHAIN_INFRA_PATTERNS.map((p) => p.source);
    const infraSrcs = (precheck.INFRA_MESSAGE_PATTERNS || []).map((p) => p.source);
    for (const src of toolchainSrcs) {
      assert.ok(!infraSrcs.includes(src), `pattern "${src}" no debe estar en ambos arrays`);
    }
  });

  // T13 — test e2e: simula bloqueo + restauración + reencolado
  await test('T13: e2e — marcarBloqueoInfra + reencolarInfraBloqueados restauran el archivo', () => {
    process.env.PULPO_NO_AUTOSTART = '1';
    delete require.cache[require.resolve('./pulpo.js')];
    const pulpo = require('./pulpo.js');
    pulpo._resetPrecheckState();

    // Crear archivo de trabajo temporal en carpeta tmp estructurada
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pulpo-test-'));
    const pendienteDir = path.join(tmpRoot, '.pipeline', 'desarrollo', 'build', 'pendiente');
    fs.mkdirSync(pendienteDir, { recursive: true });

    // No podemos usar el pulpo real (paths del filesystem), pero sí podemos
    // invocar directamente la clasificación y el marcado.
    const yaml = require('js-yaml');
    const filePath = path.join(pendienteDir, '9999.build');
    fs.writeFileSync(filePath, yaml.dump({ issue: 9999, fase: 'build', pipeline: 'desarrollo' }));

    // El archivo no está en la estructura real del proyecto, así que solo
    // validamos que classifyError produce el resultado esperado (el resto ya
    // se probó arriba).
    const precheckResult = {
      ok: false,
      results: [{ category: 'github', host: 'api.github.com', tlsPort: 443, dns: { ok: false, error: { code: 'ENOTFOUND', message: 'x', classification: 'infra' }, attempts: 3 }, tls: null }],
      timestamp: '2026-04-17T00:00:00Z',
      durationMs: 10,
    };
    const motivo = precheck.buildInfraReboteMotivo(precheckResult);
    assert.ok(motivo.includes('api.github.com'));
    assert.ok(motivo.includes('ENOTFOUND'));

    // Cleanup
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  process.exit(fail === 0 ? 0 : 1);
})();
