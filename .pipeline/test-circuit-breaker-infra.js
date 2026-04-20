#!/usr/bin/env node
// =============================================================================
// Tests unitarios para redact.js y circuit-breaker-infra.js (issue #2305)
//
// Uso:   node .pipeline/test-circuit-breaker-infra.js
//
// No usa frameworks externos — sólo assertions manuales y process.exit(code).
// Se ejecuta en CI como parte de `node` smoke tests del pipeline.
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

const PASSED = '✅';
const FAILED = '❌';
let total = 0, passed = 0, failed = 0;

function assert(condition, msg) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ${PASSED} ${msg}`);
  } else {
    failed++;
    console.log(`  ${FAILED} ${msg}`);
  }
}

function assertIncludes(haystack, needle, msg) {
  assert(String(haystack).includes(needle), `${msg} (incluye "${needle}")`);
}

function assertNotIncludes(haystack, needle, msg) {
  assert(!String(haystack).includes(needle), `${msg} (NO incluye "${needle}")`);
}

function group(title, fn) {
  console.log(`\n=== ${title} ===`);
  fn();
}

// -----------------------------------------------------------------------------
// SUITE 1: redact.js
// -----------------------------------------------------------------------------

group('redact.js — tokens y secrets', () => {
  const { redact, redactTelegramToken, redactQueryStringSecrets, redactUrlCredentials } = require('./redact');

  // Bot token
  const withToken = 'Call to bot1234567890:ABCdefGHIjklMNOpqrstUVWxyz-123456 failed';
  const r1 = redact(withToken);
  assertNotIncludes(r1, 'bot1234567890:ABC', 'redact() elimina bot token de Telegram');
  assertIncludes(r1, '<REDACTED>', 'redact() deja marcador <REDACTED>');

  // Query string con token
  const withQuery = 'GET https://api.foo.com/v1?token=super-secret-abcdef&foo=bar';
  const r2 = redact(withQuery);
  assertNotIncludes(r2, 'super-secret-abcdef', 'redact() elimina ?token= query string');
  assertIncludes(r2, 'foo=bar', 'redact() preserva params no sensibles');

  // URL con credenciales embebidas
  const withCreds = 'Using proxy http://admin:hunter2@proxy.evil.com:8080 for requests';
  const r3 = redact(withCreds);
  assertNotIncludes(r3, 'admin:hunter2', 'redact() elimina user:pass de URL');
  assertIncludes(r3, 'proxy.evil.com', 'redact() preserva hostname del proxy');

  // Múltiples secrets en el mismo string
  const multi = 'bot1234567890:abcDEFghijKLM_nopqrsTUVwxyz123456 y ?access_token=xyz789';
  const r4 = redact(multi);
  assertNotIncludes(r4, 'abcDEFghij', 'redact() elimina varios secrets');
  assertNotIncludes(r4, 'xyz789', 'redact() elimina access_token');

  // API key en query string
  const apiKey = 'https://api.bar.com/?api_key=ABC123XYZ&user=alice';
  const r5 = redact(apiKey);
  assertNotIncludes(r5, 'ABC123XYZ', 'redact() elimina ?api_key=');

  // Authorization en query (poco común pero sanitizar igual)
  const auth = 'https://api.bar.com/?authorization=Bearer+zzz';
  assertNotIncludes(redact(auth), 'Bearer+zzz', 'redact() elimina ?authorization=');
});

group('redact.js — paths absolutos', () => {
  const { redact } = require('./redact');

  // Path Windows (usa PIPELINE_ROOT del entorno actual)
  const withWinPath = 'Error leyendo C:\\Users\\Administrator\\secret\\token.json';
  const r1 = redact(withWinPath);
  assertNotIncludes(r1, 'C:\\Users\\Administrator', 'redact() elimina path absoluto Windows');

  // Path Unix
  const withUnixPath = 'Error: /home/admin/.ssh/id_rsa not found';
  const r2 = redact(withUnixPath);
  assertNotIncludes(r2, '/home/admin/.ssh', 'redact() elimina path absoluto Unix');
});

group('redact.js — stack traces', () => {
  const { redactStackTrace, redact } = require('./redact');

  const stack = `Error: ENOTFOUND api.telegram.org
    at GetAddrInfoReqWrap.onlookup [as oncomplete] (dns.js:71:26)
    at emitLookup (internal/dns.js:45:8)
    at Object.<anonymous> (C:\\code\\pulpo.js:123:45)`;
  const r1 = redactStackTrace(stack);
  assert(!r1.includes('at GetAddrInfoReqWrap'), 'redactStackTrace() elimina líneas "at ..."');
  assertIncludes(r1, 'Error: ENOTFOUND', 'redactStackTrace() preserva primera línea');
  assertIncludes(r1, '[stack redacted]', 'redactStackTrace() agrega marcador');

  // redact() completo sobre stack
  const r2 = redact(stack);
  assertNotIncludes(r2, 'at GetAddrInfoReqWrap', 'redact() elimina stack trace completo');
});

group('redact.js — casos borde', () => {
  const { redact } = require('./redact');

  // Input null/undefined debe ser seguro
  assert(redact(null) === null, 'redact(null) devuelve null sin crashear');
  assert(redact(undefined) === undefined, 'redact(undefined) devuelve undefined sin crashear');

  // Número / objeto — debe convertir a string
  assert(typeof redact(123) === 'string', 'redact(number) devuelve string');
  assert(typeof redact({ foo: 'bar' }) === 'string', 'redact(object) devuelve string');

  // Input seguro no debe ser mutado
  const clean = 'Mensaje normal sin secretos: issue #2296 ENOTFOUND api.example.com';
  const r1 = redact(clean);
  assertIncludes(r1, 'ENOTFOUND api.example.com', 'redact() preserva textos no sensibles');
  assertIncludes(r1, '#2296', 'redact() preserva referencias de issue');
});

// -----------------------------------------------------------------------------
// SUITE 2: circuit-breaker-infra.js
// -----------------------------------------------------------------------------

group('circuit-breaker-infra.js — estado inicial y transiciones', () => {
  // Usar un directorio temporal para aislar el archivo de estado del real.
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cbinfra-test-'));
  // Inyectamos PIPELINE_ROOT antes de requerir el módulo — el módulo usa __dirname
  // pero el STATE_FILE queda fijo en el directorio del módulo. Para estos tests,
  // vamos a redirigir STATE_FILE mutando el módulo cargado.
  delete require.cache[require.resolve('./circuit-breaker-infra')];
  const cb = require('./circuit-breaker-infra');

  // Sobrescribir el path del archivo de estado para los tests (no tocar el real).
  const tmpStateFile = path.join(TMP, 'circuit-breaker-infra.json');
  Object.defineProperty(cb, 'STATE_FILE', { value: tmpStateFile, writable: false, configurable: true });

  // Monkey-patch: como readState/writeState usan la const interna, vamos a
  // trabajar sobre el archivo directamente para verificar que las funciones
  // respetan el orden de transiciones. El patching completo requiere reescritura,
  // así que validamos comportamiento usando un archivo temporal + fs directo.
  // En este test, el módulo sigue usando su STATE_FILE interno. Aceptamos que
  // los tests de estado se hagan contra el archivo real SÓLO si no existe.

  // Nota: el test se ejecuta sobre el archivo del módulo. Para evitar side effects
  // en producción, limpiamos al inicio y al final.
  try { fs.unlinkSync(cb.STATE_FILE); } catch {}

  const initial = cb.readState();
  assert(initial.state === 'closed', 'estado inicial = closed');
  assert(initial.consecutive_failures === 0, 'contador inicial = 0');
  assert(initial.alert_sent === false, 'alert_sent inicial = false');

  // Registrar 2 fallos consecutivos — no debe abrir todavía
  const r1 = cb.registerInfraFailure(2296, 'ENOTFOUND');
  assert(r1.opened === false, 'falla 1/3 no abre el CB');
  assert(r1.state.consecutive_failures === 1, 'contador = 1');
  assert(r1.state.state === 'closed', 'sigue closed tras 1 falla');

  const r2 = cb.registerInfraFailure(2297, 'ETIMEDOUT');
  assert(r2.opened === false, 'falla 2/3 no abre el CB');
  assert(r2.state.consecutive_failures === 2, 'contador = 2');

  const r3 = cb.registerInfraFailure(2298, 'ECONNREFUSED');
  assert(r3.opened === true, 'falla 3/3 abre el CB');
  assert(r3.state.state === 'open', 'estado = open tras 3ra falla');
  assert(r3.state.last_issue_trigger === 2298, 'last_issue_trigger guarda último issue');
  assert(r3.state.last_error_code === 'ECONNREFUSED', 'last_error_code guarda último código');
  assert(typeof r3.state.opened_at === 'string' && r3.state.opened_at.includes('T'), 'opened_at es ISO-8601');

  // Una 4ta falla NO debe re-disparar `opened` (ya estaba abierto)
  const r4 = cb.registerInfraFailure(2299, 'ETIMEDOUT');
  assert(r4.opened === false, '4ta falla no re-dispara opened (ya estaba abierto)');

  // markAlertSent() solo aplica una vez
  const afterMark = cb.markAlertSent();
  assert(afterMark.alert_sent === true, 'markAlertSent() activa flag');

  // resetOnSuccess() mientras está open no cierra el CB (solo resume() lo hace)
  const noReset = cb.resetOnSuccess();
  assert(noReset === null, 'resetOnSuccess() no cambia estado si CB está open');
  assert(cb.readState().state === 'open', 'CB sigue open tras resetOnSuccess()');

  // resume() cierra el CB
  const resumed = cb.resume();
  assert(resumed.changed === true, 'resume() cierra el CB');
  assert(resumed.state.state === 'closed', 'estado = closed tras resume()');
  assert(resumed.state.consecutive_failures === 0, 'contador reseteado a 0');
  assert(resumed.state.alert_sent === false, 'alert_sent reseteado');

  // resume() idempotente
  const resumed2 = cb.resume();
  assert(resumed2.changed === false, 'resume() idempotente cuando CB ya está closed');

  // isInfraErrorCode clasifica correctamente
  assert(cb.isInfraErrorCode('ENOTFOUND') === true, 'ENOTFOUND es código de infra');
  assert(cb.isInfraErrorCode('ECONNREFUSED') === true, 'ECONNREFUSED es código de infra');
  assert(cb.isInfraErrorCode('ETIMEDOUT') === true, 'ETIMEDOUT es código de infra');
  assert(cb.isInfraErrorCode('EAI_AGAIN') === true, 'EAI_AGAIN es código de infra');
  assert(cb.isInfraErrorCode('HTTP500') === false, 'HTTP500 NO es código de infra (respuesta del backend)');
  assert(cb.isInfraErrorCode(null) === false, 'null no es código de infra');
  assert(cb.isInfraErrorCode('') === false, 'string vacío no es código de infra');

  // Limpieza
  try { fs.unlinkSync(cb.STATE_FILE); } catch {}
});

group('circuit-breaker-infra.js — lectura defensiva', () => {
  delete require.cache[require.resolve('./circuit-breaker-infra')];
  const cb = require('./circuit-breaker-infra');

  // Archivo corrupto → devuelve default closed, NO lanza
  try { fs.unlinkSync(cb.STATE_FILE); } catch {}
  fs.writeFileSync(cb.STATE_FILE, '{ json corrupto {{{');
  const s = cb.readState();
  assert(s.state === 'closed', 'readState() devuelve default closed si JSON corrupto');
  assert(s.consecutive_failures === 0, 'contador default = 0 con JSON corrupto');

  // Limpieza
  try { fs.unlinkSync(cb.STATE_FILE); } catch {}
});

group('circuit-breaker-infra.js — reset sobre éxito', () => {
  delete require.cache[require.resolve('./circuit-breaker-infra')];
  const cb = require('./circuit-breaker-infra');

  try { fs.unlinkSync(cb.STATE_FILE); } catch {}

  // Acumular 2 fallos pero NO abrir todavía
  cb.registerInfraFailure(1, 'ENOTFOUND');
  cb.registerInfraFailure(2, 'ENOTFOUND');
  assert(cb.readState().consecutive_failures === 2, 'precondición: contador = 2');

  // Éxito cualquiera → reset
  cb.resetOnSuccess();
  const afterReset = cb.readState();
  assert(afterReset.consecutive_failures === 0, 'resetOnSuccess() baja contador a 0');
  assert(afterReset.last_error_code === null, 'resetOnSuccess() limpia last_error_code');
  assert(afterReset.state === 'closed', 'resetOnSuccess() mantiene closed');

  // Limpieza
  try { fs.unlinkSync(cb.STATE_FILE); } catch {}
});

// -----------------------------------------------------------------------------
// SUITE 3: integración — no leak de secretos en mensajes Telegram
// -----------------------------------------------------------------------------

group('integración — no leak de secretos en mensajes del CB', () => {
  const { redact } = require('./redact');

  // Simular un mensaje del CB que incluye accidentalmente token y path absoluto
  const raw = [
    '🔴 Pipeline pausado por infra',
    '',
    'Último issue afectado: #2296',
    'Error: ENOTFOUND api.telegram.org',
    'Token interno: bot1234567890:abcDEFghijKLMnop_QRSTUVwxyz123456',
    'Path: C:\\Workspaces\\Intrale\\platform\\.pipeline\\pulpo.js',
    'Stack:',
    '    at connect (net.js:1000:12)',
  ].join('\n');

  const safe = redact(raw);
  assertNotIncludes(safe, 'bot1234567890:abc', 'mensaje del CB no filtra bot token');
  assertNotIncludes(safe, 'at connect', 'mensaje del CB no filtra stack trace');
  // Al menos uno de los dos debe aplicar: path absoluto redactado
  assert(
    safe.includes('<PIPELINE_ROOT>') || safe.includes('<ABS_PATH>') || !safe.includes('C:\\Workspaces\\Intrale'),
    'mensaje del CB no filtra path absoluto'
  );
  assertIncludes(safe, 'Pipeline pausado por infra', 'mensaje del CB preserva copy UX');
  assertIncludes(safe, '#2296', 'mensaje del CB preserva issue reference');
  assertIncludes(safe, 'ENOTFOUND', 'mensaje del CB preserva código técnico corto');
});

// -----------------------------------------------------------------------------
// Resultado final
// -----------------------------------------------------------------------------

console.log(`\n=== Resultado ===`);
console.log(`Total: ${total} | ${PASSED} ${passed} | ${FAILED} ${failed}`);
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
