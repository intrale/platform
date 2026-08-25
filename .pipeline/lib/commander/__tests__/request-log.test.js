// =============================================================================
// request-log.test.js — Cobertura del helper de log por petición del Commander
// (#3949 / EP7-H2).
//
// Estructura:
//   T-1  buildRequestId → string filename-safe `^[a-zA-Z0-9-]+$` (incl. chat_id
//        negativo de grupos Telegram) + sufijo + sin colisión entre ms distintos.
//   T-2  redacción efectiva: un secreto inyectado en una etapa NO aparece en el
//        archivo (la escritura hereda el stream sanitizado — SEC-1/SEC-2).
//   T-3  las 4 cabeceras de etapa (transcripción / dispatch / Sherlock / envío)
//        están presentes y en orden.
//   T-4  close() cierra el fd sin error (idempotencia del flush).
//   T-5  logFileName produce `commander-<id>.log`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../request-log');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reqlog-'));
}

// --- T-1 ---------------------------------------------------------------------
test('buildRequestId produce un id filename-safe (^[a-zA-Z0-9-]+$)', () => {
  const id = mod.buildRequestId(123456, 1718000000000);
  assert.match(id, /^[a-zA-Z0-9-]+$/);
  assert.equal(id, '123456-1718000000000');
});

test('buildRequestId acepta chat_id negativo (grupos Telegram) sin deformarlo', () => {
  const id = mod.buildRequestId(-1001234567890, 1718000000000);
  assert.match(id, /^[a-zA-Z0-9-]+$/);
  assert.equal(id, '-1001234567890-1718000000000');
});

test('buildRequestId elimina caracteres no permitidos (`:`, `/`, espacios)', () => {
  const id = mod.buildRequestId('ab:cd/ef gh', 1718000000000);
  assert.match(id, /^[a-zA-Z0-9-]+$/);
  assert.equal(id, 'abcdefgh-1718000000000');
});

test('buildRequestId con sufijo (turnId) rompe empate sin perder safety', () => {
  const a = mod.buildRequestId(-100, 1718000000000, 'a1b2c3d4');
  const b = mod.buildRequestId(-100, 1718000000000, 'deadbeef');
  assert.match(a, /^[a-zA-Z0-9-]+$/);
  assert.notEqual(a, b);
  assert.equal(a, '-100-1718000000000-a1b2c3d4');
});

test('buildRequestId distintos ms → ids distintos (anti-colisión)', () => {
  const a = mod.buildRequestId(-100, 1718000000000);
  const b = mod.buildRequestId(-100, 1718000000001);
  assert.notEqual(a, b);
});

test('buildRequestId tolera chatId/nowMs nulos sin romper', () => {
  const id = mod.buildRequestId(null, null);
  assert.match(id, /^[a-zA-Z0-9-]+$/);
  assert.equal(id, 'unknown-0');
});

// --- T-5 ---------------------------------------------------------------------
test('logFileName produce commander-<id>.log', () => {
  assert.equal(mod.logFileName('-100-1718000000000'), 'commander--100-1718000000000.log');
});

// --- T-2 ---------------------------------------------------------------------
test('un secreto inyectado en una etapa NO aparece en texto plano (redacción)', async () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(-100, 1718000000001);
  const rl = mod.openRequestLog(dir, reqId, { silentFs: true });

  // Secretos representativos cubiertos por el sanitizer (JWT / password=).
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  rl.stage('transcripción', { audios: 1 });
  rl.line(`texto: Authorization: Bearer ${jwt}`);
  rl.line('texto: mi password=supersecreto123 va acá');
  rl.stage('envío', { chars: 10 });
  await rl.close();

  const content = fs.readFileSync(rl.path, 'utf8');
  assert.ok(!content.includes(jwt), 'el JWT no debe aparecer en plano');
  assert.ok(!content.includes('supersecreto123'), 'el password no debe aparecer en plano');
  assert.match(content, /REDACTED/, 'debe haber al menos un placeholder de redacción');
});

