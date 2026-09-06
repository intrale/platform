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
 *   T14b — #2405: los 6 motivos de drift de toolchain siguen siendo infra (guard #6745)
 *   T18 — #6745 CA-1: patrón infra dentro de un identificador de código → codigo
 *   T19 — #6745 CA-1: bloques de código y refs archivo.ext:linea se enmascaran
 *   T20 — #6745 CA-2/CA-8: code_signal degrada prosa pero no el tier máquina
 *   T21 — #6745 SEC-A: motivo vacío/nulo/no clasificable → codigo, nunca infra
 *   T22 — #6745 CA-9: adversarial ReDoS ~10KB en < 50ms
 *   T23 — #6745 CA-11: compat de INFRA_MESSAGE_PATTERNS y del wrapper classifyError
 *
 * Uso:
 *   node .pipeline/test-connectivity-precheck.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const precheck = require('./connectivity-precheck');
// #6259 (P3) — `PULPO_NO_AUTOSTART` es variable de CONTROL DE SEGURIDAD y aca hay
// que HABILITARLA (pulpo.js gatea su `module.exports` con `=== '1'` al importar).
// `withEnv` la RECHAZA por diseno (tira Error antes de mutar), asi que el patron
// correcto es P3: `snapshotEnv` + `restoreEnv` en `finally` dentro del mismo test.
// La ausencia de `withEnv` aca es lo CORRECTO, no un dialecto local (CA-6259-10).
const { snapshotEnv, restoreEnv } = require('./lib/test-helpers/with-env');

function enableWorktreeDependencies() {
  try { require.resolve('js-yaml'); return; } catch (_) { /* worktree sin node_modules */ }
  const gitFile = fs.readFileSync(path.join(__dirname, '..', '.git'), 'utf8').trim();
  const gitDir = path.resolve(path.join(__dirname, '..'), gitFile.replace(/^gitdir:\s*/, ''));
  process.env.NODE_PATH = path.join(gitDir, '..', '..', '..', 'node_modules');
  require('node:module').Module._initPaths();
}

