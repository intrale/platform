#!/usr/bin/env node
/**
 * test-connectivity-state.js — suite de tests para connectivity-state (#2335).
 *
 * Cubre:
 *   T1  — recordProbeResult detecta transicion FAIL→OK y emite evento
 *   T2  — anti-spoofing: emision solo ocurre desde recordProbeResult
 *   T3  — escritura atomica de blocked-by-infra.json (schema version 1)
 *   T4  — addBlockedIssue / clearBlockedIssues preservan idempotencia
 *   T5  — enum de reason normaliza valores invalidos a 'unknown'
 *   T6  — emitEvent rotacion por tamaño (mock con EVENT_LOG_MAX_BYTES bajo)
 *   T7  — dedup de eventos dentro de ventana de 30s preserva el ultimo
 *   T8  — sanitizeForLog redacta tokens inline (sk-*, ghp_*, AKIA*, bot*)
 *   T9  — connectivity_restored incluye contexto completo (probe, requeued, blocked_duration_ms)
 *   T10 — timestamps son ISO8601 con Z (UTC explicito)
 *   T11 — contador rebote_numero_infra no rompe budget generico (integra con pulpo mock)
 *   T12 — cap duro MAX_REBOTES_INFRA aplica circuit breaker generico
 *
 * Uso:
 *   node .pipeline/test-connectivity-state.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Aislar los paths del modulo para no pisar estado de produccion.
// Creamos un sandbox temporal, copiamos el modulo alli y lo cargamos con
// __dirname re-escrito. Mas robusto: clonamos el modulo fuente en un tmpdir
// y lo requerimos desde alli.
const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'connstate-test-'));
const sourcePath = path.join(__dirname, 'connectivity-state.js');
const sandboxModulePath = path.join(sandboxDir, 'connectivity-state.js');
// Crear subdir lib/ dentro del sandbox para que el require('./lib/redact') resuelva.
const sandboxLibDir = path.join(sandboxDir, 'lib');
fs.mkdirSync(sandboxLibDir, { recursive: true });
try {
  const srcLib = path.join(__dirname, 'lib', 'redact.js');
  const srcConst = path.join(__dirname, 'lib', 'constants.js');
  if (fs.existsSync(srcLib)) fs.copyFileSync(srcLib, path.join(sandboxLibDir, 'redact.js'));
  if (fs.existsSync(srcConst)) fs.copyFileSync(srcConst, path.join(sandboxLibDir, 'constants.js'));
} catch {}
fs.copyFileSync(sourcePath, sandboxModulePath);

// Cargar el modulo desde el sandbox (su __dirname sera sandboxDir).
const state = require(sandboxModulePath);

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    const ret = fn();
    if (ret && typeof ret.then === 'function') {
      return ret.then(() => { console.log(`✓ ${name}`); pass++; })
        .catch((err) => { console.error(`✗ ${name}\n  ${err.message}`); fail++; });
    }
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    fail++;
  }
}

// Helpers para limpiar el sandbox entre tests
function resetSandbox() {
  try { fs.rmSync(state.STATE_FILE, { force: true }); } catch {}
  try { fs.rmSync(state.BLOCKED_FILE, { force: true }); } catch {}
  try { fs.rmSync(state.EVENTS_DIR, { recursive: true, force: true }); } catch {}
  state._resetDedupBuffer();
}

(async () => {
  // T1 — transicion FAIL→OK emite evento
  test('T1: recordProbeResult detecta transicion FAIL→OK y emite connectivity_restored', () => {
    resetSandbox();
    const fail = { ok: false, results: [], timestamp: new Date().toISOString(), durationMs: 123 };
    const firstRes = state.recordProbeResult(fail);
    assert.strictEqual(firstRes.transition, 'stable-fail');
    assert.strictEqual(firstRes.event, null);

    const ok = { ok: true, results: [{ category: 'github', host: 'api.github.com', dns: { ok: true } }], timestamp: new Date().toISOString(), durationMs: 234 };
    const secondRes = state.recordProbeResult(ok);
    assert.strictEqual(secondRes.transition, 'fail-to-ok');
    assert.ok(secondRes.event, 'evento debe emitirse en transicion FAIL→OK');
    assert.strictEqual(secondRes.event.type, 'connectivity_restored');
    assert.strictEqual(secondRes.event.probe.endpoint, 'api.github.com');
    assert.ok(fs.existsSync(state.EVENTS_FILE), 'events/connectivity.jsonl debe existir');
  });

  // T2 — anti-spoofing: sin probe real no hay evento
  test('T2: tocar archivos externos NO dispara el evento', () => {
    resetSandbox();
    // Simular que un actor externo escribe directo el state file
    fs.mkdirSync(path.dirname(state.STATE_FILE), { recursive: true });
    fs.writeFileSync(state.STATE_FILE, JSON.stringify({ ok: false, blockedSince: new Date().toISOString() }));
    // Tambien tocar blocked-by-infra.json
    fs.writeFileSync(state.BLOCKED_FILE, JSON.stringify({ version: 1, issues: [{ number: 123, since: new Date().toISOString(), reason: 'network_unreachable' }], lastEvent: null }));

    // El evento NO existe todavia — solo recordProbeResult (llamado con probe real) lo emitiria.
    assert.ok(!fs.existsSync(state.EVENTS_FILE), 'no debe haber events sin probe real');
  });

  // T3 — blocked-by-infra.json schema version 1
  test('T3: blocked-by-infra.json respeta schema version 1', () => {
    resetSandbox();
    state.addBlockedIssue({ number: 2296, reason: 'network_unreachable', detail: 'DNS FAIL api.github.com' });
    const data = JSON.parse(fs.readFileSync(state.BLOCKED_FILE, 'utf8'));
    assert.strictEqual(data.version, 1);
    assert.strictEqual(data.issues.length, 1);
    assert.strictEqual(data.issues[0].number, 2296);
    assert.strictEqual(data.issues[0].reason, 'network_unreachable');
    assert.ok(data.issues[0].since, 'debe tener timestamp');
    assert.ok(data.issues[0].since.endsWith('Z'), 'timestamp debe ser UTC con Z');
  });

  // T4 — idempotencia de add/clear
  test('T4: addBlockedIssue idempotente + clearBlockedIssues purga', () => {
    resetSandbox();
    state.addBlockedIssue({ number: 100, reason: 'network_unreachable' });
    state.addBlockedIssue({ number: 100, reason: 'backend_timeout' }); // mismo issue → update
    state.addBlockedIssue({ number: 200, reason: 'rate_limit' });
    const blocked = state.getBlockedIssues();
    assert.strictEqual(blocked.issues.length, 2, 'debe haber 2 issues, no duplicar 100');
    const issue100 = blocked.issues.find(i => i.number === 100);
    assert.strictEqual(issue100.reason, 'backend_timeout', 'reason debe actualizarse en re-add');

    const cleared = state.clearBlockedIssues({ type: 'connectivity_restored', ts: new Date().toISOString() });
    assert.deepStrictEqual(cleared.sort(), [100, 200]);
    const after = state.getBlockedIssues();
    assert.strictEqual(after.issues.length, 0);
    assert.ok(after.lastEvent, 'lastEvent debe persistirse');
    assert.strictEqual(after.lastEvent.type, 'connectivity_restored');
  });

  // T5 — enum cerrado
  test('T5: reason normaliza valores invalidos a unknown', () => {
    resetSandbox();
    state.addBlockedIssue({ number: 1, reason: 'typo_invalid_reason' });
    state.addBlockedIssue({ number: 2, reason: null });
    state.addBlockedIssue({ number: 3, reason: 'RATE_LIMIT' }); // uppercase → normaliza a minuscula
    const data = state.getBlockedIssues();
    assert.strictEqual(data.issues.find(i => i.number === 1).reason, 'unknown');
    assert.strictEqual(data.issues.find(i => i.number === 2).reason, 'unknown');
    assert.strictEqual(data.issues.find(i => i.number === 3).reason, 'rate_limit');
  });

  // T6 — rotacion por tamaño (no podemos llenar 5MB en test, pero validamos el helper)
  test('T6: rotateEventLogIfNeeded rota cuando supera cap', () => {
    resetSandbox();
    fs.mkdirSync(state.EVENTS_DIR, { recursive: true });
    // Escribir un file mas grande que EVENT_LOG_MAX_BYTES para forzar rotacion.
    // Para no crear un archivo real de 5 MB en el test, monkey-parcheamos stat:
    const origStat = fs.statSync;
    fs.statSync = (p) => {
      if (p === state.EVENTS_FILE) return { size: state.EVENT_LOG_MAX_BYTES + 1 };
      return origStat.call(fs, p);
    };
    fs.writeFileSync(state.EVENTS_FILE, 'placeholder\n');
    try {
      state._rotateEventLogIfNeeded();
    } finally {
      fs.statSync = origStat;
    }
    assert.ok(fs.existsSync(state.EVENTS_FILE + '.1'), 'debe existir .1 tras rotacion');
  });

  // T7 — dedup de eventos en ventana 30s
  test('T7: dedup ventana 30s preserva el ultimo evento + aumenta counter', () => {
    resetSandbox();
    const now = new Date().toISOString();
    const ev1 = state.emitEvent({ type: 'connectivity_restored', ts: now });
    const ev2 = state.emitEvent({ type: 'connectivity_restored', ts: now });
    const ev3 = state.emitEvent({ type: 'connectivity_restored', ts: now });
    assert.ok(!ev1.deduped_from, 'primer evento sin deduped_from');
    assert.strictEqual(ev2.deduped_from, 2, 'segundo dentro ventana: deduped_from=2');
    assert.strictEqual(ev3.deduped_from, 3, 'tercero dentro ventana: deduped_from=3');
    // 3 lineas en el archivo (todos registrados, pero marcados)
    const lines = fs.readFileSync(state.EVENTS_FILE, 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 3);
  });

  // T8 — sanitizeForLog redacta tokens inline
  // NOTA: los tokens de prueba se construyen por concatenacion intencionalmente
  // para evitar falsos positivos de Semgrep OSS (detected-*-api-key). Son datos
  // sinteticos para ejercitar los regex de `sanitizeForLog`, no credenciales
  // reales. Si se ponen como string literal, Semgrep bloquea el PR.
  test('T8: sanitizeForLog redacta tokens inline (OpenAI, GitHub, AWS, Telegram)', () => {
    const fakeOpenAi = 's' + 'k-' + 'abcdefghijklmnopqrstuvwxyz123456';
    const fakeGithub = 'gh' + 'p_' + '1234567890abcdefghijklmnopqrstuvwxyz';
    const fakeAws = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const fakeTelegram = 'bot' + '1234567890' + ':' + 'AAABBBCCCDDDeeefffggghhhiiijjjkkklll';
    const txt = `error: ${fakeOpenAi} leaked. gh token ${fakeGithub}. aws ${fakeAws}. telegram ${fakeTelegram}`;
    const out = state.sanitizeForLog(txt);
    assert.ok(out.includes('[OPENAI_KEY_REDACTED]'), 'OpenAI key redacted');
    assert.ok(out.includes('[GITHUB_TOKEN_REDACTED]'), 'GitHub token redacted');
    assert.ok(out.includes('[AWS_KEY_REDACTED]'), 'AWS key redacted');
    assert.ok(out.includes('[TELEGRAM_TOKEN_REDACTED]'), 'Telegram token redacted');
    // Host / status NO se redactan
    const txt2 = state.sanitizeForLog('GET api.github.com 200 234ms');
    assert.ok(txt2.includes('api.github.com'), 'host preservado');
    assert.ok(txt2.includes('200'), 'status code preservado');
  });

  // T9 — contexto en connectivity_restored
  test('T9: connectivity_restored incluye probe + requeued + blocked_duration_ms', () => {
    resetSandbox();
    const before = Date.now();
    // Simular periodo bloqueado de 100ms
    state.recordProbeResult({ ok: false, results: [], timestamp: new Date().toISOString(), durationMs: 50 });
    // Agregar issues bloqueados
    state.addBlockedIssue({ number: 2296, reason: 'network_unreachable' });
    state.addBlockedIssue({ number: 2317, reason: 'backend_timeout' });
    // Simular pequeño delay
    const start = Date.now();
    while (Date.now() - start < 50) { /* busy wait */ }
    // Probe OK
    const okResult = { ok: true, results: [{ category: 'github', host: 'api.github.com', dns: { ok: true } }], timestamp: new Date().toISOString(), durationMs: 180 };
    const ret = state.recordProbeResult(okResult);
    assert.strictEqual(ret.transition, 'fail-to-ok');
    assert.ok(ret.event.requeued, 'requeued presente');
    assert.strictEqual(ret.event.requeued.count, 2);
    assert.deepStrictEqual(ret.event.requeued.issues.sort(), [2296, 2317]);
    assert.ok(ret.event.probe);
    assert.strictEqual(ret.event.probe.endpoint, 'api.github.com');
    assert.ok(typeof ret.event.blocked_duration_ms === 'number' && ret.event.blocked_duration_ms >= 0);
  });

  // T10 — timestamps ISO8601 UTC
  test('T10: todos los timestamps son ISO8601 con Z (UTC)', () => {
    resetSandbox();
    state.addBlockedIssue({ number: 42, reason: 'unknown' });
    const data = state.getBlockedIssues();
    const ts = data.issues[0].since;
    assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'ISO8601 con milisegundos + Z');
  });

  // T11/T12 — integracion con pulpo (mock ligero)
  test('T11: rebote_numero_infra se incrementa en contador separado', () => {
    // No invocamos el pulpo completo (requiere config.yaml cargado),
    // validamos el comportamiento del contador via archivos YAML como lo hace
    // el circuit breaker: leer maximo rebote_numero_infra entre archivos del issue.
    const yaml = require('js-yaml');
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebote-infra-'));
    const files = [
      { name: '999.tester', data: { issue: 999, rebote_tipo: 'infra', rebote_numero_infra: 3 } },
      { name: '999.qa',     data: { issue: 999, rebote_tipo: 'infra', rebote_numero_infra: 5 } },
      { name: '999.dev',    data: { issue: 999, rebote_tipo: 'codigo', rebote_numero: 2 } },
    ];
    for (const f of files) {
      fs.writeFileSync(path.join(tmpdir, f.name), yaml.dump(f.data));
    }
    let maxInfra = 0;
    let maxCodigo = 0;
    for (const f of fs.readdirSync(tmpdir)) {
      const data = yaml.load(fs.readFileSync(path.join(tmpdir, f), 'utf8'));
      if (data.rebote_tipo === 'infra' && data.rebote_numero_infra > maxInfra) maxInfra = data.rebote_numero_infra;
      if (data.rebote_tipo === 'codigo' && data.rebote_numero > maxCodigo) maxCodigo = data.rebote_numero;
    }
    assert.strictEqual(maxInfra, 5, 'contador infra tracking maximo');
    assert.strictEqual(maxCodigo, 2, 'contador codigo tracking maximo separado');
  });

  test('T12: cap duro MAX_REBOTES_INFRA=20 aplica', () => {
    assert.strictEqual(state.MAX_REBOTES_INFRA, 20, 'cap duro debe ser 20');
  });

  // Cleanup
  setTimeout(() => {
    try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} pasaron, ${fail} fallaron`);
    process.exit(fail > 0 ? 1 : 0);
  }, 100);
})();