// --- T-3 ---------------------------------------------------------------------
test('las 4 cabeceras de etapa están presentes y en orden', async () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(42, 1718000000002);
  const rl = mod.openRequestLog(dir, reqId, { silentFs: true });

  rl.stage('transcripción', { audios: 0 });
  rl.line('texto: hola');
  rl.stage('dispatch', { intent_class: 'llm', provider: 'anthropic', model: 'claude-cli' });
  rl.stage('Sherlock', { veredicto: 'ok', provider: 'anthropic-haiku', duration_ms: 1234 });
  rl.stage('envío', { canal: 'texto', chars: 4 });
  await rl.close();

  const content = fs.readFileSync(rl.path, 'utf8');
  const idxTrans = content.indexOf('etapa:transcripción');
  const idxDisp = content.indexOf('etapa:dispatch');
  const idxSher = content.indexOf('etapa:Sherlock');
  const idxEnv = content.indexOf('etapa:envío');

  assert.ok(idxTrans >= 0, 'falta etapa transcripción');
  assert.ok(idxDisp >= 0, 'falta etapa dispatch');
  assert.ok(idxSher >= 0, 'falta etapa Sherlock');
  assert.ok(idxEnv >= 0, 'falta etapa envío');
  assert.ok(idxTrans < idxDisp && idxDisp < idxSher && idxSher < idxEnv, 'las etapas deben estar en orden');

  // El req:<id> debe aparecer en cada cabecera.
  assert.match(content, new RegExp(`req:${reqId}`));
  // La metadata de dispatch debe estar presente (SEC-3: solo strings).
  assert.match(content, /provider: anthropic/);
  assert.match(content, /veredicto: ok/);
});

// --- T-4 ---------------------------------------------------------------------
test('close() cierra el writer sin error y es seguro de awaitear', async () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(7, 1718000000003);
  const rl = mod.openRequestLog(dir, reqId, { silentFs: true });
  rl.stage('transcripción', {});
  rl.line('contenido');
  await assert.doesNotReject(() => rl.close());
  assert.ok(fs.existsSync(rl.path), 'el archivo debe existir tras close()');
});

test('openRequestLog expone path/fileName/reqId correctos', () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(-1, 1718000000004);
  const rl = mod.openRequestLog(dir, reqId, { silentFs: true });
  assert.equal(rl.reqId, reqId);
  assert.equal(rl.fileName, `commander-${reqId}.log`);
  assert.equal(rl.path, path.join(dir, `commander-${reqId}.log`));
  return rl.close();
});

// --- #3951 EP7-H4 — writeRequestMeta + metaFileName --------------------------

test('metaFileName produce commander-<id>.meta.json (mismo prefijo que el .log)', () => {
  assert.equal(mod.metaFileName('-100-1718000000000'), 'commander--100-1718000000000.meta.json');
});

test('metaFileName es filename-safe (limpia caracteres no permitidos)', () => {
  assert.equal(mod.metaFileName('ab:cd/ef gh'), 'commander-abcdefgh.meta.json');
  assert.match(mod.metaFileName('x:y/z'), /^commander-[a-zA-Z0-9-]+\.meta\.json$/);
});

test('writeRequestMeta persiste un sidecar con shape ACOTADO', () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(-100, 1718000000010);
  const p = mod.writeRequestMeta(dir, reqId, {
    resultado: 'ajustada',
    provider: 'gemini-google',
    sameProviderVerification: true,
    crossProviderDispatch: false,
  });
  assert.equal(p, path.join(dir, `commander-${reqId}.meta.json`));
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(parsed, {
    resultado: 'ajustada',
    provider: 'gemini-google',
    sameProviderVerification: true,
    crossProviderDispatch: false,
  });
});