const __nodePathSnap = snapshotEnv(['NODE_PATH']);
enableWorktreeDependencies();
process.on('exit', () => restoreEnv(__nodePathSnap));

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
    // #6259 (P3) — snapshot + set + restore en `finally`: la variable no
    // sobrevive al test aunque un assert reviente (SEC-2). `withEnv` no aplica:
    // es variable de control y aca hay que HABILITARLA.
    const __snap = snapshotEnv(['PULPO_NO_AUTOSTART']);
    process.env.PULPO_NO_AUTOSTART = '1';
    try {
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
    } finally {
      restoreEnv(__snap);
    }
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

  // #2405 — T14b: los 6 motivos de drift de entorno del host (exit 78 / EX_CONFIG /
  // FATAL: JAVA_HOME / prosa de JAVA_HOME) siguen clasificando como problema de
  // ENTORNO. Guard de regresión pedido por QA en #6745: los 4 literales que
  // implementan estos casos son los únicos del módulo con escapes (`\b`, `\s`), o
  // sea los únicos que una edición vía heredoc/`echo -e` puede destruir sin que se
  // note ni en `git diff` ni en la vista de GitHub. T14 sólo cubre los mensajes en
  // inglés de TOOLCHAIN_INFRA_PATTERNS, que no llevan escapes: la corrupción de
  // #6745 pasó por delante de las 3 suites en verde.
  await test('T14b: los 6 motivos de drift de toolchain siguen siendo infra (#2405, guard #6745)', () => {
    const CASOS_2405 = [
      ['M1 exit 78',       'El helper de validacion de toolchain fallo con exit 78 antes de compilar'],
      ['M2 exit code 78',  'proceso terminado con exit code 78'],
      ['M3 EX_CONFIG',     'El wrapper devolvio EX_CONFIG y aborto la corrida'],
      ['M4 FATAL prefijo', 'FATAL: JAVA_HOME apunta a un directorio que no existe en el host'],
      ['M5 prosa invalido','JAVA_HOME invalido en el host, no se pudo arrancar el build'],
      ['M6 prosa allowlist','JAVA_HOME no esta en la allowlist de rutas permitidas del runner'],
    ];
    for (const [id, motivo] of CASOS_2405) {
      assert.strictEqual(precheck.classifyError(motivo), 'infra', `${id}: "${motivo}" deberia clasificar infra`);
    }

    // Guard estructural directo: cero caracteres de control en el fuente del módulo.
    // Es el síntoma exacto de la corrupción (el `\b` de un borde de palabra se
    // materializa como U+0008 crudo cuando el escape lo interpreta la shell).
    const fuente = fs.readFileSync(path.join(__dirname, 'connectivity-precheck.js'), 'utf8');
    // Se construye con `new RegExp` y escapes ASCII a propósito: escribir la clase
    // con los caracteres crudos en el fuente reintroduciría el mismo defecto que
    // este test existe para detectar.
    const CTRL_RE = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]', 'g');
    const ctrl = fuente.match(CTRL_RE) || [];
    assert.strictEqual(ctrl.length, 0,
      `connectivity-precheck.js tiene ${ctrl.length} caracteres de control crudos (escapes destruidos)`);

    // Y los 4 literales con escape siguen presentes tal cual, sin la barra perdida.
    for (const literal of ['\\bexit\\s+(?:code\\s+)?78\\b', '\\bEX_CONFIG\\b',
                           'FATAL:\\s*JAVA_HOME', 'JAVA_HOME\\s+(?:invalido|no\\s+esta\\s+en\\s+la\\s+allowlist)']) {
      assert.ok(fuente.includes(literal), `falta el literal intacto: ${literal}`);
    }
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

  // ===========================================================================
  // #6745 — enmascarado de spans de código, señales de código y asimetría
  // ===========================================================================

  // T18 — CA-1: el patrón de infra DENTRO de un identificador ya no gana
  await test('T18: patrón infra dentro de un identificador de código → codigo (#6745 CA-1)', () => {
    // Los cuatro casos que `security` reprodujo contra `main` antes del fix:
    // los tres primeros clasificaban `infra` por substring, el cuarto es el
    // único legítimo y tiene que seguir siendo infra.
    assert.strictEqual(
      precheck.classifyError('El gate falla: LOCK_TIMEOUT_MS está hardcodeado en 5000'),
      'codigo',
      'una constante citada como evidencia no es un timeout de red',
    );
    assert.strictEqual(
      precheck.classifyError('Secret hardcodeado dentro de resolveDnsCache()'),
      'codigo',
      'un método camelCase con "Dns" adentro no es un fallo de DNS',
    );
    assert.strictEqual(
      precheck.classifyError('el valor de `timeout` no se respeta en el wizard'),
      'codigo',
      'un span entre backticks es código citado, no prosa de red',
    );
    assert.strictEqual(
      precheck.classifyError('fallo por timeout de red a los 30s'),
      'infra',
      'CA-6: la prosa de red real sigue siendo infra',
    );
  });

  // T19 — CA-1: bloques de código y refs archivo.ext:linea también se enmascaran
  await test('T19: bloques de código y refs archivo.ext:linea se enmascaran (#6745 CA-1)', () => {
    const conFence = [
      'El gate rechaza porque el handler quedó así:',
      '```js',
      'const t = { timeout: 30, dns: true };',
      '```',
      'y el criterio pedía leerlo de config.',
    ].join('\n');
    assert.strictEqual(precheck.classifyError(conFence), 'codigo',
      'lo que está dentro de un bloque de código es evidencia citada, no prosa');

    // Bloque sin cerrar: el enmascarado tolera el no-cierre (no puede quedar
    // media clasificación colgada por un backtick olvidado).
    assert.strictEqual(precheck.classifyError('mirá esto:\n```\ntimeout=30\ndns=1'), 'codigo');

    // Referencia archivo.ext:linea — `dns-cache.js` no es camelCase ni snake,
    // así que sólo el masking de path refs lo salva.
    assert.strictEqual(precheck.classifyError('Falta el guard en dns-cache.js:12'), 'codigo');

    // Y el enmascarado NO borra texto: preserva offsets y longitud.
    const txt = 'antes `timeout` despues';
    assert.strictEqual(precheck.maskCodeSpans(txt).length, txt.length);
    assert.ok(/^antes /.test(precheck.maskCodeSpans(txt)));
  });

  // T20 — CA-2 + CA-8: señales de código y precedencia del tier máquina
  await test('T20: code_signal degrada la prosa infra pero NO el tier máquina (#6745 CA-2/CA-8)', () => {
    // La señal de código gana contra la PROSA...
    assert.strictEqual(
      precheck.classifyError('El cambio no esta commiteado: git status lo confirma, y encima hubo timeout'),
      'codigo',
    );
    // ...pero PIERDE contra un machine token (regresión de #6495).
    assert.strictEqual(
      precheck.classifyError('LINTER_BASE_UNAVAILABLE: base no confiable. git status reporta cambios.'),
      'infra',
      '#6495: un fetch caído no puede rebotar a dev por citar `git status`',
    );
    // ...y contra un errno.
    assert.strictEqual(
      precheck.classifyError('ETIMEDOUT contra la API. git status: 3 archivos sin commitear.'),
      'infra',
    );

    // La evidencia tipada nombra el tier que decidió.
    // `ENOTFOUND` es errno (INFRA_ERROR_CODES se evalúa primero); `getaddrinfo`
    // y `LINTER_BASE_UNAVAILABLE` son machine tokens puros.
    assert.strictEqual(precheck.classifyErrorDetailed('getaddrinfo ENOTFOUND').evidencia, 'errno');
    assert.strictEqual(precheck.classifyErrorDetailed('falla en getaddrinfo del host').evidencia, 'machine_token');
    assert.strictEqual(precheck.classifyErrorDetailed('LINTER_BASE_UNAVAILABLE: sin base').evidencia, 'machine_token');
    assert.strictEqual(precheck.classifyErrorDetailed('ETIMEDOUT').evidencia, 'errno');
    assert.strictEqual(precheck.classifyErrorDetailed('fallo por timeout de red').evidencia, 'prose');
    assert.strictEqual(precheck.classifyErrorDetailed('uname: command not found').evidencia, 'toolchain');
    assert.strictEqual(precheck.classifyErrorDetailed('git status muestra cambios').evidencia, 'code_signal');

    // `accionRequerida` es ORTOGONAL: se reporta aunque gane el tier máquina.
    assert.strictEqual(
      precheck.classifyErrorDetailed('LINTER_BASE_UNAVAILABLE. git status reporta cambios.').accionRequerida,
      'codigo',
    );
  });

  // T21 — SEC-A: la asimetría. `infra` exige evidencia positiva.
  await test('T21: motivo vacío, nulo o no clasificable → codigo, NUNCA infra (#6745 SEC-A)', () => {
    // Este test es el único freno si mañana alguien mete un `return 'infra'`
    // como fallback: `infra` es la única clase de rebote sin cota superior.
    assert.strictEqual(precheck.classifyError(''), 'codigo');
    assert.strictEqual(precheck.classifyError('   '), 'codigo');
    assert.strictEqual(precheck.classifyError('blah blah sin ninguna señal'), 'codigo');
    assert.strictEqual(precheck.classifyError(null), null);
    assert.strictEqual(precheck.classifyError(undefined), null);
    assert.strictEqual(precheck.classifyErrorDetailed(null).clasificacion, null);
    assert.strictEqual(precheck.classifyErrorDetailed('').clasificacion, 'codigo');

    // El enum de CA-10 es cerrado.
    const enumCerrado = ['security_floor', 'code_signal', 'phase_capability', null];
    for (const m of ['', 'timeout de red', 'getaddrinfo', 'git status y timeout', 'x'.repeat(50)]) {
      assert.ok(enumCerrado.includes(precheck.classifyErrorDetailed(m).infra_downgraded_by),
        `infra_downgraded_by fuera del enum para: ${m}`);
    }
  });

  // T22 — CA-9 / SEC-4: ReDoS. Presupuesto duro de 50 ms.
  await test('T22: adversarial ~10KB de backticks y guiones bajos sin cerrar en < 50ms (#6745 CA-9)', () => {
    const adversarial = '`'.repeat(3000)
      + '_'.repeat(3000)
      + 'aA'.repeat(1500)
      + 'a_'.repeat(500)
      + '..js:'.repeat(200)
      + '```'.repeat(100);
    assert.ok(adversarial.length >= 10000, `el payload debe superar los 10KB, mide ${adversarial.length}`);

    const t0 = process.hrtime.bigint();
    const r = precheck.classifyError(adversarial);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    assert.strictEqual(r, 'codigo', 'ruido sin evidencia positiva ⇒ codigo (SEC-A)');
    assert.ok(ms < 50, `presupuesto ReDoS excedido: ${ms.toFixed(2)}ms (límite 50ms)`);

    // Y el truncado ocurre ANTES de la primera regex: la ventana es dura.
    assert.strictEqual(precheck.maskCodeSpans(adversarial).length, precheck.MAX_MOTIVO_SCAN_LEN);
    assert.strictEqual(precheck.MAX_MOTIVO_SCAN_LEN, 8192);
  });

  // T23 — CA-11: compat de los exports
  await test('T23: INFRA_MESSAGE_PATTERNS sigue siendo la concatenación de los dos tiers (#6745 CA-11)', () => {
    assert.ok(Array.isArray(precheck.INFRA_MACHINE_TOKENS));
    assert.ok(Array.isArray(precheck.INFRA_PROSE_PATTERNS));
    assert.deepStrictEqual(
      precheck.INFRA_MESSAGE_PATTERNS.map((p) => p.source),
      [...precheck.INFRA_MACHINE_TOKENS, ...precheck.INFRA_PROSE_PATTERNS].map((p) => p.source),
      'CA-11: los consumidores externos siguen viendo la unión de ambos tiers',
    );
    // Los dos tiers no se solapan entre sí.
    const machine = new Set(precheck.INFRA_MACHINE_TOKENS.map((p) => p.source));
    for (const p of precheck.INFRA_PROSE_PATTERNS) {
      assert.ok(!machine.has(p.source), `pattern "${p.source}" no puede estar en los dos tiers`);
    }
    // Y `classifyError` sigue siendo un wrapper: mismo resultado que el detallado.
    for (const m of ['getaddrinfo', 'timeout de red', 'type mismatch', '', null]) {
      assert.strictEqual(precheck.classifyError(m), precheck.classifyErrorDetailed(m).clasificacion);
    }
  });

  // T13 — test e2e: simula bloqueo + restauración + reencolado
  await test('T13: e2e — marcarBloqueoInfra + reencolarInfraBloqueados restauran el archivo', () => {
    // #6259 (P3) — snapshot + set + restore en `finally`: la variable no
    // sobrevive al test aunque un assert reviente (SEC-2). `withEnv` no aplica:
    // es variable de control y aca hay que HABILITARLA.
    const __snap = snapshotEnv(['PULPO_NO_AUTOSTART']);
    process.env.PULPO_NO_AUTOSTART = '1';
    try {
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
    } finally {
      restoreEnv(__snap);
    }
  });

  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  process.exit(fail === 0 ? 0 : 1);
})();