test('writeRequestMeta descarta campos extra (no filtra config de providers)', () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(7, 1718000000011);
  const p = mod.writeRequestMeta(dir, reqId, {
    resultado: 'ok',
    provider: 'anthropic',
    sameProviderVerification: false,
    crossProviderDispatch: false,
    // Campos que NUNCA deben llegar al sidecar (SEC-3):
    providersConfig: { anthropic: { ANTHROPIC_API_KEY: 'sk-secret-xyz' } },
    apiKey: 'sk-leak',
  });
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(!raw.includes('sk-secret-xyz'), 'no debe filtrar API keys');
  assert.ok(!raw.includes('sk-leak'), 'no debe filtrar credenciales');
  assert.ok(!raw.includes('providersConfig'), 'no debe incluir config de providers');
  const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed).sort(), ['crossProviderDispatch', 'provider', 'resultado', 'sameProviderVerification']);
});

test('writeRequestMeta coacciona tipos (strings/booleans) defensivamente', () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(1, 1718000000012);
  const p = mod.writeRequestMeta(dir, reqId, {
    resultado: 123,            // no-string → ''
    provider: null,            // no-string → ''
    sameProviderVerification: 'yes', // no-boolean → OMITIDO (tri-estado, #3951)
    crossProviderDispatch: 1,  // no-boolean estricto → false
  });
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(parsed.resultado, '');
  assert.equal(parsed.provider, '');
  // #3951 rebote — un valor no-boolean NO se persiste (no es ni same ni cross):
  // el campo se omite para que el render no invente chip de verificación.
  assert.ok(!('sameProviderVerification' in parsed), 'no-boolean ⇒ campo omitido');
  assert.equal(parsed.crossProviderDispatch, false);
});

test('writeRequestMeta persiste sameProviderVerification:false (cross) como boolean', () => {
  // false NO debe omitirse: es un estado real (verificación cross-provider).
  const dir = tmpDir();
  const reqId = mod.buildRequestId(8, 1718000000014);
  const p = mod.writeRequestMeta(dir, reqId, {
    resultado: 'ok', provider: 'anthropic', sameProviderVerification: false, crossProviderDispatch: false,
  });
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok('sameProviderVerification' in parsed, 'false es un estado real, debe persistir');
  assert.equal(parsed.sameProviderVerification, false);
});

test('writeRequestMeta OMITE sameProviderVerification cuando es null (sin verificación, #3951)', () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(9, 1718000000015);
  const p = mod.writeRequestMeta(dir, reqId, {
    resultado: 'ok', provider: 'anthropic', sameProviderVerification: null, crossProviderDispatch: false,
  });
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(!('sameProviderVerification' in parsed), 'null ⇒ campo ausente en el sidecar');
});

test('writeRequestMeta es best-effort: dir inexistente → null sin tirar', () => {
  const p = mod.writeRequestMeta(path.join(os.tmpdir(), 'no', 'existe', 'dir', 'xyz123'), 'abc-1', { resultado: 'ok' });
  assert.equal(p, null);
});

test('writeRequestMeta es idempotente (sobreescribe)', () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(2, 1718000000013);
  mod.writeRequestMeta(dir, reqId, { resultado: 'ok', provider: 'anthropic' });
  const p = mod.writeRequestMeta(dir, reqId, { resultado: 'error', provider: 'anthropic' });
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(parsed.resultado, 'error');
});

// =============================================================================
// #6458 — Canal estructurado de etapas (`commander-<reqId>.stages.jsonl`).
//
//   T-6   CA-1 / REQ-SEC-2 — durabilidad AL `stage()`, sin `close()`.
//   T-7   CA-2 / SEC-1     — `line()` con delimitador forjado no fabrica etapas.
//   T-8   CA-3 / REQ-SEC-4 — el canal no tiene handle ni path exportado.
//   T-9   CA-4 / REQ-SEC-6 — lectura fail-closed sin prototype pollution.
//   T-10  CA-5 / REQ-SEC-5 — sin path traversal.
//   T-11  CA-6 / REQ-SEC-3 — los secrets salen redactados y la línea sigue JSON.
//   T-12  CA-7 / SEC-3     — una entrada = una línea.
//   T-13  D2  / REQ-SEC-1  — `buildAuditReqRef` no filtra el chat id crudo.
// =============================================================================

const crypto = require('node:crypto');

// hashFor() de `multi-provider.js` / `inflight-fallback.js`, replicado acá para
// probar la coincidencia del primer segmento SIN importar esos módulos.
function hashFor(x) {
  return crypto.createHash('sha256').update(String(x || ''), 'utf8').digest('hex').slice(0, 12);
}

function stagesPathOf(dir, reqId) {
  return path.join(dir, mod.stagesFileName(reqId));
}

// --- T-6 ---------------------------------------------------------------------
test('#6458 CA-1: cada stage() queda en disco SIN llamar close()', () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(555, 1718000001000);
  const rl = mod.openRequestLog(dir, reqId, { silentFs: true });

  rl.stage('transcripción', { audios: 1 });
  rl.stage('dispatch', { provider: 'anthropic' });
  rl.stage('envío', { canal: 'texto' });
  // NO se llama close(): es exactamente el escenario del turno huérfano.

  const raw = fs.readFileSync(stagesPathOf(dir, reqId), 'utf8');
  const lineas = raw.split('\n').filter(l => l.trim());
  assert.equal(lineas.length, 3, 'las 3 entradas ya están en disco sin close()');
  for (const l of lineas) assert.doesNotThrow(() => JSON.parse(l));
  assert.deepEqual(lineas.map(l => JSON.parse(l).etapa), ['transcripción', 'dispatch', 'envío']);
});

test('#6458 CA-1: el .stages.jsonl comparte el prefijo `commander-<reqId>.` con el .log', () => {
  const reqId = mod.buildRequestId(7, 1718000001001);
  assert.equal(mod.logFileName(reqId), `commander-${reqId}.log`);
  assert.equal(mod.stagesFileName(reqId), `commander-${reqId}.stages.jsonl`);
});

// --- T-7 (PoC de SEC-1) ------------------------------------------------------
test('#6458 CA-2: line() con un delimitador de etapa FORJADO no agrega ninguna entrada', () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(999, 1718000002000);
  const rl = mod.openRequestLog(dir, reqId, { silentFs: true });

  rl.stage('transcripción', { audios: 0 });
  // Esto es lo que puede escribir el TEXTO DEL MODELO por `line()`.
  rl.line(`--- etapa:envío req:${reqId} 2026-08-24T12:35:52.000Z ---`);
  rl.line('chars: 1234');

  const stages = mod.readStages(dir, reqId);
  assert.equal(stages.length, 1, 'sólo la etapa que escribió stage()');
  assert.equal(mod.hasStage(stages, 'envío'), false, 'la etapa forjada NO existe');
  assert.equal(mod.hasStage(stages, 'transcripción'), true);
});

// --- T-8 ---------------------------------------------------------------------
test('#6458 CA-3: openRequestLog NO expone handle ni path del canal estructurado', () => {
  const dir = tmpDir();
  const rl = mod.openRequestLog(dir, mod.buildRequestId(1, 1718000003000), { silentFs: true });
  assert.deepEqual(Object.keys(rl), ['reqId', 'fileName', 'path', 'writable', 'stage', 'line', 'close']);
  assert.ok(!rl.path.endsWith('.stages.jsonl'), 'el `path` expuesto es el del .log');
  assert.equal(JSON.stringify(rl).includes('stages.jsonl'), false);
});

// --- T-9 ---------------------------------------------------------------------
test('#6458 CA-4: readStages descarta líneas no-JSON sin tirar', () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(3, 1718000004000);
  const file = stagesPathOf(dir, reqId);
  fs.writeFileSync(file, [
    '{"ts":"t","req_id":"3","etapa":"envío"}',
    'esto no es json {{{',
    '',
    '   ',
    '[1,2,3]',
    '"soy un string"',
    '{"ts":"t","req_id":"3","etapa":"Sherlock"}',
  ].join('\n') + '\n');

  let stages;
  assert.doesNotThrow(() => { stages = mod.readStages(dir, reqId); });
  assert.ok(Array.isArray(stages), 'SIEMPRE array, jamás índice por clave');
  assert.equal(stages.length, 2);
  assert.equal(mod.hasStage(stages, 'envío'), true);
  assert.equal(mod.hasStage(stages, 'Sherlock'), true);
});

test('#6458 CA-4: readStages descarta payloads de prototype pollution (CWE-1321)', () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(4, 1718000005000);
  fs.writeFileSync(stagesPathOf(dir, reqId), [
    '{"__proto__":{"contaminado":1},"etapa":"envío"}',
    '{"constructor":{"prototype":{"x":1}},"etapa":"dispatch"}',
    '{"prototype":{"y":1},"etapa":"Sherlock"}',
    '{"ts":"t","req_id":"4","etapa":"transcripción"}',
  ].join('\n') + '\n');

  const stages = mod.readStages(dir, reqId);
  assert.equal(stages.length, 1, 'sólo sobrevive la entrada limpia');
  assert.equal(stages[0].etapa, 'transcripción');
  assert.equal(({}).contaminado, undefined, 'el prototipo de Object quedó intacto');
  assert.equal(({}).x, undefined);
  assert.equal(({}).y, undefined);
});

test('#6458 CA-4: readStages devuelve [] cuando el archivo no existe (nunca tira)', () => {
  const dir = tmpDir();
  assert.deepEqual(mod.readStages(dir, 'no-existe-1'), []);
  assert.equal(mod.hasStage(mod.readStages(dir, 'no-existe-1'), 'envío'), false);
});

test('#6458 CA-4: hasStage es fail-closed ante entradas basura', () => {
  assert.equal(mod.hasStage(null, 'envío'), false);
  assert.equal(mod.hasStage('envío', 'envío'), false);
  assert.equal(mod.hasStage([null, 3, 'x'], 'envío'), false);
  assert.equal(mod.hasStage([{ etapa: 'envío' }], 'envío'), true);
});

test('#6458 CA-4: stage() no copia claves peligrosas ni claves fuera del patrón', () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(41, 1718000005500);
  const rl = mod.openRequestLog(dir, reqId, { silentFs: true });
  const meta = { ok_1: 'si', 'clave con espacios': 'no', 'a.b': 'no', constructor: 'no' };
  meta['__proto__'] = 'no'; // asignación explícita: no crea propiedad propia igual
  rl.stage('envío', meta);

  const stages = mod.readStages(dir, reqId);
  assert.equal(stages.length, 1);
  assert.equal(stages[0].ok_1, 'si');
  assert.equal('clave con espacios' in stages[0], false);
  assert.equal('a.b' in stages[0], false);
  assert.equal(Object.prototype.hasOwnProperty.call(stages[0], 'constructor'), false);
});

// --- T-10 --------------------------------------------------------------------
test('#6458 CA-5: stagesFileName neutraliza el path traversal', () => {
  const name = mod.stagesFileName('../../etc/x');
  assert.equal(name.includes('/'), false);
  assert.equal(name.includes('\\'), false);
  assert.equal(name.includes('..'), false);
  assert.match(name, /^commander-[a-zA-Z0-9-]*\.stages\.jsonl$/);
});

test('#6458 CA-5: readStages con reqId hostil no lee fuera de logDir', () => {
  const base = tmpDir();
  const dir = path.join(base, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  // Archivo "sensible" fuera del logDir, con nombre alcanzable por traversal.
  fs.writeFileSync(path.join(base, 'commander-etcx.stages.jsonl'),
    '{"ts":"t","req_id":"x","etapa":"secreto"}\n');

  const stages = mod.readStages(dir, '../../etc/x');
  assert.deepEqual(stages, [], 'no escapó de logDir');
  assert.equal(mod.hasStage(stages, 'secreto'), false);
});

// --- T-11 --------------------------------------------------------------------
test('#6458 CA-6: un secret en una etapa sale REDACTADO y la línea sigue siendo JSON', () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(6, 1718000006000);
  const rl = mod.openRequestLog(dir, reqId, { silentFs: true });
  rl.stage('envío', { k: 'AKIAIOSFODNN7EXAMPLE' });

  const raw = fs.readFileSync(stagesPathOf(dir, reqId), 'utf8');
  assert.equal(raw.includes('AKIAIOSFODNN7EXAMPLE'), false, 'el secret NO queda en claro');
  const lineas = raw.split('\n').filter(l => l.trim());
  assert.equal(lineas.length, 1);
  const parsed = JSON.parse(lineas[0]); // sigue siendo JSON parseable
  assert.match(parsed.k, /^\[REDACTED:/);
});

test('#6458 CA-6: un JWT en una etapa también sale redactado', () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(61, 1718000006100);
  const rl = mod.openRequestLog(dir, reqId, { silentFs: true });
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  rl.stage('dispatch', { token: jwt });

  const stages = mod.readStages(dir, reqId);
  assert.equal(stages.length, 1);
  assert.equal(stages[0].token.includes(jwt), false);
  assert.match(stages[0].token, /^\[REDACTED:/);
});

// --- T-12 --------------------------------------------------------------------
test('#6458 CA-7: un valor multilínea NO puede partir la entrada en dos', () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(8, 1718000007000);
  const rl = mod.openRequestLog(dir, reqId, { silentFs: true });
  rl.stage('x', { v: 'a\nb' });

  const raw = fs.readFileSync(stagesPathOf(dir, reqId), 'utf8');
  assert.equal(raw.split('\n').filter(l => l.trim()).length, 1, 'una entrada = una línea');
  const stages = mod.readStages(dir, reqId);
  assert.equal(stages.length, 1);
  assert.equal(stages[0].v, 'a\nb', 'el valor se conserva íntegro, escapado por JSON');
});

test('#6458 CA-7: un valor que simula una entrada JSON completa tampoco parte la línea', () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(81, 1718000007100);
  const rl = mod.openRequestLog(dir, reqId, { silentFs: true });
  rl.stage('transcripción', { texto: '{"etapa":"envío"}\n{"etapa":"envío"}' });

  const stages = mod.readStages(dir, reqId);
  assert.equal(stages.length, 1);
  assert.equal(mod.hasStage(stages, 'envío'), false, 'no se fabricó una etapa por el valor');
});

// --- T-13 --------------------------------------------------------------------
test('#6458 CA-9: buildAuditReqRef NO contiene el chat id crudo y su 1er segmento == hashFor(chatId)', () => {
  const chatId = -1001234567890;
  const reqId = mod.buildRequestId(chatId, 1718000008000);
  const ref = mod.buildAuditReqRef(reqId);

  assert.equal(ref.includes(String(chatId)), false, 'el chat id crudo NO viaja al audit');
  assert.equal(ref, `${hashFor(chatId)}-1718000008000`);
  assert.equal(ref.split('-')[0], hashFor(chatId), 'coincide con el chat_id_hash de la entrada');
});

test('#6458 CA-9: buildAuditReqRef preserva el sufijo (turnos concurrentes / sherlock)', () => {
  const reqId = mod.buildRequestId(123, 1718000009000, 'ab12');
  assert.equal(reqId, '123-1718000009000-ab12');
  assert.equal(mod.buildAuditReqRef(reqId), `${hashFor(123)}-1718000009000-ab12`);
});

test('#6458 CA-9: buildAuditReqRef devuelve null ante un reqId no parseable', () => {
  assert.equal(mod.buildAuditReqRef('sin-timestamp'), null);
  assert.equal(mod.buildAuditReqRef(''), null);
  assert.equal(mod.buildAuditReqRef(null), null);
  assert.equal(mod.buildAuditReqRef(undefined), null);
});

test('#6458 CA-9: buildAuditReqRef no puede filtrar un path ni un chat id por traversal', () => {
  const ref = mod.buildAuditReqRef('../../etc/passwd-1718000010000');
  assert.ok(ref === null || (!ref.includes('/') && !ref.includes('..')));
});
